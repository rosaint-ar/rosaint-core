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

// Body: { precios: { "<variant_code>": <precio_final>, ... }, dry_run:true|false }
// Para cada template, toma el menor precio como base (list_price) y el resto como price_extra en su ptav.
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const body = await req.json().catch(() => ({}));
    const precios: Record<string, number> = body.precios || {};
    const dry = body.dry_run !== false;
    const codes = Object.keys(precios);
    if (!codes.length) return new Response(JSON.stringify({ ok: false, error: "Falta 'precios'" }), { headers: cors });

    // variantes por codigo
    const vIds = await call("product.product", "search", [[["default_code", "in", codes]]], { context: { active_test: false } });
    const vars = await call("product.product", "read", [vIds, ["id", "default_code", "product_tmpl_id", "product_template_attribute_value_ids"]], { context: { active_test: false } });

    // agrupar por template
    const porTmpl: Record<number, any[]> = {};
    for (const v of vars) { (porTmpl[v.product_tmpl_id[0]] ||= []).push(v); }

    const plan: any[] = [];
    for (const [tmplIdStr, vs] of Object.entries(porTmpl)) {
      const tmplId = Number(tmplIdStr);
      const conPrecio = vs.map((v) => ({ v, precio: precios[v.default_code] })).filter((x) => x.precio != null);
      const base = Math.min(...conPrecio.map((x) => x.precio));
      const p: any = { tmpl_id: tmplId, base, variantes: [] };
      if (!dry) await call("product.template", "write", [[tmplId], { list_price: base }]);
      for (const { v, precio } of conPrecio) {
        const extra = precio - base;
        const ptavId = v.product_template_attribute_value_ids[0];
        if (!dry) await call("product.template.attribute.value", "write", [[ptavId], { price_extra: extra }]);
        p.variantes.push({ code: v.default_code, variant_id: v.id, ptav_id: ptavId, precio_final: precio, extra });
      }
      plan.push(p);
    }

    // verificar
    let verif: any = null;
    if (!dry) verif = await call("product.product", "read", [vIds, ["default_code", "lst_price", "price_extra"]], { context: { active_test: false } });
    return new Response(JSON.stringify({ ok: true, dry_run: dry, plan, verificacion: verif }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
