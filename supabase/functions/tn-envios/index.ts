// tn-envios — Core → Tienda Nube → Envíos y descuentos.
//   accion "productos": productos y variantes con peso y medidas (+ categorías) de la tienda.
//   accion "cotizar":   arma una bolsa de prueba en la Storefront API, pide las tarifas reales
//                       (el mismo calculador del checkout) y aplica las reglas de descuento de envío.
//   accion "promos":    promociones de envío gratis activas.
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
async function tnGet(store: number, tok: string, path: string): Promise<any> {
  for (let intento = 0; intento < 4; intento++) {
    const r = await fetch(`https://api.tiendanube.com/2025-03/${store}${path}`, { headers: { Authentication: `bearer ${tok}`, "User-Agent": UA, Accept: "application/json" } });
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
  const subtotal = Number(carro.cost?.total ?? carro.cost?.subtotal ?? 0);
  const { data: reglas } = await (async () => {
    const r = await fetch(`${SB_URL}/rest/v1/tn_envio_reglas?store_id=eq.${store}&select=*`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
    return { data: r.ok ? await r.json() : [] };
  })();
  const carrito = { unidades, unidades_por_categoria: porCat, subtotal };
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
    const d = evaluarReglas((reglas as Rec[]).filter((r) => r.activa || body.incluir_borradores !== false), carrito, o);
    return { ...o, descuento: d, precio_cliente: d ? Math.round((o.precio - d.descuento) * 100) / 100 : o.precio };
  }).sort((a, b) => a.precio - b.precio);
  return { carrito, opciones, avisos, bolsa: c.id };
}

// Publica la configuración del callback tn-descuentos (tiendas, reglas, bolsas de prueba) en el archivo
// público tn-publico/tn-descuentos.json. El callback lo lee por la CDN (cerca de Tienda Nube) en vez de
// ir a la base en us-west-2 en cada consulta. Lo disparan los triggers de las tres tablas.
async function publicarDescuentos() {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_descuentos_datos`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("datos " + r.status);
  const datos = { ...(await r.json()), publicado: new Date().toISOString() };
  const up = await fetch(`${SB_URL}/storage/v1/object/tn-publico/tn-descuentos.json`, { method: "POST",
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", "x-upsert": "true", "cache-control": "max-age=20" },
    body: JSON.stringify(datos) });
  if (!up.ok) throw new Error("subida " + up.status + ": " + (await up.text()).slice(0, 200));
  return { publicado: datos.publicado, reglas: datos.reglas.length, prueba: datos.prueba.length };
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
    else throw new Error("Acción desconocida");
    return new Response(JSON.stringify({ ok: true, tienda: TIENDAS[store].nombre, store, ...out }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 200, headers: cors });
  }
});
