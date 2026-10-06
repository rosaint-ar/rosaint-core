import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-productos v3 (JSON-RPC) - batch nc_descuento: producto para NC de descuento
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const IVA21_VENTAS = 187;
const CUENTA_DESC = "5.2.1.01.080";
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

async function ncDescuento(uid: number) {
  const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };
  const nombre = "Descuento comercial";
  const ya = await execKw(uid, "product.template", "search_read", [[["name", "=", nombre]]], { fields: ["id", "name"], context: ctx }) as Rec[];
  if (ya.length) return { estado: "ya existe", id: ya[0].id };
  const acc = await execKw(uid, "account.account", "search_read", [[["code", "=", CUENTA_DESC]]], { fields: ["id", "name"], context: ctx }) as Rec[];
  if (!acc.length) return { error: "cuenta " + CUENTA_DESC + " no encontrada" };
  const vals: Rec = { name: nombre, type: "service", sale_ok: true, purchase_ok: false, property_account_income_id: acc[0].id, taxes_id: [[6, 0, [IVA21_VENTAS]]] };
  const id = await execKw(uid, "product.template", "create", [vals], { context: ctx }) as number;
  const ver = await execKw(uid, "product.template", "read", [[id]], { fields: ["id", "name", "type", "sale_ok", "purchase_ok", "property_account_income_id", "taxes_id", "categ_id"], context: ctx }) as Rec[];
  const v = ver[0];
  return { estado: "creado", id, verificacion: { nombre: v.name, tipo: v.type, venta: v.sale_ok, compra: v.purchase_ok, cuenta_ingreso: m2o(v.property_account_income_id), impuestos: ((v.taxes_id as number[]) || []).length, categoria: m2o(v.categ_id) } };
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const uid = await authenticate();
    if (body.batch === "nc_descuento") return new Response(JSON.stringify({ ok: true, ...await ncDescuento(uid) }), { headers: cors });
    return new Response(JSON.stringify({ ok: false, error: "batch no soportado" }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
