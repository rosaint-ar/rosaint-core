// ====== Finanzas (módulo del Core) — SOLO LECTURA ======
// Vive dentro de odoo-metricas porque el plan de Supabase llegó al máximo de funciones.
// Se entra con body.modo = "finanzas_*". Empresa VELAZQUEZ (company 2).
//   finanzas_relevar : consultas sueltas para conocer cómo está cargado Odoo.
//   finanzas_tablero : todo lo que muestra la pantalla Finanzas (saldos, flujo, a cobrar, a pagar,
//                      pasivos, balance) + un bloque `control` que cruza cada total por dos caminos.
type Rec = Record<string, unknown>;
type Ex = (model: string, method: string, args: unknown[], kw?: Rec) => Promise<Rec[]>;
type Dom = unknown[][];
const C = 2;
const DESDE = "2026-03-01";
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
const m2oName = (v: unknown) => Array.isArray(v) ? String((v as unknown[])[1]) : "";
const r2 = (x: number) => Math.round(x * 100) / 100;
const codigo = (cuenta: string) => cuenta.split(" ")[0];
const sinCodigo = (cuenta: string) => cuenta.replace(/^[\d.]+\s+/, "");

// Categoría del dinero que entra o sale, según la contrapartida del asiento.
function categoria(code: string, tipo: string): string {
  if (code.startsWith("2.1.4")) return "Sueldos y honorarios";
  if (code.startsWith("2.1.1.01.06") || code.startsWith("2.1.1.01.07")) return "Cadeterías";
  if (tipo === "asset_receivable") return "Cobros de clientes";
  if (tipo === "liability_payable") return "Pagos a proveedores";
  if (code.startsWith("2.1.2") || code.startsWith("2.1.3") || code.startsWith("1.1.4")) return "Impuestos";
  if (tipo === "equity" || tipo === "equity_unaffected" || code.startsWith("3.")) return "Aportes y retiros";
  if (tipo.startsWith("expense")) return "Gastos pagados directo";
  if (tipo.startsWith("income")) return "Ingresos directos";
  return "Otros";
}

export async function finanzas(body: Rec, ex: Ex, ctx: Rec): Promise<Rec> {
  const out: Rec = { ok: true, modo: body.modo };
  const safe = async (k: string, f: () => Promise<unknown>) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String((e as Error).message || e) }; } };
  const sr = (model: string, dom: Dom, fields: string[], kw: Rec = {}) => ex(model, "search_read", [dom], { fields, ...kw });
  const rg = (model: string, dom: Dom, fields: string[], groupby: string[]) => ex(model, "read_group", [dom, fields, groupby], { lazy: false });
  const emp: Dom = [["company_id", "=", C]];
  const posted: Dom = [["company_id", "=", C], ["parent_state", "=", "posted"]];
  const mov = (tipos: string[], extra: Dom = []): Dom => [["company_id", "=", C], ["state", "=", "posted"], ["move_type", "in", tipos], ...extra];

  if (body.modo === "finanzas_relevar") {
    await safe("diarios", () => sr("account.journal", emp, ["name", "code", "type", "default_account_id", "suspense_account_id", "currency_id", "bank_account_id", "active", "bank_statements_source"], { context: { ...ctx, active_test: false } }));
    await safe("saldos_por_tipo", () => rg("account.move.line", posted, ["balance:sum"], ["account_type"]));
    await safe("saldos_liquidez", () => rg("account.move.line", [...posted, ["account_type", "in", ["asset_cash", "asset_current", "liability_credit_card"]]], ["balance:sum", "amount_currency:sum"], ["account_id"]));
    await safe("extractos", () => sr("account.bank.statement", emp, ["name", "journal_id", "date", "balance_start", "balance_end_real", "balance_end"], { order: "date desc", limit: 15 }));
    await safe("lineas_extracto", () => rg("account.bank.statement.line", emp, ["amount:sum"], ["journal_id", "is_reconciled"]));
    await safe("pagos", () => rg("account.payment", emp, ["amount:sum"], ["journal_id", "payment_type", "state"]));
    await safe("a_cobrar", () => rg("account.move", mov(["out_invoice", "out_refund"], [["amount_residual", "!=", 0]]), ["amount_residual_signed:sum"], ["payment_state"]));
    await safe("a_pagar", () => rg("account.move", mov(["in_invoice", "in_refund"], [["amount_residual", "!=", 0]]), ["amount_residual_signed:sum"], ["payment_state"]));
    await safe("resultado_por_cuenta", () => rg("account.move.line", [...posted, ["account_type", "in", ["expense", "expense_direct_cost", "expense_depreciation", "income", "income_other"]]], ["balance:sum"], ["account_id"]));
    await safe("borradores", () => rg("account.move", [...emp, ["state", "=", "draft"]], ["amount_total_signed:sum"], ["move_type"]));
    return out;
  }

  if (body.modo !== "finanzas_tablero") return { ok: false, error: "modo desconocido" };

  // ---------- meses (hora argentina) ----------
  const hoyAR = new Date(Date.now() - 3 * 3600 * 1000);
  const hoy = hoyAR.toISOString().slice(0, 10);
  const meses: string[] = [];
  for (let d = new Date(Date.UTC(2026, 2, 1)); d <= hoyAR; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) meses.push(d.toISOString().slice(0, 7));
  const N = meses.length, idx: Record<string, number> = {}; meses.forEach((m, i) => idx[m] = i);
  const zeros = () => new Array(N).fill(0);

  // ---------- cuentas de dinero = cuenta principal de cada diario de banco/caja ----------
  const diarios = await sr("account.journal", [...emp, ["type", "in", ["bank", "cash"]]], ["name", "code", "type", "default_account_id", "bank_account_id"]);
  const liq: Record<number, Rec> = {};
  for (const j of diarios) { const a = m2oId(j.default_account_id); if (a) liq[a] = { diario: j.name, tipo: j.type, cuenta: m2oName(j.default_account_id), cbu: m2oName(j.bank_account_id), codigo_diario: j.code }; }
  const liqIds = Object.keys(liq).map(Number);

  // renglones publicados en cuentas de dinero (toda la historia de VELAZQUEZ)
  const lLiq = liqIds.length ? await sr("account.move.line", [...posted, ["account_id", "in", liqIds]], ["move_id", "date", "account_id", "balance", "partner_id", "name", "ref"], { order: "date asc, id asc" }) : [];
  const moveIds = [...new Set(lLiq.map(l => m2oId(l.move_id)).filter((x): x is number => !!x))];
  // contrapartidas de esos asientos
  const lCp = moveIds.length ? await sr("account.move.line", [["move_id", "in", moveIds], ["account_id", "not in", liqIds]], ["move_id", "account_id", "account_type", "balance", "partner_id"]) : [];
  const cpPorMov: Record<number, Rec[]> = {}; for (const l of lCp) (cpPorMov[m2oId(l.move_id) as number] ||= []).push(l);
  const liqPorMov: Record<number, Rec[]> = {}; for (const l of lLiq) (liqPorMov[m2oId(l.move_id) as number] ||= []).push(l);

  const cuentas: Record<number, { saldo: number; entradas: number[]; salidas: number[]; cierre: number[]; ultimo: string; n: number }> = {};
  for (const a of liqIds) cuentas[a] = { saldo: 0, entradas: zeros(), salidas: zeros(), cierre: zeros(), ultimo: "", n: 0 };
  const flujo: Record<string, { entradas: number[]; salidas: number[] }> = {};
  // flujo por cuenta de dinero + categoría (así la pantalla puede separar, p. ej., "Pagos internos")
  const addF = (cuenta: string, cat: string, i: number, v: number) => { const f = (flujo[cuenta + "|" + cat] ||= { entradas: zeros(), salidas: zeros() }); if (v >= 0) f.entradas[i] += v; else f.salidas[i] += -v; };
  const recientes: Rec[] = [];
  let transferencias = 0;

  for (const mid of moveIds) {
    const ls = liqPorMov[mid] || []; const cps = cpPorMov[mid] || [];
    const fecha = String(ls[0]?.date || ""); const i = idx[fecha.slice(0, 7)];
    const neto = ls.reduce((s, l) => s + ((l.balance as number) || 0), 0);   // variación total de dinero del asiento
    for (const l of ls) {
      const a = m2oId(l.account_id) as number; const v = (l.balance as number) || 0; const c = cuentas[a];
      c.saldo += v; c.n++; c.ultimo = String(l.date);
      if (i !== undefined) { if (v >= 0) c.entradas[i] += v; else c.salidas[i] += -v; }
    }
    // reparto del neto por categoría de contrapartida (exacto: la contrapartida suma −neto)
    let det = "";
    if (Math.abs(neto) >= 0.005) {
      const porCat: Record<string, number> = {};
      for (const cp of cps) { const cat = categoria(codigo(m2oName(cp.account_id)), String(cp.account_type || "")); porCat[cat] = (porCat[cat] || 0) - ((cp.balance as number) || 0); }
      const totCp = Object.values(porCat).reduce((s, v) => s + v, 0);
      const cuentaMov = String(liq[m2oId(ls[0]?.account_id) as number]?.diario || "");
      for (const [cat, v] of Object.entries(porCat)) if (i !== undefined && Math.abs(totCp) > 0.005) addF(cuentaMov, cat, i, neto * v / totCp);
      det = Object.keys(porCat).join(" + ");
    } else if (ls.length > 1) { transferencias += ls.filter(l => ((l.balance as number) || 0) > 0).reduce((s, l) => s + (l.balance as number), 0); det = "Transferencia entre cuentas"; }
    recientes.push({ fecha, asiento: m2oName(ls[0]?.move_id), cuenta: ls.map(l => liq[m2oId(l.account_id) as number]?.diario).join(" → "), importe: r2(neto), categoria: det, detalle: String(ls[0]?.name || ""), contacto: m2oName(ls[0]?.partner_id) || m2oName(cps[0]?.partner_id) });
  }
  // saldo al cierre de cada mes, por cuenta
  for (const a of liqIds) {
    const c = cuentas[a]; let acum = 0; let k = 0;
    const ls = lLiq.filter(l => m2oId(l.account_id) === a);
    for (let i = 0; i < N; i++) { const fin = meses[i] + "-31"; while (k < ls.length && String(ls[k].date) <= fin) { acum += (ls[k].balance as number) || 0; k++; } c.cierre[i] = r2(acum); }
  }
  out.hoy = hoy; out.meses = meses;
  out.cuentas = liqIds.map(a => ({ id: a, ...liq[a], saldo: r2(cuentas[a].saldo), movimientos: cuentas[a].n, ultimo_movimiento: cuentas[a].ultimo, entradas: cuentas[a].entradas.map(r2), salidas: cuentas[a].salidas.map(r2), cierre_mes: cuentas[a].cierre }))
    .sort((x, y) => Math.abs(y.saldo) - Math.abs(x.saldo));
  out.flujo = Object.entries(flujo).map(([k, f]) => ({ cuenta: k.split("|")[0], categoria: k.split("|")[1], entradas: f.entradas.map(r2), salidas: f.salidas.map(r2) }));
  out.transferencias_entre_cuentas = r2(transferencias);
  out.movimientos_recientes = recientes.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 120);

  // ---------- a cobrar / a pagar (renglones abiertos de clientes y proveedores) ----------
  const abiertos = await sr("account.move.line", [...posted, ["account_type", "in", ["asset_receivable", "liability_payable"]], ["reconciled", "=", false], ["amount_residual", "!=", 0]],
    ["move_id", "account_id", "account_type", "partner_id", "date", "date_maturity", "balance", "amount_residual", "amount_residual_currency", "currency_id", "name"]);
  const movAb = [...new Set(abiertos.map(l => m2oId(l.move_id)).filter((x): x is number => !!x))];
  const infoMov: Record<number, Rec> = {};
  if (movAb.length) for (const m of await sr("account.move", [["id", "in", movAb]], ["name", "move_type", "invoice_date", "invoice_date_due", "amount_total", "invoice_origin", "ref"])) infoMov[m.id as number] = m;
  const dias = (f: string) => Math.round((Date.parse(hoy) - Date.parse(f)) / 86400000);
  const item = (l: Rec) => {
    const m = infoMov[m2oId(l.move_id) as number] || {};
    const vence = String(l.date_maturity || m.invoice_date_due || l.date || "");
    const moneda = m2oName(l.currency_id);
    return { comprobante: m.name || m2oName(l.move_id), tipo: m.move_type, contacto: m2oName(l.partner_id), fecha: m.invoice_date || l.date, vence, dias_vencido: vence ? dias(vence) : 0,
      total: r2((m.amount_total as number) || 0), saldo: r2((l.amount_residual as number) || 0), moneda: moneda && moneda !== "ARS" ? moneda : "", saldo_moneda: moneda && moneda !== "ARS" ? r2((l.amount_residual_currency as number) || 0) : null, origen: m.invoice_origin || m.ref || "" };
  };
  // Odoo deja renglones abiertos cuando un pago no se vinculó a su factura/devengamiento (pasa con los
  // sueldos: cada pago parcial queda suelto). Por eso se agrupa por cuenta + contacto y manda el NETO.
  const grupos: Record<string, { cuenta: string; tipo: string; contacto: string; neto: number; items: ReturnType<typeof item>[] }> = {};
  for (const l of abiertos) {
    const k = m2oName(l.account_id) + "|" + (m2oId(l.partner_id) || 0);
    const g = (grupos[k] ||= { cuenta: m2oName(l.account_id), tipo: String(l.account_type), contacto: m2oName(l.partner_id) || "(sin contacto)", neto: 0, items: [] });
    g.neto += (l.amount_residual as number) || 0; g.items.push(item(l));
  }
  const gl = Object.values(grupos).map(g => ({ ...g, neto: r2(g.neto) }));
  const rec = abiertos.filter(l => l.account_type === "asset_receivable").map(item);
  const pag = abiertos.filter(l => l.account_type === "liability_payable").map(item);
  // a cobrar: documentos de clientes con saldo (los créditos a favor del cliente van aparte)
  // si un contacto tiene comprobantes en los dos sentidos, se muestra UN renglón con su neto
  const docs = (g: typeof gl[number], signo: number) => {
    const deuda = g.items.filter(x => x.saldo * signo > 0), contra = g.items.filter(x => x.saldo * signo < 0);
    if (!contra.length) return deuda.map(x => ({ ...x, saldo: x.saldo * signo, saldo_moneda: x.saldo_moneda === null ? null : x.saldo_moneda * signo, cuenta: sinCodigo(g.cuenta) }));
    const vence = deuda.map(x => x.vence).sort()[0] || "";
    return [{ comprobante: `Saldo neto (${g.items.length} comprobantes)`, tipo: "neto", contacto: g.contacto, fecha: "", vence, dias_vencido: vence ? dias(vence) : 0, total: 0, saldo: r2(g.neto * signo), moneda: "", saldo_moneda: null, origen: "", cuenta: sinCodigo(g.cuenta) }];
  };
  out.a_cobrar = gl.filter(g => g.tipo === "asset_receivable" && g.neto > 0.005).flatMap(g => docs(g, 1)).sort((a, b) => a.vence.localeCompare(b.vence));
  out.creditos_clientes = gl.filter(g => g.tipo === "asset_receivable" && g.neto < -0.005).map(g => ({ contacto: g.contacto, cuenta: g.cuenta, saldo: -g.neto, items: g.items }));
  // a pagar: por contacto con saldo neto a pagar; se listan sus comprobantes abiertos
  out.a_pagar = gl.filter(g => g.tipo === "liability_payable" && g.neto < -0.005).flatMap(g => docs(g, -1)).sort((a, b) => a.vence.localeCompare(b.vence));
  out.creditos_proveedores = gl.filter(g => g.tipo === "liability_payable" && g.neto > 0.005).map(g => ({ contacto: g.contacto, cuenta: sinCodigo(g.cuenta), saldo: g.neto, comprobantes: g.items.length }));
  out.a_pagar_por_contacto = gl.filter(g => g.tipo === "liability_payable" && Math.abs(g.neto) > 0.005).map(g => ({ contacto: g.contacto, cuenta: sinCodigo(g.cuenta), saldo: -g.neto, comprobantes: g.items.length }))
    .sort((a, b) => b.saldo - a.saldo);
  // abiertos que se compensan entre sí (neto 0): están saldados, falta vincularlos en Odoo
  out.sin_vincular = gl.filter(g => Math.abs(g.neto) <= 0.005 && g.items.length > 1).map(g => ({ contacto: g.contacto, cuenta: sinCodigo(g.cuenta), renglones: g.items.length, importe: r2(g.items.filter(x => x.saldo > 0).reduce((s, x) => s + x.saldo, 0)) }));

  // ---------- saldos por cuenta (balance) ----------
  const porCuenta = await rg("account.move.line", posted, ["balance:sum"], ["account_id"]);
  const cuentasInfo: Record<number, Rec> = {};
  const accIds = porCuenta.map(g => m2oId(g.account_id)).filter((x): x is number => !!x);
  if (accIds.length) for (const a of await sr("account.account", [["id", "in", accIds]], ["code", "name", "account_type"], { context: { ...ctx, active_test: false } })) cuentasInfo[a.id as number] = a;
  out.saldos_cuentas = porCuenta.map(g => { const a = cuentasInfo[m2oId(g.account_id) as number] || {}; return { codigo: a.code, cuenta: a.name, tipo: a.account_type, saldo: r2((g.balance as number) || 0) }; })
    .filter(x => Math.abs(x.saldo) >= 0.01).sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));

  // ---------- resultado por mes y cuenta (lo registrado en contabilidad) ----------
  const resMes = await rg("account.move.line", [...posted, ["date", ">=", DESDE], ["account_type", "in", ["income", "income_other", "expense", "expense_direct_cost", "expense_depreciation"]]], ["balance:sum"], ["account_id", "date:month"]);
  const resultado: Record<string, number[]> = {};
  for (const g of resMes) {
    const rango = (g.__range as Rec)?.["date:month"] as Rec | undefined; const mes = String(rango?.from || "").slice(0, 7); const i = idx[mes]; if (i === undefined) continue;
    const a = cuentasInfo[m2oId(g.account_id) as number] || {}; const k = `${a.code} ${a.name}`;
    (resultado[k] ||= zeros())[i] += -((g.balance as number) || 0);   // ingresos positivos, gastos negativos
  }
  out.resultado = Object.entries(resultado).map(([cuenta, v]) => ({ codigo: codigo(cuenta), cuenta: sinCodigo(cuenta), valores: v.map(r2) })).sort((a, b) => a.codigo.localeCompare(b.codigo));

  // ---------- borradores (lo que todavía no cuenta) ----------
  out.borradores = (await sr("account.move", [...emp, ["state", "=", "draft"]], ["name", "move_type", "date", "partner_id", "amount_total_signed", "ref"])).map(m => ({ comprobante: m.name || "(sin número)", tipo: m.move_type, fecha: m.date, contacto: m2oName(m.partner_id), importe: r2((m.amount_total_signed as number) || 0), ref: m.ref || "" }));

  // ---------- control: cada número por dos caminos ----------
  const porTipo = await rg("account.move.line", posted, ["balance:sum"], ["account_type"]);
  const tipoSaldo: Record<string, number> = {}; for (const g of porTipo) tipoSaldo[String(g.account_type)] = (g.balance as number) || 0;
  const sumaCuentasDinero = liqIds.reduce((s, a) => s + cuentas[a].saldo, 0);
  const sumaFlujo = Object.values(flujo).reduce((s, f) => s + f.entradas.reduce((a, b) => a + b, 0) - f.salidas.reduce((a, b) => a + b, 0), 0);
  const recTotal = rec.reduce((s, x) => s + x.saldo, 0), pagTotal = pag.reduce((s, x) => s + x.saldo, 0);
  const liqDesdeBalance = (out.saldos_cuentas as Rec[]).filter(x => liqIds.some(a => (cuentasInfo[a] || {}).code === x.codigo)).reduce((s, x) => s + (x.saldo as number), 0);
  out.control = {
    dinero: { renglones: r2(sumaCuentasDinero), balance: r2(liqDesdeBalance), dif: r2(sumaCuentasDinero - liqDesdeBalance) },
    flujo: { suma_flujo: r2(sumaFlujo), variacion_desde_marzo: r2(sumaCuentasDinero - (lLiq.filter(l => String(l.date) < DESDE).reduce((s, l) => s + ((l.balance as number) || 0), 0))), nota: "entradas − salidas por categoría = variación del dinero desde marzo" },
    a_cobrar: { abiertos: r2(recTotal), cuenta_clientes: r2(tipoSaldo.asset_receivable || 0), dif: r2(recTotal - (tipoSaldo.asset_receivable || 0)) },
    a_pagar: { abiertos: r2(pagTotal), cuenta_proveedores: r2(tipoSaldo.liability_payable || 0), dif: r2(pagTotal - (tipoSaldo.liability_payable || 0)) },
    renglones_dinero: lLiq.length, asientos_dinero: moveIds.length,
  };
  return out;
}
