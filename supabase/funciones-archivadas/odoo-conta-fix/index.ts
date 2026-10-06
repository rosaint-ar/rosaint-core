import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-fix v3 (JSON-RPC) - split_iva: separar una factura en 2 alicuotas (Imhoff)
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const IVA21 = 188, IVA105 = 186;
type Rec = Record<string, unknown>;
const m2o = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    if (body.batch !== "split_iva") return new Response(JSON.stringify({ ok: false, error: "batch?" }), { headers: cors });
    const uid = await authenticate();
    const ctx = { lang: "es_ES", allowed_company_ids: [1, 2] };
    const num = (body.num as string) || "00004-00002513";
    const base21 = Number(body.base21), base105 = Number(body.base105);
    const dryRun = body.dry_run !== false;
    const mv = await execKw(uid, "account.move", "search_read", [[["name", "ilike", num], ["move_type", "=", "in_invoice"]]], { fields: ["id", "name", "state", "amount_untaxed", "amount_tax", "amount_total", "invoice_line_ids"], limit: 2, context: ctx }) as Rec[];
    if (!mv.length) return new Response(JSON.stringify({ ok: false, error: "no encontrada" }), { headers: cors });
    if (mv.length > 1) return new Response(JSON.stringify({ ok: false, error: "más de una coincidencia" }), { headers: cors });
    const m = mv[0];
    const invLines = (m.invoice_line_ids as number[]) || [];
    const curLines = await execKw(uid, "account.move.line", "read", [invLines, ["id", "name", "price_subtotal", "account_id", "product_id"]], { context: ctx }) as Rec[];
    const acc = m2oId(curLines[0]?.account_id);
    const prod = m2oId(curLines[0]?.product_id);
    const nuevas = [
      { name: "Gravado 21%", quantity: 1, price_unit: base21, account_id: acc, product_id: prod, tax_ids: [[6, 0, [IVA21]]] },
      { name: "Gravado 10,5%", quantity: 1, price_unit: base105, account_id: acc, product_id: prod, tax_ids: [[6, 0, [IVA105]]] },
    ];
    const plan = { factura: m.name, estado: m.state, antes: { neto: m.amount_untaxed, iva: m.amount_tax, total: m.amount_total, lineas: curLines.map(l => ({ desc: l.name, subtotal: l.price_subtotal })) }, nuevas_lineas: nuevas.map(n => ({ desc: n.name, neto: n.price_unit, tax: n.tax_ids[0][2] })) };
    if (dryRun) return new Response(JSON.stringify({ ok: true, dry_run: true, plan }), { headers: cors });
    if (m.state === "posted") await execKw(uid, "account.move", "button_draft", [[m.id]], { context: ctx });
    const cmds: unknown[] = invLines.map(id => [2, id]);
    for (const n of nuevas) cmds.push([0, 0, n]);
    await execKw(uid, "account.move", "write", [[m.id], { invoice_line_ids: cmds }], { context: ctx });
    await execKw(uid, "account.move", "action_post", [[m.id]], { context: ctx });
    const ver = await execKw(uid, "account.move", "read", [[m.id], ["name", "state", "amount_untaxed", "amount_tax", "amount_total"]], { context: ctx }) as Rec[];
    const taxL = await execKw(uid, "account.move.line", "search_read", [[["move_id", "=", m.id], ["display_type", "=", "tax"]]], { fields: ["name", "balance"], context: ctx }) as Rec[];
    return new Response(JSON.stringify({ ok: true, plan, resultado: { ...ver[0], impuestos: taxL.map(t => ({ nombre: t.name, monto: Math.abs((t.balance as number) || 0) })) } }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
