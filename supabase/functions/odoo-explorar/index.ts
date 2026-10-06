import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-explorar (v27) ======
// v27: control de aplicacion en aplicar_percepciones.
// - Devuelve "no_aplicadas": percepciones que no encontraron su linea de impuesto
//   (pasa cuando el account.tax calcula 0 y Odoo no genera la linea).
// - Acepta "total_esperado" (total del comprobante) y devuelve diferencia / cuadra.
// - "problemas": lista de textos para que el frontend avise en rojo. Antes fallaba en silencio.
// v26: soporte multi-linea en aplicar_percepciones.

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;

function escapeXml(s: string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function unescapeXml(s: string){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");}
function xmlValue(v: unknown): string {
  if(typeof v==="number")return Number.isInteger(v)?`<value><int>${v}</int></value>`:`<value><double>${v}</double></value>`;
  if(typeof v==="boolean")return `<value><boolean>${v?1:0}</boolean></value>`;
  if(typeof v==="string")return `<value><string>${escapeXml(v)}</string></value>`;
  if(Array.isArray(v))return `<value><array><data>${v.map(xmlValue).join("")}</data></array></value>`;
  if(v&&typeof v==="object"){const m=Object.entries(v as Record<string,unknown>).map(([k,val])=>`<member><name>${escapeXml(k)}</name>${xmlValue(val)}</member>`).join("");return `<value><struct>${m}</struct></value>`;}
  return `<value><boolean>0</boolean></value>`;
}
function buildRequest(method:string,params:unknown[]){return `<?xml version=\"1.0\"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param>${xmlValue(p)}</param>`).join("")}</params></methodCall>`;}
class Cursor{s:string;i:number;constructor(s:string){this.s=s;this.i=0;}
  nextTag(){const lt=this.s.indexOf("<",this.i);if(lt===-1)return null;const gt=this.s.indexOf(">",lt);if(gt===-1)return null;let raw=this.s.slice(lt+1,gt).trim();this.i=gt+1;if(raw.startsWith("?"))return this.nextTag();const closing=raw.startsWith("/");if(closing)raw=raw.slice(1).trim();const selfClose=raw.endsWith("/");if(selfClose)raw=raw.slice(0,-1).trim();return{tag:raw.split(/\s/)[0].toLowerCase(),closing,selfClose};}
  readTextUntilClose(tag:string){const close=`</${tag}>`;const idx=this.s.toLowerCase().indexOf(close,this.i);const end=idx===-1?this.s.length:idx;const t=this.s.slice(this.i,end);this.i=(idx===-1?this.s.length:idx+close.length);return t;}}
function peekTag(cur:Cursor){const s=cur.i;const t=cur.nextTag();cur.i=s;return t;}
function seekOpen(cur:Cursor,tag:string){for(;;){const t=cur.nextTag();if(!t)return;if(!t.closing&&t.tag===tag)return;}}
function consumeClose(cur:Cursor,tag:string){const c=`</${tag}>`;const idx=cur.s.toLowerCase().indexOf(c,cur.i);if(idx!==-1)cur.i=idx+c.length;}
function parseValueBody(cur:Cursor): unknown {
  const save=cur.i;const t=cur.nextTag();if(!t)return "";if(t.closing&&t.tag==="value")return "";
  switch(t.tag){
    case "int":case "i4":{const x=cur.readTextUntilClose(t.tag);consumeClose(cur,"value");return parseInt(x.trim()||"0",10);}
    case "double":{const x=cur.readTextUntilClose("double");consumeClose(cur,"value");return parseFloat(x.trim()||"0");}
    case "boolean":{const x=cur.readTextUntilClose("boolean");consumeClose(cur,"value");return x.trim()==="1";}
    case "string":{const x=cur.readTextUntilClose("string");consumeClose(cur,"value");return unescapeXml(x);}
    case "nil":{if(!t.selfClose)consumeClose(cur,"nil");consumeClose(cur,"value");return null;}
    case "array":{const arr:unknown[]=[];seekOpen(cur,"data");for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="data"){cur.nextTag();break;}if(p.tag==="value"&&!p.closing){cur.nextTag();arr.push(parseValueBody(cur));}else cur.nextTag();}consumeClose(cur,"array");consumeClose(cur,"value");return arr;}
    case "struct":{const obj:Record<string,unknown>={};for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="struct"){cur.nextTag();break;}if(p.tag==="member"&&!p.closing){cur.nextTag();seekOpen(cur,"name");const n=cur.readTextUntilClose("name").trim();seekOpen(cur,"value");obj[n]=parseValueBody(cur);consumeClose(cur,"member");}else cur.nextTag();}consumeClose(cur,"value");return obj;}
    default:{cur.i=save;const x=cur.readTextUntilClose("value");return unescapeXml(x.trim());}
  }
}
function parseResponse(xml:string){if(/<fault>/i.test(xml)){const c=new Cursor(xml);seekOpen(c,"value");throw new Error("Odoo fault: "+JSON.stringify(parseValueBody(c)));}const c=new Cursor(xml);seekOpen(c,"value");return parseValueBody(c);}
async function xmlrpcCall(endpoint:string,method:string,params:unknown[]){const res=await fetch(`${ODOO_URL}${endpoint}`,{method:"POST",headers:{"Content-Type":"text/xml"},body:buildRequest(method,params)});return parseResponse(await res.text());}
async function authenticate(){const uid=await xmlrpcCall("/xmlrpc/2/common","authenticate",[ODOO_DB,ODOO_LOGIN,ODOO_KEY,{}]);if(!uid||typeof uid!=="number")throw new Error("Auth fallida");return uid as number;}
async function execKw(uid:number,model:string,method:string,args:unknown[],kwargs:Record<string,unknown>={}){return await xmlrpcCall("/xmlrpc/2/object","execute_kw",[ODOO_DB,uid,ODOO_KEY,model,method,args,kwargs]);}

function monthRange(periodo:string){const [y,m]=periodo.split("-").map(Number);const desde=`${y}-${String(m).padStart(2,"0")}-01`;const ld=new Date(y,m,0).getDate();return{desde,hasta:`${y}-${String(m).padStart(2,"0")}-${String(ld).padStart(2,"0")}`};}
function esGrupoIVAReal(nombreGrupo:string){const n=(nombreGrupo||'').toUpperCase();return /^VAT \d/.test(n)||/^IVA \d/.test(n);}

async function conciliarPeriodo(uid:number,periodo:string){
  const {desde,hasta}=monthRange(periodo);
  const moves=await execKw(uid,"account.move","search_read",[[["move_type","in",["in_invoice","in_refund"]],["company_id","=",COMPANY_ID],["state","=","posted"],["date",">=",desde],["date","<=",hasta]]],{fields:["id","name","move_type","partner_id","invoice_date","date","amount_untaxed","amount_tax","amount_total","amount_untaxed_signed","amount_tax_signed","amount_total_signed","currency_id","company_currency_id","l10n_latam_document_number","l10n_latam_document_type_id"],order:"date asc"}) as Array<Record<string,unknown>>;
  const moveIds=moves.map(m=>m.id as number);
  const pids=[...new Set(moves.map(m=>Array.isArray(m.partner_id)?(m.partner_id as unknown[])[0] as number:null).filter((x):x is number=>x!==null))];
  let pmap:Record<number,string>={};
  if(pids.length){const ps=await execKw(uid,"res.partner","read",[pids],{fields:["id","vat"]}) as Array<Record<string,unknown>>;pmap=Object.fromEntries(ps.map(p=>[p.id as number,(p.vat as string)||""]));}
  const ivaPorMove:Record<number,number>={}, percPorMove:Record<number,number>={};
  if(moveIds.length){
    const taxLines=await execKw(uid,"account.move.line","search_read",[[["move_id","in",moveIds],["display_type","=","tax"]]],{fields:["move_id","balance","tax_group_id"]}) as Array<Record<string,unknown>>;
    for(const l of taxLines){
      const mid=Array.isArray(l.move_id)?(l.move_id as unknown[])[0] as number:null; if(mid===null)continue;
      const gname=Array.isArray(l.tax_group_id)?(l.tax_group_id as unknown[])[1] as string:"";
      const bal=Math.abs((l.balance as number)||0);
      if(esGrupoIVAReal(gname)) ivaPorMove[mid]=(ivaPorMove[mid]||0)+bal;
      else percPorMove[mid]=(percPorMove[mid]||0)+bal;
    }
  }
  const facturas=moves.map(m=>{
    const id=m.id as number;
    const pid=Array.isArray(m.partner_id)?(m.partner_id as unknown[])[0] as number:null;
    const dt=Array.isArray(m.l10n_latam_document_type_id)?m.l10n_latam_document_type_id as [number,string]:[null,""];
    const esNC=m.move_type==="in_refund";const signo=esNC?-1:1;
    const curId=Array.isArray(m.currency_id)?(m.currency_id as unknown[])[0] as number:null;
    const compCurId=Array.isArray(m.company_currency_id)?(m.company_currency_id as unknown[])[0] as number:null;
    const monedaExtranjera = curId!==null && compCurId!==null && curId!==compCurId;
    const neto = monedaExtranjera ? Math.abs((m.amount_untaxed_signed as number)||0) : (m.amount_untaxed as number);
    const total = monedaExtranjera ? Math.abs((m.amount_total_signed as number)||0) : (m.amount_total as number);
    const ivaReal=(ivaPorMove[id]||0); const perc=(percPorMove[id]||0);
    return{id,proveedor:Array.isArray(m.partner_id)?(m.partner_id as unknown[])[1]:"",cuit:String(pid!==null?(pmap[pid]||""):"").replace(/\D/g,""),comprobante:m.l10n_latam_document_number||"",tipo_doc_codigo:dt[0],tipo_doc_nombre:dt[1],es_nc:esNC,moneda_extranjera:monedaExtranjera,fecha_factura:m.invoice_date,fecha_contable:m.date,neto:neto*signo,iva:ivaReal*signo,percepciones:perc*signo,total:total*signo};
  });
  return{periodo,desde,hasta,company_id:COMPANY_ID,cantidad:facturas.length,facturas};
}
async function relevarPieza(uid:number,que:string){
  if(que==="grupos")return{que,data:await execKw(uid,"account.tax.group","search_read",[[]],{fields:["id","name"]})};
  return{que:"impuestos",data:await execKw(uid,"account.tax","search_read",[[["company_id","=",COMPANY_ID],["type_tax_use","=","purchase"]]],{fields:["id","name","amount","amount_type","tax_group_id","active"]})};
}
async function leerLineasTax(uid:number,moveId:number){
  const cab=await execKw(uid,"account.move","read",[[moveId]],{fields:["id","state","amount_untaxed","amount_tax","amount_total"]}) as Array<Record<string,unknown>>;
  const tl=await execKw(uid,"account.move.line","search_read",[[["move_id","=",moveId],["display_type","=","tax"]]],{fields:["id","name","balance","tax_line_id"]});
  return{cabecera:cab[0],lineas_tax:tl};
}

async function leerBorrador(uid:number,moveId:number){
  const cab=await execKw(uid,"account.move","read",[[moveId]],{fields:["id","name","state","l10n_latam_document_number","invoice_line_ids","amount_untaxed","amount_tax","amount_total"]}) as Array<Record<string,unknown>>;
  if(!cab[0]) throw new Error("Borrador no encontrado");
  const invLineIds=(cab[0]?.invoice_line_ids as number[])||[];
  const invLines=await execKw(uid,"account.move.line","read",[invLineIds],{fields:["id","name","display_type","product_id","account_id","tax_ids","price_unit","quantity","price_subtotal"]}) as Array<Record<string,unknown>>;
  const gastos=invLines.filter(l=>l.display_type==="product").map(l=>({
    id: l.id,
    nombre: l.name,
    producto: Array.isArray(l.product_id) ? (l.product_id as unknown[])[1] : "",
    cuenta: Array.isArray(l.account_id) ? (l.account_id as unknown[])[1] : "",
    price_unit: Number(l.price_unit ?? 0),
    quantity: Number(l.quantity ?? 1),
    price_subtotal: Number(l.price_subtotal ?? 0),
  }));
  return { cabecera: cab[0], lineas_gasto: gastos };
}

async function idsIVA(uid:number):Promise<Set<number>>{
  const taxes=await execKw(uid,"account.tax","search_read",[[["company_id","=",COMPANY_ID],["type_tax_use","=","purchase"]]],{fields:["id","tax_group_id"]}) as Array<Record<string,unknown>>;
  const set=new Set<number>();
  for(const t of taxes){const g=Array.isArray(t.tax_group_id)?(t.tax_group_id as unknown[])[1] as string:"";if(esGrupoIVAReal(g))set.add(t.id as number);}
  return set;
}

// v27 - control de que lo aplicado realmente quedo bien.
type Perc = {tax_id:number; monto:number};
function armarControl(percep:Perc[], noAplicadas:Perc[], totalEsperado:number|null, cabecera:Record<string,unknown>|undefined){
  const problemas:string[]=[];
  if(noAplicadas.length){
    const ids=noAplicadas.map(p=>p.tax_id).join(", ");
    problemas.push(`No se aplicaron ${noAplicadas.length} de ${percep.length} percepciones (tax_id: ${ids}). Odoo no genero la linea de impuesto: revisa que esos impuestos no esten configurados en 0%.`);
  }
  const totalOdoo=Number(cabecera?.amount_total ?? 0);
  let diferencia:number|null=null;
  if(totalEsperado!=null){
    diferencia=Math.round((totalOdoo-totalEsperado)*100)/100;
    if(Math.abs(diferencia)>=0.01){
      problemas.push(`El total en Odoo (${totalOdoo.toFixed(2)}) no coincide con el total del comprobante (${totalEsperado.toFixed(2)}). Diferencia: ${diferencia.toFixed(2)}.`);
    }
  }
  return { no_aplicadas: noAplicadas, total_esperado: totalEsperado, total_odoo: totalOdoo, diferencia, cuadra: problemas.length===0, problemas };
}


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
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

_servirConGuardia(async(req:Request)=>{
  const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    let body:Record<string,unknown>={};try{body=await req.json();}catch{/* */}
    const uid=await authenticate();

    if(body.modo==="apuntes_factura"){
      let id=body.id as number|undefined;
      if(!id && body.comprobante){
        const found=await execKw(uid,"account.move","search",[[["l10n_latam_document_number","=",String(body.comprobante)],["company_id","=",COMPANY_ID]]]) as number[];
        id=found[0];
      }
      if(!id) return new Response(JSON.stringify({ok:false,error:"No encontrada"}),{headers:cors});
      const cab=await execKw(uid,"account.move","read",[[id]],{fields:["id","name","l10n_latam_document_number","amount_untaxed","amount_tax","amount_total","amount_untaxed_signed","amount_tax_signed","amount_total_signed","currency_id","company_currency_id","invoice_currency_rate"]}) as Array<Record<string,unknown>>;
      const lineas=await execKw(uid,"account.move.line","search_read",[[["move_id","=",id]]],{fields:["name","display_type","debit","credit","balance","amount_currency","tax_group_id"]});
      return new Response(JSON.stringify({ok:true,cabecera:cab[0],lineas},null,2),{headers:cors});
    }

    if(body.modo==="buscar_borrador"){
      const cuit=String(body.cuit||"").replace(/\D/g,"");
      const cg=cuit.length===11?`${cuit.slice(0,2)}-${cuit.slice(2,10)}-${cuit.slice(10)}`:cuit;
      const pids=await execKw(uid,"res.partner","search",[["|",["vat","=",cuit],["vat","=",cg]]]) as number[];
      let f:unknown=[];
      if(pids.length)f=await execKw(uid,"account.move","search_read",[[["move_type","=","in_invoice"],["company_id","=",COMPANY_ID],["state","=","draft"],["partner_id","in",pids]]],{fields:["id","name","l10n_latam_document_number","amount_untaxed","amount_tax","amount_total"]});
      return new Response(JSON.stringify({ok:true,cuit_buscado:cuit,partner_ids:pids,borradores:f}),{headers:cors});
    }

    if(body.modo==="leer_borrador"){
      const moveId=body.move_id as number;
      if(!moveId) return new Response(JSON.stringify({ok:false,error:"Falta move_id"}),{headers:cors});
      const info=await leerBorrador(uid,moveId);
      return new Response(JSON.stringify({ok:true,...info}),{headers:cors});
    }

    if(body.modo==="aplicar_percepciones"){
      const moveId=body.move_id as number;
      const percep=(body.percepciones as Perc[])||[];
      const netoObjetivo = (body.neto!=null) ? Number(body.neto) : null;
      const ivaTaxId = (body.iva_tax_id!=null) ? Number(body.iva_tax_id) : null;
      const totalEsperado = (body.total_esperado!=null) ? Number(body.total_esperado) : null;
      const dist = (body.lineas_distribucion as Array<{line_id:number;price_unit:number}>|undefined) || null;

      const cab=await execKw(uid,"account.move","read",[[moveId]],{fields:["state","invoice_line_ids"]}) as Array<Record<string,unknown>>;
      if(cab[0]?.state!=="draft")return new Response(JSON.stringify({ok:false,error:"No es borrador"}),{headers:cors});
      const invLineIds=(cab[0]?.invoice_line_ids as number[])||[];
      const invLines=await execKw(uid,"account.move.line","read",[invLineIds],{fields:["id","display_type","tax_ids","price_unit","quantity"]}) as Array<Record<string,unknown>>;
      const gastos=invLines.filter(l=>l.display_type==="product");
      if(!gastos.length)return new Response(JSON.stringify({ok:false,error:"Sin linea de gasto"}),{headers:cors});

      const setIVA=await idsIVA(uid);

      if(dist && dist.length){
        const gastoIds=new Set(gastos.map(g=>g.id));
        for(const d of dist){ if(!gastoIds.has(d.line_id)) return new Response(JSON.stringify({ok:false,error:`line_id ${d.line_id} no pertenece al borrador`}),{headers:cors}); }
        const taxIdsLinea:number[]=[];
        if(ivaTaxId && setIVA.has(ivaTaxId)) taxIdsLinea.push(ivaTaxId);
        const primeraLineId = dist[0].line_id;
        const cmdsLineas:unknown[]=[];
        for(const d of dist){
          const taxFinales=[...taxIdsLinea];
          if(d.line_id===primeraLineId){
            for(const p of percep){ if(p.tax_id && !taxFinales.includes(p.tax_id)) taxFinales.push(p.tax_id); }
          }
          cmdsLineas.push([1,d.line_id,{price_unit:Number(d.price_unit),quantity:1,tax_ids:[[6,false,taxFinales]]}]);
        }
        await execKw(uid,"account.move","write",[[moveId],{invoice_line_ids:cmdsLineas}]);

        let aplicadas=0; const noAplicadas:Perc[]=[];
        if(percep.length){
          const tl=await execKw(uid,"account.move.line","search_read",[[["move_id","=",moveId],["display_type","=","tax"]]],{fields:["id","tax_line_id"]}) as Array<Record<string,unknown>>;
          const cmds:unknown[]=[];
          for(const p of percep){
            const ln=tl.find(l=>Array.isArray(l.tax_line_id)&&(l.tax_line_id as unknown[])[0]===p.tax_id);
            if(ln){ cmds.push([1,ln.id,{balance:p.monto,debit:p.monto,credit:0}]); aplicadas++; } else { noAplicadas.push(p); }
          }
          if(cmds.length)await execKw(uid,"account.move","write",[[moveId],{line_ids:cmds}]);
        }
        const fin=await leerLineasTax(uid,moveId);
        const ctrl=armarControl(percep,noAplicadas,totalEsperado,fin.cabecera as Record<string,unknown>);
        return new Response(JSON.stringify({ok:true,modo:"multi_linea",lineas_asignadas:dist.length,iva_taxid:ivaTaxId,aplicadas,...ctrl,...fin}),{headers:cors});
      }

      if(gastos.length>1)return new Response(JSON.stringify({ok:false,error:`La factura tiene ${gastos.length} lineas de gasto. Enviar lineas_distribucion para distribuir el neto entre ellas.`,lineas_gasto:gastos.map(g=>({id:g.id,name:g.name,price_unit:g.price_unit}))}),{headers:cors});
      const gasto=gastos[0];
      const taxIdsFinales:number[]=[];
      if(ivaTaxId && setIVA.has(ivaTaxId)) taxIdsFinales.push(ivaTaxId);
      for(const p of percep){ if(p.tax_id && !taxIdsFinales.includes(p.tax_id)) taxIdsFinales.push(p.tax_id); }
      const cambios:Record<string,unknown>={tax_ids:[[6,false,taxIdsFinales]]};
      let netoEscrito=null;
      if(netoObjetivo!=null && netoObjetivo>0){
        cambios.price_unit=netoObjetivo;
        cambios.quantity=1;
        netoEscrito=netoObjetivo;
      }
      await execKw(uid,"account.move","write",[[moveId],{invoice_line_ids:[[1,gasto.id,cambios]]}]);

      let aplicadas=0; const noAplicadas:Perc[]=[];
      if(percep.length){
        const tl=await execKw(uid,"account.move.line","search_read",[[["move_id","=",moveId],["display_type","=","tax"]]],{fields:["id","tax_line_id"]}) as Array<Record<string,unknown>>;
        const cmds:unknown[]=[];
        for(const p of percep){
          const ln=tl.find(l=>Array.isArray(l.tax_line_id)&&(l.tax_line_id as unknown[])[0]===p.tax_id);
          if(ln){ cmds.push([1,ln.id,{balance:p.monto,debit:p.monto,credit:0}]); aplicadas++; } else { noAplicadas.push(p); }
        }
        if(cmds.length)await execKw(uid,"account.move","write",[[moveId],{line_ids:cmds}]);
      }
      const fin=await leerLineasTax(uid,moveId);
      const ctrl=armarControl(percep,noAplicadas,totalEsperado,fin.cabecera as Record<string,unknown>);
      return new Response(JSON.stringify({ok:true,modo:"linea_unica",neto_escrito:netoEscrito,iva_taxid:ivaTaxId,aplicadas,...ctrl,...fin}),{headers:cors});
    }

    if(body.modo==="leer_lineas_tax")return new Response(JSON.stringify({ok:true,...await leerLineasTax(uid,body.move_id as number)}),{headers:cors});
    if(body.modo==="contabilidad")return new Response(JSON.stringify({ok:true,company_id:COMPANY_ID,...await relevarPieza(uid,(body.que as string)||"impuestos")}),{headers:cors});
    const periodo=(body.periodo as string)||"";
    if(body.modo==="diagnostico"||!periodo){const c=await execKw(uid,"res.company","search_read",[[]],{fields:["id","name","vat"]});return new Response(JSON.stringify({ok:true,uid,companias:c}),{headers:cors});}
    return new Response(JSON.stringify({ok:true,...await conciliarPeriodo(uid,periodo)}),{headers:cors});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String((e as Error).message||e)}),{headers:cors,status:200});}
});
