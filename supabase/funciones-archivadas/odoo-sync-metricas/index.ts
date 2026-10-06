import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ====== odoo-sync-metricas (v2) ======
// FIX: en este Odoo las lineas de producto tienen display_type='product' (no false).
// Filtro correcto: product_id != false (excluye tax/payment_term que tienen product_id false).
// Excluye de la tabla de PRODUCTOS las lineas de descuento (nombre con 'Desc.' o subtotal<0),
// pero esas SI cuentan en total_gastado (se toma de amount_untaxed de la factura, no de lineas).

const ODOO_URL=Deno.env.get("ODOO_URL")!,ODOO_DB=Deno.env.get("ODOO_DB")!,ODOO_LOGIN=Deno.env.get("ODOO_LOGIN")!,ODOO_KEY=Deno.env.get("ODOO_KEY")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!,SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF_URL=`${SUPABASE_URL}/functions/v1/odoo-sync-metricas`;
const RST=1,VEL=2;const CTX_BOTH={allowed_company_ids:[VEL,RST]};const BATCH=15;const HOY=new Date();

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
function pid(v){return Array.isArray(v)?v[0]:null;}function pname(v){return Array.isArray(v)?v[1]:null;}
function normWa(tel){if(!tel)return null;let d=(""+tel).replace(/[^0-9]/g,"");if(!d)return null;if(d.startsWith("54"))d=d.slice(2);if(d.startsWith("0"))d=d.slice(1);if(d.length<10)return null;let local=d;if(local.startsWith("9"))local=local.slice(1);local=local.replace(/^(\d{2,4})15(\d{6,8})$/,"$1$2");if(local.length<10)return null;return "549"+local;}
function median(arr){if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function daysBetween(a,b){return Math.round((a.getTime()-b.getTime())/86400000);}
function esDescuento(nombre){if(!nombre)return false;const n=nombre.toLowerCase();return n.includes("desc.")||n.includes("descuento")||n.includes("bonif");}
function segmentar(diasDesde,intervalo,totalFacturas){if(totalFacturas===0||diasDesde==null)return "nunca_compro";let ref=intervalo;if(!ref||ref<=0)ref=null;if(ref){const r=diasDesde/ref;if(r<1)return "activo";if(r<2)return "enfriandose";if(r<4)return "a_reactivar";return "dormido";}else{if(diasDesde<60)return "activo";if(diasDesde<120)return "enfriandose";if(diasDesde<240)return "a_reactivar";return "dormido";}}

Deno.serve(async(req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const db=createClient(SUPABASE_URL,SERVICE_KEY);
  let body={};try{body=await req.json();}catch{/* */}
  const after=Number(body.after||0);const tag="sync_metricas",fase="sync";
  try{
    if(after===0){
      await db.from("cliente_producto").delete().neq("partner_id",-1);
      await db.from("odoo_crm_run").upsert({run_tag:tag,fase,estado:"en_proceso",cursor_after:0,profesionales_total:0,mensaje:"sincronizando metricas v2",updated_at:new Date().toISOString()},{onConflict:"run_tag,fase"});
    }else{
      const {data:cur}=await db.from("odoo_crm_run").select("cursor_after,estado").eq("run_tag",tag).eq("fase",fase).single();
      if(!cur||cur.estado!=="en_proceso"||Number(cur.cursor_after)!==after)return new Response(JSON.stringify({ok:true,descartado:true}),{headers:cors});
    }
    const {data:lote}=await db.from("odoo_crm_contacto").select("partner_id,nombre,vat,email").gt("partner_id",after).order("partner_id",{ascending:true}).limit(BATCH);
    const uid=await authO();
    if(lote&&lote.length){
      for(const c of lote){
        const pidv=c.partner_id;
        const cont=await execKw(uid,"res.partner","read",[[pidv]],{fields:["phone","mobile"],context:CTX_BOTH});
        const tel=cont[0]?.mobile||cont[0]?.phone||null;
        const facs=await execKw(uid,"account.move","search_read",[[["move_type","=","out_invoice"],["state","=","posted"],["partner_id","=",pidv]]],{fields:["id","invoice_date","company_id","amount_untaxed"],order:"invoice_date asc",context:CTX_BOTH});
        let fRst=0,fVel=0,total=0;const fechas=[];
        for(const f of facs){const ci=pid(f.company_id);if(ci===RST)fRst++;else if(ci===VEL)fVel++;total+=(f.amount_untaxed||0);if(f.invoice_date)fechas.push(f.invoice_date);}
        const nF=facs.length;let primera=null,ultima=null,dias=null,inter=null;
        if(fechas.length){primera=fechas[0];ultima=fechas[fechas.length-1];dias=daysBetween(HOY,new Date(ultima));if(fechas.length>1){const gaps=[];for(let i=1;i<fechas.length;i++)gaps.push(daysBetween(new Date(fechas[i]),new Date(fechas[i-1])));inter=median(gaps);}}
        const ticket=nF?total/nF:0;const seg=segmentar(dias,inter,nF);const wa=normWa(tel);
        await db.from("cliente_metricas").upsert({partner_id:pidv,nombre:c.nombre,vat:c.vat,email:c.email,telefono:tel,telefono_wa:wa,primera_compra:primera,ultima_compra:ultima,dias_desde_ultima:dias,total_facturas:nF,facturas_rst:fRst,facturas_vel:fVel,total_gastado:total,ticket_promedio:ticket,intervalo_tipico_dias:inter,score_reactivacion:(inter&&dias!=null)?dias/inter:null,segmento:seg,sincronizado_at:new Date().toISOString()},{onConflict:"partner_id"});
        if(nF){
          const fids=facs.map(f=>f.id);
          // FIX: filtrar por product_id != false (saca tax/payment_term). Leer en sub-tandas de facturas para no agotar memoria.
          const prodMap={};
          for(let i=0;i<fids.length;i+=30){
            const sub=fids.slice(i,i+30);
            const lineas=await execKw(uid,"account.move.line","search_read",[[["move_id","in",sub],["product_id","!=",false]]],{fields:["product_id","quantity","price_subtotal","date"],context:CTX_BOTH});
            for(const l of lineas){const pp=pid(l.product_id);const pn=pname(l.product_id);if(!pp)continue;if(esDescuento(pn))continue;
              if(!prodMap[pp])prodMap[pp]={product_id:pp,product_name:pn,veces:0,cant:0,monto:0,ult:null};
              const p=prodMap[pp];p.veces++;p.cant+=(l.quantity||0);p.monto+=(l.price_subtotal||0);if(l.date&&(!p.ult||l.date>p.ult))p.ult=l.date;}
          }
          const filas=Object.values(prodMap).map(p=>({partner_id:pidv,product_id:p.product_id,product_name:p.product_name,veces_comprado:p.veces,cantidad_total:p.cant,monto_total:p.monto,ultima_compra:p.ult}));
          if(filas.length)await db.from("cliente_producto").upsert(filas,{onConflict:"partner_id,product_id"});
        }
      }
      const {data:cur}=await db.from("odoo_crm_run").select("profesionales_total").eq("run_tag",tag).eq("fase",fase).single();
      const next=lote[lote.length-1].partner_id;
      await db.from("odoo_crm_run").update({cursor_after:next,profesionales_total:(cur?.profesionales_total||0)+lote.length,mensaje:`procesando, ultimo ${next}`,updated_at:new Date().toISOString()}).eq("run_tag",tag).eq("fase",fase);
      fetch(SELF_URL,{method:"POST",headers:{"Authorization":`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({after:next})}).catch(()=>{});
      return new Response(JSON.stringify({ok:true,continua:true,hasta:next}),{headers:cors});
    }else{
      await db.from("odoo_crm_run").update({estado:"completado",mensaje:"sync completa",updated_at:new Date().toISOString()}).eq("run_tag",tag).eq("fase",fase);
      return new Response(JSON.stringify({ok:true,fin:true}),{headers:cors});
    }
  }catch(e){
    await db.from("odoo_crm_run").update({estado:"error",mensaje:String((e&&e.message)||e),updated_at:new Date().toISOString()}).eq("run_tag",tag).eq("fase",fase);
    return new Response(JSON.stringify({ok:false,error:String((e&&e.message)||e)}),{headers:cors,status:200});
  }
});
