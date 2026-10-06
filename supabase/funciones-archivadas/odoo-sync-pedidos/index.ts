import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// captura el ultimo sale.order de cada cliente con compras -> cliente_metricas.ultimo_pedido_id/name
const ODOO_URL=Deno.env.get("ODOO_URL")!,ODOO_DB=Deno.env.get("ODOO_DB")!,ODOO_LOGIN=Deno.env.get("ODOO_LOGIN")!,ODOO_KEY=Deno.env.get("ODOO_KEY")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!,SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RST=1,VEL=2;const CTX_BOTH={allowed_company_ids:[VEL,RST]};
function escapeXml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function unescapeXml(s){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");}
function xmlValue(v){if(typeof v==="number")return Number.isInteger(v)?`<value><int>${v}</int></value>`:`<value><double>${v}</double></value>`;if(typeof v==="boolean")return `<value><boolean>${v?1:0}</boolean></value>`;if(typeof v==="string")return `<value><string>${escapeXml(v)}</string></value>`;if(Array.isArray(v))return `<value><array><data>${v.map(xmlValue).join("")}</data></array></value>`;if(v&&typeof v==="object"){const m=Object.entries(v).map(([k,val])=>`<member><name>${escapeXml(k)}</name>${xmlValue(val)}</member>`).join("");return `<value><struct>${m}</struct></value>`;}return `<value><boolean>0</boolean></value>`;}
function buildRequest(method,params){return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param>${xmlValue(p)}</param>`).join("")}</params></methodCall>`;}
class Cur{constructor(s){this.s=s;this.i=0;}nextTag(){const lt=this.s.indexOf("<",this.i);if(lt===-1)return null;const gt=this.s.indexOf(">",lt);if(gt===-1)return null;let raw=this.s.slice(lt+1,gt).trim();this.i=gt+1;if(raw.startsWith("?"))return this.nextTag();const closing=raw.startsWith("/");if(closing)raw=raw.slice(1).trim();const selfClose=raw.endsWith("/");if(selfClose)raw=raw.slice(0,-1).trim();return{tag:raw.split(/\s/)[0].toLowerCase(),closing,selfClose};}readTextUntilClose(tag){const close=`</${tag}>`;const idx=this.s.toLowerCase().indexOf(close,this.i);const end=idx===-1?this.s.length:idx;const t=this.s.slice(this.i,end);this.i=(idx===-1?this.s.length:idx+close.length);return t;}}
function peekTag(c){const s=c.i;const t=c.nextTag();c.i=s;return t;}function seekOpen(c,tag){for(;;){const t=c.nextTag();if(!t)return;if(!t.closing&&t.tag===tag)return;}}function consumeClose(c,tag){const cl=`</${tag}>`;const idx=c.s.toLowerCase().indexOf(cl,c.i);if(idx!==-1)c.i=idx+cl.length;}
function parseValueBody(c){const save=c.i;const t=c.nextTag();if(!t)return "";if(t.closing&&t.tag==="value")return "";switch(t.tag){case "int":case "i4":{const x=c.readTextUntilClose(t.tag);consumeClose(c,"value");return parseInt(x.trim()||"0",10);}case "double":{const x=c.readTextUntilClose("double");consumeClose(c,"value");return parseFloat(x.trim()||"0");}case "boolean":{const x=c.readTextUntilClose("boolean");consumeClose(c,"value");return x.trim()==="1";}case "string":{const x=c.readTextUntilClose("string");consumeClose(c,"value");return unescapeXml(x);}case "nil":{if(!t.selfClose)consumeClose(c,"nil");consumeClose(c,"value");return null;}case "array":{const arr=[];seekOpen(c,"data");for(;;){const p=peekTag(c);if(!p)break;if(p.closing&&p.tag==="data"){c.nextTag();break;}if(p.tag==="value"&&!p.closing){c.nextTag();arr.push(parseValueBody(c));}else c.nextTag();}consumeClose(c,"array");consumeClose(c,"value");return arr;}case "struct":{const obj={};for(;;){const p=peekTag(c);if(!p)break;if(p.closing&&p.tag==="struct"){c.nextTag();break;}if(p.tag==="member"&&!p.closing){c.nextTag();seekOpen(c,"name");const n=c.readTextUntilClose("name").trim();seekOpen(c,"value");obj[n]=parseValueBody(c);consumeClose(c,"member");}else c.nextTag();}consumeClose(c,"value");return obj;}default:{c.i=save;const x=c.readTextUntilClose("value");return unescapeXml(x.trim());}}}
function parseResponse(xml){if(/<fault>/i.test(xml)){const c=new Cur(xml);seekOpen(c,"value");throw new Error("Odoo fault: "+JSON.stringify(parseValueBody(c)));}const c=new Cur(xml);seekOpen(c,"value");return parseValueBody(c);}
async function rpc(endpoint,method,params){const r=await fetch(`${ODOO_URL}${endpoint}`,{method:"POST",headers:{"Content-Type":"text/xml"},body:buildRequest(method,params)});return parseResponse(await r.text());}
async function authO(){const uid=await rpc("/xmlrpc/2/common","authenticate",[ODOO_DB,ODOO_LOGIN,ODOO_KEY,{}]);if(!uid)throw new Error("Auth fallida");return uid;}
async function execKw(uid,model,method,args,kwargs={}){return await rpc("/xmlrpc/2/object","execute_kw",[ODOO_DB,uid,ODOO_KEY,model,method,args,kwargs]);}

Deno.serve(async(req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const db=createClient(SUPABASE_URL,SERVICE_KEY);
  let body={};try{body=await req.json();}catch{/* */}
  const limite=Number(body.limite||40);
  try{
    const {data:lista,error}=await db.rpc('pendientes_pedido',{lim:limite});
    if(error)throw new Error('rpc: '+error.message);
    if(!lista||!lista.length)return new Response(JSON.stringify({ok:true,fin:true,procesados:0}),{headers:cors});
    const uid=await authO();
    let ok=0;
    for(const row of lista){
      const pid=row.partner_id;
      const so=await execKw(uid,"sale.order","search_read",[[["partner_id","=",pid]]],{fields:["id","name"],limit:1,order:"date_order desc",context:CTX_BOTH});
      if(Array.isArray(so)&&so.length){await db.from("cliente_metricas").update({ultimo_pedido_id:so[0].id,ultimo_pedido_name:so[0].name}).eq("partner_id",pid);ok++;}
      else{await db.from("cliente_metricas").update({ultimo_pedido_id:-1,ultimo_pedido_name:null}).eq("partner_id",pid);} // -1 = sin pedido (factura directa), no reintentar
    }
    return new Response(JSON.stringify({ok:true,procesados:lista.length,con_pedido:ok}),{headers:cors});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String((e&&e.message)||e)}),{headers:cors});}
});
