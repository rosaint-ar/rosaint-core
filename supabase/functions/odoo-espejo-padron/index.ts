import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ====== odoo-espejo-padron (v2) ======
// Padron de profesionales = contactos ACTIVOS con etiqueta 'Profesional' (id 1).
// (La etiqueta es la fuente de verdad; en Fase 1 se la pusimos a todos los profesionales.)
// Da de alta nuevos, de baja los que perdieron la etiqueta. Idempotente.

const ODOO_URL=Deno.env.get("ODOO_URL")!,ODOO_DB=Deno.env.get("ODOO_DB")!,ODOO_LOGIN=Deno.env.get("ODOO_LOGIN")!,ODOO_KEY=Deno.env.get("ODOO_KEY")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!,SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RST=1,VEL=2;// Solo VELAZQUEZ: desde el 27-sep el usuario de Odoo ya no tiene acceso a RST (company 1) y pedirla rompe toda la función
const CTX_BOTH={allowed_company_ids:[VEL]};const TAG_PROF=1;
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


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  // conectores (Claude / MCP) con su clave propia de Tienda Nube o Mercado Libre
  const proxy = req.headers.get("x-proxy-secret") || "";
  if (proxy && [Deno.env.get("TN_PROXY_SECRET"), Deno.env.get("ML_PROXY_SECRET")].some((x) => x && x === proxy)) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (srk && a.slice(7) === srk) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}
function _servirConGuardia(...args: any[]) {
  const h = args[args.length - 1];
  args[args.length - 1] = async (req: Request, info: any) => {
    if (req.method === "OPTIONS" || await _accesoPermitido(req)) return h(req, info);
    return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), {
      status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  };
  return (Deno.serve as any)(...args);
}

_servirConGuardia(async(req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const db=createClient(SUPABASE_URL,SERVICE_KEY);
  try{
    const uid=await authO();
    // PADRON = contactos activos con etiqueta Profesional (filtro confiable). Excluir empresa propia (15).
    const porTag=await execKw(uid,"res.partner","search",[[["category_id","in",[TAG_PROF]],["active","=",true]]],{context:CTX_BOTH});
    const setProf=new Set(porTag||[]);setProf.delete(15);
    if(setProf.size<50) throw new Error('padron sospechosamente chico ('+setProf.size+'), abortando por seguridad');
    const padron=[...setProf];

    const {data:actuales}=await db.from("cliente_metricas").select("partner_id,es_profesional").limit(5000);
    const mapaActual=new Map();(actuales||[]).forEach(r=>mapaActual.set(r.partner_id,r.es_profesional));

    const nuevos=[],reactivar=[];
    for(const pid of padron){ if(!mapaActual.has(pid))nuevos.push(pid); else if(mapaActual.get(pid)===false)reactivar.push(pid); }
    const bajas=[];
    for(const [pid,esProf] of mapaActual){ if(esProf===true && !setProf.has(pid) && pid!==15) bajas.push(pid); }

    if(bajas.length){for(let i=0;i<bajas.length;i+=100){await db.from("cliente_metricas").update({es_profesional:false,verificado_at:new Date().toISOString()}).in("partner_id",bajas.slice(i,i+100));}}
    if(reactivar.length){for(let i=0;i<reactivar.length;i+=100){await db.from("cliente_metricas").update({es_profesional:true,verificado_at:new Date().toISOString()}).in("partner_id",reactivar.slice(i,i+100));}}
    let nuevosOk=0;
    if(nuevos.length){
      for(let i=0;i<nuevos.length;i+=50){
        const sub=nuevos.slice(i,i+50);
        const datos=await execKw(uid,"res.partner","read",[sub],{fields:["name","vat","email","phone","mobile"],context:CTX_BOTH});
        const filas=(datos||[]).map(d=>({partner_id:d.id,nombre:d.name||('Contacto '+d.id),vat:d.vat||null,email:d.email||null,telefono:d.mobile||d.phone||null,es_profesional:true,total_facturas:0,facturas_rst:0,facturas_vel:0,total_gastado:0,segmento:'nunca_compro',verificado_at:new Date().toISOString()}));
        if(filas.length){const {error}=await db.from("cliente_metricas").upsert(filas,{onConflict:"partner_id"});if(!error)nuevosOk+=filas.length;}
        // tambien agregarlos a odoo_crm_contacto para que el sync de detalle los recorra
        const filasBase=(datos||[]).map(d=>({partner_id:d.id,nombre:d.name||('Contacto '+d.id),vat:d.vat||null,email:d.email||null}));
        if(filasBase.length){await db.from("odoo_crm_contacto").upsert(filasBase,{onConflict:"partner_id"});}
      }
    }
    return new Response(JSON.stringify({ok:true,padron_odoo:padron.length,altas_nuevas:nuevos.length,altas_ok:nuevosOk,reactivados:reactivar.length,bajas:bajas.length}),{headers:cors});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String((e&&e.message)||e)}),{headers:cors});}
});
