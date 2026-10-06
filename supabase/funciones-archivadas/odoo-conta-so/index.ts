import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-so v2 (JSON-RPC) - neutraliza la linea de descuento huerfana poniendo cantidad 0
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
async function neutralizar(uid: number, orderName: string, esperado: number, dryRun: boolean) {
  const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };
  const so = await execKw(uid, "sale.order", "search_read", [[["name", "=", orderName]]], { fields: ["id", "name", "invoice_status", "amount_total", "order_line"], context: ctx }) as Rec[];
  if (!so.length) return { error: "pedido no encontrado" };
  const o = so[0];
  const lineas = await execKw(uid, "sale.order.line", "read", [o.order_line], { fields: ["id", "name", "qty_invoiced", "qty_to_invoice", "price_unit", "price_subtotal"], context: ctx }) as Rec[];
  const cand = lineas.filter(l => (l.qty_invoiced as number) === 0 && Math.abs((l.qty_to_invoice as number) || 0) > 0.0001);
  if (cand.length !== 1) return { error: `Se esperaba 1 renglon a facturar, hay ${cand.length}`, candidatos: cand };
  const t = cand[0];
  if (Math.round((t.price_unit as number)) !== Math.round(esperado)) return { error: `El precio del renglon (${t.price_unit}) no coincide con lo esperado (${esperado})`, candidato: t };
  const antes = { estado_facturacion: o.invoice_status, total: o.amount_total, renglon: { id: t.id, desc: t.name, precio: t.price_unit, subtotal: t.price_subtotal } };
  if (dryRun) return { dry_run: true, antes };
  await execKw(uid, "sale.order.line", "write", [[t.id], { product_uom_qty: 0 }], { context: ctx });
  const so2 = await execKw(uid, "sale.order", "read", [[o.id]], { fields: ["invoice_status", "amount_total"], context: ctx }) as Rec[];
  const lin2 = await execKw(uid, "sale.order.line", "read", [[t.id]], { fields: ["qty_to_invoice", "product_uom_qty", "price_subtotal", "invoice_status"], context: ctx }) as Rec[];
  return { hecho: true, antes, despues: { estado_facturacion: so2[0].invoice_status, total: so2[0].amount_total, renglon: lin2[0] } };
}
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    if (body.batch !== "neutralizar_desc") return new Response(JSON.stringify({ ok: false, error: "batch?" }), { headers: cors });
    const uid = await authenticate();
    return new Response(JSON.stringify({ ok: true, ...await neutralizar(uid, (body.order as string) || "", Number(body.esperado), body.dry_run === true) }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
