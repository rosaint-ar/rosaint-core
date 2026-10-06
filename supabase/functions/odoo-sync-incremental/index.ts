import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ====== odoo-sync-incremental (v2 — PEDIDOS) ======
// Basado en PEDIDOS CONFIRMADOS (sale.order state in sale/done), no facturas.
// Compra = pedido confirmado. Fecha = date_order. Monto = amount_untaxed. Productos = sale.order.line.
// 1) marca ultima_sync 2) Odoo: pedidos confirmados con write_date>=marca -> partner_ids
// 3) recalcula esos 4) recalcular_segmentos() en base 5) actualiza marca.

const ODOO_URL=Deno.env.get("ODOO_URL")!,ODOO_DB=Deno.env.get("ODOO_DB")!,ODOO_LOGIN=Deno.env.get("ODOO_LOGIN")!,ODOO_KEY=Deno.env.get("ODOO_KEY")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!,SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RST=1,VEL=2;// Solo VELAZQUEZ: desde el 27-sep el usuario de Odoo ya no tiene acceso a RST (company 1) y pedirla rompe toda la función
const CTX_BOTH={allowed_company_ids:[VEL]};const HOY=new Date();const ESTADOS=["sale","done"];
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
function pidf(v){return Array.isArray(v)?v[0]:null;}function pname(v){return Array.isArray(v)?v[1]:null;}
function esDescuento(n){if(!n)return false;const x=n.toLowerCase();return x.includes("desc.")||x.includes("descuento")||x.includes("bonif");}
function median(arr){if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function daysBetween(a,b){return Math.round((a.getTime()-b.getTime())/86400000);}
function soloFecha(dt){return dt?(""+dt).slice(0,10):null;}
function normWa(tel){if(!tel)return null;let d=(""+tel).replace(/[^0-9]/g,"");if(!d)return null;if(d.startsWith("54"))d=d.slice(2);if(d.startsWith("0"))d=d.slice(1);if(d.length<10)return null;let local=d;if(local.startsWith("9"))local=local.slice(1);local=local.replace(/^(\d{2,4})15(\d{6,8})$/,"$1$2");if(local.length<10)return null;return "549"+local;}
function segmentar(dias,intervalo,nF){if(nF===0||dias==null)return "nunca_compro";let ref=(intervalo&&intervalo>0)?intervalo:null;if(ref){const r=dias/ref;if(r<1)return "activo";if(r<2)return "enfriandose";if(r<4)return "a_reactivar";return "dormido";}else{if(dias<60)return "activo";if(dias<120)return "enfriandose";if(dias<240)return "a_reactivar";return "dormido";}}

async function recalcCliente(db,uid,pid,nombre){
  const cont=await execKw(uid,"res.partner","read",[[pid]],{fields:["name","phone","mobile"],context:CTX_BOTH});
  const tel=cont[0]?.mobile||cont[0]?.phone||null; const nom=nombre||cont[0]?.name||('Contacto '+pid);
  // PEDIDOS CONFIRMADOS del cliente
  const ords=await execKw(uid,"sale.order","search_read",[[["state","in",ESTADOS],["partner_id","=",pid]]],{fields:["name","date_order","company_id","amount_untaxed"],order:"date_order asc",context:CTX_BOTH});
  let fR=0,fV=0,total=0;const fechas=[];let ultId=null,ultName=null,ultFecha=null;
  for(const o of ords){const ci=pidf(o.company_id);if(ci===RST)fR++;else if(ci===VEL)fV++;total+=(o.amount_untaxed||0);const f=soloFecha(o.date_order);if(f){fechas.push(f);if(!ultFecha||f>=ultFecha){ultFecha=f;ultId=o.id;ultName=o.name;}}}
  const nF=ords.length;let primera=null,ultima=null,dias=null,inter=null;
  if(fechas.length){const fo=[...fechas].sort();primera=fo[0];ultima=fo[fo.length-1];dias=daysBetween(HOY,new Date(ultima));if(fo.length>1){const gaps=[];for(let i=1;i<fo.length;i++)gaps.push(daysBetween(new Date(fo[i]),new Date(fo[i-1])));inter=median(gaps);}}
  const ticket=nF?total/nF:0;const seg=segmentar(dias,inter,nF);const wa=normWa(tel);
  await db.from("cliente_metricas").update({nombre:nom,telefono:tel,telefono_wa:wa,primera_compra:primera,ultima_compra:ultima,dias_desde_ultima:dias,total_facturas:nF,facturas_rst:fR,facturas_vel:fV,total_gastado:total,ticket_promedio:ticket,intervalo_tipico_dias:inter,score_reactivacion:(inter&&dias!=null)?dias/inter:null,segmento:seg,ultimo_pedido_id:(ultId||-1),ultimo_pedido_name:ultName,sincronizado_at:new Date().toISOString()}).eq("partner_id",pid);
  // PRODUCTOS desde lineas de pedido confirmado
  if(nF>0){
    const dom=[["order_id.state","in",ESTADOS],["order_partner_id","=",pid],["product_id","!=",false]];
    const grupos=await execKw(uid,"sale.order.line","read_group",[dom,["product_uom_qty:sum","price_subtotal:sum"],["product_id"]],{lazy:false,context:CTX_BOTH});
    const filas=[];const ids=[];
    for(const g of grupos){const pp=pidf(g.product_id);const pn=pname(g.product_id);if(!pp||esDescuento(pn))continue;ids.push(pp);filas.push({partner_id:pid,product_id:pp,product_name:pn,veces_comprado:g.__count||0,cantidad_total:g.product_uom_qty||0,monto_total:g.price_subtotal||0,ultima_compra:null});}
    if(filas.length){await db.from("cliente_producto").upsert(filas,{onConflict:"partner_id,product_id"});await db.from("cliente_producto").delete().eq("partner_id",pid).not("product_id","in",`(${ids.join(",")})`);}
    else { await db.from("cliente_producto").delete().eq("partner_id",pid); }
  }
}

Deno.serve(async(req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const db=createClient(SUPABASE_URL,SERVICE_KEY);
  let body={};try{body=await req.json();}catch{/* */}
  try{
    let desde=body.desde;
    if(!desde){ const {data}=await db.from("odoo_crm_run").select("mensaje").eq("run_tag","sync_incremental").eq("fase","marca").single(); desde=data?.mensaje||"2026-06-01 00:00:00"; }
    const ahora=new Date().toISOString().replace('T',' ').slice(0,19);
    const uid=await authO();
    const margen=new Date(new Date(desde+'Z').getTime()-24*3600*1000).toISOString().replace('T',' ').slice(0,19);
    // PEDIDOS confirmados creados/modificados desde la marca
    const ords=await execKw(uid,"sale.order","search_read",[[["state","in",ESTADOS],["write_date",">=",margen]]],{fields:["partner_id"],context:CTX_BOTH});
    const pids=[...new Set((ords||[]).map(m=>pidf(m.partner_id)).filter(x=>x&&x!==15))];
    let recalculados=0;
    if(pids.length){
      const {data:prof}=await db.from("cliente_metricas").select("partner_id,nombre").eq("es_profesional",true).in("partner_id",pids);
      const mapaNom=new Map();(prof||[]).forEach(p=>mapaNom.set(p.partner_id,p.nombre));
      for(const pid of (prof||[]).map(p=>p.partner_id)){ await recalcCliente(db,uid,pid,mapaNom.get(pid)); recalculados++; }
    }
    await db.rpc('recalcular_segmentos');
    await db.from("odoo_crm_run").update({mensaje:ahora,updated_at:new Date().toISOString()}).eq("run_tag","sync_incremental").eq("fase","marca");
    return new Response(JSON.stringify({ok:true,pedidos_movidos:(ords||[]).length,clientes_recalculados:recalculados,desde,hasta:ahora}),{headers:cors});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String((e&&e.message)||e)}),{headers:cors});}
});
