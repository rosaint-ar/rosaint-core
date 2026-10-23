import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// tn-seguimientos v42 — SOLO LECTURA. verify_jwt=true. Panel de ventas confirmadas de Odoo + stock.
// v41: fecha_despacho = stock.picking.date_done (respaldo; el real sale de tracking-despacho).
// v42 (22-10-2026): ① Mercado Libre usa el ESTADO REAL del envio (tabla ml_envio_estado que mantiene
//   el cron ml-estado-sync, status+substatus del shipment) en vez del delivery_status de Odoo, que se
//   marca full al cargar la venta y daba TODO como despachado. ② Las ventas SIN transporte asignado ya
//   no se asumen "retiro": van a la categoria 'sinasignar' (puede faltar cargar el envio). Un retiro de
//   verdad solo si la linea de envio dice retiro/mostrador.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
// Etiquetas de ESTADO que maneja Seguimientos: 21 ✅ Listo y 22 🔄 Entrega parcial (excluyentes).
// Desde el 23/10/2026 el "¿para cuándo?" es la FECHA DE DESPACHO del pedido (commitment_date, la
// pildora de color del listado de ventas de Odoo): las etiquetas 2 Hoy, 4 1 dia y 5 2-3 dias se borraron.
const READINESS = [21, 22];
// Dia ARGENTINO (UTC-3) de un datetime de Odoo (que viene en UTC), como AAAA-MM-DD.
function diaAR(s: unknown): string | null {
  if (!s) return null;
  const t = Date.parse(String(s).replace(" ", "T") + "Z");
  return isNaN(t) ? null : new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
const STORE_ID = 385079;
const TN_BASE = `https://api.tiendanube.com/2025-03/${STORE_ID}`;
const UA = "Rosaint Core - seguimientos (rosaint.ar@gmail.com)";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
type Rec = Record<string, unknown>;

async function getToken(): Promise<string> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_store_token`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("token rpc " + r.status + ": " + (await r.text()));
  const tok = await r.json(); if (!tok || typeof tok !== "string") throw new Error("Sin token TN"); return tok;
}
async function odooRpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function odooAuth(): Promise<number> { const uid = await odooRpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid) throw new Error("Odoo auth"); return uid as number; }
async function odooExec(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await odooRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: { allowed_company_ids: [COMPANY_ID] } }]); }

function normPhone(raw: string): string { let d = (raw || "").replace(/\D/g, ""); if (!d) return ""; if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("0")) d = d.slice(1); if (!d.startsWith("54")) d = "54" + d; if (d[2] !== "9") d = "549" + d.slice(2); return d; }
function carrierDe(f: Rec | undefined): { nombre: string; opcion: string } {
  const shipping = (f?.shipping || {}) as Rec; const option = (shipping.option || {}) as Rec; const carrier = (shipping.carrier || {}) as Rec;
  const opcion = String(option.name || carrier.name || ""); const s = opcion.toLowerCase(); let nombre = String(carrier.name || "Envío");
  if (/andreani/.test(s)) nombre = "Andreani"; else if (/correo\s*argentino/.test(s)) nombre = "Correo Argentino"; else if (/\boca\b/.test(s)) nombre = "OCA"; else if (/retiro|pickup|retira|acordar/.test(s)) nombre = "Retiro";
  return { nombre, opcion };
}
function modalidadDe(opcion: string): string { const s = (opcion || "").toLowerCase(); if (/sucursal|pickup|punto|hop/.test(s)) return "Retiro en sucursal"; return "Envío a domicilio"; }
function primerNombre(nombre: string): string { const n = (nombre || "").trim().split(/\s+/)[0] || ""; if (!n) return ""; return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(); }
function nameTokens(s: string): string[] { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3); }
function diaUTC(iso: string): number { const d = new Date(iso); return Math.floor(d.getTime() / 86400000); }
function fechaDespachoDMY(odooDt: string): string {
  const d = new Date(String(odooDt).replace(" ", "T") + "Z"); if (isNaN(d.getTime())) return "";
  const art = new Date(d.getTime() - 3 * 3600 * 1000); const p = (n: number) => String(n).padStart(2, "0");
  return p(art.getUTCDate()) + "/" + p(art.getUTCMonth() + 1) + "/" + art.getUTCFullYear();
}
function prodFromLine(l: Rec): Rec { const raw = String(l.name || ""); const m = raw.match(/^\[([^\]]+)\]\s*([\s\S]+)$/); return { sku: m ? m[1] : null, nombre: m ? m[2].trim().split(/\n/)[0] : raw.trim().split(/\n/)[0], cantidad: Number(l.product_uom_qty || 1) }; }
function esEnvio(f: Rec): boolean {
  const sh = (f.shipping as Rec) || {};
  if (sh.type === "ship") return true;
  if ((f.tracking_info as Rec)?.code) return true;
  const opt = String(((sh.option as Rec)?.name) || ((sh.carrier as Rec)?.name) || "").toLowerCase();
  if (sh.type === "pickup" && /(env[ií]o nube|andreani|correo|\boca\b|sucursal|punto|hop)/.test(opt)) return true;
  return false;
}
// Categoria por tipo de entrega. 'sinasignar' = venta sin transporte cargado en Odoo (NO se asume
// retiro: puede faltar cargar el envio). 'retiro' solo si la linea lo dice expresamente.
function categoriaDe(o: Rec, lineLabel: string): string {
  const src = Array.isArray(o.source_id) ? String((o.source_id as unknown[])[1]).toLowerCase() : "";
  if (/mercado libre|meli/.test(src)) return "ml";
  const s = (lineLabel || "").toLowerCase();
  if (s) {
    if (/retir|mostrador/.test(s)) return "retiro";
    if (/local|rosario/.test(s)) return "rosario";
    return "correo";
  }
  return "sinasignar";
}

async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const dias = Number(new URL(req.url).searchParams.get("dias") || "30");
    const sinceMs = Date.now() - dias * 24 * 3600 * 1000;
    const since = new Date(sinceMs).toISOString();

    const token = await getToken();
    const url = `${TN_BASE}/orders?payment_status=paid&per_page=100&created_at_min=${encodeURIComponent(since)}&sort=-id`;
    const tr = await fetch(url, { headers: { Authentication: `bearer ${token}`, "User-Agent": UA, Accept: "application/json" } });
    if (!tr.ok) throw new Error("TN orders " + tr.status + ": " + (await tr.text()));
    const orders = (await tr.json()) as Rec[];
    const tnList: Rec[] = [];
    for (const o of orders) {
      if (o.cancelled_at || o.status === "cancelled") continue;
      const ffs = (o.fulfillments as Rec[]) || []; const ships = ffs.filter(esEnvio); if (!ships.length) continue;
      const f = ships.find((x) => ((x.tracking_info as Rec)?.code)) || ships[0]; const tinfo = (f.tracking_info as Rec) || {}; const { nombre: transportista, opcion } = carrierDe(f);
      const fst = String(f.status || "").toUpperCase(); const sst = String(o.shipping_status || "").toLowerCase();
      const despachado = ["DISPATCHED", "SHIPPED", "IN_TRANSIT", "DELIVERED", "FULFILLED"].includes(fst) || ["shipped", "fulfilled", "dispatched", "delivered", "in_transit"].includes(sst);
      const clienteTN = String(o.contact_name || (o.customer as Rec)?.name || ""); const telRaw = String(o.contact_phone || (o.customer as Rec)?.phone || ""); const ship = (o.shipping_address as Rec) || {};
      const productos = ((o.products as Rec[]) || []).map((p) => ({ nombre: String(p.name || ""), cantidad: Number(p.quantity || 1), sku: p.sku ? String(p.sku) : null }));
      tnList.push({ numero: o.number, fecha: o.created_at, cliente_tn: clienteTN, telefono_wa: normPhone(telRaw), provincia: ship.province || null, ciudad: ship.city || null, productos, total: Number(o.total || 0), transportista, modalidad: modalidadDe(opcion), tracking_code: tinfo.code ? String(tinfo.code) : null, tracking_url: tinfo.url ? String(tinfo.url) : null, shipping_status: sst || null, despachado });
    }

    const uid = await odooAuth();
    const odooSince = new Date(sinceMs - 3 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const odooOrders = await odooExec(uid, "sale.order", "search_read", [[["company_id", "=", COMPANY_ID], ["state", "in", ["sale", "done"]], ["date_order", ">=", odooSince]]], { fields: ["name", "amount_total", "date_order", "partner_id", "delivery_status", "carrier_id", "source_id", "tag_ids", "client_order_ref", "commitment_date"], order: "id desc", limit: 800 }) as Rec[];
    const oids = odooOrders.map((o) => o.id as number);

    const lineByOrder: Record<number, string> = {};
    try { const dl = await odooExec(uid, "sale.order.line", "search_read", [[["order_id", "in", oids], ["is_delivery", "=", true]]], { fields: ["order_id", "name"] }) as Rec[]; for (const l of dl) { const oid = Array.isArray(l.order_id) ? (l.order_id as unknown[])[0] as number : 0; lineByOrder[oid] = String(l.name || ""); } } catch (_e) { /* */ }
    const partnerIds = [...new Set(odooOrders.map((o) => Array.isArray(o.partner_id) ? (o.partner_id as unknown[])[0] as number : null).filter((x): x is number => x != null))];
    const pmap: Record<number, Rec> = {};
    try { const ps = await odooExec(uid, "res.partner", "read", [partnerIds], { fields: ["id", "name", "mobile", "phone", "city", "state_id"] }) as Rec[]; for (const p of ps) pmap[p.id as number] = p; } catch (_e) { /* */ }
    const prodByOrder: Record<number, Rec[]> = {};
    const allProdIds = new Set<number>();
    try { const ls = await odooExec(uid, "sale.order.line", "search_read", [[["order_id", "in", oids], ["is_delivery", "=", false], ["display_type", "=", false]]], { fields: ["order_id", "name", "product_uom_qty", "qty_delivered", "product_id"] }) as Rec[]; for (const l of ls) { const oid = Array.isArray(l.order_id) ? (l.order_id as unknown[])[0] as number : 0; const nm = String(l.name || "").toLowerCase(); if (/descuento|env[ií]o|gratuit|free|reembolso/.test(nm)) continue; (prodByOrder[oid] ||= []).push(l); const pidp = Array.isArray(l.product_id) ? (l.product_id as unknown[])[0] as number : null; if (pidp) allProdIds.add(pidp); } } catch (_e) { /* */ }
    const stockMap: Record<number, number> = {};
    if (allProdIds.size) { try { const prods = await odooExec(uid, "product.product", "read", [[...allProdIds]], { fields: ["qty_available"] }) as Rec[]; for (const p of prods) stockMap[p.id as number] = Number(p.qty_available || 0); } catch (_e) { /* */ } }
    const fechaDespachoPorOrden: Record<number, string> = {};
    try {
      const picks = await odooExec(uid, "stock.picking", "search_read", [[["sale_id", "in", oids], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]]], { fields: ["sale_id", "date_done"] }) as Rec[];
      for (const pk of picks) {
        const soid = Array.isArray(pk.sale_id) ? (pk.sale_id as unknown[])[0] as number : 0;
        const dd = pk.date_done ? String(pk.date_done) : "";
        if (!soid || !dd) continue;
        if (!fechaDespachoPorOrden[soid] || dd > fechaDespachoPorOrden[soid]) fechaDespachoPorOrden[soid] = dd;
      }
    } catch (_e) { /* */ }
    let etiquetasOpciones: Rec[] = [];
    try { etiquetasOpciones = await odooExec(uid, "crm.tag", "read", [READINESS], { fields: ["id", "name"] }) as Rec[]; } catch (_e) { /* */ }

    // Estado REAL de despacho de ML (cron ml-estado-sync). Odoo marca delivery_status=full al cargar
    // la venta de ML -> no sirve para saber si salio. client_order_ref en Odoo puede ser el order_id
    // O el pack_id, por eso el mapa indexa por los dos.
    const esMlOrder = (o: Rec) => Array.isArray(o.source_id) && /mercado libre|meli/i.test(String((o.source_id as unknown[])[1]));
    const mlRefs = [...new Set(odooOrders.filter(esMlOrder).map((o) => String(o.client_order_ref || "").trim()).filter(Boolean))];
    const mlRef: Record<string, Rec> = {};
    if (mlRefs.length) {
      try {
        const L = mlRefs.join(",");
        const r = await fetch(`${SB_URL}/rest/v1/ml_envio_estado?select=ml_order_id,pack_id,despachado,entregado,estado_label&or=(ml_order_id.in.(${L}),pack_id.in.(${L}))`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
        if (r.ok) { const rows = await r.json() as Rec[]; for (const row of rows) { if (row.ml_order_id) mlRef[String(row.ml_order_id)] = row; if (row.pack_id) mlRef[String(row.pack_id)] = row; } }
      } catch (_e) { /* */ }
    }

    const idx: Record<string, Rec[]> = {};
    for (const so of odooOrders) { const k = (Math.round(Number(so.amount_total) * 100) / 100).toFixed(2); (idx[k] ||= []).push(so); }
    const tnByOdoo: Record<number, Rec> = {};
    const porRef: Record<string, Rec> = {};
    for (const so of odooOrders) if (so.client_order_ref) porRef[String(so.client_order_ref).trim()] = so;
    for (const tn of tnList) {
      const so = porRef[String(tn.numero)];
      if (so && !tnByOdoo[so.id as number]) { tnByOdoo[so.id as number] = tn; tn._cruzado = true; }
    }
    for (const tn of tnList) {
      if (tn._cruzado) continue;
      const k = (Math.round(Number(tn.total) * 100) / 100).toFixed(2); let cands = idx[k] || [];
      if (!cands.length) { const t = Number(tn.total); cands = odooOrders.filter((so) => Math.abs(Number(so.amount_total) - t) <= 0.5); }
      if (!cands.length) continue;
      let best: Rec | null = null; let bestScore = -1;
      const tnTok = new Set(nameTokens(String(tn.cliente_tn))); const tnDia = diaUTC(String(tn.fecha));
      for (const so of cands) { if (tnByOdoo[so.id as number]) continue; const soName = Array.isArray(so.partner_id) ? String((so.partner_id as unknown[])[1]) : ""; const overlap = nameTokens(soName).filter((t) => tnTok.has(t)).length; const soDia = diaUTC(String(so.date_order).replace(" ", "T") + "Z"); const prox = Math.max(0, 5 - Math.abs(soDia - tnDia)); const score = overlap * 10 + prox; if (score > bestScore) { bestScore = score; best = so; } }
      if (best && bestScore >= 10) tnByOdoo[best.id as number] = tn;
    }

    const out: Rec[] = [];
    const stockLibre: Record<number, number> = { ...stockMap };
    const ordenStock = [...odooOrders].sort((a, b) => String(a.date_order).localeCompare(String(b.date_order)));
    const asignado: Record<string, number> = {};
    for (const o of ordenStock) {
      if (String(o.delivery_status || "") === "full") continue;
      for (const l of prodByOrder[o.id as number] || []) {
        const ppid = Array.isArray(l.product_id) ? (l.product_id as unknown[])[0] as number : null; if (ppid == null) continue;
        const pend = Math.max(Number(l.product_uom_qty || 0) - Number(l.qty_delivered || 0), 0);
        const toma = Math.min(pend, Math.max(stockLibre[ppid] || 0, 0));
        stockLibre[ppid] = (stockLibre[ppid] || 0) - toma;
        asignado[(o.id as number) + "|" + ppid] = (asignado[(o.id as number) + "|" + ppid] || 0) + toma;
      }
    }
    for (const o of odooOrders) {
      const oid = o.id as number;
      const lineLabel = lineByOrder[oid] || "";
      const categoria = categoriaDe(o, lineLabel);
      const pid = Array.isArray(o.partner_id) ? (o.partner_id as unknown[])[0] as number : null;
      const p = pid != null ? pmap[pid] : null;
      const nombre = p ? String(p.name || "") : (Array.isArray(o.partner_id) ? String((o.partner_id as unknown[])[1]) : "");
      const tn = tnByOdoo[oid];
      const telWa = (tn && tn.telefono_wa) ? String(tn.telefono_wa) : normPhone(p ? String(p.mobile || p.phone || "") : "");
      const oLines = prodByOrder[oid] || [];
      const productos = tn ? (tn.productos as Rec[]) : oLines.map(prodFromLine);
      const prov = tn && tn.provincia ? tn.provincia : (p && Array.isArray(p.state_id) ? String((p.state_id as unknown[])[1]) : null);
      const ciudad = tn && tn.ciudad ? tn.ciudad : (p ? (p.city || null) : null);
      const full = String(o.delivery_status || "") === "full";
      // despachado: ML por su estado real; el resto por TN o, si no, por el delivery_status de Odoo.
      let despachado: boolean; let mlEstado: string | null = null; let mlEntregado = false;
      if (categoria === "ml") {
        const me = mlRef[String(o.client_order_ref || "").trim()];
        if (me) { despachado = !!me.despachado; mlEstado = (me.estado_label as string) || null; mlEntregado = !!me.entregado; }
        else despachado = full;
      } else {
        despachado = tn ? !!tn.despachado : full;
      }
      const trackingCode = tn ? (tn.tracking_code || null) : null;
      const transportista = tn ? tn.transportista : (categoria === "rosario" ? "Envío Rosario" : categoria === "retiro" ? "Retiro" : categoria === "sinasignar" ? "Sin asignar" : categoria === "ml" ? "Mercado Libre" : "Correo");
      const fechaDespachoRaw = fechaDespachoPorOrden[oid] || null;
      let totQty = 0, disp = 0;
      const productos_stock: Rec[] = [];
      for (const l of oLines) {
        const q = Number(l.product_uom_qty || 0);
        const deliv = Number(l.qty_delivered || 0);
        const ppid = Array.isArray(l.product_id) ? (l.product_id as unknown[])[0] as number : null;
        const pending = Math.max(q - deliv, 0);
        const k = oid + "|" + ppid; const st = ppid != null ? Math.min(asignado[k] || 0, pending) : 0; if (ppid != null) asignado[k] = (asignado[k] || 0) - st;
        const ready = Math.min(Math.max(deliv, 0) + Math.min(st, pending), q);
        totQty += q; disp += ready;
        const pf = prodFromLine(l);
        productos_stock.push({ nombre: pf.nombre, sku: pf.sku, pedido: q, entregado: deliv, stock: st, falta: full ? 0 : Math.max(pending - st, 0) });
      }
      const stockPct = totQty > 0 ? (full ? 100 : Math.round(100 * disp / totQty)) : null;
      const tagIds = Array.isArray(o.tag_ids) ? (o.tag_ids as number[]) : [];
      const etiqueta = tagIds.find((t) => READINESS.includes(t)) ?? null;
      out.push({
        estado_key: String(oid), odoo_id: oid, odoo_so: o.name, odoo_delivery_status: o.delivery_status || null,
        categoria, cliente: nombre, titular: nombre, primer_nombre: primerNombre(nombre),
        telefono_wa: telWa, provincia: prov, ciudad, productos, total: Number(o.amount_total || 0), fecha: o.date_order,
        transportista, modalidad: tn ? tn.modalidad : null, numero: tn ? tn.numero : null,
        tracking_code: trackingCode, tracking_url: tn ? (tn.tracking_url || null) : null,
        shipping_status: tn ? tn.shipping_status : null, despachado, ml_estado: mlEstado, ml_entregado: mlEntregado,
        fecha_despacho: fechaDespachoRaw ? fechaDespachoDMY(fechaDespachoRaw) : null, fecha_despacho_iso: fechaDespachoRaw,
        necesita_seguimiento: categoria === "correo" && despachado && !!trackingCode,
        tiene_tn: !!tn, pedido_pdf_url: `${ODOO_URL}/report/pdf/sale.report_saleorder/${oid}`,
        stock_pct: stockPct, productos_stock, etiqueta, despacho_programado: diaAR(o.commitment_date),
      });
    }

    const cont = (c: string) => out.filter((x) => x.categoria === c).length;
    const resumen = { total: out.length, correo: cont("correo"), rosario: cont("rosario"), retiro: cont("retiro"), sinasignar: cont("sinasignar"), ml: cont("ml"), para_avisar: out.filter((x) => x.categoria === "correo" && x.necesita_seguimiento).length };
    return new Response(JSON.stringify({ ok: true, odoo_url: ODOO_URL, etiquetas: etiquetasOpciones, resumen, ordenes: out }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
