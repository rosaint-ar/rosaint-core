import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// v17 (6-oct-2026): separa el cupón DEL VENDEDOR (order.coupon, baja tu precio → frena) del cupón de la PLATAFORMA
//      (payments[].coupon_amount: lo paga ML/MP, el precio de venta no cambia → se carga igual y se anota). Antes frenaba ambos.
// ═══ ml-odoo-cargar (v16) — carga ventas de Mercado Libre en Odoo, POR PACK ═══
// v16: contexto Odoo SOLO empresa 2 (VELAZQUEZ). RST Cosmetics (1) se dio de baja -> pedir [1,2] tiraba
//      "Acceso a empresas no autorizadas" y frenaba TODA la carga. v15: cancelaciones. v14: candado.
// v13: auto+bitacora. v12: localidad related. v11: FLEX. v10: date_order. CORTE 01/09. Una venta=un pack.
// Modos: listar | preview | cargar[,reemplazar_so_id][,forzar] | auto | set_marcadores | backfill_ref[,overwrite][,limpiar]

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const SELLER = 157540060;
const DESDE = "2026-09-01";
const ODOO_URL = Deno.env.get("ODOO_URL")!, ODOO_DB = Deno.env.get("ODOO_DB")!, ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!, ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY = 2, COUNTRY_AR = 10, TAX_IVA21_VENTAS = 187, PAYMENT_ML = 41, PAYMENT_TERM_CONTADO = 1, SOURCE_ML = 15, FLEX_TAG = 20;
// Etiquetas de preparacion (crm.tag, verificadas en Odoo el 06/10/2026): se pone UNA sola segun
// cuanto falta para la fecha de despacho que pide Mercado Libre. NO se tocan 21 (Listo) ni
// 22 (Entrega parcial): esas las maneja Diego a mano.
const TAG_HOY = 2, TAG_1DIA = 4, TAG_2A3 = 5;
const TAGS_PREPARACION = [TAG_HOY, TAG_1DIA, TAG_2A3];
const ID_TYPE: Record<string, number> = { DNI: 5, CUIT: 4, CUIL: 6 };
const AFIP: Record<string, number> = { "consumidor final": 5, "iva responsable inscripto": 1, "responsable monotributo": 6, "monotributo": 6, "iva sujeto exento": 4, "sujeto exento": 4 };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function mlToken(sb: any): Promise<string> {
  const { data: auth } = await sb.from("ml_auth").select("*").eq("id", 1).single();
  if (!auth?.refresh_token) throw new Error("Falta refresh token de ML.");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: Deno.env.get("ML_APP_ID")!, client_secret: Deno.env.get("ML_SECRET")!, refresh_token: auth.refresh_token });
  const r = await fetch(ML_TOKEN_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const d = await r.json(); if (!r.ok) throw new Error("No se pudo renovar token ML: " + JSON.stringify(d));
  await sb.from("ml_auth").update({ access_token: d.access_token, refresh_token: d.refresh_token, token_expira_en: new Date(Date.now() + (d.expires_in ?? 21600) * 1000).toISOString(), actualizado_en: new Date().toISOString() }).eq("id", 1);
  return d.access_token;
}
let MLTOK = "";
async function mlGet(path: string, headers: any = {}) { const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${MLTOK}`, ...headers } }); if (!r.ok) return null; return await r.json(); }

let _uid: number | null = null;
async function odooCall(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }) });
  const j = await r.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error)); return j.result;
}
async function odooAuth() { if (_uid) return _uid; _uid = await odooCall("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number; if (!_uid) throw new Error("Auth Odoo fallida"); return _uid; }
async function exec(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await odooAuth(); kwargs.context = { allowed_company_ids: [COMPANY], lang: "es_ES", ...((kwargs.context as any) || {}) };
  return await odooCall("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}

const soloDig = (s: string) => String(s || "").replace(/\D/g, "");
const titleCase = (s: string) => String(s || "").trim().split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
function fmtVat(tipo: string, num: string): string[] { const n = soloDig(num); if (!n) return []; if (tipo === "DNI") { return [n.replace(/\B(?=(\d{3})+(?!\d))/g, "."), n]; } if (tipo === "CUIT" || tipo === "CUIL") { const c = n.length === 11 ? `${n.slice(0,2)}-${n.slice(2,10)}-${n.slice(10)}` : n; return [c, n]; } return [n]; }
let _prodCache: Record<string, number> | null = null;
async function productoPorSku(skus: string[]): Promise<Record<string, number>> { if (!_prodCache) { const res = await exec("product.product", "search_read", [[["default_code", "!=", false]], ["id", "default_code"]], { limit: 5000 }) as any[]; _prodCache = {}; for (const p of res) _prodCache[String(p.default_code)] = p.id; } const out: Record<string, number> = {}; for (const s of skus) out[s] = _prodCache[s]; return out; }
async function buscarPartner(tipo: string, num: string): Promise<number | null> { const vats = fmtVat(tipo, num); if (!vats.length) return null; const dom: unknown[] = []; vats.forEach((v, i) => { if (i > 0) dom.unshift("|"); dom.push(["vat", "=", v]); }); const ids = await exec("res.partner", "search", [dom], { limit: 1 }) as number[]; return ids[0] || null; }
function mapAfip(desc: string): number { return AFIP[(desc || "").toLowerCase().trim()] ?? 5; }
function stateId(code: string, states: Record<string, number>): number | false { const c = String(code || "").replace(/^AR-/, ""); return states[c] || false; }
let _states: Record<string, number> | null = null;
async function estadosAR(): Promise<Record<string, number>> { if (_states) return _states; const res = await exec("res.country.state", "search_read", [[["country_id", "=", COUNTRY_AR]], ["id", "code"]], { limit: 60 }) as any[]; _states = {}; for (const s of res) _states[String(s.code)] = s.id; return _states; }
function fechaOdoo(iso: string): string | false { if (!iso) return false; const d = new Date(iso); if (isNaN(d.getTime())) return false; return d.toISOString().slice(0, 19).replace("T", " "); }
// Fecha en Argentina (UTC-3, sin horario de verano) como yyyy-mm-dd. Identico a ml-despacho:
// las dos piezas leen el MISMO dato (expected_date del SLA) y lo comparan igual, asi la etiqueta
// nunca puede contradecir a la tarjeta "A despachar hoy". Ver rosaint-ml-despacho.
function fechaAR(offsetDias = 0): string {
  return new Date(Date.now() - 3 * 3600 * 1000 + offsetDias * 86400000).toISOString().slice(0, 10);
}
// Traduce la fecha de despacho a la etiqueta: atrasada o de hoy -> Hoy; manana -> 1 dia;
// en 2 o 3 dias -> 2-3 dias; mas lejos -> ninguna (no hay apuro todavia).
function etiquetaDe(sla: string): { id: number; nombre: string; dias: number } | null {
  const exp = String(sla || "").slice(0, 10);
  if (!exp) return null;
  // exp ya viene en hora argentina (ML lo manda con offset -03:00), asi que comparar las dos
  // fechas como medianoche UTC da la diferencia de dias limpia, sin lio de zonas.
  const a = Date.parse(exp + "T00:00:00Z"), b = Date.parse(fechaAR(0) + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return null;
  const dias = Math.round((a - b) / 86400000);
  if (dias <= 0) return { id: TAG_HOY, nombre: "Hoy", dias };
  if (dias === 1) return { id: TAG_1DIA, nombre: "1 dia", dias };
  if (dias <= 3) return { id: TAG_2A3, nombre: "2-3 dias", dias };
  return null;
}
// Una sola etiqueta de preparacion a la vez: se agrega la que corresponde y se sacan las otras dos,
// asi una venta no queda con dos (y si se recarga con otra fecha, se corrige sola).
function tagsDe(p: any): unknown[] {
  const cmds: unknown[] = [p.flex ? [4, FLEX_TAG] : [3, FLEX_TAG]];
  const id = p.etiqueta ? p.etiqueta.id : 0;
  for (const t of TAGS_PREPARACION) cmds.push(t === id ? [4, t] : [3, t]);
  return cmds;
}

async function armarPack(seedId: string) {
  const seed = await mlGet(`/orders/${seedId}`); if (!seed) throw new Error(`Orden/pack ML ${seedId} no encontrado`);
  const packId = String(seed.pack_id || seed.id); let ordenes = [seed];
  // Un pack se carga entero o no se carga: si no se puede leer el pack o alguna de sus órdenes, se corta
  // (antes se salteaba la orden que fallaba y quedaba un pedido incompleto marcado como cargado).
  if (seed.pack_id) {
    const pk = await mlGet(`/packs/${packId}`); if (!pk) throw new Error(`No se pudo leer el pack ML ${packId}: se reintenta en la próxima pasada`);
    const otras = ((pk.orders) || []).map((o: any) => String(o.id)).filter((id: string) => id !== String(seed.id));
    for (const id of otras) { const o = await mlGet(`/orders/${id}`); if (!o) throw new Error(`No se pudo leer la orden ${id} del pack ${packId}: se reintenta en la próxima pasada`); ordenes.push(o); }
  }
  // solo las órdenes vigentes: una orden cancelada dentro del pack no se carga
  ordenes = ordenes.filter((o: any) => o.status !== "cancelled");
  if (!ordenes.length) throw new Error(`El pack ${packId} está todo cancelado`);
  const primary = ordenes[0];
  let flex = false, full = false, sla = "";
  const sid = primary.shipping?.id;
  if (sid) {
    try {
      const sh = await mlGet(`/shipments/${sid}`, { "x-format-new": "true" });
      const lt = sh?.logistic?.type || sh?.logistic_type || "";
      flex = lt === "self_service";
      full = lt === "fulfillment";   // lo despacha ML desde su deposito: no hay nada que preparar aca
    } catch (_) { }
    // La fecha de despacho sale del SLA del envio (expected_date). El lead_time viene con nulos:
    // esa leccion ya la pago ml-despacho. En Full no se pide: no corresponde etiqueta.
    if (!full) { try { const sl = await mlGet(`/shipments/${sid}/sla`); sla = String(sl?.expected_date || ""); } catch (_) { } }
  }
  const etiqueta = etiquetaDe(sla);
  const bi = await mlGet(`/orders/${primary.id}/billing_info`, { "x-version": "2" }); const b = bi?.buyer?.billing_info || {}; const ident = b.identification || {};
  const tipoDoc = String(ident.type || "DNI").toUpperCase();
  const nombre = [b.name, b.last_name].filter(Boolean).join(" ").trim() || (primary.buyer?.nickname ?? "Consumidor Final ML");
  const addr = b.address || {}; const cond = b.taxes?.taxpayer_type?.description || "Consumidor Final";
  const items: any[] = [];
  for (const o of ordenes) for (const it of (o.order_items || [])) items.push({ sku: String(it.item?.seller_sku || "").trim(), titulo: it.item?.title || "", qty: it.quantity || 0, precio: it.unit_price || 0 });
  const skuMap = await productoPorSku(items.map((i) => i.sku).filter(Boolean));
  const lineas = items.map((i) => ({ ...i, product_id: skuMap[i.sku] || null }));
  const total = ordenes.reduce((a, o) => a + (o.total_amount || 0), 0);
  const suma_lineas = items.reduce((a, i) => a + i.precio * i.qty, 0);
  // cupón del vendedor: baja el precio que cobrás (frena la carga). Cupón de ML/MP: lo paga la plataforma al comprador.
  const cupon_vendedor = ordenes.reduce((a, o) => a + (o.coupon?.amount || 0), 0);
  const cupon_plataforma = ordenes.reduce((a, o) => a + (o.payments || []).reduce((x: number, p: any) => x + (p.coupon_amount || 0), 0), 0);
  // si el total de la orden no coincide con la suma de los productos, algo cambió el precio: se trata como cupón propio
  const cupon = cupon_vendedor + (Math.abs(total - suma_lineas) > 0.5 ? Math.abs(total - suma_lineas) : 0);
  return { pack_id: packId, order_ids: ordenes.map((o) => String(o.id)), fecha: primary.date_created, total, cupon, cupon_plataforma, suma_lineas, flex, full, sla, etiqueta,
    cliente: { nombre, tipo_doc: tipoDoc, documento: soloDig(ident.number || ""), condicion_afip: cond, localidad: titleCase(addr.city_name || ""), provincia_code: addr.state?.code || "", provincia_nombre: addr.state?.name || "", cp: addr.zip_code || "" }, lineas };
}
async function yaCargada(packId: string): Promise<number | null> { const ids = await exec("sale.order", "search", [[["client_order_ref", "=", String(packId)], ["company_id", "=", COMPANY]]], { limit: 1 }) as number[]; return ids[0] || null; }
async function partnerDe(p: any): Promise<number> {
  const partnerId = await buscarPartner(p.cliente.tipo_doc, p.cliente.documento);
  if (partnerId) {
    try { const cur = await exec("res.partner", "read", [[partnerId], ["city"]], {}) as any[]; const c = cur[0]?.city; if (c && c !== titleCase(c)) await exec("res.partner", "write", [[partnerId], { city: titleCase(c) }]); } catch (_) { }
    return partnerId;
  }
  const states = await estadosAR(); const [vatFmt] = fmtVat(p.cliente.tipo_doc, p.cliente.documento);
  return await exec("res.partner", "create", [{ name: p.cliente.nombre, company_type: "person", customer_rank: 1, vat: vatFmt || false, l10n_latam_identification_type_id: ID_TYPE[p.cliente.tipo_doc] || 5, l10n_ar_afip_responsibility_type_id: mapAfip(p.cliente.condicion_afip), country_id: COUNTRY_AR, state_id: stateId(p.cliente.provincia_code, states), city: p.cliente.localidad || false, zip: p.cliente.cp || false }], {}) as number;
}
async function crearBorrador(p: any, reSo: number | null) {
  const partnerId = await partnerDe(p);
  const linesAdd = p.lineas.map((l: any) => [0, 0, { product_id: l.product_id, product_uom_qty: l.qty, price_unit: l.precio, tax_id: [[6, 0, [TAX_IVA21_VENTAS]]] }]);
  const vals: any = { partner_id: partnerId, company_id: COMPANY, client_order_ref: p.pack_id, date_order: fechaOdoo(p.fecha), payment_term_id: PAYMENT_TERM_CONTADO, x_studio_mtodo_de_pago_2: PAYMENT_ML, source_id: SOURCE_ML, tag_ids: tagsDe(p) };
  let soId: number;
  if (reSo) { await exec("sale.order", "write", [[reSo], { ...vals, order_line: [[5, 0, 0], ...linesAdd] }]); soId = reSo; }
  else { soId = await exec("sale.order", "create", [{ ...vals, order_line: linesAdd }], {}) as number; }
  const so = await exec("sale.order", "read", [[soId], ["name", "amount_total"]], {}) as any[];
  return { so_id: soId, so_name: so[0]?.name, total_odoo: so[0]?.amount_total, total_coincide: Math.abs((so[0]?.amount_total || 0) - (p.total || 0)) < 0.5, partner_id: partnerId };
}
async function packsPendientes(): Promise<Array<{ pack_id: string; order_id: string; fecha: string }>> {
  const orders: any[] = [];
  for (let p = 0; p < 4; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=paid&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length - 1].date_created || "") < DESDE) break; }
  const packMap: Record<string, { order_id: string; fecha: string }> = {};
  for (const o of orders) { if ((o.date_created || "") < DESDE) continue; const pid = String(o.pack_id || o.id); if (!packMap[pid] || (o.date_created || "") < packMap[pid].fecha) packMap[pid] = { order_id: String(o.id), fecha: o.date_created }; }
  const pids = Object.keys(packMap); if (!pids.length) return [];
  const existing = await exec("sale.order", "search_read", [[["client_order_ref", "in", pids], ["company_id", "=", COMPANY]], ["client_order_ref"]], {}) as any[];
  const setC = new Set(existing.map((e) => String(e.client_order_ref)));
  return pids.filter((pid) => !setC.has(pid)).map((pid) => ({ pack_id: pid, order_id: packMap[pid].order_id, fecha: packMap[pid].fecha })).sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
}
async function packsCancelados(): Promise<string[]> {
  const orders: any[] = [];
  for (let p = 0; p < 3; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=cancelled&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length - 1].date_created || "") < DESDE) break; }
  const packs = new Set<string>();
  for (const o of orders) { if ((o.date_created || "") < DESDE) continue; packs.add(String(o.pack_id || o.id)); }
  return [...packs];
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

_servirConGuardia(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({})) as any; const modo = body.modo || "listar"; MLTOK = await mlToken(sb);

    // Recalcula y escribe SOLO las etiquetas de una venta ya cargada (no toca nada mas).
    // Se niega si la fecha de despacho ya paso: una venta vieja ya despachada no tiene que
    // aparecer como "Hoy". Con forzar:true se escribe igual.
    if (modo === "etiquetar") {
      const seed = String(body.order_id || "");
      if (!seed) return new Response(JSON.stringify({ ok: false, error: "Falta order_id" }), { headers: cors });
      const p = await armarPack(seed);
      const soId = await yaCargada(p.pack_id);
      if (!soId) return new Response(JSON.stringify({ ok: false, error: "Ese pack no esta cargado en Odoo", pack_id: p.pack_id }), { headers: cors });
      const cur = (await exec("sale.order", "read", [[soId], ["name", "state", "tag_ids", "delivery_status"]], {}) as any[])[0] || {};
      if (cur.state === "cancel") return new Response(JSON.stringify({ ok: false, error: `${cur.name} esta cancelada`, so_id: soId }), { headers: cors });
      // Si ya se entrego no hay nada que preparar: etiquetarla seria ruido. Visto con datos reales
      // el 06/10: S01324/S01328/S01329 estaban entregadas y su fecha de despacho era HOY, asi que
      // un etiquetado masivo sin este freno les habria puesto "Hoy" sin motivo.
      if (!body.forzar && cur.delivery_status === "full") {
        return new Response(JSON.stringify({ ok: false, error: `${cur.name} ya esta entregada: no se etiqueta (forzar:true para hacerlo igual)`,
          so: cur.name, so_id: soId, entrega: cur.delivery_status, etiquetas_antes: cur.tag_ids }), { headers: cors });
      }
      const dias = p.etiqueta ? p.etiqueta.dias : null;
      if (!body.forzar && (dias === null || dias < 0)) {
        return new Response(JSON.stringify({ ok: false, error: dias === null ? "Sin fecha de despacho util: no corresponde etiqueta" : "La fecha de despacho ya paso: no se etiqueta (forzar:true para hacerlo igual)",
          so: cur.name, so_id: soId, sla: p.sla, dias, etiquetas_antes: cur.tag_ids }), { headers: cors });
      }
      await exec("sale.order", "write", [[soId], { tag_ids: tagsDe(p) }]);
      const post = (await exec("sale.order", "read", [[soId], ["tag_ids"]], {}) as any[])[0] || {};
      return new Response(JSON.stringify({ ok: true, so: cur.name, so_id: soId, pack_id: p.pack_id, sla: p.sla, dias,
        etiqueta: p.etiqueta, flex: p.flex, etiquetas_antes: cur.tag_ids, etiquetas_despues: post.tag_ids }), { headers: cors });
    }

    if (modo === "set_marcadores") { const soId = Number(body.so_id); if (!soId) return new Response(JSON.stringify({ ok: false, error: "Falta so_id" }), { headers: cors }); await exec("sale.order", "write", [[soId], { source_id: SOURCE_ML, x_studio_mtodo_de_pago_2: PAYMENT_ML, payment_term_id: PAYMENT_TERM_CONTADO }]); const so = await exec("sale.order", "read", [[soId], ["name", "x_studio_origen"]], {}) as any[]; return new Response(JSON.stringify({ ok: true, so: so[0] }), { headers: cors }); }

    if (modo === "backfill_ref") {
      const pares = (body.pares || []) as Array<{ so_id: number; ref?: string }>;
      if (body.limpiar) { let limpiadas = 0; const errs: string[] = []; for (const pr of pares) { try { await exec("sale.order", "write", [[pr.so_id], { client_order_ref: false }]); limpiadas++; } catch (e) { errs.push(`${pr.so_id}: ${(e as Error).message}`); } } return new Response(JSON.stringify({ ok: true, limpiadas, errores: errs.slice(0, 20) }), { headers: cors }); }
      let escritas = 0, saltadas = 0; const errores: string[] = []; for (const pr of pares) { try { const cur = await exec("sale.order", "read", [[pr.so_id], ["client_order_ref"]], {}) as any[]; if (cur[0]?.client_order_ref && !body.overwrite) { saltadas++; continue; } await exec("sale.order", "write", [[pr.so_id], { client_order_ref: String(pr.ref) }]); escritas++; } catch (e) { errores.push(`${pr.so_id}: ${(e as Error).message}`); } } return new Response(JSON.stringify({ ok: true, escritas, saltadas, errores: errores.slice(0, 20) }), { headers: cors });
    }

    if (modo === "auto") {
      const cutoff = new Date(Date.now() - 120000).toISOString();
      const { data: got } = await sb.from("ml_odoo_lock").update({ running: true, since: new Date().toISOString() }).eq("id", 1).or(`running.eq.false,since.lt.${cutoff}`).select();
      if (!got || !got.length) return new Response(JSON.stringify({ ok: true, skip: "auto ya en ejecucion" }), { headers: cors });
      try {
        const pend = await packsPendientes();
        let cargadas = 0, revisar = 0, errores = 0, saltadas = 0, canceladas = 0; const bitac: any[] = []; const detalle: any[] = [];
        for (const it of pend) {
          try {
            if (await yaCargada(it.pack_id)) { saltadas++; continue; }
            const p = await armarPack(it.order_id);
            const faltan = p.lineas.filter((l: any) => !l.product_id);
            if (faltan.length) { revisar++; bitac.push({ pack_id: p.pack_id, cliente: p.cliente.nombre, total: p.total, resultado: "revisar", detalle: "SKU sin producto: " + faltan.map((f: any) => f.sku).join(",") }); }
            else if (p.cupon > 0) { revisar++; bitac.push({ pack_id: p.pack_id, cliente: p.cliente.nombre, total: p.total, resultado: "revisar", detalle: "cupón $" + p.cupon }); }
            else { const r = await crearBorrador(p, null); cargadas++; if (!r.total_coincide) revisar++; bitac.push({ pack_id: p.pack_id, so_name: r.so_name, cliente: p.cliente.nombre, total: p.total, resultado: r.total_coincide ? "cargada" : "revisar", detalle: [r.total_coincide ? "" : `cargada, pero el total de Odoo ($${r.total_odoo}) no coincide con ML ($${p.total}) — revisar antes de confirmar`, p.cupon_plataforma > 0 ? "cupón de ML/MP $" + p.cupon_plataforma + " (no afecta el precio)" : ""].filter(Boolean).join(" · ") }); detalle.push({ so_name: r.so_name, cliente: p.cliente.nombre, total: r.total_odoo }); }
          } catch (e) { errores++; bitac.push({ pack_id: it.order_id, resultado: "error", detalle: String((e as Error).message || e).slice(0, 250) }); }
        }
        // ── sweep de cancelaciones ──
        try {
          const cpacks = await packsCancelados();
          if (cpacks.length) {
            const sos = await exec("sale.order", "search_read", [[["client_order_ref", "in", cpacks], ["company_id", "=", COMPANY], ["state", "!=", "cancel"]], ["id", "name", "delivery_status", "client_order_ref"]], {}) as any[];
            for (const so of sos) {
              try {
                // Pack de varias órdenes: se cancela el pedido entero solo si TODAS están canceladas en ML.
                // Si queda alguna vigente (o no se pudo verificar), va a revisar: hay que sacar solo esos renglones.
                const pk = await mlGet(`/packs/${so.client_order_ref}`);
                const idsPack = ((pk?.orders) || []).map((o: any) => String(o.id));
                let vigentes = 0, sinVerificar = 0;
                if (idsPack.length > 1) for (const id of idsPack) { const o = await mlGet(`/orders/${id}`); if (!o) sinVerificar++; else if (o.status !== "cancelled") vigentes++; }
                if (so.delivery_status === "full" || so.delivery_status === "partial") { revisar++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "revisar", detalle: "cancelada en ML pero tiene entrega — revisar/devolver a mano" }); }
                else if (vigentes || sinVerificar) { revisar++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "revisar", detalle: vigentes ? `cancelación parcial en ML: ${vigentes} orden(es) del pack siguen vigentes — sacar a mano solo los renglones cancelados` : "no se pudo verificar si todo el pack está cancelado — revisar" }); }
                else { await exec("sale.order", "action_cancel", [[so.id]], {}); canceladas++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "cancelada", detalle: "cancelada en ML" }); }
              } catch (e) { errores++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "error", detalle: "cancelar: " + String((e as Error).message || e).slice(0, 150) }); }
            }
          }
        } catch (_) { }
        if (bitac.length) { try { await sb.from("ml_odoo_bitacora").insert(bitac); } catch (_) { } }
        return new Response(JSON.stringify({ ok: true, pendientes: pend.length, cargadas, canceladas, revisar, saltadas, errores, detalle }), { headers: cors });
      } finally { try { await sb.from("ml_odoo_lock").update({ running: false, since: new Date().toISOString() }).eq("id", 1); } catch (_) { } }
    }

    if (modo === "listar") {
      const orders: any[] = [];
      for (let p = 0; p < 4; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=paid&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length-1].date_created || "") < DESDE) break; }
      const packs: Record<string, any> = {};
      for (const o of orders) { if ((o.date_created || "") < DESDE) continue; const pid = String(o.pack_id || o.id); if (!packs[pid]) packs[pid] = { pack_id: pid, fecha: o.date_created, total: 0, items: 0, comprador: o.buyer?.nickname || "", order_id: String(o.id) }; packs[pid].total += o.total_amount || 0; packs[pid].items += (o.order_items || []).length; if ((o.date_created || "") < packs[pid].fecha) { packs[pid].fecha = o.date_created; packs[pid].order_id = String(o.id); } }
      const packIds = Object.keys(packs);
      const cargadas = packIds.length ? await exec("sale.order", "search_read", [[["client_order_ref", "in", packIds], ["company_id", "=", COMPANY]], ["client_order_ref", "name"]], {}) as any[] : [];
      const setC: Record<string, string> = {}; for (const c of cargadas) setC[String(c.client_order_ref)] = c.name;
      const lista = Object.values(packs).map((p: any) => ({ ...p, ya_cargada: !!setC[p.pack_id], so_name: setC[p.pack_id] || null })).sort((a: any, b: any) => (a.fecha || "").localeCompare(b.fecha || ""));
      return new Response(JSON.stringify({ ok: true, corte: DESDE, cantidad: lista.length, pendientes: lista.filter((x:any)=>!x.ya_cargada).length, packs: lista }), { headers: cors });
    }

    const seedId = String(body.pack_id || body.order_id || "");
    if (!seedId) return new Response(JSON.stringify({ ok: false, error: "Falta pack_id u order_id" }), { headers: cors });

    if (modo === "preview") {
      const p = await armarPack(seedId); const partnerId = await buscarPartner(p.cliente.tipo_doc, p.cliente.documento); const warnings: string[] = [];
      if ((p.fecha || "") < DESDE) warnings.push(`Compra anterior al corte (${DESDE}).`);
      for (const l of p.lineas) if (!l.product_id) warnings.push(`SKU sin producto en Odoo: ${l.sku || "(vacío)"} — ${l.titulo}`);
      if (p.cupon > 0) warnings.push(`Compra con cupón del vendedor $${p.cupon} — revisar el precio.`);
      if (p.cupon_plataforma > 0) warnings.push(`Cupón de ML/MP $${p.cupon_plataforma}: lo paga la plataforma, el precio de venta no cambia.`);
      const soId = await yaCargada(p.pack_id);
      return new Response(JSON.stringify({ ok: true, ...p, cliente_existe: !!partnerId, partner_id: partnerId, ya_cargada: !!soId, so_id: soId, warnings }), { headers: cors });
    }

    if (modo === "cargar") {
      // Mismo candado que la carga automática: si las dos corren a la vez pueden crear el mismo pack dos veces.
      const cutoff = new Date(Date.now() - 120000).toISOString();
      const { data: got } = await sb.from("ml_odoo_lock").update({ running: true, since: new Date().toISOString() }).eq("id", 1).or(`running.eq.false,since.lt.${cutoff}`).select();
      if (!got || !got.length) return new Response(JSON.stringify({ ok: false, error: "Hay una carga automática en curso: probá de nuevo en un minuto." }), { headers: cors });
      try {
      const p = await armarPack(seedId);
      if ((p.fecha || "") < DESDE && !body.forzar) return new Response(JSON.stringify({ ok: false, error: `Compra anterior al corte ${DESDE}. forzar:true para cargar igual.`, fecha: p.fecha }), { headers: cors });
      const reSo = body.reemplazar_so_id ? Number(body.reemplazar_so_id) : null;
      if (!reSo) { const yaId = await yaCargada(p.pack_id); if (yaId) return new Response(JSON.stringify({ ok: true, ya_cargada: true, so_id: yaId, pack_id: p.pack_id, msg: "El pack ya estaba cargado" }), { headers: cors }); }
      const faltan = p.lineas.filter((l: any) => !l.product_id);
      if (faltan.length) return new Response(JSON.stringify({ ok: false, error: "Hay SKU sin producto en Odoo", faltan }), { headers: cors });
      if (p.cupon > 0 && !body.forzar) return new Response(JSON.stringify({ ok: false, error: `Compra con cupón $${p.cupon}. forzar:true para cargar.`, cupon: p.cupon }), { headers: cors });
      const r = await crearBorrador(p, reSo);
      return new Response(JSON.stringify({ ok: true, [reSo ? "reemplazada" : "creada"]: true, ...r, pack_id: p.pack_id, fecha: fechaOdoo(p.fecha), flex: p.flex, localidad: p.cliente.localidad, renglones: p.lineas.length, total_ml: p.total, cliente: p.cliente.nombre }), { headers: cors });
      } finally { try { await sb.from("ml_odoo_lock").update({ running: false, since: new Date().toISOString() }).eq("id", 1); } catch (_) { } }
    }

    return new Response(JSON.stringify({ ok: false, error: "modo invalido" }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
