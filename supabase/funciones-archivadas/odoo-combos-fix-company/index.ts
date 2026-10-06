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
    const dry = body.dry_run !== false;
    const log: string[] = [];
    if (!dry) {
      await call("mrp.bom", "write", [[337, 338, 339, 340], { company_id: 2 }]);
      log.push("boms 337,338,339,340 -> company 2");
      // borrar receta vacia duplicada 324 (MASOTERAPIA Neutro, company 1, sin lineas)
      const b324 = await call("mrp.bom", "read", [[324], ["bom_line_ids"]], { context: { active_test: false } });
      if (b324.length && (!b324[0].bom_line_ids || b324[0].bom_line_ids.length === 0)) { await call("mrp.bom", "unlink", [[324]]); log.push("bom 324 (vacia) eliminada"); }
      else log.push("bom 324 NO vacia, no se toca");
    }
    const verif = await call("mrp.bom", "read", [[322, 323, 325, 326, 327, 328, 337, 338, 339, 340], ["id", "product_id", "company_id"]], { context: { active_test: false } });
    return new Response(JSON.stringify({ ok: true, dry_run: dry, log, verif }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
