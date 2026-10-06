import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-iibb-ventas v3 - SOLO LECTURA
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
type Rec = Record<string, unknown>;
const m2oName = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
function lastDay(mes: string): string { const [y, m] = mes.split("-").map(Number); const d = new Date(Date.UTC(y, m, 0)).getUTCDate(); return `${mes}-${String(d).padStart(2, "0")}`; }
const r2 = (n: number) => Math.round(n * 100) / 100;


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
    const uid = await authenticate();
    const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };

    // MODO cliente: lista todos los comprobantes de venta de un cliente (por nombre parcial)
    if (body.cliente) {
      const rows = await execKw(uid, "account.move", "search_read", [[
        ["move_type", "in", ["out_invoice", "out_refund"]],
        ["company_id", "=", COMPANY_ID],
        ["partner_id.name", "ilike", body.cliente as string],
      ]], { fields: ["name", "state", "move_type", "invoice_date", "partner_id", "ref", "invoice_origin", "amount_untaxed_signed", "amount_total_signed", "reversed_entry_id"], order: "invoice_date", context: ctx }) as Rec[];
      return new Response(JSON.stringify({ ok: true, cliente: body.cliente, comprobantes: rows.map(r => ({ comprobante: r.name, estado: r.state, tipo: r.move_type, fecha: r.invoice_date, imponible: r.amount_untaxed_signed, con_iva: r.amount_total_signed, motivo: r.ref, origen: r.invoice_origin, revierte_a: m2oName(r.reversed_entry_id) })) }, null, 2), { headers: cors });
    }

    const mes = (body.mes as string) || "2026-06";
    const desde = `${mes}-01`;
    const hasta = lastDay(mes);
    const moves = await execKw(uid, "account.move", "search_read", [[
      ["move_type", "in", ["out_invoice", "out_refund"]],
      ["state", "=", "posted"],
      ["company_id", "=", COMPANY_ID],
      ["invoice_date", ">=", desde],
      ["invoice_date", "<=", hasta],
    ]], { fields: ["name", "move_type", "invoice_date", "partner_id", "ref", "invoice_origin", "amount_untaxed_signed", "amount_total_signed"], context: ctx }) as Rec[];

    const partnerIds = [...new Set(moves.map((mv) => m2oId(mv.partner_id)).filter((x): x is number => !!x))];
    const partners = partnerIds.length ? await execKw(uid, "res.partner", "read", [partnerIds], { fields: ["state_id"], context: ctx }) as Rec[] : [];
    const provDe: Record<number, string> = {};
    for (const p of partners) provDe[p.id as number] = m2oName(p.state_id) || "(Sin provincia)";

    type Acu = { imponible: number; total: number; nFac: number; nNC: number };
    const nueva = (): Acu => ({ imponible: 0, total: 0, nFac: 0, nNC: 0 });
    const soloFac: Record<string, Acu> = {};
    const netas: Record<string, Acu> = {};
    const add = (bag: Record<string, Acu>, prov: string, unt: number, tot: number, esNC: boolean) => { const a = (bag[prov] ||= nueva()); a.imponible += unt; a.total += tot; if (esNC) a.nNC++; else a.nFac++; };
    const detalleNC: Rec[] = [];
    for (const mv of moves) {
      const pid = m2oId(mv.partner_id);
      const prov = (pid && provDe[pid]) || "(Sin provincia)";
      const unt = (mv.amount_untaxed_signed as number) || 0;
      const tot = (mv.amount_total_signed as number) || 0;
      const esNC = mv.move_type === "out_refund";
      add(netas, prov, unt, tot, esNC);
      if (!esNC) add(soloFac, prov, unt, tot, esNC);
      if (esNC) detalleNC.push({ comprobante: mv.name, fecha: mv.invoice_date, cliente: m2oName(mv.partner_id), provincia: prov, imponible: r2(Math.abs(unt)), motivo: mv.ref || null });
    }
    const armar = (bag: Record<string, Acu>) => { const filas = Object.entries(bag).map(([prov, a]) => ({ provincia: prov, imponible: r2(a.imponible), total: r2(a.total) })).sort((x, y) => y.imponible - x.imponible); return { total_imponible: r2(filas.reduce((s, f) => s + f.imponible, 0)), total_con_iva: r2(filas.reduce((s, f) => s + f.total, 0)), provincias: filas }; };
    return new Response(JSON.stringify({ ok: true, mes, desde, hasta, cantidad_comprobantes: moves.length, detalle_notas_credito: detalleNC, solo_facturas: armar(soloFac), netas_de_devoluciones: armar(netas) }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
