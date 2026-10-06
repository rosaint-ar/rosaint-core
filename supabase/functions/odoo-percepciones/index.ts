import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-percepciones v1 (JSON-RPC) - SOLO LECTURA: percepciones por comprobante y regimen, para cruzar con AFIP IMP_PER_RET
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
type Rec = Record<string, unknown>;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
const m2oName = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
function monthRange(periodo: string) { const [y, m] = periodo.split("-").map(Number); const desde = `${y}-${String(m).padStart(2, "0")}-01`; const ld = new Date(y, m, 0).getDate(); return { desde, hasta: `${y}-${String(m).padStart(2, "0")}-${String(ld).padStart(2, "0")}` }; }
function esGrupoIVAReal(g: string) { const n = (g || "").toUpperCase(); return /^VAT \d/.test(n) || /^IVA \d/.test(n); }
// Mapea el nombre del impuesto de Odoo al codigo de regimen de AFIP
function regimenDe(nombre: string): string {
  const n = (nombre || "").toLowerCase();
  if (/2408/.test(n)) return "493";      // Percepcion IVA General RG 2408/08
  if (/5319/.test(n)) return "976";      // Percepcion IVA Especial RG 5319/23
  if (/iibb|ingresos brutos/.test(n)) return "iibb";
  if (/ganancia|profit|earnings/.test(n)) return "ganancias";
  if (/percepci.n del iva|vat perception/.test(n)) return "iva_otro";
  return "otros";
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
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const periodo = (body.periodo as string) || "";
    if (!periodo) return new Response(JSON.stringify({ ok: false, error: "falta periodo" }), { headers: cors });
    const uid = await authenticate();
    const { desde, hasta } = monthRange(periodo);
    const moves = await execKw(uid, "account.move", "search_read", [[["move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", COMPANY_ID], ["state", "=", "posted"], ["date", ">=", desde], ["date", "<=", hasta]]], { fields: ["id", "move_type", "l10n_latam_document_number", "partner_id"] }) as Rec[];
    const moveIds = moves.map(m => m.id as number);
    const pids = [...new Set(moves.map(m => m2oId(m.partner_id)).filter((x): x is number => x !== null))];
    let pmap: Record<number, string> = {};
    if (pids.length) { const ps = await execKw(uid, "res.partner", "read", [pids, ["vat"]]) as Rec[]; pmap = Object.fromEntries(ps.map(p => [p.id as number, String((p.vat as string) || "").replace(/\D/g, "")])); }
    // lineas de impuesto
    let taxByMove: Record<number, Record<string, number>> = {};
    if (moveIds.length) {
      const tl = await execKw(uid, "account.move.line", "search_read", [[["move_id", "in", moveIds], ["display_type", "=", "tax"]]], { fields: ["move_id", "balance", "tax_line_id", "tax_group_id"] }) as Rec[];
      for (const l of tl) {
        const mid = m2oId(l.move_id); if (mid === null) continue;
        const gname = m2oName(l.tax_group_id) || "";
        if (esGrupoIVAReal(gname)) continue; // es IVA propio, no percepcion
        const tname = m2oName(l.tax_line_id) || gname;
        const reg = regimenDe(tname);
        const bal = Math.abs((l.balance as number) || 0);
        (taxByMove[mid] = taxByMove[mid] || {})[reg] = (taxByMove[mid]?.[reg] || 0) + bal;
      }
    }
    const facturas = moves.map(m => {
      const id = m.id as number; const pid = m2oId(m.partner_id);
      const esNC = m.move_type === "in_refund"; const signo = esNC ? -1 : 1;
      const por = taxByMove[id] || {};
      const porFirmado: Record<string, number> = {}; let tot = 0;
      for (const k of Object.keys(por)) { porFirmado[k] = Math.round(por[k] * signo * 100) / 100; tot += por[k]; }
      return { comprobante: m.l10n_latam_document_number, cuit: pid !== null ? (pmap[pid] || "") : "", proveedor: m2oName(m.partner_id), es_nc: esNC, por_regimen: porFirmado, total_percep: Math.round(tot * signo * 100) / 100 };
    }).filter(f => Object.keys(f.por_regimen).length > 0);
    return new Response(JSON.stringify({ ok: true, periodo, desde, hasta, cantidad: facturas.length, facturas }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
