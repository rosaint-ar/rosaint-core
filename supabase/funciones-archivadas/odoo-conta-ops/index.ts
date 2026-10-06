import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-ops v3 - operaciones contables por pasos, con foto antes/despues
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
const F_MOVE = ["id", "name", "state", "invoice_date", "date", "partner_id", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state"];
const F_LINE = ["id", "display_type", "product_id", "name", "account_id", "quantity", "price_unit", "debit", "credit", "tax_ids", "tax_line_id", "reconciled"];

async function fotoProveedor(uid: number, partnerId: number) {
  const lineas = await kw(uid, "account.move.line", "search_read", [[
    ["company_id", "=", 2], ["partner_id", "=", partnerId],
    ["account_id.account_type", "=", "liability_payable"], ["parent_state", "=", "posted"],
  ]], { fields: ["id", "move_name", "date", "debit", "credit", "amount_residual", "reconciled"], order: "date,id" }) as Rec[];
  const saldo = lineas.reduce((a, l) => a + (Number(l.debit) - Number(l.credit)), 0);
  return { saldo: Math.round(saldo * 100) / 100, lineas };
}

const F_PROD = ["id", "default_code", "name", "standard_price", "qty_available", "quantity_svl", "value_svl", "uom_id"];
async function fotoProducto(uid: number, productId: number) {
  const p = (await kw(uid, "product.product", "read", [[productId], F_PROD]) as Rec[])[0];
  const capas = await kw(uid, "stock.valuation.layer", "search_read", [[["product_id", "=", productId], ["company_id", "=", 2], ["remaining_qty", "!=", 0]]],
    { fields: ["id", "create_date", "reference", "quantity", "unit_cost", "value", "remaining_qty", "remaining_value"], order: "id" });
  return { producto: p, capas };
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out: Rec = {}; const pasos: Rec[] = [];
  try {
    const body = await req.json() as Rec;
    const uid = await auth();
    const pid = body.partner_id ? Number(body.partner_id) : 0;
    const mid = body.move_id ? Number(body.move_id) : 0;
    const prid = body.product_id ? Number(body.product_id) : 0;
    if (pid) out.antes = await fotoProveedor(uid, pid);
    if (prid) out.producto_antes = await fotoProducto(uid, prid);

    const paso = async (nombre: string, fn: () => Promise<unknown>) => {
      try { const r = await fn(); pasos.push({ paso: nombre, ok: true, r }); return r; }
      catch (e) { pasos.push({ paso: nombre, ok: false, error: String((e as Error).message || e) }); return null; }
    };

    if (Array.isArray(body.a_borrador)) for (const m of body.a_borrador as number[]) await paso(`borrador ${m}`, () => kw(uid, "account.move", "button_draft", [[m]]));

    if (Array.isArray(body.cancelar_pagos)) {
      for (const id of body.cancelar_pagos as number[]) {
        await paso(`draft pago ${id}`, () => kw(uid, "account.payment", "action_draft", [[id]]));
        await paso(`cancelar pago ${id}`, () => kw(uid, "account.payment", "action_cancel", [[id]]));
      }
    }

    if (Array.isArray(body.crear_pagos)) {
      const creados: Rec[] = [];
      for (const p of body.crear_pagos as Rec[]) {
        const id = await paso(`crear pago ${p.date} ${p.amount}`, () => kw(uid, "account.payment", "create", [p])) as number | null;
        if (id) {
          await paso(`postear pago ${id}`, () => kw(uid, "account.payment", "action_post", [[id]]));
          creados.push(((await kw(uid, "account.payment", "read", [[id], ["id", "name", "date", "amount", "journal_id", "state"]])) as Rec[])[0]);
        }
      }
      out.pagos_creados = creados;
    }

    if (body.crear_asiento) {
      const id = await paso("crear asiento", () => kw(uid, "account.move", "create", [body.crear_asiento])) as number | null;
      if (id) {
        if (body.postear_asiento) await paso(`postear asiento ${id}`, () => kw(uid, "account.move", "action_post", [[id]]));
        out.asiento = await kw(uid, "account.move", "read", [[id], ["id", "name", "state", "date", "ref"]]);
        out.asiento_lineas = await kw(uid, "account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["id", "account_id", "name", "debit", "credit"], order: "id" });
      }
    }

    // escribir en el asiento (permite comandos sobre invoice_line_ids / line_ids)
    if (body.escribir_move) {
      const w = body.escribir_move as { id: number; vals: Rec };
      await paso(`escribir move ${w.id}`, () => kw(uid, "account.move", "write", [[w.id], w.vals], { context: { check_move_validity: false } }));
    }

    if (Array.isArray(body.ajustar_lineas)) {
      for (const a of body.ajustar_lineas as Rec[]) {
        await paso(`ajustar linea ${a.id}`, () => kw(uid, "account.move.line", "write", [[Number(a.id)], a.vals], { context: { check_move_validity: false } }));
      }
    }

    if (Array.isArray(body.postear_moves)) for (const m of body.postear_moves as number[]) await paso(`postear ${m}`, () => kw(uid, "account.move", "action_post", [[m]]));

    if (Array.isArray(body.conciliar)) for (const g of body.conciliar as number[][]) await paso(`conciliar ${JSON.stringify(g)}`, () => kw(uid, "account.move.line", "reconcile", [g]));

    // revaluacion de stock: usa el asistente nativo de Odoo
    if (body.revaluar) {
      const rv = body.revaluar as Rec;
      const vals: Rec = {
        product_id: Number(rv.product_id),
        added_value: Number(rv.added_value),
        reason: rv.reason ?? "",
        company_id: 2,
      };
      if (rv.account_id) vals.account_id = Number(rv.account_id);
      if (rv.account_journal_id) vals.account_journal_id = Number(rv.account_journal_id);
      if (rv.date) vals.date = rv.date;
      const wid = await paso("crear asistente revaluacion", () => kw(uid, "stock.valuation.layer.revaluation", "create", [vals])) as number | null;
      if (wid) {
        out.revaluacion_previa = await kw(uid, "stock.valuation.layer.revaluation", "read", [[wid], ["current_value_svl", "current_quantity_svl", "added_value", "new_value", "new_value_by_qty", "account_id", "account_journal_id", "date"]]);
        if (!rv.solo_simular) await paso(`aplicar revaluacion ${wid}`, () => kw(uid, "stock.valuation.layer.revaluation", "action_validate_revaluation", [[wid]]));
      }
    }

    // escotilla generica: [{paso, model, method, args, kwargs}]
    if (Array.isArray(body.llamar)) {
      const res: Rec[] = [];
      for (const c of body.llamar as Rec[]) {
        const etiqueta = String(c.paso || `${c.model}.${c.method}`);
        const r = await paso(etiqueta, () => kw(uid, String(c.model), String(c.method), (c.args as unknown[]) || [], (c.kwargs as Rec) || {}));
        res.push({ paso: etiqueta, r });
      }
      out.llamadas = res;
    }

    if (mid) {
      out.move = await kw(uid, "account.move", "read", [[mid], F_MOVE]);
      out.lineas = await kw(uid, "account.move.line", "search_read", [[["move_id", "=", mid]]], { fields: F_LINE, order: "id" });
    }
    if (pid) out.despues = await fotoProveedor(uid, pid);
    if (prid) out.producto_despues = await fotoProducto(uid, prid);
    return new Response(JSON.stringify({ ok: true, pasos, ...out }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e), pasos, ...out }, null, 1), { headers: cors, status: 200 });
  }
});
