// tn-envios — Core → Tienda Nube → Envíos y descuentos.
//   accion "productos": productos y variantes con peso y medidas (+ categorías) de la tienda.
//   accion "cotizar":   arma una bolsa de prueba en la Storefront API, pide las tarifas reales
//                       (el mismo calculador del checkout) y aplica las reglas de descuento de envío.
//   accion "promos":    promociones de envío gratis activas.
//   accion "resultados": bolsas que consultó Tienda Nube y pedidos con la bonificación de envío (pestaña Resultados).
// Las reglas viven en public.tn_envio_reglas. evaluarReglas() es la misma lógica que va a usar
// el callback de la app de descuentos cuando Tienda Nube la autorice.
// Primero solo Rosaint; Augusta se suma agregándola a TIENDAS (hasta que tenga su propio Core).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Rosaint Core - envios (rosaint.ar@gmail.com)";
const TIENDAS: Record<number, { nombre: string; mcp: string }> = {
  385079: { nombre: "Rosaint", mcp: "https://comprar.rosaint.online/api/mcp" },
  // 1142221: { nombre: "Augusta", mcp: "https://comprar.augustaintimates.com/api/mcp" },
};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
type Rec = Record<string, any>;

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

async function token(store: number): Promise<string> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_store_token`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_store_id: store }) });
  if (!r.ok) throw new Error("token rpc " + r.status);
  const t = await r.json(); if (!t || typeof t !== "string") throw new Error("Sin token de Tienda Nube para " + store); return t;
}
async function tnGet(store: number, tok: string, path: string, version = "2025-03"): Promise<any> {
  for (let intento = 0; intento < 4; intento++) {
    const r = await fetch(`https://api.tiendanube.com/${version}/${store}${path}`, { headers: { Authentication: `bearer ${tok}`, "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1200 * (intento + 1))); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`TN ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error("Tienda Nube no responde (demasiados pedidos)");
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const es = (n: any) => (n && typeof n === "object" ? (n.es ?? Object.values(n)[0] ?? "") : String(n ?? ""));

async function productos(store: number) {
  const tok = await token(store);
  const lista: Rec[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await tnGet(store, tok, `/products?per_page=200&page=${page}`);
    if (!r || !r.length) break;
    for (const p of r) lista.push({
      id: p.id, nombre: es(p.name), publicado: !!p.published, envio_gratis: !!p.free_shipping,
      categorias: (p.categories || []).map((c: Rec) => c.id),
      variantes: (p.variants || []).map((v: Rec) => ({
        id: v.id, valores: (v.values || []).map(es).join(" / "), sku: v.sku,
        precio: num(v.promotional_price) ?? num(v.price), stock: v.stock === null ? null : num(v.stock),
        peso: num(v.weight), ancho: num(v.width), alto: num(v.height), prof: num(v.depth),
      })),
    });
    if (r.length < 200) break;
  }
  const cats = (await tnGet(store, tok, `/categories?per_page=200&fields=id,name,parent`)) || [];
  return { productos: lista, categorias: cats.map((c: Rec) => ({ id: c.id, nombre: es(c.name), padre: c.parent })) };
}

async function mcpLlamar(store: number, tool: string, args: Rec) {
  const r = await fetch(TIENDAS[store].mcp, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await r.text(); let m: Rec | null = null;
  for (const l of t.split(/\r?\n/)) if (l.startsWith("data:")) { try { m = JSON.parse(l.slice(5)); } catch { /* sigue */ } }
  if (!m) { try { m = JSON.parse(t); } catch { throw new Error("Respuesta rara del calculador de la tienda"); } }
  if (m!.error) throw new Error("Calculador: " + JSON.stringify(m!.error).slice(0, 200));
  let p = m!.result?.structuredContent;
  for (const c of m!.result?.content || []) if (c.type === "text") { try { p = JSON.parse(c.text); break; } catch { /* sigue */ } }
  return p || {};
}

function clasificar(nombre: string) {
  const s = nombre.toLowerCase();
  const medio = /andreani/.test(s) ? "andreani" : /correo/.test(s) ? "correo" : "otro";
  const entrega = /sucursal|punto|retiro|pickup|hop/.test(s) ? "sucursal" : "domicilio";
  return { medio, entrega };
}

// ZONA (12/11/2026): MISMA lógica que tn-descuentos (callback) y que la bolsa de rosaint.online.
// CPA (S2000ABC): la letra ES la provincia; CP de 4 dígitos: tabla cp_provincias (rangos [desde, hasta, letra]).
const LETRAS = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]$/;
const PROVINCIAS: Record<string, string> = { C: "Ciudad de Buenos Aires", B: "Buenos Aires", K: "Catamarca", H: "Chaco", U: "Chubut", X: "Córdoba", W: "Corrientes", E: "Entre Ríos", P: "Formosa", Y: "Jujuy", L: "La Pampa", F: "La Rioja", M: "Mendoza", N: "Misiones", Q: "Neuquén", R: "Río Negro", A: "Salta", J: "San Juan", D: "San Luis", Z: "Santa Cruz", S: "Santa Fe", G: "Santiago del Estero", V: "Tierra del Fuego", T: "Tucumán" };
const NOMBRE_A_LETRA: Record<string, string> = Object.fromEntries(Object.entries(PROVINCIAS).map(([l, n]) => [n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(), l]));
NOMBRE_A_LETRA["capital federal"] = "C"; NOMBRE_A_LETRA["ciudad autonoma de buenos aires"] = "C"; NOMBRE_A_LETRA["caba"] = "C";
const letraDeNombre = (n: unknown) => NOMBRE_A_LETRA[String(n ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()] || "";
function cpPartes(cp: unknown) { const m = String(cp ?? "").toUpperCase().replace(/\s/g, "").match(/^([A-Z])?(\d{4})/); return m ? { cp: m[2], letra: m[1] && LETRAS.test(m[1]) ? m[1] : "" } : null; }
function provinciaDe(cp: unknown, rangos: [number, number, string][]) {
  const x = cpPartes(cp); if (!x) return null; if (x.letra) return x.letra;
  const n = Number(x.cp); let a = 0, b = rangos.length - 1;
  while (a <= b) { const m = (a + b) >> 1, r = rangos[m]; if (n < r[0]) b = m - 1; else if (n > r[1]) a = m + 1; else return r[2]; }
  return null;
}
function cpEnLista(lista: unknown, cp: string) {
  for (const parte of String(lista ?? "").replace(/\s*-\s*/g, "-").split(/[,;\s]+/)) {
    const m = parte.match(/^(\d{4})(?:-(\d{4}))?$/); if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]), n = Number(cp);
    if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
  }
  return false;
}
function zonaOk(r: Rec, cp: unknown, rangos: [number, number, string][]) {
  const modo = r.zona_modo || "todas"; if (modo === "todas") return true;
  const x = cpPartes(cp); if (!x) return false;
  const enCps = cpEnLista(r.zona_cps, x.cp), provs: string[] = r.zona_provincias || [];
  if (modo === "incluir") { if (enCps) return true; const p = provinciaDe(cp, rangos); return !!p && provs.includes(p); }
  if (enCps) return false; if (!provs.length) return true;
  const p = provinciaDe(cp, rangos); return !!p && !provs.includes(p);
}

// Misma lógica para el simulador y para el futuro callback de descuentos.
// carrito = { unidades_por_categoria: {catId: n}, unidades: n, subtotal: $ }, opcion = { medio, entrega, precio }
export function evaluarReglas(reglas: Rec[], carrito: Rec, opcion: Rec, hoy = new Date().toISOString().slice(0, 10)) {
  if (!(opcion.precio > 0)) return null; // envío ya gratis: no se pisa
  const vale = reglas.filter((r) => {
    if (r.desde && hoy < r.desde) return false;
    if (r.hasta && hoy > r.hasta) return false;
    if (r.medio !== "todos" && r.medio !== opcion.medio) return false;
    if (r.entrega !== "todas" && r.entrega !== opcion.entrega) return false;
    if (r.min_monto != null && carrito.subtotal < Number(r.min_monto)) return false;
    if (r.max_monto != null && carrito.subtotal > Number(r.max_monto)) return false;
    const u = r.categoria_ids?.length
      ? r.categoria_ids.reduce((s: number, c: number) => s + (carrito.unidades_por_categoria[c] || 0), 0)
      : carrito.unidades;
    if (r.min_unidades != null && u < r.min_unidades) return false;
    if (!zonaOk(r, carrito.cp, carrito.rangos || [])) return false;
    return true;
  });
  let mejor: Rec | null = null;
  for (const r of vale) {
    let d = r.descuento_tipo === "porcentaje" ? opcion.precio * Number(r.descuento_valor) / 100 : Number(r.descuento_valor);
    if (r.tope != null) d = Math.min(d, Number(r.tope));
    d = Math.min(Math.round(d * 100) / 100, opcion.precio);
    if (!mejor || d > mejor.descuento || (d === mejor.descuento && r.prioridad < mejor.prioridad)) mejor = { regla_id: r.id, regla: r.nombre, texto: r.texto, descuento: d, prioridad: r.prioridad, activa: r.activa };
  }
  return mejor;
}

async function cotizar(store: number, body: Rec) {
  const cp = String(body.cp || "").trim().toUpperCase();
  if (!/^[A-Z]?\d{4}[A-Z]{0,3}$/.test(cp)) throw new Error("Código postal inválido");
  const items = (body.items || []).filter((i: Rec) => i.pid && i.vid && i.q > 0).slice(0, 40);
  if (!items.length) throw new Error("Agregá al menos un producto");
  const S = `https://storefront-api.tiendanube.com/unstable/stores/${store}/carts`;
  const c = await (await fetch(S, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  if (!c.id) throw new Error("No se pudo armar la bolsa de prueba");
  const avisos: string[] = [];
  let carro: Rec = c;
  for (const i of items) {
    const r = await fetch(`${S}/${c.id}/line-items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: i.pid, variant_id: i.vid, quantity: i.q }) });
    if (r.ok) carro = await r.json(); else avisos.push(`No se pudo sumar ${i.nombre || i.vid} x${i.q} (¿sin stock?)`);
  }
  const [cid, hash] = atob(c.id.slice(5).replace(/-/g, "+").replace(/_/g, "/")).split(".");
  // Bolsa de prueba: en el checkout, el callback tn-descuentos le aplica también las reglas en borrador.
  await fetch(`${SB_URL}/rest/v1/tn_carritos_prueba`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ store_id: store, cart_id: Number(cid) }) }).catch(() => {});
  await publicarDescuentos().catch(() => {});
  const p = await mcpLlamar(store, "get_shipping_methods", { cart_id: Number(cid), cart_hash: hash, zipcode: cp, country_code: "AR" });
  // unidades por categoría (para las reglas)
  const tok = await token(store);
  const porCat: Record<string, number> = {};
  let unidades = 0;
  for (const li of carro.line_items || []) {
    unidades += li.quantity;
    const prod = await tnGet(store, tok, `/products/${li.product_id}?fields=categories`);
    for (const cat of prod?.categories || []) porCat[cat.id] = (porCat[cat.id] || 0) + li.quantity;
  }
  // Igual que el callback: monto de lista (Tienda Nube manda totals.subtotal antes de descuentos).
  const subtotal = Math.round((carro.line_items || []).reduce((s: number, l: Rec) => s + Number(l.cost?.unit_price || 0) * l.quantity, 0) * 100) / 100;
  const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` };
  const [reglas, tiendaCfg] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/tn_envio_reglas?store_id=eq.${store}&select=*`, { headers: hdr }).then((r) => r.ok ? r.json() : []),
    fetch(`${SB_URL}/rest/v1/tn_descuentos_tiendas?store_id=eq.${store}&select=excluir_pares`, { headers: hdr }).then((r) => r.ok ? r.json() : []),
  ]);
  // Mismo criterio de margen que tn-descuentos: si hay otro descuento, solo valen las reglas «acumula».
  const variantes = new Set((carro.line_items || []).map((l: Rec) => Number(l.variant_id)));
  const otros = (carro.coupons || []).length ? "cupón"
    : (carro.line_items || []).some((l: Rec) => Number(l.cost?.compare_at_unit_price || 0) > Number(l.cost?.unit_price || 0)) ? "producto en oferta"
    : ((tiendaCfg as Rec[])[0]?.excluir_pares || []).some((par: number[]) => par.every((v) => variantes.has(Number(v)))) ? "rutina"
    : (carro.line_items || []).some((l: Rec) => (l.discounts || []).length) ? "otro descuento" : "";
  if (otros) avisos.push(`La bolsa tiene ${otros}: solo se aplican las reglas que se suman a otros descuentos.`);
  // Provincia del CP cotizado (CPA: su letra; si no, la tabla) para las reglas con zona.
  const px = cpPartes(cp);
  let rangos: [number, number, string][] = [];
  if (px && !px.letra) { const f = await sbGet(`cp_provincias?select=provincia&cp=eq.${px.cp}`); if (f[0]) rangos = [[Number(px.cp), Number(px.cp), f[0].provincia]]; }
  const provincia = provinciaDe(cp, rangos);
  if (!provincia && reglas.some((r: Rec) => r.zona_modo && r.zona_modo !== "todas")) avisos.push(`El código postal ${cp} no está en la tabla de provincias: las reglas con zona no se aplican (cargalo en Resultados → códigos sin provincia).`);
  const carrito = { unidades, unidades_por_categoria: porCat, subtotal, otros, cp, rangos, provincia, provincia_nombre: provincia ? PROVINCIAS[provincia] : null };
  const vistos = new Map<string, Rec>();
  for (const o of [...(p.home_delivery || []), ...(p.pickup_points || [])]) {
    const nombre = String(o.original_name || o.name || "");
    const { medio, entrega } = clasificar(nombre + " " + (o.option_type === "pickup" ? "sucursal" : ""));
    const precio = Number(o.price?.amount ?? 0);
    const clave = o.option_type === "pickup" ? `${medio}|sucursal` : nombre;
    const previo = vistos.get(clave);
    if (previo && previo.precio <= precio) { previo.lugares++; continue; }
    vistos.set(clave, { nombre: o.option_type === "pickup" ? `${medio === "correo" ? "Correo Argentino" : medio === "andreani" ? "Andreani" : "Retiro"} a sucursal` : String(o.name || nombre), medio, entrega: o.option_type === "pickup" ? "sucursal" : entrega, precio, dias: o.delivery_days || "", lugares: (previo?.lugares || 0) + 1 });
  }
  const opciones = [...vistos.values()].map((o) => {
    const d = evaluarReglas((reglas as Rec[]).filter((r) => (r.activa || body.incluir_borradores !== false) && (!otros || r.acumula)), carrito, o);
    return { ...o, descuento: d, precio_cliente: d ? Math.round((o.precio - d.descuento) * 100) / 100 : o.precio };
  }).sort((a, b) => a.precio - b.precio);
  return { carrito, opciones, avisos, bolsa: c.id };
}

// Publica la configuración del callback tn-descuentos (tiendas, reglas, bolsas de prueba) en el archivo
// público tn-publico/tn-descuentos-v2.json. El callback lo lee por la CDN (cerca de Tienda Nube) en vez de
// ir a la base en us-west-2 en cada consulta. Lo disparan los triggers de las tres tablas.
async function publicarDescuentos() {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_descuentos_datos`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("datos " + r.status);
  const datos = { ...(await r.json()), publicado: new Date().toISOString() };
  const up = await fetch(`${SB_URL}/storage/v1/object/tn-publico/tn-descuentos-v2.json`, { method: "POST",
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", "x-upsert": "true", "cache-control": "max-age=10, stale-while-revalidate=86400, stale-if-error=86400" },
    body: JSON.stringify(datos) });
  if (!up.ok) throw new Error("subida " + up.status + ": " + (await up.text()).slice(0, 200));
  return { publicado: datos.publicado, reglas: datos.reglas.length, prueba: datos.prueba.length };
}

// Resultados de las reglas (pestaña «Resultados»): cuánto se ofrece y cuánto se cobra de verdad.
//   Bolsas: registro de tn-descuentos (nivel cross_items = filas con subtotal); por bolsa vale su ÚLTIMA consulta.
//   Pedidos: API de pedidos de Tienda Nube; la bonificación se reconoce igual que en tn-odoo-cargar
//   (promotion_id de tn_descuentos_tiendas o promoción «Envío con descuento»). Las bolsas de prueba no cuentan.
async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
  if (!r.ok) throw new Error("base " + r.status + ": " + (await r.text()).slice(0, 160));
  return await r.json();
}
async function resultados(store: number, diasPedidos: number) {
  const dias = [7, 30, 90].includes(diasPedidos) ? diasPedidos : 30;
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const [reglas, tiendas, tablaCp] = await Promise.all([
    sbGet(`tn_envio_reglas?select=nombre,activa,min_monto,max_monto,descuento_tipo,descuento_valor,texto,zona_modo,zona_provincias,zona_cps&store_id=eq.${store}&order=prioridad`),
    sbGet(`tn_descuentos_tiendas?select=promotion_id&store_id=eq.${store}`),
    // La tabla entera en rangos (la misma que usa el callback): un select directo corta en 1.000 filas.
    fetch(`${SB_URL}/rest/v1/rpc/tn_descuentos_datos`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json()).then((j) => (j.cp || []) as [number, number, string][]),
  ]);
  const enRango = (s: number | null) => s != null && reglas.some((r) => (r.min_monto == null || s >= Number(r.min_monto)) && (r.max_monto == null || s <= Number(r.max_monto)));
  const provDe = (cp: unknown) => provinciaDe(cp, tablaCp) || "";
  const porProv: Record<string, Rec> = {};
  const fila = (p: string) => (porProv[p || "?"] ??= { provincia: p || "?", nombre: p ? PROVINCIAS[p] : "Sin código postal o sin provincia", bolsas: 0, bolsas_en_rango: 0, bolsas_bonificadas: 0, pagados: 0, pagados_en_rango: 0, pagados_bonificados: 0 });
  const sinProv = new Map<string, Rec>(); // CP que aparecen y no están en la tabla (con la provincia que dice el pedido, si hay)

  // Bolsas: la última consulta de cada una (una bolsa se consulta varias veces mientras cambia).
  const ultima = new Map<string, Rec>();
  for (let off = 0; off < 50000; off += 1000) {
    const p = await sbGet(`tn_descuentos_log?select=cart_id,recibido_en,subtotal,descuento,prueba,respuesta,cp&store_id=eq.${store}&recibido_en=gte.${desde}&subtotal=not.is.null&order=id.asc&limit=1000&offset=${off}`);
    for (const x of p) if (x.cart_id && String(x.cart_id) !== "0" && x.prueba !== true) ultima.set(String(x.cart_id), x);
    if (p.length < 1000) break;
  }
  const bolsas = [...ultima.values()];
  const conBonif = bolsas.filter((x) => x.respuesta === "descuento" && Number(x.descuento) > 0);
  for (const x of bolsas) {
    const p = provDe(x.cp), f = fila(p); f.bolsas++;
    if (enRango(num(x.subtotal))) f.bolsas_en_rango++;
    if (x.respuesta === "descuento" && Number(x.descuento) > 0) f.bolsas_bonificadas++;
    const cx = cpPartes(x.cp); if (cx && !p) { const s = sinProv.get(cx.cp) || { cp: cx.cp, veces: 0, sugerida: "" }; s.veces++; sinProv.set(cx.cp, s); }
  }
  const bolsasOut = {
    total: bolsas.length,
    en_rango: bolsas.filter((x) => enRango(num(x.subtotal))).length,
    con_bonificacion: conBonif.length,
    ofrecido: Math.round(conBonif.reduce((a, x) => a + Number(x.descuento), 0)),
  };

  // Pedidos del período (sin cancelados).
  const tok = await token(store);
  const idsEnvio = new Set(tiendas.map((t) => String(t.promotion_id || "")).filter(Boolean));
  const pedidos: Rec[] = [];
  for (let page = 1; page <= 15; page++) {
    // Pedidos por la v1, como tn-odoo-cargar (la 2025-03 devuelve la lista vacía con estos filtros).
    const p = await tnGet(store, tok, `/orders?per_page=200&page=${page}&created_at_min=${desde.slice(0, 10)}T00:00:00-03:00&sort_by=created_at-descending&fields=id,number,created_at,status,payment_status,subtotal,total,shipping_cost_customer,promotional_discount,shipping_address`, "v1");
    if (!Array.isArray(p) || !p.length) break;
    pedidos.push(...p);
    if (p.length < 200) break;
  }
  const vivos = pedidos.filter((o) => o.status !== "cancelled");
  const bonifDe = (o: Rec) => Math.round(((o.promotional_discount?.promotions_applied || []) as Rec[])
    .filter((x) => idsEnvio.has(String(x.promotion_id || "")) || /^env[ií]o con descuento$/i.test(String(x.promotion_name || "").trim()))
    .reduce((a, x) => a + (num(x.total_discount_amount) || 0), 0) * 100) / 100;
  const pagados = vivos.filter((o) => o.payment_status === "paid");
  const lista = vivos.map((o) => ({ numero: o.number, fecha: o.created_at, pago: o.payment_status, subtotal: num(o.subtotal), envio: num(o.shipping_cost_customer), bonificacion: bonifDe(o), total: num(o.total) }))
    .filter((o) => o.bonificacion > 0).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const pagadosBonif = lista.filter((o) => o.pago === "paid");
  // Del pedido solo se usan CP y provincia de entrega (nada personal sale de acá).
  for (const o of pagados) {
    const cp = o.shipping_address?.zipcode, p = provDe(cp), f = fila(p); f.pagados++;
    if (enRango(num(o.subtotal))) f.pagados_en_rango++;
    if (bonifDe(o) > 0) f.pagados_bonificados++;
    const cx = cpPartes(cp); if (cx && !p) { const s = sinProv.get(cx.cp) || { cp: cx.cp, veces: 0, sugerida: "" }; s.veces++; s.sugerida ||= letraDeNombre(o.shipping_address?.province); sinProv.set(cx.cp, s); }
  }
  return {
    dias, desde, reglas, provincias: PROVINCIAS,
    por_provincia: Object.values(porProv).sort((a, b) => (b.pagados + b.bolsas) - (a.pagados + a.bolsas)),
    sin_provincia: [...sinProv.values()].sort((a, b) => b.veces - a.veces).slice(0, 60),
    bolsas: bolsasOut,
    pedidos: {
      vistos: pedidos.length,
      pagados: pagados.length,
      pagados_en_rango: pagados.filter((o) => enRango(num(o.subtotal))).length,
      con_bonificacion: pagadosBonif.length,
      bonificado: Math.round(pagadosBonif.reduce((a, o) => a + o.bonificacion, 0)),
      ventas_con_bonificacion: Math.round(pagadosBonif.reduce((a, o) => a + (o.total || 0), 0)),
      lista: lista.slice(0, 100),
    },
  };
}

// Link al checkout real de una bolsa de prueba, para ver el descuento ahí (no se paga nada).
async function checkout(store: number, bolsa: string) {
  if (!/^cart_[A-Za-z0-9_-]+$/.test(bolsa || "")) throw new Error("Bolsa inválida");
  const r = await fetch(`https://storefront-api.tiendanube.com/unstable/stores/${store}/carts/${bolsa}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.checkout_url) throw new Error("La tienda no devolvió el checkout (" + r.status + ")");
  return { checkout_url: j.checkout_url };
}

_servirConGuardia(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = req.method === "POST" ? await req.json() : Object.fromEntries(new URL(req.url).searchParams);
    if (body.accion === "publicar_descuentos") return new Response(JSON.stringify({ ok: true, ...(await publicarDescuentos()) }), { headers: cors });
    const store = Number(body.store || 385079);
    if (!TIENDAS[store]) throw new Error("Tienda no habilitada en este módulo: " + store);
    let out: Rec;
    if (body.accion === "productos") out = await productos(store);
    else if (body.accion === "cotizar") out = await cotizar(store, body);
    else if (body.accion === "checkout") out = await checkout(store, String(body.bolsa || ""));
    else if (body.accion === "promos") out = await mcpLlamar(store, "get_free_shipping_promotions", {});
    else if (body.accion === "resultados") out = await resultados(store, Number(body.dias || 30));
    else throw new Error("Acción desconocida");
    return new Response(JSON.stringify({ ok: true, tienda: TIENDAS[store].nombre, store, ...out }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 200, headers: cors });
  }
});
