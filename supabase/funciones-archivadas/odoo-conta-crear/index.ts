import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-crear v3 - alta/edicion de proveedor, producto y factura + posteo + registro de pago
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid; return uid;
}
const CTX = { lang: "es_ES", allowed_company_ids: [2] };
async function kw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  kwargs.context = { ...CTX, ...((kwargs.context as Rec) || {}) };
  return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}
const F_PARTNER = ["id", "name", "vat", "street", "city", "zip", "state_id", "country_id", "phone", "l10n_latam_identification_type_id", "l10n_ar_afip_responsibility_type_id", "l10n_ar_gross_income_number", "l10n_ar_gross_income_type", "supplier_rank", "property_account_payable_id"];
const F_MOVE = ["id", "name", "state", "move_type", "journal_id", "l10n_latam_document_type_id", "l10n_latam_document_number", "invoice_date", "date", "partner_id", "ref", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "currency_id"];
const F_LINE = ["id", "display_type", "product_id", "name", "account_id", "quantity", "price_unit", "debit", "credit", "tax_ids", "reconciled", "full_reconcile_id"];

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out: Rec = {};
  try {
    const body = await req.json() as Rec;
    const uid = await auth();

    if (body.partner) {
      const p = body.partner as Rec;
      const ya = await kw(uid, "res.partner", "search_read", [[["vat", "=", p.vat]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
      if (ya.length) out.partner = { existia: true, ...ya[0] };
      else { const id = await kw(uid, "res.partner", "create", [p]) as number; out.partner = await kw(uid, "res.partner", "read", [[id], F_PARTNER]); }
    }
    if (body.partner_write) {
      const w = body.partner_write as { id: number; vals: Rec };
      out.partner_antes = await kw(uid, "res.partner", "read", [[w.id], F_PARTNER]);
      await kw(uid, "res.partner", "write", [[w.id], w.vals]);
      out.partner = await kw(uid, "res.partner", "read", [[w.id], F_PARTNER]);
    }
    if (body.producto) {
      const pr = body.producto as Rec;
      const ya = await kw(uid, "product.template", "search_read", [[["default_code", "=", pr.default_code]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
      if (ya.length) out.producto = { existia: true, ...ya[0] };
      else {
        const id = await kw(uid, "product.template", "create", [pr]) as number;
        out.producto = await kw(uid, "product.template", "read", [[id], ["id", "default_code", "name", "categ_id", "property_account_expense_id", "supplier_taxes_id"]]);
        out.producto_variante = await kw(uid, "product.product", "search_read", [[["product_tmpl_id", "=", id]]], { fields: ["id", "default_code"] });
      }
    }
    if (body.factura) {
      const id = await kw(uid, "account.move", "create", [body.factura]) as number;
      out.factura = await kw(uid, "account.move", "read", [[id], F_MOVE]);
      out.factura_lineas = await kw(uid, "account.move.line", "search_read", [[["move_id", "=", id]]], { fields: F_LINE, order: "id" });
    }

    const mid = body.postear_move_id ? Number(body.postear_move_id) : (body.pagar ? Number((body.pagar as Rec).move_id) : 0);

    if (body.postear_move_id) {
      try { await kw(uid, "account.move", "action_post", [[mid]]); out.posteo = { ok: true }; }
      catch (e) { out.posteo = { ok: false, error: String((e as Error).message || e) }; }
    }

    if (body.pagar) {
      const pg = body.pagar as Rec;
      try {
        const ctxPago = { ...CTX, active_model: "account.move", active_ids: [Number(pg.move_id)] };
        const vals: Rec = { journal_id: pg.journal_id, payment_date: pg.payment_date };
        if (pg.amount !== undefined) vals.amount = pg.amount;
        if (pg.memo !== undefined) vals.memo = pg.memo;
        const wid = await kw(uid, "account.payment.register", "create", [vals], { context: ctxPago }) as number;
        out.wizard = await kw(uid, "account.payment.register", "read", [[wid], ["amount", "payment_date", "journal_id", "payment_type", "communication"]], { context: ctxPago });
        await kw(uid, "account.payment.register", "action_create_payments", [[wid]], { context: ctxPago });
        out.pago = { ok: true };
        out.pagos = await kw(uid, "account.payment", "search_read", [[["partner_id", "=", pg.partner_id], ["date", "=", pg.payment_date]]], { fields: ["id", "name", "date", "amount", "journal_id", "state", "payment_type", "memo"] });
      } catch (e) { out.pago = { ok: false, error: String((e as Error).message || e) }; }
    }

    if (mid) {
      out.factura = await kw(uid, "account.move", "read", [[mid], F_MOVE]);
      out.factura_lineas = await kw(uid, "account.move.line", "search_read", [[["move_id", "=", mid]]], { fields: F_LINE, order: "id" });
    }

    return new Response(JSON.stringify({ ok: true, ...out }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e), parcial: out }, null, 1), { headers: cors, status: 200 });
  }
});
