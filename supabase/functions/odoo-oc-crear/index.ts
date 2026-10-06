import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ================================================================
// odoo-oc-crear — crea una ORDEN DE COMPRA EN BORRADOR en Odoo (company 2)
// a partir del pedido armado en el Core. NO confirma nada: queda en draft
// para que se revise y confirme en Odoo. Valida al usuario logueado.
// Body: { partner_id?, proveedor_nombre?, lineas:[{codigo,cantidad,precio?}] }
// ================================================================
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const COMPANY_ID = 2;
const CTX = { allowed_company_ids: [COMPANY_ID], company_id: COMPANY_ID, lang: "es_ES" };

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid as number; return _uid;
}
async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await auth();
  const ctx = { ...CTX, ...((kwargs.context as Record<string, unknown>) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: ctx }]);
}
async function usuarioValido(req: Request): Promise<boolean> {
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const apikey = req.headers.get("apikey") || PUB;
  try { const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } }); return r.ok; } catch { return false; }
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
  const bad = (error: string) => new Response(JSON.stringify({ ok: false, error }), { headers: cors, status: 200 });
  try {
    if (!(await usuarioValido(req))) return bad("No autorizado");
    const body = await req.json() as { partner_id?: number; proveedor_nombre?: string; lineas?: Array<{ codigo: string; cantidad: number; precio?: number }> };
    const lineas = (body.lineas || []).filter((l) => l && l.codigo && Number(l.cantidad) > 0);
    if (!lineas.length) return bad("El pedido no tiene renglones");

    // Proveedor: por id si vino, si no por nombre exacto y luego aproximado.
    let pid = Number(body.partner_id) || null;
    if (!pid && body.proveedor_nombre) {
      const nombre = String(body.proveedor_nombre);
      let f = await call("res.partner", "search", [[["name", "=", nombre], ["supplier_rank", ">", 0]]], { limit: 1 }) as number[];
      if (!f.length) f = await call("res.partner", "search", [[["name", "ilike", nombre]]], { limit: 1 }) as number[];
      pid = f[0] || null;
    }
    if (!pid) return bad("No encontré el proveedor en Odoo. Revisá la ficha del proveedor.");

    // Productos por default_code.
    const codigos = [...new Set(lineas.map((l) => String(l.codigo)))];
    const prods = await call("product.product", "search_read", [[["default_code", "in", codigos]]], { fields: ["id", "default_code"] }) as Array<Record<string, unknown>>;
    const idPorCodigo: Record<string, number> = {};
    for (const p of prods) idPorCodigo[String(p.default_code)] = p.id as number;

    const orderLine: unknown[] = [];
    const faltantes: string[] = [];
    for (const l of lineas) {
      const id = idPorCodigo[String(l.codigo)];
      if (!id) { faltantes.push(String(l.codigo)); continue; }
      const vals: Record<string, unknown> = { product_id: id, product_qty: Number(l.cantidad) };
      if (Number(l.precio) > 0) vals.price_unit = Number(l.precio);
      orderLine.push([0, 0, vals]);
    }
    if (!orderLine.length) return bad("Ninguno de los productos existe en Odoo (" + faltantes.join(", ") + ")");

    const oid = await call("purchase.order", "create", [{ partner_id: pid, order_line: orderLine }]) as number;
    const info = await call("purchase.order", "read", [[oid], ["name", "state", "amount_total"]]) as Array<Record<string, unknown>>;
    return new Response(JSON.stringify({ ok: true, id: oid, name: info[0]?.name || String(oid), state: info[0]?.state, amount_total: info[0]?.amount_total, faltantes }), { headers: cors });
  } catch (e) {
    return bad(String((e as Error).message ?? e));
  }
});
