import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const CTX = { allowed_company_ids: [1, 2], lang: "es_ES" };
const ATTR_PRESENTACION = 11;
const CATEG_COMBOS = 34;
const TAXES = [88, 187];

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

const COMBOS = [
  { name: "[COMBO] REDUCTOR INTENSIVO", variantes: [
    { pres: "Gel 250g + Crema 500g", code: "61201", comps: [199, 95] },
    { pres: "Gel 500g + Crema 1 Kg", code: "61202", comps: [99, 96] },
  ]},
  { name: "[COMBO] REAFIRMANTE INTENSIVO", variantes: [
    { pres: "Gel 250g + Crema 500g", code: "61301", comps: [199, 161] },
    { pres: "Gel 500g + Crema 1 Kg", code: "61302", comps: [99, 160] },
  ]},
];

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const body = await req.json().catch(() => ({}));
    const dry = body.dry_run !== false;
    const acciones: any[] = [];

    // componentes: uom
    const compIds = [...new Set(COMBOS.flatMap((c) => c.variantes.flatMap((v) => v.comps)))];
    const comps = await call("product.product", "read", [compIds, ["id", "default_code", "name", "uom_id"]]);
    const compMap: any = Object.fromEntries(comps.map((c: any) => [c.id, c]));

    // valores de Presentación (buscar; crear si falta)
    const presNames = [...new Set(COMBOS.flatMap((c) => c.variantes.map((v) => v.pres)))];
    const presMap: Record<string, number> = {};
    for (const nm of presNames) {
      const found = await call("product.attribute.value", "search", [[["attribute_id", "=", ATTR_PRESENTACION], ["name", "=", nm]]]);
      if (found.length) presMap[nm] = found[0];
      else if (dry) { presMap[nm] = -1; acciones.push(`CREAR valor Presentación "${nm}"`); }
      else { presMap[nm] = await call("product.attribute.value", "create", [{ attribute_id: ATTR_PRESENTACION, name: nm }]); acciones.push(`valor Presentación "${nm}" creado id ${presMap[nm]}`); }
    }
    const valId2def = (combo: any) => { const m: Record<number, any> = {}; for (const v of combo.variantes) m[presMap[v.pres]] = v; return m; };

    const resultado: any[] = [];
    for (const combo of COMBOS) {
      const presIds = [...new Set(combo.variantes.map((v) => presMap[v.pres]))];
      const rc: any = { nombre: combo.name };

      // template existente?
      const tIds = await call("product.template", "search", [[["name", "=", combo.name]]], { context: { active_test: false } });
      let tmplId = tIds[0];
      if (!tmplId) {
        if (dry) { rc.template = "CREAR nuevo"; rc.variantes = combo.variantes.map((v) => ({ code: v.code, pres: v.pres, comps: v.comps })); resultado.push(rc); continue; }
        tmplId = await call("product.template", "create", [{
          name: combo.name, categ_id: CATEG_COMBOS, type: "consu", sale_ok: true, purchase_ok: false,
          invoice_policy: "order", list_price: 0, taxes_id: [[6, 0, TAXES]],
          attribute_line_ids: [[0, 0, { attribute_id: ATTR_PRESENTACION, value_ids: [[6, 0, presIds]] }]],
        }]);
        rc.template = `creado id ${tmplId}`;
      } else rc.template = `ya existía id ${tmplId}`;

      // variantes
      const tmpl = (await call("product.template", "read", [[tmplId], ["product_variant_ids"]]))[0];
      const vars = await call("product.product", "read", [tmpl.product_variant_ids, ["id", "default_code", "product_template_attribute_value_ids"]]);
      const ptavIds = [...new Set(vars.flatMap((v: any) => v.product_template_attribute_value_ids))];
      const ptavs = await call("product.template.attribute.value", "read", [ptavIds, ["id", "product_attribute_value_id"]]);
      const ptav2val: Record<number, number> = Object.fromEntries(ptavs.map((p: any) => [p.id, p.product_attribute_value_id[0]]));
      const d = valId2def(combo);
      rc.variantes = [];
      for (const v of vars) {
        const valId = ptav2val[v.product_template_attribute_value_ids[0]];
        const def = d[valId];
        if (!def) { rc.variantes.push({ variant_id: v.id, error: `sin match (valId ${valId})` }); continue; }
        const rv: any = { variant_id: v.id, code: def.code, comps: def.comps };
        if (!dry) {
          if (!v.default_code) await call("product.product", "write", [[v.id], { default_code: def.code }]);
          const bomEx = await call("mrp.bom", "search", [[["product_id", "=", v.id]]], { context: { active_test: false } });
          if (bomEx.length) rv.bom = `ya existía id ${bomEx[0]}`;
          else {
            rv.bom = await call("mrp.bom", "create", [{
              product_tmpl_id: tmplId, product_id: v.id, type: "phantom", product_qty: 1, product_uom_id: 1,
              bom_line_ids: def.comps.map((cid) => [0, 0, { product_id: cid, product_qty: 1, product_uom_id: compMap[cid].uom_id[0] }]),
            }]);
          }
        }
        rc.variantes.push(rv);
      }
      resultado.push(rc);
    }
    return new Response(JSON.stringify({ ok: true, dry_run: dry, acciones, resultado }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
