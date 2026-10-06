import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-envios v4 (JSON-RPC) - rango de fechas del ingreso por envios
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const CUENTA_VENTA_PROD = "4.1.1.01.010";
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
async function rango(uid: number) {
  const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };
  const cta = await execKw(uid, "account.account", "search_read", [[["code", "=", CUENTA_VENTA_PROD]]], { fields: ["id"], context: ctx }) as Rec[];
  const tmpls = await execKw(uid, "product.template", "search_read", [[["categ_id.complete_name", "=", "Métodos de envío"]]], { fields: ["product_variant_ids"], context: ctx }) as Rec[];
  const variantIds = tmpls.flatMap(t => (t.product_variant_ids as number[]) || []);
  const dom = [["product_id", "in", variantIds], ["account_id", "=", cta[0].id], ["company_id", "=", COMPANY_ID], ["parent_state", "=", "posted"]];
  const first = await execKw(uid, "account.move.line", "search_read", [dom], { fields: ["date"], order: "date asc", limit: 1, context: ctx }) as Rec[];
  const last = await execKw(uid, "account.move.line", "search_read", [dom], { fields: ["date"], order: "date desc", limit: 1, context: ctx }) as Rec[];
  // por mes
  const porMes = await execKw(uid, "account.move.line", "read_group", [dom, ["balance:sum"], ["date:month"]], { context: ctx, lazy: false }) as Rec[];
  return { primera: first[0]?.date, ultima: last[0]?.date, por_mes: porMes.map(m => ({ mes: m["date:month"], monto: Math.abs((m.balance as number) || 0) })) };
}
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const uid = await authenticate();
    if (body.batch === "rango") return new Response(JSON.stringify({ ok: true, ...await rango(uid) }), { headers: cors });
    return new Response(JSON.stringify({ ok: false, error: "batch?" }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
