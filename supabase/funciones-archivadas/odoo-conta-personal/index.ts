import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-personal v3 (JSON-RPC) - unificar la cuenta/producto no deducibles con gastos varios no operativos
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const IVA21_COMPRAS = 188;
const NOMBRE = "Gastos varios no operativos";
type Rec = Record<string, unknown>;
const m2o = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
async function accByCode(uid: number, code: string, ctx: Rec) { const r = await execKw(uid, "account.account", "search_read", [[["code", "=", code]]], { fields: ["id", "code", "name", "deprecated"], context: ctx }) as Rec[]; return r[0] || null; }
async function movs(uid: number, accId: number, ctx: Rec) { return await execKw(uid, "account.move.line", "search_count", [[["account_id", "=", accId], ["company_id", "=", COMPANY_ID]]], { context: ctx }) as number; }
async function unificar(uid: number, dryRun: boolean) {
  const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };
  const cta010 = await accByCode(uid, "5.9.1.01.010", ctx);
  const cta030 = await accByCode(uid, "5.9.1.01.030", ctx);
  const prodGN = await execKw(uid, "product.template", "search_read", [[["default_code", "=", "GN01"]]], { fields: ["id", "name", "property_account_expense_id", "supplier_taxes_id"], context: ctx }) as Rec[];
  const prod459 = await execKw(uid, "product.template", "read", [[459]], { fields: ["id", "name", "active"], context: ctx }) as Rec[];
  const mov010 = cta010 ? await movs(uid, cta010.id as number, ctx) : 0;
  const mov030 = cta030 ? await movs(uid, cta030.id as number, ctx) : 0;
  const estado = { cta010, mov010, cta030, mov030, productoGN01: prodGN[0] || null, producto459: prod459[0] || null };
  if (dryRun) return { dry_run: true, estado, plan: ["renombrar 5.9.1.01.010 -> " + NOMBRE, "renombrar producto GN01 -> " + NOMBRE + " (IVA 21%)", "desactivar 5.9.1.01.030 (movs: " + mov030 + ")", "desactivar producto 459"] };
  const hechos: string[] = [];
  if (cta010) { await execKw(uid, "account.account", "write", [[cta010.id], { name: NOMBRE }], { context: ctx }); hechos.push("cuenta 010 renombrada"); }
  if (prodGN.length) { await execKw(uid, "product.template", "write", [[prodGN[0].id], { name: NOMBRE, supplier_taxes_id: [[6, 0, [IVA21_COMPRAS]]] }], { context: ctx }); hechos.push("producto GN01 renombrado + IVA21"); }
  if (cta030) { if (mov030 === 0) { await execKw(uid, "account.account", "write", [[cta030.id], { deprecated: true }], { context: ctx }); hechos.push("cuenta 030 desactivada (deprecated)"); } else hechos.push("cuenta 030 NO desactivada: tiene " + mov030 + " movs"); }
  if (prod459.length) { await execKw(uid, "product.template", "write", [[459], { active: false }], { context: ctx }); hechos.push("producto 459 desactivado"); }
  const verif010 = await accByCode(uid, "5.9.1.01.010", ctx);
  const verif030 = await accByCode(uid, "5.9.1.01.030", ctx);
  return { hechos, verif: { cta010: verif010, cta030: verif030 } };
}
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const uid = await authenticate();
    if (body.batch === "unificar") return new Response(JSON.stringify({ ok: true, ...await unificar(uid, body.dry_run === true) }), { headers: cors });
    return new Response(JSON.stringify({ ok: false, error: "batch?" }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
