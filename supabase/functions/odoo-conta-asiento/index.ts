import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// ====== odoo-conta-asiento v2 — asientos contables de lote FIJO (Rosaint, company 2) ======
// Solo hace operaciones predefinidas y aprobadas por Dirección; nada genérico.
// Entra únicamente con la clave interna (x-cron-key): no se llama desde las pantallas.
// Body: { lote: "<nombre>", paso: "...", dry_run?: true }
//
// Lote "iva_combustible" (aprobado 13-oct-2026): el IVA de 12 tickets de combustible
// ($104.742,11) no se computó en las DDJJ F.2051 de mayo a agosto 2026 (decisión/error del
// contador anterior); se toma en la DDJJ de septiembre.
//   paso "reclasificar" (31/08/2026): IVA crédito fiscal → IVA crédito fiscal a recuperar.
//   paso "recuperar"    (30/09/2026): la vuelta, cuando la contadora confirme que lo computó.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2;
const CTX = { lang: "es_ES", allowed_company_ids: [C] };
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function uid(): Promise<number> {
  if (_uid) return _uid;
  const u = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!u || typeof u !== "number") throw new Error("Auth Odoo fallida");
  return (_uid = u);
}
const ex = async (model: string, method: string, args: unknown[], kw: Rec = {}) =>
  rpc("object", "execute_kw", [ODOO_DB, await uid(), ODOO_KEY, model, method, args, { ...kw, context: { ...CTX, ...((kw.context as Rec) || {}) } }]);

const LOTE = {
  importe: 104742.11,
  cuenta_iva: "1.1.4.04.010",
  cuenta_nueva: { code: "1.1.4.04.060", name: "IVA crédito fiscal a recuperar (no computado)" },
  detalle: "IVA combustible no computado en DDJJ may-ago 2026 (may 28.092,46 · jun 19.214,29 · jul 28.601,27 · ago 28.834,09) — 12 tickets",
  pasos: {
    reclasificar: { fecha: "2026-08-31", ref: "IVA-COMB-NO-COMPUTADO-MAY-AGO", debe: "nueva", haber: "iva" },
    recuperar: { fecha: "2026-09-30", ref: "IVA-COMB-RECUPERADO-SEP", debe: "iva", haber: "nueva" },
  } as Record<string, { fecha: string; ref: string; debe: string; haber: string }>,
};

async function cuenta(code: string): Promise<number | null> {
  const r = await ex("account.account", "search_read", [[["code", "=", code], ["company_ids", "in", [C]]]], { fields: ["id"] }) as Rec[];
  return r.length ? r[0].id as number : null;
}

async function iva_combustible(body: Rec): Promise<Rec> {
  const p = LOTE.pasos[String(body.paso || "")];
  if (!p) return { ok: false, error: "paso desconocido (reclasificar | recuperar)" };
  const dry = !!body.dry_run;
  const log: string[] = [];
  // ya cargado? (idempotente)
  const ya = await ex("account.move", "search_read", [[["ref", "=", p.ref], ["company_id", "=", C], ["state", "!=", "cancel"]]], { fields: ["name", "state", "date"] }) as Rec[];
  if (ya.length) return { ok: true, ya_existia: ya };
  const idIva = await cuenta(LOTE.cuenta_iva); if (!idIva) return { ok: false, error: "no encuentro la cuenta " + LOTE.cuenta_iva };
  let idNueva = await cuenta(LOTE.cuenta_nueva.code);
  if (!idNueva) {
    if (body.paso === "recuperar") return { ok: false, error: "la cuenta a recuperar no existe" };
    log.push("crear cuenta " + LOTE.cuenta_nueva.code + " " + LOTE.cuenta_nueva.name);
    if (!dry) idNueva = await ex("account.account", "create", [{ code: LOTE.cuenta_nueva.code, name: LOTE.cuenta_nueva.name, account_type: "asset_current", reconcile: false, company_ids: [[6, 0, [C]]] }]) as number;
  }
  const diario = await ex("account.journal", "search_read", [[["company_id", "=", C], ["type", "=", "general"], ["code", "in", ["MISC", "VARIO", "Vario"]]]], { fields: ["id", "name", "code"] }) as Rec[];
  const diarioG = diario.length ? diario : await ex("account.journal", "search_read", [[["company_id", "=", C], ["type", "=", "general"]]], { fields: ["id", "name", "code"], limit: 1 }) as Rec[];
  if (!diarioG.length) return { ok: false, error: "no hay diario de operaciones varias" };
  const cta = (k: string) => k === "iva" ? idIva : idNueva;
  const linea = (acc: number | null, debit: number, credit: number) => [0, 0, { account_id: acc, name: LOTE.detalle, debit, credit, tax_ids: [[6, 0, []]], tax_tag_ids: [[6, 0, []]] }];
  const vals = { move_type: "entry", journal_id: diarioG[0].id, date: p.fecha, ref: p.ref, company_id: C,
    line_ids: [linea(cta(p.debe), LOTE.importe, 0), linea(cta(p.haber), 0, LOTE.importe)] };
  log.push(`asiento ${p.fecha} en ${diarioG[0].name}: Debe ${p.debe === "iva" ? LOTE.cuenta_iva : LOTE.cuenta_nueva.code} / Haber ${p.haber === "iva" ? LOTE.cuenta_iva : LOTE.cuenta_nueva.code} por ${LOTE.importe}`);
  if (dry) return { ok: true, dry_run: true, log };
  const mid = await ex("account.move", "create", [vals]) as number;
  await ex("account.move", "action_post", [[mid]]);
  const m = await ex("account.move", "read", [[mid], ["name", "state", "date", "ref"]]) as Rec[];
  const ls = await ex("account.move.line", "search_read", [[["move_id", "=", mid]]], { fields: ["account_id", "debit", "credit", "tax_line_id"] }) as Rec[];
  return { ok: true, log, asiento: m[0], lineas: ls };
}

// ---------------------------------------------------------------------------------------------
// Lote "combustible_internos" (aprobado 13-oct-2026): los 19 tickets de combustible pasan de
// "renglón gravado + renglón de tributos con IVA 0%" a "un renglón gravado con IVA 21% +
// Impuestos internos (+ Percepción IVA RG 2408 en Pan American)". Total, neto e IVA no cambian
// (verificado contra las DDJJ presentadas); el interno pasa a su casillero del libro de IVA.
//   paso "config": Impuestos internos (149) al 1% (se pisa con el importe real, como las
//                  percepciones) y a la cuenta 5.2.1.01.050 Movilidad y viáticos (opción 2).
//   paso "ticket" {nombre}: corrige UN ticket con controles; si algo no da exacto no lo valida.
type T = { neto: number; iva: number; interno: number; perc: number; total: number };
const TICKETS: Record<string, T> = {
  "TF-A 00024-00073500": { neto: 20330.59, iva: 4269.42, interno: 5399.93, perc: 0, total: 29999.94 },
  "TF-A 00024-00074036": { neto: 20667.82, iva: 4340.24, interno: 4991.92, perc: 0, total: 29999.98 },
  "TF-A 00019-00048466": { neto: 50004.15, iva: 10500.87, interno: 9566.01, perc: 0, total: 70071.03 },
  "FA-A 08888-00049218": { neto: 35296.7, iva: 7412.31, interno: 7291.07, perc: 0, total: 50000.08 },
  "TF-A 00020-00089604": { neto: 34876.12, iva: 7323.99, interno: 7800, perc: 0, total: 50000.11 },
  "TF-A 00020-00090070": { neto: 34876.14, iva: 7323.99, interno: 7799.98, perc: 0, total: 50000.11 },
  "TF-A 00023-00066262": { neto: 64021.35, iva: 13444.48, interno: 14547.07, perc: 0, total: 92012.9 },
  "TF-A 00020-00091140": { neto: 67435.34, iva: 14161.42, interno: 15403.33, perc: 0, total: 97000.09 },
  "TF-A 05422-00001384": { neto: 35320.73, iva: 7417.35, interno: 7261.88, perc: 1059.62, total: 51059.58 },
  "TF-A 00023-00068294": { neto: 20857.48, iva: 4380.07, interno: 4762.51, perc: 0, total: 30000.06 },
  "TF-A 05463-00001745": { neto: 35318.45, iva: 7416.87, interno: 7264.64, perc: 1059.55, total: 51059.51 },
  "TF-A 05422-00001757": { neto: 73501.19, iva: 15435.25, interno: 16084.58, perc: 2205.04, total: 107226.06 },
  "TF-A 05422-00001780": { neto: 27994.83, iva: 5878.91, interno: 6126.23, perc: 839.84, total: 40839.81 },
  "TF-A 00019-00040639": { neto: 34700.5, iva: 7287.11, interno: 8012.37, perc: 0, total: 49999.98 },
  "TF-A 05422-00001992": { neto: 34859.99, iva: 7320.6, interno: 7860.39, perc: 1045.8, total: 51086.78 },
  "FA-A 08318-00054982": { neto: 67833.99, iva: 14245.14, interno: 15922.85, perc: 0, total: 98001.98 },
  "TF-A 00019-00041839": { neto: 34611.19, iva: 7268.35, interno: 8120.56, perc: 0, total: 50000.1 },
  "TF-A 00046-00016396": { neto: 34578.9, iva: 7261.57, interno: 8159.56, perc: 0, total: 50000.03 },
  "TF-A 00019-00042776": { neto: 34621.83, iva: 7270.58, interno: 8107.65, perc: 0, total: 50000.06 },
};
// Tickets nuevos a cargar con el método nuevo (datos del ticket impreso)
type N = { partner: number; diario: number; tipo_doc: number; numero: string; fecha: string; neto: number; iva: number; interno: number; perc: number; total: number };
const NUEVOS: Record<string, N> = {
  // Pan American, foto del 13-oct-2026: neto 35.543,11 · IVA 7.464,05 · "10 Impuesto interno" 6.992,82 · "09 IVA RI" 1.066,29 · total 51.066,27
  "TF-A 05422-00002555": { partner: 892, diario: 33, tipo_doc: 56, numero: "05422-00002555", fecha: "2026-10-01", neto: 35543.11, iva: 7464.05, interno: 6992.82, perc: 1066.29, total: 51066.27 },
};
const TAX_IVA = 188, TAX_INT = 149, TAX_PERC = 195, PROD_GRAV = 256, CTA_MOVILIDAD = 766;
const r2 = (x: number) => Math.round(x * 100) / 100;
const m2o = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;

async function combustible_internos(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run;
  if (body.paso === "config") {
    const t = (await ex("account.tax", "read", [[TAX_INT], ["amount", "invoice_repartition_line_ids", "refund_repartition_line_ids"]]) as Rec[])[0];
    const repIds = [...(t.invoice_repartition_line_ids as number[]), ...(t.refund_repartition_line_ids as number[])];
    const reps = await ex("account.tax.repartition.line", "read", [repIds, ["repartition_type", "account_id"]]) as Rec[];
    const antes = { amount: t.amount, cuentas: reps.map(r => [r.id, r.repartition_type, r.account_id]) };
    if (dry) return { ok: true, dry_run: true, antes };
    const cmd = (ids: number[]) => reps.filter(r => ids.includes(r.id as number) && r.repartition_type === "tax").map(r => [1, r.id, { account_id: CTA_MOVILIDAD }]);
    await ex("account.tax", "write", [[TAX_INT], { amount: 1, invoice_repartition_line_ids: cmd(t.invoice_repartition_line_ids as number[]), refund_repartition_line_ids: cmd(t.refund_repartition_line_ids as number[]) }]);
    const t2 = (await ex("account.tax", "read", [[TAX_INT], ["amount"]]) as Rec[])[0];
    const reps2 = await ex("account.tax.repartition.line", "read", [repIds, ["repartition_type", "account_id"]]) as Rec[];
    return { ok: true, antes, despues: { amount: t2.amount, cuentas: reps2.map(r => [r.id, r.repartition_type, r.account_id]) } };
  }
  // paso "productos": que la carga nueva salga sola con el método nuevo y no se pueda volver al viejo.
  //   GA06 trae por defecto IVA 21% + Impuestos internos; GA07 (renglón de tributos al 0%) se archiva.
  //   Si alguien cargara el método viejo, el 1% de internos haría que el total no cierre contra el ticket.
  if (body.paso === "productos") {
    const antes = await ex("product.product", "read", [[PROD_GRAV, 388], ["display_name", "supplier_taxes_id", "active"]]) as Rec[];
    if (dry) return { ok: true, dry_run: true, antes };
    await ex("product.template", "write", [[256], { supplier_taxes_id: [[6, 0, [TAX_IVA, TAX_INT]]] }]);
    await ex("product.template", "write", [[388], { active: false }]);
    const despues = await ex("product.product", "read", [[PROD_GRAV, 388], ["display_name", "supplier_taxes_id", "active"]], { context: { active_test: false } }) as Rec[];
    return { ok: true, antes, despues };
  }
  // paso "cargar" {nombre}: carga un ticket NUEVO con el método nuevo, desde la tabla fija NUEVOS (datos
  // tomados del ticket impreso). Controla duplicado, IVA = 21% del neto y total = el del ticket.
  if (body.paso === "cargar") {
    const n = NUEVOS[String(body.nombre || "")];
    if (!n) return { ok: false, error: "ticket fuera de la tabla de nuevos" };
    const dup = await ex("account.move", "search_read", [[["partner_id", "=", n.partner], ["name", "ilike", n.numero], ["move_type", "=", "in_invoice"], ["state", "!=", "cancel"]]], { fields: ["name", "state"] }) as Rec[];
    if (dup.length) return { ok: false, error: "ya está cargado", dup };
    if (r2(n.neto * 0.21) !== n.iva || r2(n.neto + n.iva + n.interno + n.perc) !== n.total) return { ok: false, error: "los importes del ticket no cierran", n };
    if (dry) return { ok: true, dry_run: true, a_cargar: n };
    const taxes = [TAX_IVA, TAX_INT, ...(n.perc ? [TAX_PERC] : [])];
    const id = await ex("account.move", "create", [{ move_type: "in_invoice", partner_id: n.partner, journal_id: n.diario, l10n_latam_document_type_id: n.tipo_doc,
      l10n_latam_document_number: n.numero, invoice_date: n.fecha, date: n.fecha, company_id: C,
      invoice_line_ids: [[0, 0, { product_id: PROD_GRAV, name: "[GA06] Combustible – Neto gravado", quantity: 1, price_unit: n.neto, tax_ids: [[6, 0, taxes]] }]] }]) as number;
    const leerN = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
    let ls = await leerN();
    const cmds: unknown[] = [];
    const li = ls.find(l => m2o(l.tax_line_id) === TAX_INT); if (!li) return { ok: false, error: "Odoo no generó la línea de internos; quedó en BORRADOR", id };
    cmds.push([1, li.id, { balance: n.interno, amount_currency: n.interno }]);
    if (n.perc) { const lp = ls.find(l => m2o(l.tax_line_id) === TAX_PERC); if (!lp) return { ok: false, error: "Odoo no generó la percepción; quedó en BORRADOR", id }; cmds.push([1, lp.id, { balance: n.perc, amount_currency: n.perc }]); }
    const tt = ls.find(l => l.display_type === "payment_term")!;
    cmds.push([1, tt.id, { balance: -n.total, amount_currency: -n.total }]);
    await ex("account.move", "write", [[id], { line_ids: cmds }]);
    ls = await leerN();
    const sum = (tid: number) => r2(ls.filter(l => m2o(l.tax_line_id) === tid).reduce((a, l) => a + (l.balance as number), 0));
    const chk = { iva: sum(TAX_IVA), interno: sum(TAX_INT), perc: sum(TAX_PERC), total: r2(-ls.filter(l => l.display_type === "payment_term").reduce((a, l) => a + (l.balance as number), 0)),
      debe: r2(ls.reduce((a, l) => a + (l.debit as number), 0)), haber: r2(ls.reduce((a, l) => a + (l.credit as number), 0)) };
    if (chk.iva !== n.iva || chk.interno !== n.interno || chk.perc !== n.perc || chk.total !== n.total || chk.debe !== chk.haber) return { ok: false, error: "no cerró exacto; quedó en BORRADOR para revisar", id, chk, n };
    await ex("account.move", "action_post", [[id]]);
    const fin = (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_untaxed", "amount_tax", "payment_state"]]) as Rec[])[0];
    return { ok: fin.state === "posted", chk, comprobante: fin };
  }
  // paso "pagar" {nombre}: registra el pago de un ticket de NUEVOS como los demás tickets de combustible:
  // diario Mercado Pago (42), método Manual, fecha del ticket, por el total, memo = número del comprobante.
  if (body.paso === "pagar") {
    const n = NUEVOS[String(body.nombre || "")];
    if (!n) return { ok: false, error: "ticket fuera de la tabla de nuevos" };
    const mv = await ex("account.move", "search_read", [[["partner_id", "=", n.partner], ["name", "ilike", n.numero], ["move_type", "=", "in_invoice"], ["state", "=", "posted"]]], { fields: ["id", "name", "amount_total", "amount_residual", "payment_state"] }) as Rec[];
    if (mv.length !== 1) return { ok: false, error: "no encuentro el ticket validado", mv };
    if (mv[0].payment_state !== "not_paid" || mv[0].amount_residual !== n.total) return { ok: false, error: "el ticket ya tiene pagos o no está por el total", ticket: mv[0] };
    if (dry) return { ok: true, dry_run: true, ticket: mv[0], pago: { diario: "Mercado Pago", fecha: n.fecha, importe: n.total } };
    const ctx = { active_model: "account.move", active_ids: [mv[0].id] };
    const wid = await ex("account.payment.register", "create", [{ journal_id: 42, payment_method_line_id: 22, payment_date: n.fecha, amount: n.total, communication: mv[0].name }], { context: ctx }) as number;
    await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
    const fin = (await ex("account.move", "read", [[mv[0].id], ["name", "amount_total", "amount_residual", "payment_state"]]) as Rec[])[0];
    const pagos = await ex("account.payment", "search_read", [[["memo", "=", mv[0].name], ["journal_id", "=", 42]]], { fields: ["name", "date", "amount", "state"] }) as Rec[];
    return { ok: fin.amount_residual === 0, ticket: fin, pagos };
  }
  if (body.paso !== "ticket") return { ok: false, error: "paso desconocido (config | productos | ticket | cargar | pagar)" };
  const nombre = String(body.nombre || ""); const e = TICKETS[nombre];
  if (!e) return { ok: false, error: "ticket fuera del lote: " + nombre };
  const mv = await ex("account.move", "search_read", [[["name", "=", nombre], ["company_id", "=", C], ["move_type", "=", "in_invoice"]]], { fields: ["id", "state", "amount_total", "payment_state"] }) as Rec[];
  if (mv.length !== 1) return { ok: false, error: "no encuentro el ticket" };
  const id = mv[0].id as number;
  const leer = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "product_id", "tax_ids", "tax_line_id", "balance", "debit", "credit", "price_unit", "quantity", "account_id"] }) as Rec[];
  const resumen = (ls: Rec[]) => {
    const tl = (tid: number) => r2(ls.filter(l => m2o(l.tax_line_id) === tid).reduce((a, l) => a + (l.balance as number), 0));
    const prod = ls.filter(l => l.display_type === "product");
    return { renglones: prod.length, neto_iva: r2(prod.filter(l => (l.tax_ids as number[]).includes(TAX_IVA)).reduce((a, l) => a + (l.balance as number), 0)),
      iva: tl(TAX_IVA), interno: tl(TAX_INT), perc: tl(TAX_PERC), total: r2(-ls.filter(l => l.display_type === "payment_term").reduce((a, l) => a + (l.balance as number), 0)),
      debe: r2(ls.reduce((a, l) => a + (l.debit as number), 0)), haber: r2(ls.reduce((a, l) => a + (l.credit as number), 0)),
      cuentas_gasto: [...new Set(ls.filter(l => l.display_type === "product" || m2o(l.tax_line_id) === TAX_INT).map(l => (l.account_id as unknown[])[1]))] };
  };
  const ls0 = await leer(); const r0 = resumen(ls0);
  if (r0.renglones === 1 && r0.interno === e.interno && r0.perc === e.perc && r0.total === e.total) return { ok: true, ya_corregido: true, estado: r0 };
  // controles de partida: tiene que estar como lo dejó la carga original
  if (mv[0].state !== "posted" || r0.renglones !== 2 || r0.neto_iva !== e.neto || r0.iva !== e.iva || r0.total !== e.total)
    return { ok: false, error: "el ticket no está como se esperaba; no toco nada", estado: r0, esperado: e };
  const grav = ls0.find(l => l.display_type === "product" && (l.tax_ids as number[]).includes(TAX_IVA))!;
  const trib = ls0.find(l => l.display_type === "product" && !(l.tax_ids as number[]).includes(TAX_IVA))!;
  const term = ls0.find(l => l.display_type === "payment_term")!;
  const parciales = await ex("account.partial.reconcile", "search_read", [[["credit_move_id", "=", term.id]]], { fields: ["debit_move_id", "amount"] }) as Rec[];
  const contrapartes = parciales.map(p => m2o(p.debit_move_id)).filter((x): x is number => !!x);
  const plan = { ticket: nombre, estado_pago: mv[0].payment_state, antes: r0,
    despues_esperado: { renglones: 1, neto_iva: e.neto, iva: e.iva, interno: e.interno, perc: e.perc, total: e.total }, pagos_a_revincular: parciales };
  if (dry) return { ok: true, dry_run: true, plan };
  if ((await ex("account.tax", "read", [[TAX_INT], ["amount"]]) as Rec[])[0].amount !== 1) return { ok: false, error: "falta el paso config (Impuestos internos al 1%)" };

  await ex("account.move", "button_draft", [[id]]);
  const taxes = [TAX_IVA, TAX_INT, ...(e.perc ? [TAX_PERC] : [])];
  await ex("account.move", "write", [[id], { invoice_line_ids: [
    [1, grav.id, { product_id: PROD_GRAV, name: "[GA06] Combustible – Neto gravado", quantity: 1, price_unit: e.neto, discount: 0, tax_ids: [[6, 0, taxes]] }],
    [2, trib.id, false],
  ] }]);
  // pisar los importes calculados al 1% por los del ticket y llevar el total al original
  let ls1 = await leer();
  const linea = (tid: number) => ls1.find(l => m2o(l.tax_line_id) === tid);
  const cmds: unknown[] = [];
  const li = linea(TAX_INT); if (!li) return { ok: false, error: "Odoo no generó la línea de Impuestos internos; el ticket quedó en BORRADOR para revisar", estado: resumen(ls1) };
  cmds.push([1, li.id, { balance: e.interno, amount_currency: e.interno }]);
  if (e.perc) { const lp = linea(TAX_PERC); if (!lp) return { ok: false, error: "Odoo no generó la percepción; el ticket quedó en BORRADOR para revisar", estado: resumen(ls1) }; cmds.push([1, lp.id, { balance: e.perc, amount_currency: e.perc }]); }
  const t1 = ls1.find(l => l.display_type === "payment_term")!;
  cmds.push([1, t1.id, { balance: -e.total, amount_currency: -e.total }]);
  await ex("account.move", "write", [[id], { line_ids: cmds }]);
  ls1 = await leer(); const r1 = resumen(ls1);
  const ok = r1.renglones === 1 && r1.neto_iva === e.neto && r1.iva === e.iva && r1.interno === e.interno && r1.perc === e.perc && r1.total === e.total && r1.debe === r1.haber;
  if (!ok) return { ok: false, error: "los importes no dieron exactos; el ticket quedó en BORRADOR para revisar", estado: r1, esperado: e };
  await ex("account.move", "action_post", [[id]]);
  const ls2 = await leer(); const r2_ = resumen(ls2);
  const termNuevo = ls2.find(l => l.display_type === "payment_term")!;
  if (contrapartes.length) await ex("account.move.line", "reconcile", [[termNuevo.id, ...contrapartes]]);
  const fin = (await ex("account.move", "read", [[id], ["state", "amount_total", "amount_residual", "payment_state"]]) as Rec[])[0];
  return { ok: fin.state === "posted" && fin.amount_residual === 0, ticket: nombre, antes: r0, despues: r2_, estado: fin };
}

// ---------------------------------------------------------------------------------------------
// Lote "compras": facturas de compra que faltaban en Odoo (cruce con Mis Comprobantes de ARCA).
// Tabla FIJA con los datos del comprobante; controla duplicado, IVA = 21% del neto y total exacto;
// pisa los importes de percepción con los del comprobante; valida y registra el pago indicado.
type Compra = { partner: number | { name: string; vat: string }; tipo_doc: number; numero: string; fecha: string; producto: number;
  neto: number; iva: number; otros: { tax: number; importe: number }[]; total: number; pago: { diario: number; fecha: string } };
const COMPRAS: Record<string, Compra> = {
  // dLocal (Pago Nube), sep-2026, PDF 533877.pdf: neto 104.640,20 · IVA 21.974,44 · Perc IIBB CABA 1% 1.046,40 · total 127.661,04
  // Igual que la de agosto (FA-A 00007-00264643): GC03 Comisiones Medios de Pago + Perc IIBB CABA (124), pagada por Mercado Pago.
  "FA-A 00007-00287537": { partner: 975, tipo_doc: 1, numero: "00007-00287537", fecha: "2026-09-30", producto: 0 /* GC03, se busca */,
    neto: 104640.20, iva: 21974.44, otros: [{ tax: 124, importe: 1046.40 }], total: 127661.04, pago: { diario: 42, fecha: "2026-09-30" } },
  // Frances Gustavo César (ferretería), FA-A del 14/09 según ARCA. La B 00005-00000881 y su NC B 00005-00000034 se anulan
  // entre sí y no se cargan. Gastos varios de producción (GP02). Pagada en efectivo.
  "FA-A 00005-00007425": { partner: { name: "Frances Gustavo César", vat: "20-18215120-4" }, tipo_doc: 1, numero: "00005-00007425", fecha: "2026-09-14", producto: 0 /* GP02 */,
    neto: 28889.02, iva: 6066.69, otros: [], total: 34955.71, pago: { diario: 38, fecha: "2026-09-14" } },
};
const PROD_COMPRA: Record<string, string> = { "FA-A 00007-00287537": "GC03", "FA-A 00005-00007425": "GP02" };

async function compras(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const nombre = String(body.nombre || ""); const c = COMPRAS[nombre];
  if (!c) return { ok: false, error: "comprobante fuera de la tabla" };
  if (r2(c.neto * 0.21) !== c.iva || r2(c.neto + c.iva + c.otros.reduce((a, o) => a + o.importe, 0)) !== c.total) return { ok: false, error: "los importes del comprobante no cierran", c };
  const prod = await ex("product.product", "search_read", [[["default_code", "=", PROD_COMPRA[nombre]]]], { fields: ["id", "display_name"] }) as Rec[];
  if (prod.length !== 1) return { ok: false, error: "no encuentro el producto " + PROD_COMPRA[nombre] };
  // proveedor
  let partner: number | null = typeof c.partner === "number" ? c.partner : null;
  if (!partner) {
    const p = c.partner as { name: string; vat: string };
    const ya = await ex("res.partner", "search_read", [[["vat", "in", [p.vat, p.vat.replace(/\D/g, "")]]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
    if (ya.length) partner = ya[0].id as number;
  }
  const dupDom = partner ? [["partner_id", "=", partner], ["name", "ilike", c.numero], ["move_type", "=", "in_invoice"], ["state", "!=", "cancel"]] : null;
  if (dupDom) { const dup = await ex("account.move", "search_read", [dupDom], { fields: ["name", "state"] }) as Rec[]; if (dup.length) return { ok: false, error: "ya está cargado", dup }; }
  if (dry) return { ok: true, dry_run: true, producto: prod[0].display_name, proveedor: partner || ("crear: " + JSON.stringify(c.partner)), c };
  if (!partner) {
    const p = c.partner as { name: string; vat: string };
    partner = await ex("res.partner", "create", [{ name: p.name, vat: p.vat, is_company: false, country_id: 10, l10n_latam_identification_type_id: 4, l10n_ar_afip_responsibility_type_id: 1, supplier_rank: 1 }]) as number;
  }
  const taxes = [TAX_IVA, ...c.otros.map(o => o.tax)];
  const id = await ex("account.move", "create", [{ move_type: "in_invoice", partner_id: partner, journal_id: 33, l10n_latam_document_type_id: c.tipo_doc,
    l10n_latam_document_number: c.numero, invoice_date: c.fecha, date: c.fecha, company_id: C,
    invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: c.neto, tax_ids: [[6, 0, taxes]] }]] }]) as number;
  const leerC = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  let ls = await leerC();
  const cmds: unknown[] = [];
  for (const o of c.otros) { const l = ls.find(x => m2o(x.tax_line_id) === o.tax); if (!l) return { ok: false, error: "Odoo no generó la línea del impuesto " + o.tax + "; quedó en BORRADOR", id }; cmds.push([1, l.id, { balance: o.importe, amount_currency: o.importe }]); }
  const tt = ls.find(l => l.display_type === "payment_term")!;
  cmds.push([1, tt.id, { balance: -c.total, amount_currency: -c.total }]);
  await ex("account.move", "write", [[id], { line_ids: cmds }]);
  ls = await leerC();
  const sum = (tid: number) => r2(ls.filter(l => m2o(l.tax_line_id) === tid).reduce((a, l) => a + (l.balance as number), 0));
  const chk = { iva: sum(TAX_IVA), otros: c.otros.map(o => [o.tax, sum(o.tax)]), total: r2(-ls.filter(l => l.display_type === "payment_term").reduce((a, l) => a + (l.balance as number), 0)),
    debe: r2(ls.reduce((a, l) => a + (l.debit as number), 0)), haber: r2(ls.reduce((a, l) => a + (l.credit as number), 0)) };
  if (chk.iva !== c.iva || chk.total !== c.total || chk.debe !== chk.haber || c.otros.some(o => sum(o.tax) !== o.importe)) return { ok: false, error: "no cerró exacto; quedó en BORRADOR para revisar", id, chk };
  await ex("account.move", "action_post", [[id]]);
  const ctx = { active_model: "account.move", active_ids: [id] };
  const mvn = (await ex("account.move", "read", [[id], ["name"]]) as Rec[])[0];
  const wid = await ex("account.payment.register", "create", [{ journal_id: c.pago.diario, payment_date: c.pago.fecha, amount: c.total, communication: mvn.name }], { context: ctx }) as number;
  await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
  const fin = (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_residual", "payment_state", "partner_id"]]) as Rec[])[0];
  return { ok: fin.state === "posted" && fin.amount_residual === 0, chk, comprobante: fin };
}

// Lote "compras_b": factura B + su nota de crédito B que la anula (como las carga Dirección siempre:
// un renglón con "IVA No Aplica" (178), la NC como reversión de la factura, y las dos conciliadas entre sí).
type ParB = { partner_vat: string; producto: string; fa: { numero: string; fecha: string; total: number }; nc: { numero: string; fecha: string; total: number } };
const COMPRAS_B: Record<string, ParB> = {
  // Frances Gustavo César: FA-B 00005-00000881 y NC-B 00005-00000034 del 14/09 (después hizo la FA-A 00005-00007425). Importes de ARCA.
  "frances_sep": { partner_vat: "20-18215120-4", producto: "GP02", fa: { numero: "00005-00000881", fecha: "2026-09-14", total: 34955.71 }, nc: { numero: "00005-00000034", fecha: "2026-09-14", total: 34955.72 } },
};
// Lote "personales": facturas B de compras del titular. Mismo criterio que FA-B 00003-00004125 (Bertolino):
// producto GN01 "Gastos varios no operativos" (5.9.1.01.010), IVA No Aplica (178), pagada por "Pagos internos" (55).
type Personal = { proveedor: { name: string; vat: string }; numero: string; fecha: string; total: number };
const PERSONALES: Record<string, Personal> = {
  "graells_108173": { proveedor: { name: "Graells Nelson Antonio", vat: "20-05410060-5" }, numero: "00338-00108173", fecha: "2026-09-13", total: 200000 },
  "indumentaria_5810": { proveedor: { name: "Industria Argentina de la Indumentaria S.A.", vat: "30-59990459-6" }, numero: "00065-00005810", fecha: "2026-09-13", total: 87000 },
  "indumentaria_5811": { proveedor: { name: "Industria Argentina de la Indumentaria S.A.", vat: "30-59990459-6" }, numero: "00065-00005811", fecha: "2026-09-13", total: 84000 },
};
async function personales(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const p = PERSONALES[String(body.nombre || "")];
  if (!p) return { ok: false, error: "comprobante fuera de la tabla" };
  const ya = await ex("res.partner", "search_read", [[["vat", "in", [p.proveedor.vat, p.proveedor.vat.replace(/\D/g, "")]]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
  let partner = ya.length ? ya[0].id as number : null;
  if (partner) {
    const dup = await ex("account.move", "search_read", [[["partner_id", "=", partner], ["name", "ilike", p.numero], ["move_type", "=", "in_invoice"], ["state", "!=", "cancel"]]], { fields: ["name"] }) as Rec[];
    if (dup.length) return { ok: false, error: "ya está cargado", dup };
  }
  const prod = await ex("product.product", "search_read", [[["default_code", "=", "GN01"]]], { fields: ["id"] }) as Rec[];
  if (dry) return { ok: true, dry_run: true, proveedor: partner ? ya[0].name : "crear " + p.proveedor.name, p };
  if (!partner) partner = await ex("res.partner", "create", [{ name: p.proveedor.name, vat: p.proveedor.vat, is_company: /S\.A\./.test(p.proveedor.name), country_id: 10, l10n_latam_identification_type_id: 4, l10n_ar_afip_responsibility_type_id: 1, supplier_rank: 1 }]) as number;
  const id = await ex("account.move", "create", [{ move_type: "in_invoice", partner_id: partner, journal_id: 33, l10n_latam_document_type_id: 6, l10n_latam_document_number: p.numero,
    invoice_date: p.fecha, date: p.fecha, company_id: C, invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: p.total, tax_ids: [[6, 0, [178]]] }]] }]) as number;
  const m = (await ex("account.move", "read", [[id], ["amount_total", "amount_tax"]]) as Rec[])[0];
  if (m.amount_total !== p.total || m.amount_tax !== 0) return { ok: false, error: "no cerró; quedó en BORRADOR", id, m };
  await ex("account.move", "action_post", [[id]]);
  const ctx = { active_model: "account.move", active_ids: [id] };
  const nm = (await ex("account.move", "read", [[id], ["name"]]) as Rec[])[0].name;
  const wid = await ex("account.payment.register", "create", [{ journal_id: 55, payment_date: p.fecha, amount: p.total, communication: nm }], { context: ctx }) as number;
  await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
  return { ok: true, comprobante: (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_residual", "payment_state", "partner_id"]]) as Rec[])[0] };
}

// Lote "tipo_cambio": corrige el TC de una factura en USD al que figura impreso en el comprobante.
// Solo facturas NO pagadas. Controla que el IVA en pesos quede = IVA en USD × TC (lo que informa ARCA).
const TC_FACTURAS: Record<string, { tc: number; neto_usd: number; iva_usd: number; total_usd: number }> = {
  // Invalcos, PDF FAC-A-0004-00002019: "TC: 1.545,00", neto U$s 138,00, IVA U$s 28,98, total U$s 166,98 (Odoo tenía 1.550)
  "FA-A 00004-00002019": { tc: 1545, neto_usd: 138, iva_usd: 28.98, total_usd: 166.98 },
};
async function tipo_cambio(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const nombre = String(body.nombre || ""); const t = TC_FACTURAS[nombre];
  if (!t) return { ok: false, error: "factura fuera de la tabla" };
  const mv = await ex("account.move", "search_read", [[["name", "=", nombre], ["move_type", "=", "in_invoice"], ["company_id", "=", C]]], { fields: ["id", "state", "payment_state", "invoice_currency_rate", "amount_total", "amount_tax", "amount_total_signed"] }) as Rec[];
  if (mv.length !== 1) return { ok: false, error: "no encuentro la factura" };
  const m = mv[0]; const id = m.id as number;
  if (m.payment_state !== "not_paid") return { ok: false, error: "la factura tiene pagos; no la toco", m };
  if (m.amount_total !== t.total_usd || m.amount_tax !== t.iva_usd) return { ok: false, error: "los importes en USD no coinciden con el comprobante", m };
  const esperado = { iva_ars: r2(t.iva_usd * t.tc), total_ars: r2(t.total_usd * t.tc) };
  if (dry) return { ok: true, dry_run: true, tc_actual: r2(1 / (m.invoice_currency_rate as number)), tc_nuevo: t.tc, total_ars_actual: m.amount_total_signed, esperado };
  await ex("account.move", "button_draft", [[id]]);
  await ex("account.move", "write", [[id], { invoice_currency_rate: 1 / t.tc }]);
  const ls = await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  const iva = r2(ls.filter(l => m2o(l.tax_line_id) === TAX_IVA).reduce((a, l) => a + (l.balance as number), 0));
  const total = r2(-ls.filter(l => l.display_type === "payment_term").reduce((a, l) => a + (l.balance as number), 0));
  const debe = r2(ls.reduce((a, l) => a + (l.debit as number), 0)), haber = r2(ls.reduce((a, l) => a + (l.credit as number), 0));
  if (iva !== esperado.iva_ars || total !== esperado.total_ars || debe !== haber) return { ok: false, error: "no dio exacto; quedó en BORRADOR para revisar", iva, total, debe, haber, esperado };
  await ex("account.move", "action_post", [[id]]);
  const fin = (await ex("account.move", "read", [[id], ["name", "state", "invoice_currency_rate", "amount_total", "amount_total_signed", "payment_state"]]) as Rec[])[0];
  return { ok: fin.state === "posted", iva_ars: iva, total_ars: total, tc: r2(1 / (fin.invoice_currency_rate as number)), comprobante: fin };
}

// Lote "first_label_anulada": FA-A 00004-01962205 (07/09, en borrador) y la NC-A 00004-00170958 que la anula.
// No hay PDF: la factura juntaba las dos compras que después se refacturaron por separado (FA-A 1962909 café +
// FA-A 1962417 jabón, con PDF). Neto 34.810,24 = 24.991,75 + 9.818,48 y total 43.132,52 = 30.943,78 + 12.188,74,
// así que las percepciones son la suma de las dos: CABA 242,05+106,06 · Neuquén 242,05+106,06 · Tucumán 219,66+96,26
// = 1.012,14, exacto contra "Otros tributos" de ARCA. IVA 7.310,14 según ARCA.
const FL = { borrador: 44582, partner_numero_nc: "00004-00170958", fecha: "2026-09-07", neto: 34810.24, iva: 7310.14, total: 43132.52,
  perc: [{ tax: 124, importe: 348.11 }, { tax: 143, importe: 348.11 }, { tax: 138, importe: 315.92 }] };
async function first_label_anulada(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run;
  const m = (await ex("account.move", "read", [[FL.borrador], ["name", "state", "partner_id", "amount_total", "amount_untaxed"]]) as Rec[])[0];
  const leerM = async (id: number) => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  const ajustar = async (id: number, signo: number) => {
    const ls = await leerM(id); const cmds: unknown[] = [];
    for (const p of FL.perc) { const l = ls.find(x => m2o(x.tax_line_id) === p.tax); if (!l) throw new Error("falta la línea del impuesto " + p.tax); cmds.push([1, l.id, { balance: signo * p.importe, amount_currency: signo * p.importe }]); }
    const li = ls.find(x => m2o(x.tax_line_id) === TAX_IVA)!; cmds.push([1, li.id, { balance: signo * FL.iva, amount_currency: signo * FL.iva }]);
    const t = ls.find(x => x.display_type === "payment_term")!; cmds.push([1, t.id, { balance: -signo * FL.total, amount_currency: -signo * FL.total }]);
    await ex("account.move", "write", [[id], { line_ids: cmds }]);
    const l2 = await leerM(id);
    const s = (tid: number) => r2(Math.abs(l2.filter(x => m2o(x.tax_line_id) === tid).reduce((a, x) => a + (x.balance as number), 0)));
    const debe = r2(l2.reduce((a, x) => a + (x.debit as number), 0)), haber = r2(l2.reduce((a, x) => a + (x.credit as number), 0));
    const ok = s(TAX_IVA) === FL.iva && FL.perc.every(p => s(p.tax) === p.importe) && debe === haber && debe === r2(FL.total);
    return { ok, iva: s(TAX_IVA), perc: FL.perc.map(p => [p.tax, s(p.tax)]), debe, haber };
  };
  if (m.state !== "draft" || m.amount_total !== FL.total || m.amount_untaxed !== FL.neto) return { ok: false, error: "el borrador no está como se esperaba", m };
  if (dry) return { ok: true, dry_run: true, factura: m.name, ajustes: FL };
  const cf = await ajustar(FL.borrador, 1);
  if (!cf.ok) return { ok: false, error: "la factura no cerró; sigue en BORRADOR", cf };
  await ex("account.move", "action_post", [[FL.borrador]]);
  const prod = await ex("product.product", "search_read", [[["default_code", "=", "GN01"]]], { fields: ["id"] }) as Rec[];
  const nc = await ex("account.move", "create", [{ move_type: "in_refund", partner_id: m2o(m.partner_id), journal_id: 33, l10n_latam_document_type_id: 3,
    l10n_latam_document_number: FL.partner_numero_nc, invoice_date: FL.fecha, date: FL.fecha, company_id: C, reversed_entry_id: FL.borrador,
    invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: FL.neto, tax_ids: [[6, 0, [TAX_IVA, 124, 138, 143]]] }]] }]) as number;
  const cn = await ajustar(nc, -1);
  if (!cn.ok) return { ok: false, error: "la nota de crédito no cerró; quedó en BORRADOR (la factura ya se validó)", cn, nc };
  await ex("account.move", "action_post", [[nc]]);
  let fin = await ex("account.move", "read", [[FL.borrador, nc], ["name", "state", "amount_total", "amount_residual", "payment_state"]]) as Rec[];
  if (fin.some(x => x.amount_residual !== 0)) {
    const term = await ex("account.move.line", "search_read", [[["move_id", "in", [FL.borrador, nc]], ["display_type", "=", "payment_term"], ["reconciled", "=", false]]], { fields: ["id"] }) as Rec[];
    if (term.length === 2) await ex("account.move.line", "reconcile", [term.map(t => t.id)]);
    fin = await ex("account.move", "read", [[FL.borrador, nc], ["name", "state", "amount_total", "amount_residual", "payment_state"]]) as Rec[];
  }
  return { ok: true, factura: cf, nota_credito: cn, comprobantes: fin };
}

// Lote "personal_a": completa un borrador de factura A de compra personal del titular. Mismo criterio que
// FA-A 00013-00015346 (Mundo Autopartes): GN01 con IVA 21% (el IVA se toma) y pago por "Pagos internos" (55).
const PERSONAL_A: Record<string, { borrador: number; neto: number; iva: number; total: number }> = {
  // J y O Rodamientos, tapafugas para el auto (PDF invoice-2000018325729788): neto 24.565,08 · IVA 5.158,67 · total 29.723,75
  "FA-A 00011-00001002": { borrador: 44536, neto: 24565.08, iva: 5158.67, total: 29723.75 },
};
// Facturas A personales que no estaban en Odoo (datos de Mis Comprobantes de ARCA): se crean con el mismo criterio.
const PERSONAL_A_NUEVAS: Record<string, { proveedor: { name: string; vat: string }; numero: string; fecha: string; neto: number; iva: number; total: number }> = {
  // Yanani Martín Ramón: no se identificó la compra; Dirección decidió cargarlas como gasto personal (13-oct-2026).
  "FA-A 00004-00013539": { proveedor: { name: "Yanani Martín Ramón", vat: "23-25430261-9" }, numero: "00004-00013539", fecha: "2026-09-03", neto: 27271.90, iva: 5727.10, total: 32999.00 },
  "FA-A 00004-00013541": { proveedor: { name: "Yanani Martín Ramón", vat: "23-25430261-9" }, numero: "00004-00013541", fecha: "2026-09-03", neto: 27271.90, iva: 5727.10, total: 32999.00 },
};
async function personal_a_nueva(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const nombre = String(body.nombre || ""); const p = PERSONAL_A_NUEVAS[nombre];
  if (!p) return { ok: false, error: "fuera de la tabla" };
  if (r2(p.neto * 0.21) !== p.iva || r2(p.neto + p.iva) !== p.total) return { ok: false, error: "los importes no cierran" };
  const ya = await ex("res.partner", "search_read", [[["vat", "in", [p.proveedor.vat, p.proveedor.vat.replace(/\D/g, "")]]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
  let partner = ya.length ? ya[0].id as number : null;
  if (partner) {
    const dup = await ex("account.move", "search_read", [[["partner_id", "=", partner], ["name", "ilike", p.numero], ["move_type", "=", "in_invoice"], ["state", "!=", "cancel"]]], { fields: ["name"] }) as Rec[];
    if (dup.length) return { ok: false, error: "ya está cargado", dup };
  }
  if (dry) return { ok: true, dry_run: true, proveedor: partner ? ya[0].name : "crear " + p.proveedor.name, p };
  if (!partner) partner = await ex("res.partner", "create", [{ name: p.proveedor.name, vat: p.proveedor.vat, is_company: false, country_id: 10, l10n_latam_identification_type_id: 4, l10n_ar_afip_responsibility_type_id: 1, supplier_rank: 1 }]) as number;
  const prod = await ex("product.product", "search_read", [[["default_code", "=", "GN01"]]], { fields: ["id"] }) as Rec[];
  const id = await ex("account.move", "create", [{ move_type: "in_invoice", partner_id: partner, journal_id: 33, l10n_latam_document_type_id: 1, l10n_latam_document_number: p.numero,
    invoice_date: p.fecha, date: p.fecha, company_id: C, invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: p.neto, tax_ids: [[6, 0, [TAX_IVA]]] }]] }]) as number;
  const mm = (await ex("account.move", "read", [[id], ["amount_total", "amount_tax"]]) as Rec[])[0];
  if (mm.amount_total !== p.total || mm.amount_tax !== p.iva) return { ok: false, error: "no cerró; quedó en BORRADOR", id, mm };
  await ex("account.move", "action_post", [[id]]);
  const ctx = { active_model: "account.move", active_ids: [id] };
  const wid = await ex("account.payment.register", "create", [{ journal_id: 55, payment_date: p.fecha, amount: p.total, communication: nombre }], { context: ctx }) as number;
  await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
  return { ok: true, comprobante: (await ex("account.move", "read", [[id], ["name", "state", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "partner_id"]]) as Rec[])[0] };
}

async function personal_a(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const nombre = String(body.nombre || ""); const p = PERSONAL_A[nombre];
  if (!p) return { ok: false, error: "fuera de la tabla" };
  const m = (await ex("account.move", "read", [[p.borrador], ["name", "state", "invoice_line_ids", "invoice_date"]]) as Rec[])[0];
  if (m.name !== nombre || m.state !== "draft" || (m.invoice_line_ids as number[]).length) return { ok: false, error: "el borrador no está como se esperaba", m };
  if (r2(p.neto * 0.21) !== p.iva || r2(p.neto + p.iva) !== p.total) return { ok: false, error: "los importes no cierran" };
  if (dry) return { ok: true, dry_run: true, m, p };
  const prod = await ex("product.product", "search_read", [[["default_code", "=", "GN01"]]], { fields: ["id"] }) as Rec[];
  await ex("account.move", "write", [[p.borrador], { invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: p.neto, tax_ids: [[6, 0, [TAX_IVA]]] }]] }]);
  const mm = (await ex("account.move", "read", [[p.borrador], ["amount_total", "amount_tax", "amount_untaxed"]]) as Rec[])[0];
  if (mm.amount_total !== p.total || mm.amount_tax !== p.iva) return { ok: false, error: "no cerró; sigue en BORRADOR", mm };
  await ex("account.move", "action_post", [[p.borrador]]);
  const ctx = { active_model: "account.move", active_ids: [p.borrador] };
  const wid = await ex("account.payment.register", "create", [{ journal_id: 55, payment_date: m.invoice_date, amount: p.total, communication: nombre }], { context: ctx }) as number;
  await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
  return { ok: true, comprobante: (await ex("account.move", "read", [[p.borrador], ["name", "state", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state"]]) as Rec[])[0] };
}

// Lote "iibb_liquidacion": asiento mensual de IIBB Convenio Multilateral armado desde la CM03 final de cada mes
// (script liq_iibb.js). Solo acepta cuentas de IIBB: gasto 5.4.2.01.*, percepciones/retenciones/saldos a favor
// 1.1.4.02.* e IIBB a pagar 2.1.3.02.010. Debe = haber obligatorio; idempotente por ref.
// Lote "iva_liquidacion": igual, para la DDJJ mensual de IVA (F.2051). Cuentas: IVA débito 2.1.3.03.010,
// IVA crédito 1.1.4.04.010, percepciones 1.1.4.04.020, saldo de libre disponibilidad 1.1.4.04.050,
// IVA saldo a pagar 2.1.3.03.020 y ajuste por redondeo 4.2.1.01.030 (diferencias de centavos de facturas en USD).
const IVA_CTAS = new Set(["2.1.3.03.010", "1.1.4.04.010", "1.1.4.04.020", "1.1.4.04.050", "2.1.3.03.020", "4.2.1.01.030"]);
const iva_liquidacion = (body: Rec) => liquidacion(body, /^IVA-2026-\d{2}$/, (c) => IVA_CTAS.has(c));
const iibb_liquidacion = (body: Rec) => liquidacion(body, /^IIBB-CM-2026-\d{2}$/, (c) => c.startsWith("5.4.2.01.") || c.startsWith("1.1.4.02.") || c === "2.1.3.02.010");
async function liquidacion(body: Rec, refOk: RegExp, permitida: (c: string) => boolean): Promise<Rec> {
  const dry = !!body.dry_run; const ref = String(body.ref || ""), fecha = String(body.fecha || ""), glosa = String(body.glosa || ref);
  const lineas = (body.lineas || []) as { code: string; debe: number; haber: number; nombre?: string }[];
  if (!refOk.test(ref) || !/^2026-\d{2}-\d{2}$/.test(fecha) || !lineas.length) return { ok: false, error: "faltan ref/fecha/lineas" };
  if (lineas.some(l => !permitida(l.code))) return { ok: false, error: "cuenta no permitida", malas: lineas.filter(l => !permitida(l.code)) };
  const debe = r2(lineas.reduce((a, l) => a + (l.debe || 0), 0)), haber = r2(lineas.reduce((a, l) => a + (l.haber || 0), 0));
  if (debe !== haber || !debe) return { ok: false, error: "no balancea", debe, haber };
  const ya = await ex("account.move", "search_read", [[["ref", "=", ref], ["company_id", "=", C], ["state", "!=", "cancel"]]], { fields: ["name", "state"] }) as Rec[];
  if (ya.length) return { ok: true, ya_existia: ya };
  const codes = [...new Set(lineas.map(l => l.code))];
  const accs = await ex("account.account", "search_read", [[["code", "in", codes], ["company_ids", "in", [C]]]], { fields: ["id", "code"] }) as Rec[];
  const id = Object.fromEntries(accs.map(a => [a.code, a.id]));
  const faltan = codes.filter(c => !id[c]); if (faltan.length) return { ok: false, error: "cuentas inexistentes", faltan };
  if (dry) return { ok: true, dry_run: true, ref, fecha, renglones: lineas.length, debe, haber };
  const diario = await ex("account.journal", "search_read", [[["company_id", "=", C], ["type", "=", "general"], ["code", "in", ["MISC", "VARIO", "Vario"]]]], { fields: ["id"] }) as Rec[];
  const mid = await ex("account.move", "create", [{ move_type: "entry", journal_id: diario[0].id, date: fecha, ref, company_id: C,
    line_ids: lineas.map(l => [0, 0, { account_id: id[l.code], name: l.nombre || glosa, debit: r2(l.debe || 0), credit: r2(l.haber || 0), tax_ids: [[6, 0, []]], tax_tag_ids: [[6, 0, []]] }]) }]) as number;
  await ex("account.move", "action_post", [[mid]]);
  const m = (await ex("account.move", "read", [[mid], ["name", "state", "date", "amount_total"]]) as Rec[])[0];
  return { ok: m.state === "posted", asiento: m };
}

// Lote "iibb_pago": pago de un VEP de IIBB CM contra "IIBB a pagar" (2.1.3.02.010), conciliado con la
// liquidación del mes (ref IIBB-CM-AAAA-MM). Tabla fija: importe = total del VEP verificado contra la cuenta
// corriente de SIFERE; fecha = vencimiento (día de presentación de la CM03); pagado desde Mercado Pago.
const IIBB_PAGOS: Record<string, { fecha: string; importe: number; diario: number }> = {
  "2026-03": { fecha: "2026-04-15", importe: 36458.11, diario: 42 },
  "2026-04": { fecha: "2026-05-15", importe: 25182.18, diario: 42 },
};
async function iibb_pago(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const mes = String(body.mes || ""); const p = IIBB_PAGOS[mes];
  if (!p) return { ok: false, error: "mes fuera de la tabla" };
  const ref = `IIBB-CM-${mes}-PAGO`;
  const ya = await ex("account.move", "search_read", [[["ref", "=", ref], ["company_id", "=", C], ["state", "!=", "cancel"]]], { fields: ["name"] }) as Rec[];
  if (ya.length) return { ok: true, ya_existia: ya };
  const liq = await ex("account.move.line", "search_read", [[["move_id.ref", "=", `IIBB-CM-${mes}`], ["account_id.code", "=", "2.1.3.02.010"], ["parent_state", "=", "posted"]]], { fields: ["id", "credit", "reconciled", "amount_residual"] }) as Rec[];
  if (liq.length !== 1 || r2(liq[0].credit as number) !== p.importe || liq[0].reconciled) return { ok: false, error: "la liquidación del mes no está como se esperaba", liq };
  const j = (await ex("account.journal", "read", [[p.diario], ["default_account_id"]]) as Rec[])[0];
  const acc = await ex("account.account", "search_read", [[["code", "=", "2.1.3.02.010"]]], { fields: ["id"] }) as Rec[];
  if (dry) return { ok: true, dry_run: true, ref, fecha: p.fecha, importe: p.importe, desde: j.default_account_id };
  const glosa = `Pago VEP IIBB Convenio Multilateral ${mes}`;
  const mid = await ex("account.move", "create", [{ move_type: "entry", journal_id: p.diario, date: p.fecha, ref, company_id: C, line_ids: [
    [0, 0, { account_id: acc[0].id, name: glosa, debit: p.importe, credit: 0, tax_ids: [[6, 0, []]], tax_tag_ids: [[6, 0, []]] }],
    [0, 0, { account_id: m2o(j.default_account_id), name: glosa, debit: 0, credit: p.importe, tax_ids: [[6, 0, []]], tax_tag_ids: [[6, 0, []]] }],
  ] }]) as number;
  await ex("account.move", "action_post", [[mid]]);
  const lp = await ex("account.move.line", "search_read", [[["move_id", "=", mid], ["account_id", "=", acc[0].id]]], { fields: ["id"] }) as Rec[];
  await ex("account.move.line", "reconcile", [[lp[0].id, liq[0].id]]);
  const fin = await ex("account.move.line", "read", [[liq[0].id], ["reconciled", "amount_residual"]]) as Rec[];
  return { ok: !!fin[0].reconciled, asiento: (await ex("account.move", "read", [[mid], ["name", "date", "state"]]) as Rec[])[0], liquidacion: fin[0] };
}

async function compras_b(body: Rec): Promise<Rec> {
  const dry = !!body.dry_run; const b = COMPRAS_B[String(body.nombre || "")];
  if (!b) return { ok: false, error: "par fuera de la tabla" };
  const pr = await ex("res.partner", "search_read", [[["vat", "in", [b.partner_vat, b.partner_vat.replace(/\D/g, "")]]]], { fields: ["id", "name"] }) as Rec[];
  if (pr.length !== 1) return { ok: false, error: "no encuentro el proveedor (cargá primero la factura A)" };
  const partner = pr[0].id as number;
  const prod = await ex("product.product", "search_read", [[["default_code", "=", b.producto]]], { fields: ["id"] }) as Rec[];
  for (const n of [b.fa.numero, b.nc.numero]) {
    const dup = await ex("account.move", "search_read", [[["partner_id", "=", partner], ["name", "ilike", n], ["move_type", "in", ["in_invoice", "in_refund"]], ["state", "!=", "cancel"]]], { fields: ["name"] }) as Rec[];
    if (dup.length) return { ok: false, error: "ya está cargado", dup };
  }
  if (dry) return { ok: true, dry_run: true, proveedor: pr[0].name, b };
  const crear = async (tipo: "in_invoice" | "in_refund", doc: number, d: { numero: string; fecha: string; total: number }, revierte?: number) => {
    const vals: Rec = { move_type: tipo, partner_id: partner, journal_id: 33, l10n_latam_document_type_id: doc, l10n_latam_document_number: d.numero,
      invoice_date: d.fecha, date: d.fecha, company_id: C, invoice_line_ids: [[0, 0, { product_id: prod[0].id, quantity: 1, price_unit: d.total, tax_ids: [[6, 0, [178]]] }]] };
    if (revierte) vals.reversed_entry_id = revierte;
    const id = await ex("account.move", "create", [vals]) as number;
    const m = (await ex("account.move", "read", [[id], ["amount_total", "amount_tax"]]) as Rec[])[0];
    if (m.amount_total !== d.total || m.amount_tax !== 0) throw new Error(`${d.numero}: total ${m.amount_total} / impuestos ${m.amount_tax}; quedó en BORRADOR`);
    await ex("account.move", "action_post", [[id]]);
    return id;
  };
  const fa = await crear("in_invoice", 6, b.fa);
  const nc = await crear("in_refund", 8, b.nc, fa);
  const term = await ex("account.move.line", "search_read", [[["move_id", "in", [fa, nc]], ["display_type", "=", "payment_term"]]], { fields: ["id"] }) as Rec[];
  await ex("account.move.line", "reconcile", [term.map(t => t.id)]);
  const fin = await ex("account.move", "read", [[fa, nc], ["name", "state", "amount_total", "amount_residual", "payment_state"]]) as Rec[];
  return { ok: true, comprobantes: fin };
}

Deno.serve(async (req: Request) => {
  const h = { "Content-Type": "application/json" };
  const clave = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (!clave || req.headers.get("x-cron-key") !== clave) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: h });
  try {
    const body = await req.json() as Rec;
    if (body.lote === "iva_combustible") return new Response(JSON.stringify(await iva_combustible(body)), { headers: h });
    if (body.lote === "iva_liquidacion") return new Response(JSON.stringify(await iva_liquidacion(body)), { headers: h });
    if (body.lote === "iibb_pago") return new Response(JSON.stringify(await iibb_pago(body)), { headers: h });
    if (body.lote === "iibb_liquidacion") return new Response(JSON.stringify(await iibb_liquidacion(body)), { headers: h });
    if (body.lote === "personal_a_nueva") return new Response(JSON.stringify(await personal_a_nueva(body)), { headers: h });
    if (body.lote === "personal_a") return new Response(JSON.stringify(await personal_a(body)), { headers: h });
    if (body.lote === "first_label_anulada") return new Response(JSON.stringify(await first_label_anulada(body)), { headers: h });
    if (body.lote === "tipo_cambio") return new Response(JSON.stringify(await tipo_cambio(body)), { headers: h });
    if (body.lote === "personales") return new Response(JSON.stringify(await personales(body)), { headers: h });
    if (body.lote === "compras_b") return new Response(JSON.stringify(await compras_b(body)), { headers: h });
    if (body.lote === "compras") return new Response(JSON.stringify(await compras(body)), { headers: h });
    if (body.lote === "combustible_internos") return new Response(JSON.stringify(await combustible_internos(body)), { headers: h });
    return new Response(JSON.stringify({ ok: false, error: "lote desconocido" }), { headers: h });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h }); }
});
