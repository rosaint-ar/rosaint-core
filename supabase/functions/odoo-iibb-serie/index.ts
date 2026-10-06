import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-iibb-serie - ventas imponibles por provincia y por mes (netas de NC)
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2;
type Rec = Record<string, unknown>;
const m2oName = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function ex(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }

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
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const nMeses = Math.min(24, Math.max(3, (body.meses as number) || 12));
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [C] };
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (nMeses - 1), 1));
    const desde = start.toISOString().slice(0, 10);
    const monthList: string[] = [];
    for (let i = 0; i < nMeses; i++) monthList.push(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    const moves = await ex(uid, "account.move", "search_read", [[
      ["move_type", "in", ["out_invoice", "out_refund"]],
      ["state", "=", "posted"],
      ["company_id", "=", C],
      ["invoice_date", ">=", desde],
    ]], { fields: ["invoice_date", "partner_id", "amount_untaxed_signed"], limit: 20000, context: ctx }) as Rec[];
    const pids = [...new Set(moves.map(mv => m2oId(mv.partner_id)).filter((x): x is number => !!x))];
    const partners = pids.length ? await ex(uid, "res.partner", "read", [pids], { fields: ["state_id"], context: ctx }) as Rec[] : [];
    const provDe: Record<number, string> = {};
    for (const p of partners) provDe[p.id as number] = m2oName(p.state_id) || "(Sin provincia)";
    // agregacion prov -> mes -> imponible
    const agg: Record<string, Record<string, number>> = {};
    for (const mv of moves) {
      const mes = (mv.invoice_date as string || "").slice(0, 7); if (!mes) continue;
      const pid = m2oId(mv.partner_id); const prov = (pid && provDe[pid]) || "(Sin provincia)";
      const unt = (mv.amount_untaxed_signed as number) || 0;
      (agg[prov] ||= {}); agg[prov][mes] = (agg[prov][mes] || 0) + unt;
    }
    const provincias = Object.keys(agg).map(prov => {
      const valores = monthList.map(m => Math.round((agg[prov][m] || 0) * 100) / 100);
      const total = Math.round(valores.reduce((a, b) => a + b, 0) * 100) / 100;
      return { provincia: prov, total, valores };
    }).sort((a, b) => b.total - a.total);
    const total_por_mes = monthList.map((_, i) => Math.round(provincias.reduce((a, p) => a + p.valores[i], 0) * 100) / 100);
    return new Response(JSON.stringify({ ok: true, desde, meses: monthList, provincias, total_por_mes }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
