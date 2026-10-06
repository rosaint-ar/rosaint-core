import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-libros-iva v1
// Descarga los ZIP del "Libro de IVA Argentino" (Reporte de Impuestos) de Odoo,
// ventas o compras, tal cual los genera Odoo. Reproduce el flujo del navegador:
// login web -> get_options del reporte -> POST al controlador /account_reports.
// La contraseña se lee de la bóveda cifrada (Vault) vía RPC con el service role.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REPORT_ID = 19; // Libro de IVA Argentino
type Rec = Record<string, unknown>;

async function jrpc(path: string, params: Rec): Promise<Response> {
  return await fetch(`${ODOO_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params, id: 1 }) });
}
async function ek(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  const r = await jrpc("/jsonrpc", { service: "object", method: "execute_kw", args: [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs] });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function getOdooPassword(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_odoo_password`, { method: "POST", headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }, body: "{}" });
  if (!r.ok) throw new Error("No se pudo leer la credencial (" + r.status + ")");
  const v = await r.json();
  if (!v || typeof v !== "string") throw new Error("Credencial de Odoo no configurada");
  return v;
}
function lastDay(mes: string): string {
  const [y, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${mes}-${String(d).padStart(2, "0")}`;
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
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Expose-Headers": "content-disposition, x-odoo-filename" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const jsonErr = (msg: string) => new Response(JSON.stringify({ ok: false, error: msg }), { headers: { ...cors, "Content-Type": "application/json" }, status: 200 });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const mes = (body.mes as string) || "";
    const tipo = (body.tipo as string) === "purchase" ? "purchase" : "sale";
    if (!/^\d{4}-\d{2}$/.test(mes)) return jsonErr("Falta el mes (formato YYYY-MM)");
    const desde = `${mes}-01`; const hasta = lastDay(mes);

    const password = await getOdooPassword();

    // 1) login web -> cookie
    const authRes = await jrpc("/web/session/authenticate", { db: ODOO_DB, login: ODOO_LOGIN, password });
    const authJson = await authRes.json();
    const sidM = (authRes.headers.get("set-cookie") || "").match(/session_id=([^;]+)/);
    const uid = authJson?.result?.uid as number | undefined;
    if (!sidM || !uid) return jsonErr("No se pudo iniciar sesión en Odoo (revisá la credencial guardada)");
    const sid = sidM[1];

    // 2) opciones del reporte con el tipo elegido
    const prev = { date: { filter: "custom", mode: "range", date_from: desde, date_to: hasta } };
    const opts = await ek(uid, "account.report", "get_options", [[REPORT_ID], prev], { context: { lang: "es_ES", allowed_company_ids: [2] } }) as Rec;
    opts.ar_vat_book_tax_types_available = { sale: { name: "Sales", selected: tipo === "sale" }, purchase: { name: "Purchases", selected: tipo === "purchase" } };

    // 3) descarga binaria por el controlador
    const form = new URLSearchParams();
    form.set("model", "account.report");
    form.set("options", JSON.stringify(opts));
    form.set("file_generator", "vat_book_export_files_to_zip");
    const dl = await fetch(`${ODOO_URL}/account_reports`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": `session_id=${sid}` }, body: form.toString() });
    const ct = dl.headers.get("content-type") || "";
    if (!dl.ok || !ct.includes("zip")) {
      const txt = await dl.text();
      return jsonErr("Odoo no devolvió el ZIP (" + dl.status + "). " + txt.slice(0, 160));
    }
    const buf = await dl.arrayBuffer();
    const cd = dl.headers.get("content-disposition") || "";
    const nombreOdoo = (cd.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)/i) || [])[1] || `Libro_IVA_${tipo === "sale" ? "Ventas" : "Compras"}_${mes}`;
    const fname = nombreOdoo.replace(/\.zip$/i, "") + ".zip";
    return new Response(buf, { headers: { ...cors, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename=\"${fname}\"`, "x-odoo-filename": fname } });
  } catch (e) { return jsonErr(String((e as Error).message || e)); }
});
