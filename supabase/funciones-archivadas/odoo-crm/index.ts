import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-crm (v8) ======
// Igual que v7 pero PAGE=100 para no superar el limite de memoria del worker.
// SOLO LECTURA. Lee valor real de property_product_pricelist (no filtra por el campo property).
// body {after:N} procesa 100 ids > N; encadenar con next_after hasta fin:true.

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const CAT_PROF = 1;
const LISTA2 = 32;
const RST = 1, VEL = 2;
const CTX_VEL = {allowed_company_ids:[VEL,RST]};
const CTX_RST = {allowed_company_ids:[RST,VEL]};
const PAGE = 100;

function escapeXml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function unescapeXml(s){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");}
function xmlValue(v){
  if(typeof v==="number")return Number.isInteger(v)?`<value><int>${v}</int></value>`:`<value><double>${v}</double></value>`;
  if(typeof v==="boolean")return `<value><boolean>${v?1:0}</boolean></value>`;
  if(typeof v==="string")return `<value><string>${escapeXml(v)}</string></value>`;
  if(Array.isArray(v))return `<value><array><data>${v.map(xmlValue).join("")}</data></array></value>`;
  if(v&&typeof v==="object"){const m=Object.entries(v).map(([k,val])=>`<member><name>${escapeXml(k)}</name>${xmlValue(val)}</member>`).join("");return `<value><struct>${m}</struct></value>`;}
  return `<value><boolean>0</boolean></value>`;
}
function buildRequest(method,params){return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param>${xmlValue(p)}</param>`).join("")}</params></methodCall>`;}
class Cursor{constructor(s){this.s=s;this.i=0;}
  nextTag(){const lt=this.s.indexOf("<",this.i);if(lt===-1)return null;const gt=this.s.indexOf(">",lt);if(gt===-1)return null;let raw=this.s.slice(lt+1,gt).trim();this.i=gt+1;if(raw.startsWith("?"))return this.nextTag();const closing=raw.startsWith("/");if(closing)raw=raw.slice(1).trim();const selfClose=raw.endsWith("/");if(selfClose)raw=raw.slice(0,-1).trim();return{tag:raw.split(/\s/)[0].toLowerCase(),closing,selfClose};}
  readTextUntilClose(tag){const close=`</${tag}>`;const idx=this.s.toLowerCase().indexOf(close,this.i);const end=idx===-1?this.s.length:idx;const t=this.s.slice(this.i,end);this.i=(idx===-1?this.s.length:idx+close.length);return t;}}
function peekTag(cur){const s=cur.i;const t=cur.nextTag();cur.i=s;return t;}
function seekOpen(cur,tag){for(;;){const t=cur.nextTag();if(!t)return;if(!t.closing&&t.tag===tag)return;}}
function consumeClose(cur,tag){const c=`</${tag}>`;const idx=cur.s.toLowerCase().indexOf(c,cur.i);if(idx!==-1)cur.i=idx+c.length;}
function parseValueBody(cur){
  const save=cur.i;const t=cur.nextTag();if(!t)return "";if(t.closing&&t.tag==="value")return "";
  switch(t.tag){
    case "int":case "i4":{const x=cur.readTextUntilClose(t.tag);consumeClose(cur,"value");return parseInt(x.trim()||"0",10);}
    case "double":{const x=cur.readTextUntilClose("double");consumeClose(cur,"value");return parseFloat(x.trim()||"0");}
    case "boolean":{const x=cur.readTextUntilClose("boolean");consumeClose(cur,"value");return x.trim()==="1";}
    case "string":{const x=cur.readTextUntilClose("string");consumeClose(cur,"value");return unescapeXml(x);}
    case "nil":{if(!t.selfClose)consumeClose(cur,"nil");consumeClose(cur,"value");return null;}
    case "array":{const arr=[];seekOpen(cur,"data");for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="data"){cur.nextTag();break;}if(p.tag==="value"&&!p.closing){cur.nextTag();arr.push(parseValueBody(cur));}else cur.nextTag();}consumeClose(cur,"array");consumeClose(cur,"value");return arr;}
    case "struct":{const obj={};for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="struct"){cur.nextTag();break;}if(p.tag==="member"&&!p.closing){cur.nextTag();seekOpen(cur,"name");const n=cur.readTextUntilClose("name").trim();seekOpen(cur,"value");obj[n]=parseValueBody(cur);consumeClose(cur,"member");}else cur.nextTag();}consumeClose(cur,"value");return obj;}
    default:{cur.i=save;const x=cur.readTextUntilClose("value");return unescapeXml(x.trim());}
  }
}
function parseResponse(xml){if(/<fault>/i.test(xml)){const c=new Cursor(xml);seekOpen(c,"value");throw new Error("Odoo fault: "+JSON.stringify(parseValueBody(c)));}const c=new Cursor(xml);seekOpen(c,"value");return parseValueBody(c);}
async function xmlrpcCall(endpoint,method,params){const res=await fetch(`${ODOO_URL}${endpoint}`,{method:"POST",headers:{"Content-Type":"text/xml"},body:buildRequest(method,params)});return parseResponse(await res.text());}
async function authenticate(){const uid=await xmlrpcCall("/xmlrpc/2/common","authenticate",[ODOO_DB,ODOO_LOGIN,ODOO_KEY,{}]);if(!uid||typeof uid!=="number")throw new Error("Auth fallida");return uid;}
async function execKw(uid,model,method,args,kwargs={}){return await xmlrpcCall("/xmlrpc/2/object","execute_kw",[ODOO_DB,uid,ODOO_KEY,model,method,args,kwargs]);}
function plId(v){return Array.isArray(v)?v[0]:null;}

Deno.serve(async(req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    let body={};try{body=await req.json();}catch{/* */}
    const after=Number(body.after||0);
    const wantIds=body.want_ids===true;
    const uid=await authenticate();

    const ids=await execKw(uid,"res.partner","search",[[["id",">",after]]],{order:"id asc",limit:PAGE,context:CTX_VEL});
    if(!ids.length){
      return new Response(JSON.stringify({ok:true,fin:true,next_after:null}),{headers:cors});
    }

    const velRows=await execKw(uid,"res.partner","read",[ids],{fields:["id","category_id","property_product_pricelist"],context:CTX_VEL});
    const rstRows=await execKw(uid,"res.partner","read",[ids],{fields:["id","property_product_pricelist"],context:CTX_RST});
    const rstPl=Object.fromEntries(rstRows.map(r=>[r.id,plId(r.property_product_pricelist)]));

    let prof=0, ya_ok=0, falta_lista=0, falta_etiqueta=0, falta_ambas=0;
    const idsModificar=[];
    for(const r of velRows){
      const cats=Array.isArray(r.category_id)?r.category_id:[];
      const tieneEtiqueta=cats.includes(CAT_PROF);
      const l2vel=plId(r.property_product_pricelist)===LISTA2;
      const l2rst=rstPl[r.id]===LISTA2;
      const esProfesional=tieneEtiqueta||l2vel||l2rst;
      if(!esProfesional)continue;
      prof++;
      const necesitaEtiqueta=!tieneEtiqueta;
      const necesitaLista=!l2vel;
      if(!necesitaEtiqueta&&!necesitaLista){ya_ok++;continue;}
      if(necesitaEtiqueta&&necesitaLista)falta_ambas++;
      else if(necesitaLista)falta_lista++;
      else falta_etiqueta++;
      if(wantIds)idsModificar.push({id:r.id,e:necesitaEtiqueta?1:0,l:necesitaLista?1:0});
    }

    const next_after=ids[ids.length-1];
    const resp={ok:true,fin:false,pagina_hasta:next_after,ids_en_pagina:ids.length,profesionales_en_pagina:prof,ya_ok,falta_lista,falta_etiqueta,falta_ambas,next_after};
    if(wantIds)resp.ids_modificar=idsModificar;
    return new Response(JSON.stringify(resp),{headers:cors});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String((e&&e.message)||e)}),{headers:cors,status:200});}
});
