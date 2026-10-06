import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// odoo-pedido-auditar — SOLO LECTURA. Un pedido de venta (company 2) renglón por renglón contra sus facturas.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
Deno.serve(async (req: Request) => {
  const h = { "Content-Type": "application/json" };
  try {
    const body = await req.json().catch(() => ({})) as Rec;
    const name = String(body.pedido || "");
    if (!/^S\d+$/.test(name)) return new Response(JSON.stringify({ ok: false, error: "pedido inválido" }), { headers: h });
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
    const ctx = { lang: "es_ES", allowed_company_ids: [2] };
    const ex = (m: string, meth: string, a: unknown[], kw: Rec = {}) => rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, m, meth, a, { ...kw, context: ctx }]) as Promise<Rec[]>;
    const so = await ex("sale.order", "search_read", [[["name", "=", name], ["company_id", "=", 2]]], { fields: ["name", "state", "date_order", "partner_id", "amount_untaxed", "amount_total", "invoice_status", "invoice_ids", "pricelist_id", "origin", "client_order_ref", "note"] });
    if (!so.length) return new Response(JSON.stringify({ ok: false, error: "no existe" }), { headers: h });
    const lines = await ex("sale.order.line", "search_read", [[["order_id", "=", so[0].id]]], { fields: ["sequence", "display_type", "product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "untaxed_amount_invoiced", "invoice_lines", "write_date"] });
    const invIds = so[0].invoice_ids as number[];
    const invs = invIds.length ? await ex("account.move", "read", [invIds], { fields: ["name", "move_type", "state", "invoice_date", "amount_untaxed", "amount_total", "reversed_entry_id", "ref", "invoice_origin", "create_date"] }) : [];
    const ilines = invIds.length ? await ex("account.move.line", "search_read", [[["move_id", "in", invIds], ["display_type", "=", "product"]]], { fields: ["move_id", "product_id", "name", "quantity", "price_unit", "discount", "price_subtotal", "sale_line_ids"] }) : [];
    return new Response(JSON.stringify({ ok: true, pedido: so[0], renglones: lines, facturas: invs, renglones_factura: ilines }), { headers: h });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h }); }
});
