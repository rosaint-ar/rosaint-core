import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// odoo-ml-relevar (v2) — lector SOLO LECTURA de Odoo para el conector ML→Odoo.
// Auth interna (JSON-RPC). Protegido por x-proxy-secret (mismo secreto que ml-api) si esta seteado.
// Solo permite metodos de lectura. Contexto empresa 2 (VELAZQUEZ); RST (1) se dio de baja.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const PROXY_SECRET = Deno.env.get("ML_PROXY_SECRET") || "";
const CTX = { allowed_company_ids: [2] };
const READ_METHODS = new Set(["search_read", "read", "search_count", "search", "fields_get", "read_group"]);

async function jsonrpc(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth() {
  if (_uid) return _uid;
  const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid; return uid;
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
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (PROXY_SECRET && req.headers.get("x-proxy-secret") !== PROXY_SECRET)
      return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { headers: cors, status: 200 });
    const body = await req.json() as { model: string; method: string; args?: unknown[]; kwargs?: Record<string, unknown> };
    const { model, method } = body;
    if (!model || !method) return new Response(JSON.stringify({ ok: false, error: "Falta model o method" }), { headers: cors });
    if (!READ_METHODS.has(method)) return new Response(JSON.stringify({ ok: false, error: `Metodo no permitido (solo lectura): ${method}` }), { headers: cors });
    const args = body.args || [];
    const kwargs = { ...(body.kwargs || {}) } as Record<string, unknown>;
    kwargs.context = { ...CTX, ...((kwargs.context as Record<string, unknown>) || {}) };
    const uid = await auth();
    const result = await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
    return new Response(JSON.stringify({ ok: true, result }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
