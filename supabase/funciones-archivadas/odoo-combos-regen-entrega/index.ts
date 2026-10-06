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
    const body = await req.json().catch(() => ({}));
    const SO = 4478;
    const so = (await call("sale.order", "read", [[SO], ["name", "state", "invoice_status", "invoice_ids", "picking_ids"]], {}))[0];
    const pickings = so.picking_ids?.length ? await call("stock.picking", "read", [so.picking_ids, ["id", "name", "state"]], {}) : [];
    const facturas = so.invoice_ids?.length ? await call("account.move", "read", [so.invoice_ids, ["id", "name", "state"]], {}) : [];
    const info: any = { pedido: so, pickings, facturas };
    const hayPickingHecho = pickings.some((p: any) => p.state === "done");
    const hayFacturaPosteada = facturas.some((f: any) => f.state === "posted");
    info.seguro_regenerar = !hayPickingHecho && !hayFacturaPosteada;

    if (body.regenerar === true && info.seguro_regenerar) {
      await call("sale.order", "action_cancel", [[SO]]);
      await call("sale.order", "action_draft", [[SO]]);
      await call("sale.order", "action_confirm", [[SO]]);
      const so2 = (await call("sale.order", "read", [[SO], ["picking_ids", "state"]], {}))[0];
      const nuevos = await call("stock.picking", "read", [so2.picking_ids, ["id", "name", "state", "move_ids"]], {});
      const moveIds = nuevos.flatMap((p: any) => p.move_ids || []);
      const moves = moveIds.length ? await call("stock.move", "read", [moveIds, ["product_id", "product_uom_qty", "state", "picking_id"]], {}) : [];
      info.resultado = { pickings_nuevos: nuevos, moves };
    }
    return new Response(JSON.stringify({ ok: true, ...info }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
