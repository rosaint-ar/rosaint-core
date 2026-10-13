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
  if (body.paso !== "ticket") return { ok: false, error: "paso desconocido (config | productos | ticket | cargar)" };
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

Deno.serve(async (req: Request) => {
  const h = { "Content-Type": "application/json" };
  const clave = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (!clave || req.headers.get("x-cron-key") !== clave) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: h });
  try {
    const body = await req.json() as Rec;
    if (body.lote === "iva_combustible") return new Response(JSON.stringify(await iva_combustible(body)), { headers: h });
    if (body.lote === "combustible_internos") return new Response(JSON.stringify(await combustible_internos(body)), { headers: h });
    return new Response(JSON.stringify({ ok: false, error: "lote desconocido" }), { headers: h });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h }); }
});
