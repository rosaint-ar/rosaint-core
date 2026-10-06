import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-metricas — tablero de Métricas del Core (solo lectura) ======
// Todo sale de Odoo, empresa VELAZQUEZ (company 2), desde marzo 2026 (mes 1).
// Ventas = facturas + ND de cliente publicadas, menos NC (amount_untaxed_signed).
// Compras = facturas de proveedor publicadas, menos NC de proveedor (sin IVA ni percepciones).
// Fecha = fecha de factura (invoice_date), igual que el informe de IIBB.
// Devuelve además un bloque `control` que suma cabeceras vs renglones mes a mes:
// si difieren en más de 1 centavo, la página lo muestra en rojo.
// `combos` (oct-2026): renglones de combos (categoría COMBOS / códigos 6xxxx) por variante,
// canal y mes, para el seguimiento de combos de la página.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const C = 2;
// Solo estas cuentas del Core pueden leer las ventas. El registro de usuarios de
// Supabase está abierto: sin esta lista, cualquiera que se cree una cuenta entraría.
const PERMITIDOS = new Set([
  "8a55f15a-184e-430b-9d2d-9067c1dbbd8a", // contacto@rosaint.com.ar
  "c0e45351-4a9f-43ec-8197-784672a00653", // rosaint.ar@gmail.com
]);
const DESDE = "2026-03-01";
type Rec = Record<string, unknown>;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
const m2oName = (v: unknown) => Array.isArray(v) ? String((v as unknown[])[1]) : "";
const r2 = (x: number) => Math.round(x * 100) / 100;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function usuarioValido(req: Request): Promise<boolean> {
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const apikey = req.headers.get("apikey") || PUB;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return PERMITIDOS.has(String(u?.id || ""));
  } catch { return false; }
}

// Grupo de gasto según el código de la cuenta contable del renglón de compra.
function grupoCompra(code: string): string {
  if (code.startsWith("1.1.6") || code.startsWith("5.1")) return "Producción";
  if (code.startsWith("5.2")) return "Comerciales";
  if (code.startsWith("5.3")) return "Administrativos";
  if (code.startsWith("5.9")) return "No operativos";
  if (code.startsWith("1.2")) return "Bienes de uso";
  return "Otros";
}


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  // conectores (Claude / MCP) con su clave propia de Tienda Nube o Mercado Libre
  const proxy = req.headers.get("x-proxy-secret") || "";
  if (proxy && [Deno.env.get("TN_PROXY_SECRET"), Deno.env.get("ML_PROXY_SECRET")].some((x) => x && x === proxy)) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (srk && a.slice(7) === srk) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}
function _servirConGuardia(...args: any[]) {
  const h = args[args.length - 1];
  args[args.length - 1] = async (req: Request, info: any) => {
    if (req.method === "OPTIONS" || await _accesoPermitido(req)) return h(req, info);
    return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), {
      status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  };
  return (Deno.serve as any)(...args);
}

_servirConGuardia(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!(await usuarioValido(req))) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { headers: cors });
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
    if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
    const ctx = { lang: "es_ES", allowed_company_ids: [C] };
    const ex = (model: string, method: string, args: unknown[], kw: Rec = {}) => rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kw, context: ctx }]) as Promise<Rec[]>;

    const now = new Date(Date.now() - 3 * 3600 * 1000);   // hora de Argentina (UTC-3)
    const meses: string[] = [];
    for (let d = new Date(Date.UTC(2026, 2, 1)); d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) meses.push(d.toISOString().slice(0, 7));
    const N = meses.length, idx: Record<string, number> = {}; meses.forEach((m, i) => idx[m] = i);
    const zeros = () => new Array(N).fill(0);
    const add = (obj: Record<string, number[]>, k: string, i: number, v: number) => { (obj[k] ||= zeros())[i] += v; };

    // ================= VENTAS =================
    const vMoves = await ex("account.move", "search_read", [[["company_id", "=", C], ["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund"]], ["invoice_date", ">=", DESDE]]],
      { fields: ["name", "move_type", "invoice_date", "partner_id", "commercial_partner_id", "amount_untaxed_signed", "amount_total_signed", "invoice_origin", "reversed_entry_id", "l10n_latam_document_type_id"] });
    const vById: Record<number, Rec> = {}; vMoves.forEach(m => vById[m.id as number] = m);

    // canal: por el pedido de venta de origen (equipo y origen UTM del pedido)
    const origenDe = (m: Rec): string => {
      let o = (m.invoice_origin as string) || "";
      if (!o || !/^S\d+/.test(o)) { const rev = m2oId(m.reversed_entry_id); if (rev && vById[rev]) o = (vById[rev].invoice_origin as string) || ""; }
      return (o.split(",")[0] || "").trim();
    };
    const soNames = [...new Set(vMoves.map(origenDe).filter(o => /^S\d+/.test(o)))];
    const sos = soNames.length ? await ex("sale.order", "search_read", [[["name", "in", soNames]]], { fields: ["name", "team_id", "source_id"] }) : [];
    const canalDePedido = (s: Rec) => {
      const src = m2oName(s.source_id).toLowerCase(), team = m2oName(s.team_id).toLowerCase();
      return src.includes("mercado") || team.includes("mercado") ? "Mercado Libre"
        : src.includes("tienda") ? "Tienda Nube" : team.includes("portal") ? "Portal web" : "Venta directa";
    };
    const canalSO: Record<string, string> = {};
    for (const s of sos) canalSO[s.name as string] = canalDePedido(s);
    const canalDe = (m: Rec) => canalSO[origenDe(m)] || "Venta directa";

    // provincia: la del contacto de la factura (mismo criterio que IIBB)
    const pids = [...new Set(vMoves.map(m => m2oId(m.partner_id)).filter((x): x is number => !!x))];
    const partners = pids.length ? await ex("res.partner", "read", [pids], { fields: ["state_id", "name"] }) : [];
    const provDe: Record<number, string> = {};
    for (const p of partners) provDe[p.id as number] = m2oName(p.state_id).replace(/\s*\(AR\)\s*$/, "") || "(Sin provincia)";

    // primera compra de cada cliente en VELAZQUEZ (para contar clientes nuevos)
    const primeras = await ex("account.move", "read_group", [[["company_id", "=", C], ["state", "=", "posted"], ["move_type", "=", "out_invoice"]], ["invoice_date:min"], ["commercial_partner_id"]], { lazy: false });
    const primeraDe: Record<number, string> = {};
    for (const g of primeras) { const id = m2oId(g.commercial_partner_id); if (id) primeraDe[id] = String(g.invoice_date || ""); }

    const serie = meses.map(m => ({ mes: m, ventas_brutas: 0, nc: 0, ventas_netas: 0, ventas_con_iva: 0, n_facturas: 0, n_nc: 0, compras_brutas: 0, compras_nc: 0, compras_netas: 0, margen: 0, unidades: 0, ingresos_envio: 0, descuentos: 0, otros_servicios: 0, clientes: 0, clientes_nuevos: 0, ticket: 0 }));
    const canal: Record<string, number[]> = {}, canalN: Record<string, number[]> = {};
    const prov: Record<string, number[]> = {}, provN: Record<string, number[]> = {};
    const tipo: Record<string, number[]> = {};
    const cli: Record<string, number[]> = {}, cliN: Record<string, number[]> = {}, cliNombre: Record<string, string> = {};
    const cliMes: Set<number>[] = meses.map(() => new Set());
    for (const m of vMoves) {
      const i = idx[String(m.invoice_date).slice(0, 7)]; if (i === undefined) continue;
      const unt = (m.amount_untaxed_signed as number) || 0, tot = (m.amount_total_signed as number) || 0;
      const s = serie[i];
      if (m.move_type === "out_invoice") { s.ventas_brutas += unt; s.n_facturas++; } else { s.nc += unt; s.n_nc++; }
      s.ventas_con_iva += tot;
      const c = canalDe(m); add(canal, c, i, unt); if (m.move_type === "out_invoice") add(canalN, c, i, 1);
      const pid = m2oId(m.partner_id); const pv = (pid && provDe[pid]) || "(Sin provincia)";
      add(prov, pv, i, unt); if (m.move_type === "out_invoice") add(provN, pv, i, 1);
      const doc = m2oName(m.l10n_latam_document_type_id);
      const letra = doc.trim().split(/\s+/).pop() || "";
      const t = ["A", "B", "C", "E"].includes(letra) ? "Comprobante " + letra : "Otro";
      add(tipo, t, i, unt);
      const cp = m2oId(m.commercial_partner_id);
      if (cp) { add(cli, String(cp), i, unt); cliNombre[String(cp)] = m2oName(m.commercial_partner_id); if (m.move_type === "out_invoice") { cliMes[i].add(cp); add(cliN, String(cp), i, 1); } }
    }
    serie.forEach((s, i) => {
      s.clientes = cliMes[i].size;
      s.clientes_nuevos = [...cliMes[i]].filter(id => (primeraDe[id] || "").slice(0, 7) === s.mes).length;
    });

    // renglones de venta: productos, unidades, envíos, descuentos
    const vLines = await ex("account.move.line", "search_read", [[["company_id", "=", C], ["parent_state", "=", "posted"], ["move_id.move_type", "in", ["out_invoice", "out_refund"]], ["move_id.invoice_date", ">=", DESDE], ["display_type", "=", "product"]]],
      { fields: ["move_id", "product_id", "quantity", "price_unit", "balance", "account_id", "sale_line_ids"] });
    const prodIds = [...new Set(vLines.map(l => m2oId(l.product_id)).filter((x): x is number => !!x))];
    const prods = prodIds.length ? await ex("product.product", "read", [prodIds], { fields: ["default_code", "name", "display_name", "categ_id", "type"], context: { ...ctx, active_test: false } }) : [];
    const prodInfo: Record<number, Rec> = {}; prods.forEach(p => prodInfo[p.id as number] = p);
    const prodAgg: Record<number, { neto: number[]; unidades: number[] }> = {};
    const ctrlVentasLineas = zeros();
    let facturadoVinculado = 0;
    const netoPorSaleLine: Record<number, number> = {};
    const descAgg: Record<string, number[]> = {}, otrosAgg: Record<string, number[]> = {};
    const comboAgg: Record<string, { pid: number; canal: string; neto: number[]; unidades: number[] }> = {};
    for (const l of vLines) {
      const mv = vById[m2oId(l.move_id) as number]; if (!mv) continue;
      const i = idx[String(mv.invoice_date).slice(0, 7)]; if (i === undefined) continue;
      const neto = -((l.balance as number) || 0);
      ctrlVentasLineas[i] += neto;
      if (Array.isArray(l.sale_line_ids) && (l.sale_line_ids as unknown[]).length) {
        facturadoVinculado += neto;
        const sl = (l.sale_line_ids as number[])[0]; netoPorSaleLine[sl] = (netoPorSaleLine[sl] || 0) + neto;
      }
      const code = m2oName(l.account_id).split(" ")[0];
      const pid = m2oId(l.product_id);
      const info = pid ? prodInfo[pid] : null;
      // envío cobrado: cuenta de envíos, o un servicio "Envío ..." de antes de separar la cuenta
      if (code === "4.1.1.01.030" || (info && info.type === "service" && /^env[ií]o/i.test(String(info.name)))) { serie[i].ingresos_envio += neto; continue; }
      // servicio con precio positivo (recargo, etc.): no es descuento, va aparte. Se mira el
      // precio del renglón y no el neto, porque en una NC el descuento se invierte de signo.
      if (code !== "5.2.1.01.080" && info && info.type === "service" && ((l.price_unit as number) || 0) >= 0) { serie[i].otros_servicios += neto; add(otrosAgg, String(info.name), i, neto); continue; }
      if (code === "5.2.1.01.080" || !pid || (info && info.type === "service")) { serie[i].descuentos += neto; add(descAgg, info ? String(info.name) : (code === "5.2.1.01.080" ? "Descuentos comerciales" : "(sin producto)"), i, neto); continue; }
      const sgn = mv.move_type === "out_refund" ? -1 : 1;
      const q = sgn * ((l.quantity as number) || 0);
      serie[i].unidades += q;
      const a = (prodAgg[pid] ||= { neto: zeros(), unidades: zeros() });
      a.neto[i] += neto; a.unidades[i] += q;
      // combos (kits de la categoría COMBOS, códigos 6xxxx): además se separan por canal
      if (info && (/combo/i.test(m2oName(info.categ_id)) || /^6\d{4}$/.test(String(info.default_code || "")) || /^\[combo\]/i.test(String(info.name)))) {
        const k = pid + "|" + canalDe(mv);
        const cb = (comboAgg[k] ||= { pid, canal: canalDe(mv), neto: zeros(), unidades: zeros() });
        cb.neto[i] += neto; cb.unidades[i] += q;
      }
    }
    const productos = Object.entries(prodAgg).map(([pid, a]) => {
      const p = prodInfo[+pid] || {};
      return { id: +pid, codigo: (p.default_code as string) || "", nombre: String(p.name || ""), categoria: m2oName(p.categ_id), neto: a.neto.map(r2), unidades: a.unidades.map(r2) };
    }).sort((x, y) => y.neto.reduce((s, v) => s + v, 0) - x.neto.reduce((s, v) => s + v, 0));
    // un renglón por combo (variante) y canal; la página arma los totales y el % sobre ventas
    const combos = Object.values(comboAgg).map(cb => {
      const p = prodInfo[cb.pid] || {};
      return { id: cb.pid, codigo: (p.default_code as string) || "", nombre: String(p.display_name || p.name || "").replace(/^\[[^\]]*\]\s*/, ""), canal: cb.canal, neto: cb.neto.map(r2), unidades: cb.unidades.map(r2) };
    }).sort((x, y) => x.codigo.localeCompare(y.codigo) || x.canal.localeCompare(y.canal));

    // ================= PEDIDOS CONFIRMADOS =================
    // Mes = fecha del pedido en hora argentina. Facturado = lo ya facturado (publicado, neto de NC)
    // de ESOS pedidos, según Odoo (untaxed_amount_invoiced de cada renglón).
    const pedidos = await ex("sale.order", "search_read", [[["company_id", "=", C], ["state", "in", ["sale", "done"]], ["date_order", ">=", DESDE + " 03:00:00"]]],
      { fields: ["name", "date_order", "amount_untaxed", "partner_id", "team_id", "source_id", "invoice_status"] });
    const pedIds = pedidos.map(p => p.id as number);
    const factPed: Record<number, number> = {};
    if (pedIds.length) {
      const g = await ex("sale.order.line", "read_group", [[["order_id", "in", pedIds]], ["untaxed_amount_invoiced:sum"], ["order_id"]], { lazy: false });
      for (const r of g) { const id = m2oId(r.order_id); if (id) factPed[id] = (r.untaxed_amount_invoiced as number) || 0; }
    }
    const mesAR = (dt: string) => new Date(new Date(dt.replace(" ", "T") + "Z").getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);
    const pedSerie = meses.map(m => ({ mes: m, n: 0, confirmado: 0, facturado: 0, sin_facturar: 0, n_pendientes: 0 }));
    const pedCanalC: Record<string, number[]> = {}, pedCanalF: Record<string, number[]> = {};
    const pendientes: Rec[] = [];
    let factPedTotal = 0;
    for (const p of pedidos) {
      const i = idx[mesAR(String(p.date_order))]; if (i === undefined) continue;
      const conf = (p.amount_untaxed as number) || 0, fac = factPed[p.id as number] || 0, sf = conf - fac;
      const s = pedSerie[i]; s.n++; s.confirmado += conf; s.facturado += fac; s.sin_facturar += sf;
      factPedTotal += fac;
      const cn = canalDePedido(p); add(pedCanalC, cn, i, conf); add(pedCanalF, cn, i, fac);
      if (Math.abs(sf) >= 1) {
        s.n_pendientes++;
        pendientes.push({ pedido: p.name, fecha: String(p.date_order), mes: meses[i], cliente: m2oName(p.partner_id), canal: cn, confirmado: r2(conf), facturado: r2(fac), sin_facturar: r2(sf), estado: p.invoice_status });
      }
    }
    pedSerie.forEach(s => { s.confirmado = r2(s.confirmado); s.facturado = r2(s.facturado); s.sin_facturar = r2(s.sin_facturar); });
    pendientes.sort((a, b) => (b.sin_facturar as number) - (a.sin_facturar as number));
    // control pedido por pedido: lo que Odoo dice facturado vs lo que suman las facturas vinculadas
    const slIds = Object.keys(netoPorSaleLine).map(Number);
    const slOrden = slIds.length ? await ex("sale.order.line", "read", [slIds], { fields: ["order_id"] }) : [];
    const factPorPedidoFacturas: Record<number, number> = {}; const nombrePed: Record<number, string> = {};
    for (const r of slOrden) { const o = m2oId(r.order_id); if (!o) continue; nombrePed[o] = m2oName(r.order_id); factPorPedidoFacturas[o] = (factPorPedidoFacturas[o] || 0) + (netoPorSaleLine[r.id as number] || 0); }
    const enListado = new Set(pedIds);
    const desvios: Rec[] = [];
    for (const o of new Set([...pedIds, ...Object.keys(factPorPedidoFacturas).map(Number)])) {
      const a = factPed[o] || 0, b = factPorPedidoFacturas[o] || 0;
      if (Math.abs(a - b) >= 0.05) desvios.push({ pedido: nombrePed[o] || (pedidos.find(p => p.id === o)?.name ?? o), segun_odoo: r2(a), segun_facturas: r2(b), dif: r2(a - b), en_listado: enListado.has(o) });
    }
    desvios.sort((x, y) => Math.abs(y.dif as number) - Math.abs(x.dif as number));
    // estado de los pedidos que no están en el listado de confirmados (cancelados, presupuestos)
    const fuera = Object.keys(factPorPedidoFacturas).map(Number).filter(o => !enListado.has(o));
    if (fuera.length) {
      try {   // informativo: si falla, no frena el tablero
        const est = await ex("sale.order", "read", [fuera], { fields: ["name", "state", "date_order"] });
        const eDe: Record<string, string> = {}; est.forEach(e => eDe[String(e.name)] = String(e.state) + " · " + String(e.date_order).slice(0, 10));
        desvios.forEach(d => { if (!d.en_listado) d.estado = eDe[String(d.pedido)] || "?"; });
      } catch { /* sin estado */ }
    }

    // ================= COMPRAS =================
    const cMoves = await ex("account.move", "search_read", [[["company_id", "=", C], ["state", "=", "posted"], ["move_type", "in", ["in_invoice", "in_refund"]], ["invoice_date", ">=", DESDE]]],
      { fields: ["move_type", "invoice_date", "partner_id", "commercial_partner_id", "amount_untaxed_signed"] });
    const cById: Record<number, Rec> = {}; cMoves.forEach(m => cById[m.id as number] = m);
    const prov2: Record<string, number[]> = {}, prov2Nombre: Record<string, string> = {};
    for (const m of cMoves) {
      const i = idx[String(m.invoice_date).slice(0, 7)]; if (i === undefined) continue;
      const v = -((m.amount_untaxed_signed as number) || 0);   // en Odoo las compras vienen en negativo
      if (m.move_type === "in_invoice") serie[i].compras_brutas += v; else serie[i].compras_nc += v;
      const cp = m2oId(m.commercial_partner_id); if (cp) { add(prov2, String(cp), i, v); prov2Nombre[String(cp)] = m2oName(m.commercial_partner_id); }
    }
    const cLines = await ex("account.move.line", "search_read", [[["company_id", "=", C], ["parent_state", "=", "posted"], ["move_id.move_type", "in", ["in_invoice", "in_refund"]], ["move_id.invoice_date", ">=", DESDE], ["display_type", "=", "product"]]],
      { fields: ["move_id", "balance", "account_id"] });
    const cGrupo: Record<string, number[]> = {}, cCuenta: Record<string, number[]> = {};
    const ctrlComprasLineas = zeros();
    for (const l of cLines) {
      const mv = cById[m2oId(l.move_id) as number]; if (!mv) continue;
      const i = idx[String(mv.invoice_date).slice(0, 7)]; if (i === undefined) continue;
      const v = (l.balance as number) || 0;
      ctrlComprasLineas[i] += v;
      const acc = m2oName(l.account_id);
      add(cGrupo, grupoCompra(acc.split(" ")[0]), i, v);
      add(cCuenta, acc, i, v);
    }

    serie.forEach(s => {
      s.ventas_netas = s.ventas_brutas + s.nc;
      s.compras_netas = s.compras_brutas + s.compras_nc;
      s.margen = s.ventas_netas - s.compras_netas;
      s.ticket = s.n_facturas ? s.ventas_brutas / s.n_facturas : 0;
      for (const k of Object.keys(s) as (keyof typeof s)[]) if (typeof s[k] === "number") (s as Rec)[k] = r2(s[k] as number);
    });

    const toList = (o: Record<string, number[]>, key: string, extra?: (k: string) => Rec) => Object.entries(o)
      .map(([k, v]) => ({ [key]: k, ...(extra ? extra(k) : {}), valores: v.map(r2), total: r2(v.reduce((a, b) => a + b, 0)) }))
      .sort((a, b) => (b.total as number) - (a.total as number));

    const control = {
      ventas: serie.map((s, i) => ({ mes: s.mes, cabecera: s.ventas_netas, renglones: r2(ctrlVentasLineas[i]), dif: r2(s.ventas_netas - ctrlVentasLineas[i]) })),
      compras: serie.map((s, i) => ({ mes: s.mes, cabecera: s.compras_netas, renglones: r2(ctrlComprasLineas[i]), dif: r2(s.compras_netas - ctrlComprasLineas[i]) })),
      comprobantes_venta: vMoves.length, comprobantes_compra: cMoves.length,
      pedidos: { facturado_segun_pedidos: r2(factPedTotal), facturado_segun_facturas: r2(facturadoVinculado), dif: r2(factPedTotal - facturadoVinculado), n_pedidos: pedidos.length, desvios: desvios.slice(0, 40) },
    };

    return new Response(JSON.stringify({
      ok: true, generado: new Date().toISOString(), desde: DESDE, meses, serie,
      canales: toList(canal, "canal", k => ({ n: canalN[k] || zeros() })),
      provincias: toList(prov, "provincia", k => ({ n: provN[k] || zeros() })),
      tipos: toList(tipo, "tipo"),
      clientes: toList(cli, "id", k => ({ nombre: cliNombre[k], n: cliN[k] || zeros() })),
      descuentos: toList(descAgg, "concepto"),
      otros_servicios: toList(otrosAgg, "concepto"),
      productos,
      combos,
      pedidos: { serie: pedSerie, canales: Object.keys(pedCanalC).map(k => ({ canal: k, confirmado: pedCanalC[k].map(r2), facturado: (pedCanalF[k] || zeros()).map(r2) })), pendientes },
      compras_grupos: toList(cGrupo, "grupo"),
      compras_cuentas: toList(cCuenta, "cuenta", k => ({ grupo: grupoCompra(k.split(" ")[0]) })),
      proveedores: toList(prov2, "id", k => ({ nombre: prov2Nombre[k] })),
      control,
    }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
