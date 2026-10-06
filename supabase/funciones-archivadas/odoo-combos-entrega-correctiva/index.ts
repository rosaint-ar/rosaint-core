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

// body: { pedidos:[{ origin, ref_picking_id, componentes:[{product_id,uom_id,name}] }], dry_run }
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const b = await req.json();
    const dry = b.dry_run !== false;
    const resultados: any[] = [];
    for (const ped of b.pedidos) {
      const ref = (await call("stock.picking", "read", [[ped.ref_picking_id], ["location_id", "location_dest_id", "picking_type_id", "group_id", "company_id"]], {}))[0];
      const r: any = { origin: ped.origin, ref, componentes: ped.componentes };
      if (dry) { resultados.push(r); continue; }
      // 1) crear picking
      const pid = await call("stock.picking", "create", [{
        picking_type_id: ref.picking_type_id[0], location_id: ref.location_id[0], location_dest_id: ref.location_dest_id[0],
        group_id: ref.group_id ? ref.group_id[0] : false, company_id: ref.company_id[0],
        origin: ped.origin + " (ajuste kit combo)",
      }]);
      // 2) crear movimientos
      for (const c of ped.componentes) await call("stock.move", "create", [{
        name: c.name, product_id: c.product_id, product_uom: c.uom_id, product_uom_qty: 1,
        location_id: ref.location_id[0], location_dest_id: ref.location_dest_id[0], picking_id: pid, company_id: ref.company_id[0],
      }]);
      // 3) confirmar + reservar
      await call("stock.picking", "action_confirm", [[pid]]);
      await call("stock.picking", "action_assign", [[pid]]);
      // 4) marcar cantidades hechas
      const pk = (await call("stock.picking", "read", [[pid], ["move_ids", "state"]], {}))[0];
      for (const mid of pk.move_ids) await call("stock.move", "write", [[mid], { quantity: 1, picked: true }]);
      // 5) validar
      let val: any;
      try { val = await call("stock.picking", "button_validate", [[pid]], { context: { skip_backorder: true, skip_sms: true } }); } catch (e) { val = "ERROR validate: " + String((e as Error).message); }
      const fin = (await call("stock.picking", "read", [[pid], ["name", "state", "move_ids"]], {}))[0];
      const moves = await call("stock.move", "read", [fin.move_ids, ["product_id", "quantity", "state"]], {});
      r.creado = { picking_id: pid, name: fin.name, state: fin.state, validate_ret: val, moves };
      resultados.push(r);
    }
    return new Response(JSON.stringify({ ok: true, dry_run: dry, resultados }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
