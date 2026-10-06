import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// escandallo-prod v5 - tarifas MO (reparto deducido) + series + refresca escandallo_tarifas
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const C = 2;
const CUENTAS_MO = ["5.1.2.01.010", "5.1.2.01.110"];
type Rec = Record<string, unknown>;
const m2o = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function ex(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
function pct(arr: number[], p: number) { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.max(0, Math.floor(p*(s.length-1)))]; }
function median(arr: number[]) { if (!arr.length) return 0.5; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
function ventana(meses: {mes:string;kg:number;u:number}[], n: number | null) {
  const sel = n ? meses.slice(-n) : meses; const nm = sel.length || 1;
  return { n_meses: sel.length, kg_mes: Math.round(sel.reduce((a,m)=>a+m.kg,0)/nm*100)/100, u_mes: Math.round(sel.reduce((a,m)=>a+m.u,0)/nm*100)/100,
    label: sel.length ? (sel[0].mes + (sel.length>1 ? ' → '+sel[sel.length-1].mes : '')) : '—' };
}

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

_servirConGuardia(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [C] };
    const mos = await ex(uid, "mrp.production", "search_read", [[["company_id", "=", C], ["state", "=", "done"]]], { fields: ["date_finished", "product_qty", "product_uom_id"], context: ctx }) as Rec[];
    const pm: Record<string, {kg:number;u:number;dias:Set<string>}> = {}; const pd: Record<string, {kg:number;u:number}> = {};
    for (const m of mos) {
      const dt = (m.date_finished as string || ""); if (!dt) continue; const mes = dt.slice(0,7), dia = dt.slice(0,10);
      const uom = (m2o(m.product_uom_id)||"").toLowerCase(); const q = (m.product_qty as number)||0;
      const esKg = uom.includes("kg")||uom.includes("litro")||uom.includes("lts");
      if(!pm[mes])pm[mes]={kg:0,u:0,dias:new Set()}; if(!pd[dia])pd[dia]={kg:0,u:0};
      pm[mes].dias.add(dia);
      if (esKg) { pm[mes].kg+=q; pd[dia].kg+=q; } else { pm[mes].u+=q; pd[dia].u+=q; }
    }
    const meses = Object.keys(pm).sort().map(mes=>({ mes, kg: Math.round(pm[mes].kg*100)/100, u: pm[mes].u, dias: pm[mes].dias.size }));
    const dias = Object.values(pd);
    const SE = dias.reduce((a,d)=>a+d.kg,0), SU = dias.reduce((a,d)=>a+d.u,0);
    const ests: number[] = [];
    for (const umbral of [10,20,30]) for (const p of [0.8,0.9,0.95]) {
      const dE = dias.filter(d=>d.u<=umbral).map(d=>d.kg).filter(x=>x>0);
      const dF = dias.filter(d=>d.kg<=umbral).map(d=>d.u).filter(x=>x>0);
      if (dE.length<5 || dF.length<5) continue;
      const Emax=pct(dE,p), Fmax=pct(dF,p); if (Emax<=0||Fmax<=0) continue;
      const diasE=SE/Emax, diasF=SU/Fmax; ests.push(diasE/(diasE+diasF));
    }
    const splitElab = ests.length ? median(ests) : 0.5;
    const capKg = pct(dias.filter(d=>d.u<=20).map(d=>d.kg).filter(x=>x>0),0.9);
    const capU  = pct(dias.filter(d=>d.kg<=20).map(d=>d.u).filter(x=>x>0),0.9);
    const cuentas = await ex(uid, "account.account", "search_read", [[["code","in",CUENTAS_MO]]], { fields:["id"], context: ctx }) as Rec[];
    const ctaIds = cuentas.map(c=>c.id as number); let laborMesProm = 0;
    if (ctaIds.length) {
      const lines = await ex(uid, "account.move.line", "search_read", [[["account_id","in",ctaIds],["company_id","=",C],["parent_state","=","posted"],["debit",">",0]]], { fields:["date","debit"], context: ctx }) as Rec[];
      const mm: Record<string,number> = {}; for (const l of lines) { const k=(l.date as string||"").slice(0,7); if(k) mm[k]=(mm[k]||0)+((l.debit as number)||0); }
      const ks=Object.keys(mm); laborMesProm = ks.length ? ks.reduce((a,k)=>a+mm[k],0)/ks.length : 0;
    }
    const windows: Record<string, Rec> = {};
    for (const [key,n] of [["all",null],["tres",3],["uno",1]] as [string,number|null][]) {
      const w = ventana(meses, n);
      windows[key] = { ...w,
        rate_kg: w.kg_mes>0 ? Math.round(laborMesProm*splitElab/w.kg_mes*100)/100 : 0,
        rate_un: w.u_mes>0 ? Math.round(laborMesProm*(1-splitElab)/w.u_mes*100)/100 : 0 };
    }
    // refrescar la tarifa vigente (ventana 'all') para el modulo de Rentabilidad
    try {
      const a = windows.all as Rec;
      await fetch(`${SB_URL}/rest/v1/escandallo_tarifas?on_conflict=id`, { method: "POST", headers: { "apikey": SB_SERVICE, "Authorization": "Bearer "+SB_SERVICE, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify([{ id: 1, rate_kg: a.rate_kg, rate_un: a.rate_un, split_elab: splitElab, kg_mes: a.kg_mes, u_mes: a.u_mes, actualizado_en: new Date().toISOString() }]) });
    } catch (_e) { /* no romper la respuesta si falla el refresh */ }
    return new Response(JSON.stringify({ ok: true, labor_ok: laborMesProm>0,
      split_elab: Math.round(splitElab*1000)/1000, split_muestras: ests.length,
      cap_kg_dia: Math.round(capKg), cap_u_dia: Math.round(capU), n_dias: dias.length,
      meses, windows }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
