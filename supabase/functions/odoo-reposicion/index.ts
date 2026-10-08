import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ================================================================
// odoo-reposicion — releva de Odoo todo lo que hace falta para
// calcular la reposicion de materias primas y envases.
// SOLO LECTURA sobre Odoo. Guarda una foto en repo_snapshot.
// El calculo (punto de pedido, cantidad sugerida) lo hace la
// pantalla, con los parametros de repo_config / repo_proveedores.
// ================================================================
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const COMPANY_ID = 2;
// RM materias primas, BM envases, SP semielaborados, BM graneles, FP fraccionamiento
const CATEGORIAS = [7, 23, 5, 4, 14];
// Lo que se repone comprando: materias primas y envases.
const CATEGORIAS_COMPRA = [7, 23];
// Historial de precios y lotes: solo lo ya comprometido o recibido.
const ESTADOS_HISTORIA = ["purchase", "done"];
// Un pedido "abierto" es todo lo que ya se puso en marcha y todavia no llego:
// desde el presupuesto pedido hasta la orden confirmada sin recibir.
const ESTADOS_ABIERTOS = ["draft", "sent", "to approve", "purchase"];
const CTX = { allowed_company_ids: [COMPANY_ID], company_id: COMPANY_ID, lang: "es_ES" };

type Row = Record<string, unknown>;
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? (v[0] as number) ?? null : null);
const m2oName = (v: unknown): string => (Array.isArray(v) ? String(v[1] ?? "") : "");
const soloFecha = (v: unknown): string | null => (v ? String(v).split(" ")[0] : null);

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}

let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid as number;
  return _uid;
}

async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await auth();
  const ctx = { ...CTX, ...((kwargs.context as Record<string, unknown>) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: ctx }]);
}

// Odoo devuelve el mes como "marzo 2026" (lang es_ES). Lo pasamos a 2026-03.
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function mesISO(txt: string): string {
  const p = String(txt).trim().split(/\s+/);
  const i = MESES.indexOf((p[0] || "").toLowerCase());
  if (i < 0 || !p[1]) return String(txt);
  return p[1] + "-" + String(i + 1).padStart(2, "0");
}

// Como se llama cada estado en la pantalla.
const ESTADO_TXT: Record<string, string> = {
  draft: "presupuesto",
  sent: "presupuesto enviado",
  "to approve": "esperando aprobación",
  purchase: "confirmado",
  done: "cerrado",
};

async function relevar() {
  const t0 = Date.now();

  // --- 1. Maestro de productos (stock y costo incluidos) ---
  const prods = await call("product.product", "search_read", [[["categ_id", "in", CATEGORIAS]]], {
    fields: ["id", "default_code", "name", "categ_id", "qty_available", "free_qty", "virtual_available",
      "standard_price", "uom_id", "active"],
    context: { active_test: false },
  }) as Row[];

  const productos = prods.map((p) => ({
    id: p.id as number,
    codigo: String(p.default_code ?? "").trim(),
    nombre: String(p.name ?? ""),
    categoria: m2oName(p.categ_id),
    categoria_id: m2oId(p.categ_id),
    unidad: m2oName(p.uom_id),
    stock: Number(p.qty_available ?? 0),
    libre: Number(p.free_qty ?? 0),
    previsto: Number(p.virtual_available ?? 0),
    costo: Number(p.standard_price ?? 0),
    activo: Boolean(p.active),
    se_compra: CATEGORIAS_COMPRA.includes(m2oId(p.categ_id) ?? -1),
  }));

  // --- 2. Consumo real: lo que las ordenes de fabricacion se comieron, por mes ---
  const domConsumo = [["state", "=", "done"], ["company_id", "=", COMPANY_ID], ["raw_material_production_id", "!=", false]];
  const grupos = await call("stock.move", "read_group",
    [domConsumo, ["product_qty"], ["product_id", "date:month"]], { lazy: false }) as Row[];
  const consumo: Record<number, Record<string, number>> = {};
  for (const g of grupos) {
    const pid = m2oId(g.product_id);
    if (pid == null) continue;
    const mes = mesISO(String(g["date:month"] ?? ""));
    consumo[pid] = consumo[pid] || {};
    consumo[pid][mes] = (consumo[pid][mes] ?? 0) + Number(g.product_qty ?? 0);
  }

  // Primer movimiento con fecha: marca desde cuando hay historia real
  const primero = await call("stock.move", "search_read", [[["state", "=", "done"], ["company_id", "=", COMPANY_ID]]],
    { fields: ["date"], limit: 1, order: "date asc" }) as Row[];
  const desde = primero.length ? soloFecha(primero[0].date) : null;

  // --- 3. Compras: quien vende cada cosa, en que lotes y a que precio ---
  // Se traen tambien los presupuestos y las ordenes sin recibir, para poder avisar
  // que algo YA esta pedido y no volver a comprarlo.
  const todosEstados = [...new Set([...ESTADOS_HISTORIA, ...ESTADOS_ABIERTOS])];
  const ordenes = await call("purchase.order", "search_read",
    [[["state", "in", todosEstados], ["company_id", "=", COMPANY_ID]]],
    { fields: ["id", "name", "partner_id", "date_order", "date_approve", "date_planned", "currency_id", "state"], order: "date_order asc" }) as Row[];
  const ordenById = new Map<number, Row>();
  for (const o of ordenes) ordenById.set(o.id as number, o);

  const ids = ordenes.map((o) => o.id as number);
  const lineasRaw: Row[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await call("purchase.order.line", "search_read",
      [[["order_id", "in", ids.slice(i, i + 50)], ["display_type", "=", false]]],
      { fields: ["id", "order_id", "product_id", "product_qty", "qty_received", "price_unit", "price_subtotal", "date_planned"] }) as Row[];
    lineasRaw.push(...r);
  }

  const compras: Row[] = [];
  const pedidos: Row[] = [];
  for (const l of lineasRaw) {
    const o = ordenById.get(m2oId(l.order_id) ?? -1);
    if (!o) continue;
    const estado = String(o.state ?? "");
    const pedida = Number(l.product_qty ?? 0);
    const recibida = Number(l.qty_received ?? 0);
    const base = {
      oc: String(o.name ?? ""),
      fecha: soloFecha(o.date_approve) ?? soloFecha(o.date_order),
      proveedor: m2oName(o.partner_id),
      producto_id: m2oId(l.product_id),
      cantidad: pedida,
      recibida,
      precio: Number(l.price_unit ?? 0),
      subtotal: Number(l.price_subtotal ?? 0),
      moneda: m2oName(o.currency_id),
      estado,
      estado_txt: ESTADO_TXT[estado] ?? estado,
    };

    if (ESTADOS_HISTORIA.includes(estado)) {
      compras.push({
        ...base,
        // Los liquidos se reciben con merma (piden 10 kg, entran 9,53). Recien por
        // debajo del 95% lo tomamos como mercaderia que todavia no llego.
        pendiente: recibida < pedida * 0.95 ? Number((pedida - recibida).toFixed(3)) : 0,
      });
    }

    // Pedido abierto: presupuesto todavia sin confirmar, o confirmado que no llego.
    const falta = Number((pedida - recibida).toFixed(3));
    const abierto = estado !== "purchase"
      ? ESTADOS_ABIERTOS.includes(estado)
      : recibida < pedida * 0.95;
    if (abierto && falta > 0) {
      pedidos.push({
        ...base,
        falta,
        // Confirmado = ya cuenta como mercaderia en camino para Odoo.
        // Presupuesto = todavia es una intencion, no suma al stock previsto.
        comprometido: estado === "purchase",
        fecha_pedido: soloFecha(o.date_order),
        fecha_prevista: soloFecha(l.date_planned) ?? soloFecha(o.date_planned),
      });
    }
  }

  const datos = {
    generado_en: new Date().toISOString(),
    historia_desde: desde,
    productos,
    consumo,
    compras,
    pedidos,
  };
  return { datos, duracion_ms: Date.now() - t0 };
}

// --- Modo "costos" (SOLO LECTURA, no guarda nada) ---
// Para auditar de dónde sale el costo de cada materia prima y envase:
// unidades (stock / compra), capas de valuación de las recepciones (incluye el ajuste
// por precio de factura) y renglones de factura vinculados a cada pedido.
async function relevarCostos(codigosExtra: string[] = []) {
  const t0 = Date.now();
  // Materias primas y envases + códigos sueltos que Core usa y no aparecen en esas categorías.
  const dom = codigosExtra.length
    ? ["|", ["categ_id", "in", CATEGORIAS_COMPRA], ["default_code", "in", codigosExtra]]
    : [["categ_id", "in", CATEGORIAS_COMPRA]];
  const prods = await call("product.product", "search_read", [dom], {
    fields: ["id", "default_code", "name", "categ_id", "uom_id", "uom_po_id", "standard_price", "qty_available", "active"],
    context: { active_test: false },
  }) as Row[];
  const pids = prods.map((p) => p.id as number);

  const uomIds = [...new Set(prods.flatMap((p) => [m2oId(p.uom_id), m2oId(p.uom_po_id)]).filter((x) => x != null))];
  const uoms = await call("uom.uom", "read", [uomIds, ["name", "factor", "factor_inv", "category_id"]]) as Row[];

  const capas = await call("stock.valuation.layer", "search_read",
    [[["company_id", "=", COMPANY_ID], ["product_id", "in", pids]]],
    { fields: ["id", "product_id", "quantity", "value", "unit_cost", "create_date", "stock_move_id", "stock_valuation_layer_id", "account_move_id", "description"] }) as Row[];

  const moveIds = [...new Set(capas.map((c) => m2oId(c.stock_move_id)).filter((x) => x != null))] as number[];
  const moves: Row[] = [];
  for (let i = 0; i < moveIds.length; i += 200) {
    moves.push(...await call("stock.move", "read", [moveIds.slice(i, i + 200), ["date", "reference", "purchase_line_id", "product_uom", "product_uom_qty", "quantity"]]) as Row[]);
  }

  const plIds = [...new Set(moves.map((m) => m2oId(m.purchase_line_id)).filter((x) => x != null))] as number[];
  const factLineas = plIds.length ? await call("account.move.line", "search_read",
    [[["purchase_line_id", "in", plIds], ["parent_state", "=", "posted"]]],
    { fields: ["move_id", "purchase_line_id", "product_id", "price_unit", "discount", "quantity", "product_uom_id", "currency_id", "price_subtotal", "balance", "date"] }) as Row[] : [];
  const movIds = [...new Set(factLineas.map((l) => m2oId(l.move_id)).filter((x) => x != null))] as number[];
  const facturas = movIds.length ? await call("account.move", "read", [movIds, ["name", "invoice_date", "partner_id", "currency_id", "invoice_currency_rate", "move_type", "payment_state", "invoice_payments_widget"]]) as Row[] : [];

  // Notas de crédito de proveedor sobre estos productos (con o sin pedido vinculado).
  // reversed_entry_id dice a qué factura corrigen.
  const ncLineas = await call("account.move.line", "search_read",
    [[["product_id", "in", pids], ["move_id.move_type", "=", "in_refund"], ["parent_state", "=", "posted"]]],
    { fields: ["move_id", "purchase_line_id", "product_id", "price_unit", "quantity", "product_uom_id", "currency_id", "price_subtotal", "balance", "date"] }) as Row[];
  const ncIds = [...new Set(ncLineas.map((l) => m2oId(l.move_id)).filter((x) => x != null))] as number[];
  const ncs = ncIds.length ? await call("account.move", "read", [ncIds, ["name", "invoice_date", "partner_id", "currency_id", "reversed_entry_id", "ref"]]) as Row[] : [];

  // Costos en destino (flete, despacho, etc. prorrateados a la recepción). Si el módulo
  // no estuviera instalado, se informa el error y sigue el resto.
  let costos_destino: Row[] = [], costos_destino_lineas: Row[] = [], costos_destino_error: string | null = null;
  try {
    costos_destino = await call("stock.landed.cost", "search_read", [[["company_id", "=", COMPANY_ID], ["state", "=", "done"]]],
      { fields: ["id", "name", "date", "amount_total", "picking_ids", "vendor_bill_id", "target_model"] }) as Row[];
    costos_destino_lineas = await call("stock.valuation.adjustment.lines", "search_read",
      [[["cost_id", "in", costos_destino.map((c) => c.id as number)]]],
      { fields: ["cost_id", "product_id", "move_id", "quantity", "former_cost", "additional_landed_cost", "cost_line_id"] }) as Row[];
  } catch (e) { costos_destino_error = String((e as Error).message ?? e); }

  return { productos: prods, uoms, capas, moves, facturas_lineas: factLineas, facturas, nc_lineas: ncLineas, ncs,
    costos_destino, costos_destino_lineas, costos_destino_error, duracion_ms: Date.now() - t0 };
}

// --- Modo "costos_sync": actualiza el precio en USD de Core con la última compra real de Odoo ---
// Reglas (acordadas con Dirección, 08-10-2026):
//  costo = (renglón de factura − NC que la revierte + flete en destino) ÷ cantidad que entró (kg o unidades),
//          pasado a USD con el BNA (cotizaciones_dolar) de la fecha de factura. Sin IVA ni percepciones.
//  Factura pagada con el diario "Pagos internos" = mercadería sin costo: se ignora y vale la compra anterior.
//  Recepción todavía sin factura: precio del pedido (origen odoo-pedido); se corrige cuando entra la factura.
//  Un precio cargado a mano en Core después de la última compra se respeta hasta que entre una compra nueva.
async function sincronizarCostos(sb: ReturnType<typeof createClient>, aplicar: boolean) {
  const d = await relevarCostos() as Record<string, any>;
  const { data: cot } = await sb.from("cotizaciones_dolar").select("fecha,venta_oficial").order("fecha");
  const fechas = (cot || []).map((c: any) => [String(c.fecha), Number(c.venta_oficial)] as [string, number]);
  const bna = (f: string) => { let r: number | null = null; for (const [x, v] of fechas) { if (x <= f) r = v; else break; } return r; };

  const mv = new Map<number, Row>(d.moves.map((m: Row) => [m.id as number, m]));
  const fac = new Map<number, Row>(d.facturas.map((f: Row) => [f.id as number, f]));
  const interna = (f: Row) => ((f.invoice_payments_widget as any)?.content || []).some((p: any) => /pagos internos/i.test(String(p.journal_name)));
  const hijos: Record<number, Row[]> = {};
  for (const c of d.capas) { const p = m2oId(c.stock_valuation_layer_id); if (p != null) (hijos[p] = hijos[p] || []).push(c); }

  // Por renglón de pedido: cantidad que entró, valor de la recepción y flete en destino
  const pl: Record<number, { pid: number; cant: number; valRec: number; flete: number; fechaRec: string }> = {};
  for (const c of d.capas) {
    if (m2oId(c.stock_valuation_layer_id) != null || !c.stock_move_id || Number(c.quantity) <= 0) continue;
    const m = mv.get(m2oId(c.stock_move_id)!); const k = m2oId(m?.purchase_line_id); if (k == null) continue;
    const h = hijos[c.id as number] || [];
    const x = pl[k] = pl[k] || { pid: m2oId(c.product_id)!, cant: 0, valRec: 0, flete: 0, fechaRec: String(c.create_date).slice(0, 10) };
    x.cant += Number(c.quantity);
    x.valRec += Number(c.value) + h.filter((y) => !/^LC/.test(String(y.description))).reduce((s, y) => s + Number(y.value), 0);
    x.flete += h.filter((y) => /^LC/.test(String(y.description))).reduce((s, y) => s + Number(y.value), 0);
  }
  const ncPorFac: Record<string, number> = {};
  const ncById = new Map<number, Row>(d.ncs.map((n: Row) => [n.id as number, n]));
  for (const l of d.nc_lineas) {
    const r = m2oId(ncById.get(m2oId(l.move_id)!)?.reversed_entry_id); if (r == null) continue;
    const k = `${r}|${m2oId(l.product_id)}`; ncPorFac[k] = (ncPorFac[k] || 0) + Math.abs(Number(l.balance));
  }

  const compras: Row[] = [];
  for (const [k, x] of Object.entries(pl)) {
    const fl = d.facturas_lineas.filter((l: Row) => m2oId(l.purchase_line_id) === Number(k));
    const fs = [...new Set(fl.map((l: Row) => m2oId(l.move_id)))].map((id) => fac.get(id as number)).filter(Boolean) as Row[];
    let ars: number, fecha = x.fechaRec, origen = "odoo", factura: string | null = null, proveedor = "", nota = "";
    if (!fl.length) { ars = x.valRec; origen = "odoo-pedido"; nota = "recepción sin factura: precio del pedido"; }
    else {
      if (fs.some(interna)) continue;
      const nc = fs.reduce((s, f) => s + (ncPorFac[`${f.id}|${x.pid}`] || 0), 0);
      ars = fl.reduce((s: number, l: Row) => s + Number(l.balance), 0) - nc;
      if (ars <= 0.01) continue; // anulada por NC
      const f = fs[0]; fecha = String(f.invoice_date || fecha); factura = fs.map((f) => f.name).join(" + "); proveedor = m2oName(f.partner_id);
      if (nc) nota = `menos NC por $${nc.toFixed(2)}`;
    }
    const tc = bna(fecha); if (!tc) continue;
    compras.push({ linea: Number(k), pid: x.pid, fecha, cant: x.cant, ars, flete: x.flete, tc, origen, factura, proveedor, nota,
      usd: (ars + x.flete) / x.cant / tc });
  }

  const { data: items } = await sb.from("items").select("codigo,tipo,unidad").in("tipo", ["MP", "IN"]);
  const { data: precios } = await sb.from("precios_items").select("*").order("vigente_desde", { ascending: false }).order("id", { ascending: false }).limit(5000);
  const ultimo: Record<string, any> = {}; const lineasVistas = new Set<number>();
  for (const p of precios || []) { if (!ultimo[p.codigo_item]) ultimo[p.codigo_item] = p; if (p.odoo_linea_compra) lineasVistas.add(p.odoo_linea_compra); }
  const prodPorCod = new Map<string, Row>(d.productos.map((p: Row) => [String(p.default_code ?? "").trim(), p]));

  const cambios: any[] = [], avisos: any[] = [];
  for (const it of items || []) {
    const p = prodPorCod.get(it.codigo); if (!p) continue;
    const uOdoo = m2oName(p.uom_id).toLowerCase(), uCore = String(it.unidad).toLowerCase();
    if (!((uCore === "kg" && uOdoo === "kg") || (uCore === "unidad" && uOdoo === "unidades"))) { avisos.push({ codigo: it.codigo, aviso: `unidad distinta (Core ${it.unidad} / Odoo ${m2oName(p.uom_id)})` }); continue; }
    const c = compras.filter((x) => x.pid === p.id).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || Number(b.linea) - Number(a.linea))[0];
    if (!c) continue;
    const u = ultimo[it.codigo]; const usd = Math.round(Number(c.usd) * 10000) / 10000;
    if (u && u.odoo_linea_compra === c.linea) {
      // misma compra: solo se corrige si cambió el importe (llegó la factura, una NC o el flete)
      if (u.origen === c.origen && Math.abs(Number(u.usd_unidad) / usd - 1) < 0.005) continue;
    } else if (u && u.origen === "manual" && lineasVistas.has(c.linea)) {
      // esta compra ya se había tomado y después alguien cargó un precio a mano:
      // manda el manual hasta que entre una compra nueva
      continue;
    }
    const vig = u && String(u.vigente_desde) > String(c.fecha) ? String(u.vigente_desde) : String(c.fecha);
    cambios.push({
      codigo_item: it.codigo, usd_unidad: usd, flete_pct: 0, iva_pct: 21, vigente_desde: vig,
      origen: c.origen, odoo_linea_compra: c.linea, factura: c.factura, proveedor: c.proveedor, fecha_compra: c.fecha,
      cantidad_recibida: Math.round(Number(c.cant) * 10000) / 10000,
      costo_ars_unidad: Math.round(Number(c.ars) / Number(c.cant) * 100) / 100,
      flete_ars_unidad: Math.round(Number(c.flete) / Number(c.cant) * 100) / 100, tc_bna: c.tc,
      notas: `Auto desde Odoo: ${c.factura || "pedido sin factura"}${c.nota ? " (" + c.nota + ")" : ""}`,
      _antes_usd: u ? Number(u.usd_unidad) : null, _antes_origen: u?.origen ?? null,
    });
  }
  let insertados = 0;
  if (aplicar && cambios.length) {
    const filas = cambios.map(({ _antes_usd, _antes_origen, ...r }) => r);
    const { error } = await sb.from("precios_items").insert(filas);
    if (error) throw new Error("No se pudieron guardar los precios: " + error.message);
    insertados = filas.length;
  }
  return { aplicado: aplicar, insertados, cambios, avisos };
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
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body = relevar */ }
    const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // modo "ultimo": devuelve la foto guardada sin pegarle a Odoo
    if (body.modo === "ultimo") {
      const { data } = await sb.from("repo_snapshot").select("generado_en,datos").order("generado_en", { ascending: false }).limit(1);
      if (!data || !data.length) {
        return new Response(JSON.stringify({ ok: false, error: "Todavia no hay ninguna foto guardada" }), { headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, cache: true, generado_en: data[0].generado_en, datos: data[0].datos }), { headers: cors });
    }

    // { modo: "costos_sync", aplicar: true } guarda; sin aplicar es un ensayo que solo lista los cambios
    if (body.modo === "costos_sync") {
      return new Response(JSON.stringify({ ok: true, ...(await sincronizarCostos(sb, body.aplicar === true)) }), { headers: cors });
    }

    if (body.modo === "costos") {
      return new Response(JSON.stringify({ ok: true, ...(await relevarCostos(Array.isArray(body.codigos) ? (body.codigos as string[]) : [])) }), { headers: cors });
    }

    const { datos, duracion_ms } = await relevar();
    await sb.from("repo_snapshot").insert({ datos, duracion_ms });
    // Dejamos las ultimas 30 fotos nada mas
    const { data: viejas } = await sb.from("repo_snapshot").select("id").order("generado_en", { ascending: false }).range(30, 999);
    if (viejas && viejas.length) await sb.from("repo_snapshot").delete().in("id", viejas.map((v) => v.id));

    return new Response(JSON.stringify({ ok: true, cache: false, generado_en: datos.generado_en, duracion_ms, datos }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), { headers: cors });
  }
});
