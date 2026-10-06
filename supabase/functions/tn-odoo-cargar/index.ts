import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// tn-odoo-cargar (v11) - carga ventas de Tienda Nube en Odoo.
// v11: Tienda Nube contesta 404 (no una lista vacia) cuando se le pide una pagina pasada la ultima.
//      Como el recorrido solo cortaba con una pagina incompleta, el conector se caia ENTERO cada vez
//      que la cantidad de ordenes pagas caia justo en un multiplo de 50 (paso el 05/10 con la 2469,
//      que fue la numero 100 desde el corte). Ahora el 404 se toma como fin de las paginas.
//      Ademas el tope de paginas pasa de 6 (300 ordenes) a 20 (1000) y si se toca se avisa.
// v10: el telefono se escribe con el MISMO formato que pone Odoo al cargarlo por pantalla
//      (+54 [9] area resto-####). Odoo NO formatea cuando se escribe por RPC, asi que lo hace el conector.
// v9: se completan mail y telefono. v8: la direccion se usa siempre que el cliente la haya cargado.
// v7: el modo auto NO pide secreto (lo disparan el webhook y el cron); esta acotado y es idempotente.
// Compania 2 (VELAZQUEZ). CORTE 01/08/2026. Solo payment_status=paid. Queda en BORRADOR.
// Modos: listar | preview | cargar | auto | sincronizar_cliente | backfill_ref | backfill_auto

const STORE = 385079;
const TN_API = "https://api.tiendanube.com/v1";
const UA = "Rosaint Odoo (rosaint.ar@gmail.com)";
const CORTE = "2026-08-01";
const POR_PAGINA = 50, MAX_PAGINAS = 20;

const ODOO_URL = Deno.env.get("ODOO_URL")!, ODOO_DB = Deno.env.get("ODOO_DB")!, ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!, ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SECRET = Deno.env.get("TN_PROXY_SECRET") || "";

const COMPANY = 2, COUNTRY_AR = 10, TAX = 187;
const PRICELIST = 56, TERM = 1, WAREHOUSE = 3, TEAM = 1, SALESMAN = 2, SOURCE_TN = 16;

const PAGOS: Record<string, number> = {
  "mercado pago": 40, "pago nube": 43,
  "transferencia bancaria": 39, "deposito / transferencia bancaria": 39, "transferencia": 39,
};
const ENVIOS = {
  domicilio: { carrier: 5, product: 185, nombre: "Envio estandar correo - Entrega a domicilio" },
  sucursal: { carrier: 6, product: 186, nombre: "Envio estandar correo - Entrega a sucursal" },
  hop: { carrier: 12, product: 305, nombre: "Envio estandar correo - Entrega a punto HOP" },
  local: { carrier: 1, product: 130, nombre: "Envio estandar local - Rosario zona 1" },
};
const FREESHIP = { product: 297, reward: 3, nombre: "Envio gratuito - Envio gratuito" };
const DESCUENTOS: Record<number, { product: number; reward: number; nombre: string }> = {
  15: { product: 418, reward: 20, nombre: "Descuento 15% en productos especificos" },
  20: { product: 322, reward: 8, nombre: "Descuento 20% en productos especificos" },
};
const ID_TYPE: Record<string, number> = { DNI: 5, CUIT: 4, CUIL: 6 };
// Codigos de area de 3 digitos, sacados de las 1.055 fichas que Odoo ya formateo + los dos clasicos que
// no aparecian en la base (220, 237). El 11 lleva 2; todo lo demas se toma como area de 4.
// Si algun dia aparece un area de 3 que no esta aca, el numero queda igual: solo cambia el espaciado.
const AREA3 = new Set(("220,221,223,230,231,236,237,249,260,261,263,264,266,280,291,294,295,297,298,299," +
  "336,338,340,341,342,343,344,345,346,347,348,349,351,353,354,357,358,362,364,370,375,376,377,379,380,381,383,385,387,388").split(","));
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret", "Content-Type": "application/json" };

const soloDig = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim().replace(/\s+/g, " ");
const titleCase = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const conPuntos = (d: string) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const nucleoDoc = (s: unknown) => { const d = soloDig(s); return d.length === 11 ? d.slice(2, 10) : d; };
// Deja el telefono como lo escribe Odoo cuando se carga por pantalla. NO agrega ni saca el 9:
// respeta lo que mando Tienda Nube, solo cambia el espaciado.
function telOdoo(raw: unknown): string | false {
  const original = String(raw ?? "").trim();
  let d = soloDig(original);
  if (!d) return false;
  if (d.startsWith("54")) d = d.slice(2);
  let nueve = "";
  if (d.length === 11 && d.startsWith("9")) { nueve = "9 "; d = d.slice(1); }
  if (d.length !== 10) return original || false;  // largo raro: se deja tal cual vino
  const largo = d.startsWith("11") ? 2 : (AREA3.has(d.slice(0, 3)) ? 3 : 4);
  const area = d.slice(0, largo), resto = d.slice(largo);
  return `+54 ${nueve}${area} ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}
function fechaOdoo(iso: string): string | false { if (!iso) return false; const d = new Date(iso); if (isNaN(d.getTime())) return false; return d.toISOString().slice(0, 19).replace("T", " "); }
function fmtVat(tipo: string, n: string): string[] {
  const d = soloDig(n); if (!d) return [];
  if (tipo === "DNI") return [conPuntos(d), d];
  if (d.length === 11) return [`${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`, d];
  return [d];
}
function domOr(leaves: unknown[]): unknown[] { const d: unknown[] = []; for (let i = 0; i < leaves.length - 1; i++) d.push("|"); return d.concat(leaves); }

let TNTOK = "";
async function tnToken(sb: any): Promise<string> {
  if (TNTOK) return TNTOK;
  const { data } = await sb.schema("mcp").from("stores").select("access_token").eq("store_id", STORE).single();
  if (!data?.access_token) throw new Error("No hay token de Tienda Nube para la tienda " + STORE);
  TNTOK = data.access_token; return TNTOK;
}
async function tnFetch(path: string) {
  return await fetch(`${TN_API}/${STORE}${path}`, { headers: { Authentication: `bearer ${TNTOK}`, "User-Agent": UA, "Content-Type": "application/json" } });
}
async function tnGet(path: string) {
  const r = await tnFetch(path);
  if (!r.ok) throw new Error(`Tienda Nube ${r.status} en ${path}`);
  return await r.json();
}
// Igual que tnGet pero para recorrer paginas: el 404 significa "no hay mas paginas", no un error.
// Tienda Nube NO devuelve una lista vacia cuando se pasa del final: devuelve 404.
async function tnGetPagina(path: string) {
  const r = await tnFetch(path);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Tienda Nube ${r.status} en ${path}`);
  return await r.json();
}

// POST a Tienda Nube (hasta ahora el conector solo leia).
async function tnPost(path: string, body: unknown) {
  const r = await fetch(`${TN_API}/${STORE}${path}`, {
    method: "POST",
    headers: { Authentication: `bearer ${TNTOK}`, "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Tienda Nube ${r.status} en ${path}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch (_) { return {}; }
}

// Para que el Core pueda escribir sin tener el secreto en una pagina publica: se valida la SESION
// del usuario logueado. Ojo: /auth/v1/user necesita la apikey que llega en el request (la anon
// legacy esta rechazada), y hay que descartar que manden la llave publicable como si fuera sesion.
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
async function usuarioValido(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const tok = auth.slice(7).trim();
  if (!tok || tok.startsWith("sb_")) return false;   // esa es la llave publicable, no una sesion
  const apikey = req.headers.get("apikey") || PUB;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
    return r.ok;
  } catch (_) { return false; }
}

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

let _prod: Record<string, number> | null = null;
async function skuMap(): Promise<Record<string, number>> {
  if (_prod) return _prod;
  const res = await exec("product.product", "search_read", [[["default_code", "!=", false]], ["id", "default_code"]], { limit: 6000 }) as any[];
  _prod = {}; for (const p of res) _prod[String(p.default_code).trim()] = p.id; return _prod;
}
let _states: Record<string, number> | null = null;
async function estados(): Promise<Record<string, number>> {
  if (_states) return _states;
  const res = await exec("res.country.state", "search_read", [[["country_id", "=", COUNTRY_AR]], ["id", "name"]], { limit: 60 }) as any[];
  _states = {}; for (const s of res) _states[norm(s.name)] = s.id;
  _states["CAPITAL FEDERAL"] = _states["CIUDAD AUTONOMA DE BUENOS AIRES"];
  _states["CABA"] = _states["CIUDAD AUTONOMA DE BUENOS AIRES"];
  _states["TIERRA DEL FUEGO, ANTARTIDA E ISLAS DEL ATLANTICO SUR"] = _states["TIERRA DEL FUEGO"];
  return _states;
}
async function buscarPartner(_tipo: string, doc: string): Promise<{ id: number; via: string } | null> {
  const d = soloDig(doc); if (!d) return null;
  const exactos: string[] = [];
  if (d.length === 11) { const dni = d.slice(2, 10); exactos.push(`${d.slice(0, 2)}-${dni}-${d.slice(10)}`, d, conPuntos(dni), dni); }
  else { exactos.push(conPuntos(d), d); }
  let ids = await exec("res.partner", "search", [domOr(exactos.map((v) => ["vat", "=", v]))], { limit: 1 }) as number[];
  if (ids[0]) return { id: ids[0], via: d.length === 11 ? "CUIT o el DNI que contiene" : "documento exacto" };
  if (d.length === 8) {
    ids = await exec("res.partner", "search", [[["vat", "like", `-${d}-`]]], { limit: 1 }) as number[];
    if (ids[0]) return { id: ids[0], via: "el CUIT que contiene ese DNI" };
  }
  return null;
}
async function yaCargada(numero: string): Promise<{ id: number; name: string } | null> {
  const r = await exec("sale.order", "search_read", [[["client_order_ref", "=", String(numero)], ["company_id", "=", COMPANY]], ["id", "name"]], { limit: 1 }) as any[];
  return r[0] ? { id: r[0].id, name: r[0].name } : null;
}

function envioDe(o: any) {
  const cod = String(o.shipping_option_code || "");
  const costo = num(o.shipping_cost_owner), cobrado = num(o.shipping_cost_customer);
  if (costo <= 0 && cobrado <= 0) return null;
  if (cod.startsWith("table_")) return { ...ENVIOS.local, costo, cobrado };
  if (o.shipping_pickup_type !== "pickup") return { ...ENVIOS.domicilio, costo, cobrado };
  if (cod === "HOP0") return { ...ENVIOS.hop, costo, cobrado };
  return { ...ENVIOS.sucursal, costo, cobrado };
}
// Si el cliente cargo su direccion se usa SIEMPRE, retire o no. Si no la cargo, queda vacia sola.
function direccionDe(o: any) {
  const calle = titleCase(o.billing_address).replace(/^Avenida\b/i, "Av.");
  const nro = String(o.billing_number || "").trim();
  let piso = String(o.billing_floor || "").trim();
  if (piso && (norm(piso) === norm(o.billing_city) || norm(piso) === norm(o.billing_locality))) piso = "";
  return { street: [calle, nro].filter(Boolean).join(" ") || false, street2: piso ? titleCase(piso) : false };
}
function ubicacionDe(o: any) {
  const pickup = o.shipping_pickup_type === "pickup";
  const suc = o.shipping_pickup_details?.address || {};
  const cod = String(o.shipping_option_code || "");
  let loc = String(o.billing_city || "").trim();
  let prov = String(o.billing_province || "").trim();
  let cp = soloDig(o.billing_zipcode).slice(0, 4);
  if (pickup && !loc) loc = cod === "CPS" ? (suc.locality || suc.city || "") : (suc.city || suc.locality || "");
  if (pickup && !prov) prov = String(suc.province || "");
  if (pickup && !cp) cp = soloDig(suc.zipcode).slice(0, 4);
  if (/rosaint/i.test(String(o.shipping_option || ""))) { if (!loc) loc = "Rosario"; if (!prov) prov = "Santa Fe"; if (!cp) cp = "2000"; }
  loc = titleCase(loc);
  if (norm(prov) === "CAPITAL FEDERAL" || norm(prov) === "CIUDAD AUTONOMA DE BUENOS AIRES") {
    if (["CAPITAL FEDERAL", "CABA", "CIUDAD AUTONOMA DE BUENOS AIRES", "BUENOS AIRES", ""].includes(norm(loc))) loc = "Capital Federal";
  }
  return { localidad: loc, provincia: prov, cp };
}
async function armar(o: any) {
  const avisos: string[] = [];
  const map = await skuMap(), st = await estados();
  const lineas = (o.products || []).map((p: any) => {
    const sku = String(p.sku || "").trim();
    const pid = map[sku] || null; if (!pid) avisos.push(`Codigo sin producto en Odoo: ${sku || "(vacio)"} - ${p.name}`);
    return { sku, nombre: p.name, qty: num(p.quantity), precio: num(p.price), product_id: pid };
  });
  const subtotal = num(o.subtotal);
  const dgw = num(o.discount_gateway);
  const dcup = num(o.discount_coupon);
  const dprom = num(o.promotional_discount?.total_discount_amount);
  if (dcup > 0) avisos.push(`Tiene cupon de $${dcup} - no se carga.`);
  if (dprom > 0) avisos.push(`Tiene descuento promocional de $${dprom} - no se carga.`);
  let descuento: any = null;
  if (dgw > 0) {
    const pct = subtotal > 0 ? Math.round((dgw / subtotal) * 100) : 0;
    if (DESCUENTOS[pct]) descuento = { ...DESCUENTOS[pct], monto: dgw, pct };
    else avisos.push(`Descuento del ${pct}% ($${dgw}) sin programa equivalente en Odoo - no se carga.`);
  }
  const envio = envioDe(o);
  const freeship = envio ? Math.max(0, envio.costo - envio.cobrado) : 0;
  const u = ubicacionDe(o), dir = direccionDe(o);
  const stateId = st[norm(u.provincia)] || false;
  if (u.provincia && !stateId) avisos.push(`Provincia no reconocida: "${u.provincia}".`);
  if (!u.localidad) avisos.push("Sin localidad.");
  const doc = soloDig(o.contact_identification);
  if (!doc) avisos.push("Sin documento - no se puede identificar al cliente.");
  const tipoDoc = doc.length === 11 ? "CUIT" : "DNI";
  const pagoNom = String(o.gateway_name || "").trim();
  const pagoId = PAGOS[pagoNom.toLowerCase()] || null;
  if (!pagoId) avisos.push(`Medio de pago sin equivalente: "${pagoNom}".`);
  if (/expreso/i.test(String(o.shipping_option_code || ""))) avisos.push("Correo Expreso - se carga como envio a domicilio nacional, revisar.");
  const esperado = lineas.reduce((a: number, l: any) => a + l.precio * l.qty, 0) + (envio ? envio.costo : 0) - freeship - (descuento ? descuento.monto : 0);
  if (Math.abs(esperado - num(o.total)) > 0.5) avisos.push(`El total no cierra: calculado $${esperado.toFixed(2)} vs Tienda Nube $${num(o.total).toFixed(2)}.`);
  const mail = String(o.contact_email || "").trim().toLowerCase();
  const tel = telOdoo(o.contact_phone || o.billing_phone);
  if (!mail) avisos.push("Sin mail.");
  if (!tel) avisos.push("Sin telefono.");
  return {
    numero: String(o.number), tn_id: String(o.id), fecha: o.created_at, total: num(o.total), subtotal,
    estado_pago: o.payment_status, pago: pagoNom, pago_id: pagoId,
    cliente: { nombre: String(o.contact_name || "").trim(), documento: doc, tipo_doc: tipoDoc, state_id: stateId,
      email: mail || false, telefono: tel, ...u, ...dir },
    lineas, envio, freeship, descuento, avisos,
  };
}
async function partnerDe(p: any): Promise<number> {
  const c = p.cliente;
  const datos: any = { street: c.street, street2: c.street2, city: c.localidad || false, zip: c.cp || false,
    state_id: c.state_id, country_id: COUNTRY_AR, email: c.email, phone: c.telefono };
  const hit = await buscarPartner(c.tipo_doc, c.documento);
  if (hit) {
    const id = hit.id;
    const cur = (await exec("res.partner", "read", [[id], ["street", "street2", "city", "zip", "state_id", "email", "phone"]], {}) as any[])[0] || {};
    const upd: any = {};
    for (const k of ["street", "street2", "city", "zip"]) if (datos[k] && String(cur[k] || "") !== String(datos[k])) upd[k] = datos[k];
    if (datos.state_id && (!cur.state_id || cur.state_id[0] !== datos.state_id)) upd.state_id = datos.state_id;
    if (c.email && String(cur.email || "").trim().toLowerCase() !== c.email) upd.email = c.email;
    // el telefono se reescribe si cambian los digitos O si esta con otro formato
    if (c.telefono && String(cur.phone || "").trim() !== c.telefono) upd.phone = c.telefono;
    if (Object.keys(upd).length) await exec("res.partner", "write", [[id], upd]);
    return id;
  }
  const [vat] = fmtVat(c.tipo_doc, c.documento);
  return await exec("res.partner", "create", [{
    name: c.nombre || "Consumidor Final", company_type: "person", customer_rank: 1,
    vat: vat || false, l10n_latam_identification_type_id: ID_TYPE[c.tipo_doc] || 5,
    l10n_ar_afip_responsibility_type_id: 5, ...datos,
  }], {}) as number;
}
async function crearBorrador(p: any) {
  const partnerId = await partnerDe(p);
  const lines: unknown[] = p.lineas.map((l: any) => [0, 0, { product_id: l.product_id, product_uom_qty: l.qty, price_unit: l.precio, tax_id: [[6, 0, [TAX]]] }]);
  if (p.envio) lines.push([0, 0, { product_id: p.envio.product, name: p.envio.nombre, product_uom_qty: 1, price_unit: p.envio.costo, tax_id: [[6, 0, [TAX]]], is_delivery: true }]);
  const vals: any = {
    partner_id: partnerId, company_id: COMPANY, client_order_ref: String(p.numero), date_order: fechaOdoo(p.fecha),
    pricelist_id: PRICELIST, payment_term_id: TERM, warehouse_id: WAREHOUSE, team_id: TEAM, user_id: SALESMAN,
    source_id: SOURCE_TN, x_studio_mtodo_de_pago_2: p.pago_id || false, order_line: lines,
  };
  if (p.envio) vals.carrier_id = p.envio.carrier;
  const soId = await exec("sale.order", "create", [vals], {}) as number;
  const cur = await exec("sale.order.line", "search_read", [[["order_id", "=", soId]], ["product_id"]], {}) as any[];
  const tiene = (pid: number) => cur.some((l) => Array.isArray(l.product_id) && l.product_id[0] === pid);
  const add: unknown[] = []; const rec: string[] = [];
  if (p.freeship > 0 && !tiene(FREESHIP.product)) { add.push([0, 0, { product_id: FREESHIP.product, name: FREESHIP.nombre, product_uom_qty: 1, price_unit: -p.freeship, tax_id: [[6, 0, [TAX]]], is_reward_line: true, reward_id: FREESHIP.reward }]); rec.push("envio gratis"); }
  if (p.descuento && !tiene(p.descuento.product)) { add.push([0, 0, { product_id: p.descuento.product, name: p.descuento.nombre, product_uom_qty: 1, price_unit: -p.descuento.monto, tax_id: [[6, 0, [TAX]]], is_reward_line: true, reward_id: p.descuento.reward }]); rec.push(`descuento ${p.descuento.pct}%`); }
  let recompensas = rec.length ? "agregadas por el conector: " + rec.join(", ") : "las puso Odoo solo";
  if (add.length) {
    try { await exec("sale.order", "write", [[soId], { order_line: add }]); }
    catch (_) {
      const simple = (add as any[]).map((a) => { const v = { ...a[2] }; delete v.is_reward_line; delete v.reward_id; return [0, 0, v]; });
      await exec("sale.order", "write", [[soId], { order_line: simple }]);
      recompensas += " (sin marca de recompensa)";
    }
  }
  const so = (await exec("sale.order", "read", [[soId], ["name", "amount_total", "state"]], {}) as any[])[0];
  return { so_id: soId, so_name: so?.name, estado: so?.state, total_odoo: so?.amount_total, total_tn: p.total, coincide: Math.abs(num(so?.amount_total) - p.total) < 0.5, partner_id: partnerId, recompensas };
}
let TOPE = false;
// Recorre las ordenes de Tienda Nube de a 50. estado=null trae TODAS (sirve para ver las que NO
// estan pagas); estado="paid" es lo que usa la carga a Odoo.
async function ordenesTN(desde: string, estado: string | null = "paid") {
  const filtro = estado ? `&payment_status=${estado}` : "";
  const out: any[] = []; TOPE = false;
  let page = 1;
  for (; page <= MAX_PAGINAS; page++) {
    const r = await tnGetPagina(`/orders?per_page=${POR_PAGINA}&page=${page}${filtro}&created_at_min=${desde}T00:00:00-03:00&sort_by=created_at-descending`);
    if (!Array.isArray(r) || !r.length) break;
    out.push(...r);
    if (r.length < POR_PAGINA) break;
  }
  if (page > MAX_PAGINAS) TOPE = true;  // se corto por el tope, puede haber ordenes sin mirar
  return out;
}
const ordenesPagas = (desde: string) => ordenesTN(desde, "paid");
async function pendientes(desde: string) {
  const orders = await ordenesPagas(desde);
  const nums = orders.map((o: any) => String(o.number));
  const yaC = nums.length ? await exec("sale.order", "search_read", [[["client_order_ref", "in", nums], ["company_id", "=", COMPANY]], ["client_order_ref"]], {}) as any[] : [];
  const set = new Set(yaC.map((c: any) => String(c.client_order_ref)));
  return { orders, pend: orders.filter((o: any) => !set.has(String(o.number))).sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at))) };
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
  const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({})) as any;
    const modo = body.modo || "listar";
    const escribe = modo === "cargar" || modo === "sincronizar_cliente" || modo === "backfill_ref" || (modo === "backfill_auto" && body.confirmar === true);
    if (escribe) {
      if (!SECRET) return ok({ ok: false, error: "Escritura bloqueada: falta configurar el secreto TN_PROXY_SECRET." });
      if (req.headers.get("x-proxy-secret") !== SECRET) return ok({ ok: false, error: "No autorizado para escribir." });
    }
    await tnToken(sb);

    if (modo === "auto") {
      const viejo = new Date(Date.now() - 180000).toISOString();
      const { data: got } = await sb.from("tn_odoo_lock").update({ running: true, since: new Date().toISOString() })
        .eq("id", 1).or(`running.eq.false,since.lt.${viejo}`).select();
      if (!got || !got.length) return ok({ ok: true, skip: "ya hay una corrida en curso" });
      try {
        const { pend } = await pendientes(body.desde || CORTE);
        let cargadas = 0, revisar = 0, errores = 0; const bit: any[] = []; const detalle: any[] = [];
        for (const o of pend) {
          try {
            const p = await armar(o);
            const bloqueo = p.avisos.filter((a) => /no se carga|sin producto|Sin documento/i.test(a));
            if (bloqueo.length) { revisar++; bit.push({ numero: p.numero, cliente: p.cliente.nombre, total: p.total, resultado: "revisar", detalle: p.avisos.join(" | ").slice(0, 500) }); continue; }
            if (await yaCargada(p.numero)) continue;
            const r = await crearBorrador(p);
            cargadas++;
            bit.push({ numero: p.numero, so_name: r.so_name, cliente: p.cliente.nombre, total: p.total, resultado: "cargada", detalle: (r.coincide ? "" : "OJO: el total no coincide. ") + r.recompensas });
            detalle.push({ orden: p.numero, venta: r.so_name, cliente: p.cliente.nombre, total: r.total_odoo, coincide: r.coincide, recompensas: r.recompensas });
          } catch (e) { errores++; bit.push({ numero: String(o.number), cliente: o.contact_name, total: num(o.total), resultado: "error", detalle: String((e as Error).message || e).slice(0, 400) }); }
        }
        if (bit.length) { try { await sb.from("tn_odoo_bitacora").insert(bit); } catch (_) { } }
        return ok({ ok: true, pendientes: pend.length, cargadas, revisar, errores, tope: TOPE, detalle });
      } catch (e) {
        // Si la corrida se cae ANTES de recorrer las ordenes (Tienda Nube u Odoo caidos, un 404 de
        // paginado, etc.) hay que dejar rastro: si no, el conector deja de cargar EN SILENCIO y solo
        // se nota cuando alguien busca una venta que falta. Paso el 05/10/2026 con la orden 2469.
        const msg = String((e as Error).message || e).slice(0, 400);
        try { await sb.from("tn_odoo_bitacora").insert([{ numero: "-", cliente: "(la corrida se cayo)", resultado: "falla", detalle: msg }]); } catch (_) { }
        return ok({ ok: false, error: msg });
      } finally { try { await sb.from("tn_odoo_lock").update({ running: false, since: new Date().toISOString() }).eq("id", 1); } catch (_) { } }
    }

    // Aviso de TRANSFERENCIAS POR CONFIRMAR: ordenes donde el cliente eligio transferencia y que
    // siguen sin marcarse como pagas en Tienda Nube. Es el punto ciego que queda: si la plata entro
    // al banco y nadie la marca en la tienda, la venta NO se carga nunca y nada avisa. Solo lectura.
    // dias = antiguedad minima para mostrarla (0 = todas). Las canceladas no cuentan.
    // CANCELAR una orden en Tienda Nube desde el Core. Decision de Diego (05/10/2026):
    // email:false (no se le manda el mail de cancelacion a la clienta) y restock:true (vuelve el stock).
    // Nunca cancela una orden PAGA: para eso hay que ir a Tienda Nube a mano.
    // Autoriza el secreto O la sesion del usuario logueado en el Core. Sin confirmar:true solo ensaya.
    if (modo === "cancelar") {
      const n = String(body.numero || "").trim();
      const tid = String(body.tn_id || "").trim();
      if (!n && !tid) return ok({ ok: false, error: "Falta numero o tn_id" });
      let o: any;
      if (tid) o = await tnGet(`/orders/${tid}`);
      else { const r = await tnGetPagina(`/orders?q=${n}&per_page=50`); o = (Array.isArray(r) ? r : []).find((x: any) => String(x.number) === n); }
      if (!o) return ok({ ok: false, error: "No se encontro la orden en Tienda Nube" });
      const numero = String(o.number), id = String(o.id);
      if (String(o.status) === "cancelled" || o.cancelled_at) return ok({ ok: true, ya_cancelada: true, numero, msg: "Esa orden ya estaba cancelada" });
      if (String(o.payment_status) === "paid") return ok({ ok: false, error: `La orden ${numero} esta PAGA: no se cancela desde aca.`, estado_pago: o.payment_status });
      const enOdoo = await yaCargada(numero);   // no deberia estar (solo se cargan las pagas), pero se avisa
      if (!body.confirmar) {
        return ok({ ok: true, ensayo: true, numero, tn_id: id, cliente: o.contact_name, total: num(o.total),
          estado: o.status, estado_pago: o.payment_status, en_odoo: enOdoo, aviso_mail: false, devuelve_stock: true });
      }
      const autorizado = (SECRET && req.headers.get("x-proxy-secret") === SECRET) || await usuarioValido(req);
      if (!autorizado) return ok({ ok: false, error: "No autorizado para cancelar." });
      const res = await tnPost(`/orders/${id}/cancel`, { reason: String(body.motivo || "other"), email: false, restock: true });
      try {
        await sb.from("tn_odoo_bitacora").insert([{ numero, cliente: o.contact_name, total: num(o.total),
          resultado: "cancelada", detalle: `Cancelada en Tienda Nube desde el Core (sin mail, con devolucion de stock). Estado de pago al cancelar: ${o.payment_status}.` }]);
      } catch (_) { }
      return ok({ ok: true, cancelada: true, numero, tn_id: id, cliente: o.contact_name, total: num(o.total),
        estado: res?.status || "cancelled", en_odoo: enOdoo });
    }

    if (modo === "transferencias") {
      const desde = String(body.desde || CORTE);
      const minDias = Number(body.dias ?? 0);
      const todas = await ordenesTN(desde, null);
      const por_estado: Record<string, number> = {};
      for (const o of todas) { const e = String(o.payment_status || "?"); por_estado[e] = (por_estado[e] || 0) + 1; }
      const hoy = Date.now();
      const lista = todas.filter((o: any) => {
        if (String(o.payment_status) === "paid") return false;
        if (String(o.status) === "cancelled" || o.cancelled_at) return false;
        return /transfer|deposito|depósito/i.test(String(o.gateway_name || "") + " " + String(o.gateway || ""));
      }).map((o: any) => ({
        numero: String(o.number), tn_id: String(o.id), fecha: o.created_at,
        dias: Math.floor((hoy - new Date(o.created_at).getTime()) / 86400000),
        cliente: String(o.contact_name || "").trim(),
        telefono: telOdoo(o.contact_phone || o.billing_phone) || "",
        total: num(o.total), estado_pago: o.payment_status, estado: o.status,
        pago: String(o.gateway_name || "").trim(), link: o.admin_url || null,
      })).filter((o: any) => o.dias >= minDias).sort((a: any, b: any) => b.dias - a.dias);
      return ok({ ok: true, desde, dias_minimo: minDias, cantidad: lista.length, tope: TOPE, por_estado, transferencias: lista });
    }

    if (modo === "listar") {
      const { orders, pend } = await pendientes(body.desde || CORTE);
      const setP = new Set(pend.map((o: any) => String(o.number)));
      const lista = orders.map((o: any) => ({
        numero: String(o.number), tn_id: String(o.id), fecha: o.created_at, cliente: o.contact_name,
        total: num(o.total), renglones: (o.products || []).length, ya_cargada: !setP.has(String(o.number)),
      })).sort((a: any, b: any) => (a.fecha || "").localeCompare(b.fecha || ""));
      return ok({ ok: true, corte: body.desde || CORTE, cantidad: lista.length, pendientes: pend.length, tope: TOPE, ordenes: lista });
    }

    if (modo === "backfill_auto") {
      const desde = String(body.desde || "2026-08-01"), hasta = String(body.hasta || "2026-09-30");
      const orders = (await ordenesPagas(desde)).filter((o: any) => String(o.created_at || "").slice(0, 10) <= hasta);
      const sos = await exec("sale.order", "search_read", [[["source_id", "=", SOURCE_TN], ["company_id", "=", COMPANY],
        ["date_order", ">=", desde + " 00:00:00"], ["date_order", "<=", hasta + " 23:59:59"]],
        ["id", "name", "date_order", "amount_total", "partner_id", "client_order_ref"]], { limit: 400 }) as any[];
      const pids = [...new Set(sos.map((s: any) => s.partner_id?.[0]).filter(Boolean))] as number[];
      const parts = pids.length ? await exec("res.partner", "read", [pids, ["vat"]], {}) as any[] : [];
      const vatOf: Record<number, string> = {}; for (const p of parts) vatOf[p.id] = nucleoDoc(p.vat);
      const cand: any[] = [];
      for (const s of sos) {
        if (s.client_order_ref) continue;
        const sd = vatOf[s.partner_id?.[0]] || ""; if (!sd) continue;
        for (const o of orders) {
          if (nucleoDoc(o.contact_identification) !== sd) continue;
          if (Math.abs(num(o.total) - num(s.amount_total)) > 0.5) continue;
          cand.push({ so_id: s.id, so: s.name, ref: String(o.number), fecha: String(s.date_order).slice(0, 10),
            monto: num(s.amount_total), cliente: s.partner_id?.[1],
            dd: Math.abs(new Date(String(s.date_order).replace(" ", "T") + "Z").getTime() - new Date(o.created_at).getTime()) });
        }
      }
      cand.sort((a, b) => a.dd - b.dd);
      const usoSo = new Set<number>(), usoRef = new Set<string>(); const pares: any[] = [];
      for (const c of cand) { if (usoSo.has(c.so_id) || usoRef.has(c.ref)) continue; usoSo.add(c.so_id); usoRef.add(c.ref); const { dd: _dd, ...r } = c; pares.push(r); }
      const sinOrden = sos.filter((s: any) => !s.client_order_ref && !usoSo.has(s.id))
        .map((s: any) => ({ so: s.name, fecha: String(s.date_order).slice(0, 10), monto: num(s.amount_total), cliente: s.partner_id?.[1] }));
      const sinVenta = orders.filter((o: any) => !usoRef.has(String(o.number)))
        .map((o: any) => ({ orden: String(o.number), fecha: String(o.created_at).slice(0, 10), monto: num(o.total), cliente: o.contact_name }));
      const extra = (body.pares_extra || []) as Array<{ so_id: number; ref: string }>;
      if (!body.confirmar) return ok({ ok: true, ensayo: true, desde, hasta, ventas: sos.length, ordenes: orders.length, pares: pares.length, extra: extra.length, sin_orden: sinOrden, sin_venta: sinVenta, detalle: pares });
      let escritas = 0, saltadas = 0; const errores: string[] = [];
      for (const pr of [...pares.map((p: any) => ({ so_id: p.so_id, ref: p.ref })), ...extra]) {
        try {
          const cur = (await exec("sale.order", "read", [[pr.so_id], ["client_order_ref", "company_id"]], {}) as any[])[0];
          if (!cur || cur.company_id?.[0] !== COMPANY) { errores.push(`${pr.so_id}: no es de la compania 2`); continue; }
          if (cur.client_order_ref) { saltadas++; continue; }
          await exec("sale.order", "write", [[pr.so_id], { client_order_ref: String(pr.ref) }]); escritas++;
        } catch (e) { errores.push(`${pr.so_id}: ${(e as Error).message}`); }
      }
      return ok({ ok: true, escritas, saltadas, errores: errores.slice(0, 20), sin_orden: sinOrden, sin_venta: sinVenta });
    }

    if (modo === "backfill_ref") {
      const pares = (body.pares || []) as Array<{ so_id: number; ref: string }>;
      let escritas = 0, saltadas = 0; const errores: string[] = [];
      for (const pr of pares) {
        try {
          const cur = (await exec("sale.order", "read", [[pr.so_id], ["client_order_ref", "company_id"]], {}) as any[])[0];
          if (!cur || cur.company_id?.[0] !== COMPANY) { errores.push(`${pr.so_id}: no es de la compania 2`); continue; }
          if (cur.client_order_ref && !body.overwrite) { saltadas++; continue; }
          await exec("sale.order", "write", [[pr.so_id], { client_order_ref: String(pr.ref) }]); escritas++;
        } catch (e) { errores.push(`${pr.so_id}: ${(e as Error).message}`); }
      }
      return ok({ ok: true, escritas, saltadas, errores: errores.slice(0, 20) });
    }

    const id = String(body.tn_id || body.id || "");
    const numero = String(body.numero || "");
    if (!id && !numero) return ok({ ok: false, error: "Falta tn_id o numero" });
    let o: any;
    if (id) o = await tnGet(`/orders/${id}`);
    else { const r = await tnGetPagina(`/orders?q=${numero}&per_page=50`); o = (Array.isArray(r) ? r : []).find((x: any) => String(x.number) === numero); }
    if (!o) return ok({ ok: false, error: "No se encontro la orden en Tienda Nube" });

    const p = await armar(o);
    const ya = await yaCargada(p.numero);
    const existe = p.cliente.documento ? await buscarPartner(p.cliente.tipo_doc, p.cliente.documento) : null;

    if (modo === "sincronizar_cliente") {
      const pid = await partnerDe(p);
      const ficha = (await exec("res.partner", "read", [[pid], ["name", "email", "phone", "street", "street2", "city", "zip", "state_id"]], {}) as any[])[0];
      return ok({ ok: true, partner_id: pid, ficha });
    }

    if (modo === "preview") return ok({ ok: true, ...p, cliente_existe: !!existe, partner_id: existe?.id ?? null, cliente_hallado_por: existe?.via ?? null, ya_cargada: !!ya, so: ya });

    if (modo === "cargar") {
      if (p.estado_pago !== "paid") return ok({ ok: false, error: `El pago esta en "${p.estado_pago}", solo se cargan las pagas.` });
      if ((p.fecha || "") < CORTE && !body.forzar) return ok({ ok: false, error: `La orden es anterior al corte ${CORTE}. forzar:true para cargarla igual.`, fecha: p.fecha });
      if (ya) return ok({ ok: true, ya_cargada: true, so: ya, msg: "Esa orden ya estaba cargada" });
      const bloqueo = p.avisos.filter((a) => /no se carga|sin producto|Sin documento/i.test(a));
      if (bloqueo.length && !body.forzar) return ok({ ok: false, error: "Necesita revision", avisos: p.avisos });
      const r = await crearBorrador(p);
      return ok({ ok: true, creada: true, ...r, numero: p.numero, cliente: p.cliente.nombre, avisos: p.avisos });
    }
    return ok({ ok: false, error: "modo invalido" });
  } catch (e) { return ok({ ok: false, error: String((e as Error).message || e) }); }
});
