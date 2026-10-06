import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const CTX = { allowed_company_ids: [1, 2], lang: "es_ES" };

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<any> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> { if (_uid) return _uid; _uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); return _uid; }
async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<any> {
  const uid = await auth(); kwargs.context = { ...CTX, ...((kwargs.context as any) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const out: any = {};
    // company de TODAS las boms de combos
    const bomIds = [322, 323, 324, 325, 326, 327, 328, 337, 338, 339, 340];
    out.boms = await call("mrp.bom", "read", [bomIds, ["id", "product_id", "type", "company_id"]], { context: { active_test: false } });
    // pedido 4478 (el nuevo S01200) company + fechas
    out.pedido_4478 = await call("sale.order", "read", [[4478], ["name", "company_id", "warehouse_id", "date_order", "state"]], {});
    // picking 4997 company + fecha creacion
    out.picking_4997 = await call("stock.picking", "read", [[4997], ["name", "company_id", "create_date", "scheduled_date"]], {});
    // combo template company + is_storable
    out.tmpl_460 = await call("product.template", "read", [[460], ["name", "company_id", "is_storable", "type"]], { context: { active_test: false } });
    return new Response(JSON.stringify({ ok: true, ...out }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
