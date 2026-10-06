import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-precios-config v2 — SOLO LECTURA.
// {} => impuestos + tarifas + resumen de reglas.
// {"detalle":true} => precio fijo por producto en Lista 1 Público (53),
//    Lista 2 Profesionales (32) y Lista 5 Tienda Online (56) + list_price.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };

    if (body.detalle === true) {
      const listIds = [53, 32, 56];
      const its = await execKw(uid, "product.pricelist.item", "search_read",
        [[["pricelist_id", "in", listIds]]],
        { fields: ["pricelist_id", "product_tmpl_id", "fixed_price", "compute_price", "min_quantity", "applied_on"], context: ctx, limit: 3000 }) as Rec[];
      const tmplIds = [...new Set(its.filter(i => Array.isArray(i.product_tmpl_id)).map(i => (i.product_tmpl_id as unknown[])[0] as number))];
      const tmpls = tmplIds.length ? await execKw(uid, "product.template", "read", [tmplIds], { fields: ["default_code", "name", "list_price", "taxes_id"], context: ctx }) as Rec[] : [];
      const tmap: Record<number, Rec> = {}; for (const t of tmpls) tmap[t.id as number] = t;
      const rows = its.map(i => {
        const tid = Array.isArray(i.product_tmpl_id) ? (i.product_tmpl_id as unknown[])[0] as number : null;
        const t = tid ? tmap[tid] : null;
        return {
          lista_id: Array.isArray(i.pricelist_id) ? (i.pricelist_id as unknown[])[0] : null,
          lista: Array.isArray(i.pricelist_id) ? (i.pricelist_id as unknown[])[1] : null,
          codigo: t?.default_code ?? null,
          nombre: t?.name ?? null,
          list_price: t?.list_price ?? null,
          fixed_price: i.fixed_price,
          compute: i.compute_price,
          min_qty: i.min_quantity,
          applied_on: i.applied_on,
        };
      });
      return new Response(JSON.stringify({ ok: true, detalle: rows }), { headers: cors });
    }

    const empresa = await execKw(uid, "res.company", "read", [[COMPANY_ID]], { fields: ["id", "name"], context: ctx });
    const taxes = await execKw(uid, "account.tax", "search_read", [[["type_tax_use", "=", "sale"], ["company_id", "=", COMPANY_ID]]], { fields: ["id", "name", "amount", "price_include"], context: ctx });
    const pricelists = await execKw(uid, "product.pricelist", "search_read", [[]], { fields: ["id", "name"], context: ctx });
    return new Response(JSON.stringify({ ok: true, empresa, taxes, pricelists }, null, 2), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
