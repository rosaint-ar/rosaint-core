import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const READINESS = [2, 4, 5, 21, 22];
// Grupo de etiquetas que maneja la pantalla Seguimientos: 2 Hoy, 4 1 dia, 5 2-3 dias,
// 21 Listo, 22 Entrega parcial. Son EXCLUYENTES entre si: al elegir una se borran las otras.
// Hasta el 06/10/2026 decia [2,4,5,19]: la 19 no existe en Odoo (Odoo saltea el id que falta,
// asi que no fallaba: simplemente no aparecian Listo ni Entrega parcial en el desplegable, y
// una venta que las tenia puestas se mostraba como "sin fecha"). Las crm.tag reales son
// 2, 4, 5, 20 (FLEX), 21 y 22. La 20 queda afuera a proposito: no es de este grupo.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error)); return j.result;
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

_servirConGuardia(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const odooId = Number(body.odoo_id);
    const tagId = (body.tag_id === null || body.tag_id === undefined) ? null : Number(body.tag_id);
    if (!odooId) throw new Error("Falta odoo_id");
    if (tagId !== null && !READINESS.includes(tagId)) throw new Error("tag_id no permitido");
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number;
    const ctx = { allowed_company_ids: [COMPANY_ID] };
    const rows = await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, "sale.order", "read", [[odooId]], { fields: ["tag_ids"], context: ctx }]) as Rec[];
    if (!rows.length) throw new Error("Orden no encontrada");
    const current = Array.isArray(rows[0].tag_ids) ? (rows[0].tag_ids as number[]) : [];
    const nuevos = current.filter((t) => !READINESS.includes(t));
    if (tagId !== null) nuevos.push(tagId);
    await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, "sale.order", "write", [[odooId], { tag_ids: [[6, false, nuevos]] }], { context: ctx }]);
    return new Response(JSON.stringify({ ok: true, odoo_id: odooId, etiqueta: tagId, tag_ids: nuevos }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
