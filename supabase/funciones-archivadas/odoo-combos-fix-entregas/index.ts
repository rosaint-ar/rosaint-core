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

// Reemplaza un movimiento de combo (no explotado) por los movimientos de sus componentes, en la MISMA entrega.
// body: { picking_id, combo_move_id, sale_line_id, componentes:[{product_id, uom_id, bom_line_id, name}] , dry_run }
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const b = await req.json();
    const dry = b.dry_run !== false;
    const combo = (await call("stock.move", "read", [[b.combo_move_id], ["location_id", "location_dest_id", "picking_id", "group_id", "procure_method", "company_id", "warehouse_id", "date", "date_deadline", "origin", "sale_line_id", "picking_type_id", "state"]], {}))[0];
    const plan = b.componentes.map((c: any) => ({
      name: c.name, product_id: c.product_id, product_uom: c.uom_id, product_uom_qty: 1,
      location_id: combo.location_id[0], location_dest_id: combo.location_dest_id[0], picking_id: combo.picking_id[0],
      group_id: combo.group_id ? combo.group_id[0] : false, procure_method: combo.procure_method, company_id: combo.company_id[0],
      warehouse_id: combo.warehouse_id ? combo.warehouse_id[0] : false, date: combo.date, date_deadline: combo.date_deadline,
      origin: combo.origin, sale_line_id: combo.sale_line_id ? combo.sale_line_id[0] : false, bom_line_id: c.bom_line_id, picking_type_id: combo.picking_type_id[0],
    }));
    if (dry) return new Response(JSON.stringify({ ok: true, dry_run: true, combo, plan }, null, 2), { headers: cors });

    await call("stock.picking", "do_unreserve", [[b.picking_id]]);
    const nuevos: number[] = [];
    for (const mv of plan) nuevos.push(await call("stock.move", "create", [mv]));
    await call("stock.move", "unlink", [[b.combo_move_id]]);
    await call("stock.picking", "action_assign", [[b.picking_id]]);
    // verificar
    const pk = (await call("stock.picking", "read", [[b.picking_id], ["name", "state", "move_ids"]], {}))[0];
    const moves = await call("stock.move", "read", [pk.move_ids, ["product_id", "product_uom_qty", "state"]], {});
    return new Response(JSON.stringify({ ok: true, dry_run: false, nuevos, picking: pk, moves }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
