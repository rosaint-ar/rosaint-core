import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-usuarios (v2) — SOLO LECTURA ======
// Lista los usuarios del Odoo de Rosaint para saber cuantas licencias (usuarios
// internos) estan ocupadas. No escribe nada.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}

Deno.serve(async (_req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  try {
    const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number;
    const ctx = { active_test: false, lang: "es_ES" };
    const call = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
      jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: { ...ctx, ...((kwargs.context as Record<string, unknown>) || {}) } }]);

    const usuarios = await call("res.users", "search_read", [[]], {
      fields: ["id", "name", "login", "active", "share", "company_id", "login_date", "groups_id"],
      order: "id asc",
    }) as Array<Record<string, unknown>>;

    const params = await call("ir.config_parameter", "search_read",
      [[["key", "in", ["database.expiration_date", "database.expiration_reason", "database.enterprise_code", "database.create_date"]]]],
      { fields: ["key", "value"] });

    // nombres de los grupos de cada usuario interno activo (para ver perfiles)
    const internos = usuarios.filter((u) => u.share === false);
    const gids = [...new Set(internos.flatMap((u) => (u.groups_id as number[]) || []))];
    const grupos = gids.length
      ? await call("res.groups", "read", [gids], { fields: ["id", "full_name"] }) as Array<Record<string, unknown>>
      : [];
    const gmap: Record<number, string> = Object.fromEntries(grupos.map((g) => [g.id as number, String(g.full_name || "")]));
    const detalle = internos.map((u) => ({
      id: u.id, nombre: u.name, login: u.login, activo: u.active,
      ultimo_login: u.login_date,
      grupos_clave: ((u.groups_id as number[]) || []).map((g) => gmap[g]).filter((n) => /Accounting|Contabilidad|Settings|Administration|Sales|Inventory|Purchase/i.test(n)),
    }));

    const resumen = {
      total_usuarios: usuarios.length,
      internos_activos: internos.filter((u) => u.active === true).length,
      internos_archivados: internos.filter((u) => u.active === false).length,
      portal_o_publicos: usuarios.filter((u) => u.share === true).length,
    };
    return new Response(JSON.stringify({ ok: true, uid, resumen, params, internos: detalle }, null, 2), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
