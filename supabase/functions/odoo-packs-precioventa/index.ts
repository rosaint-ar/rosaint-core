import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-packs-precioventa (v7, 06-10-2026) ======
// v7: modos de solo lectura { ventas_producto }, { bom }, { producciones } y { crear_granel } (granel nuevo + lista de materiales).
// Funcion unica de "precios a canales" (el proyecto llego al tope de funciones del plan).
// v6: modo { tienda_nube: "ensayo"|"aplicar" } que alinea los precios de Tienda Nube con el Core.
// v5: modos { lista5 } y { combos } para Odoo.  v4: contexto solo company 2 y packs en Lista 2.
// Modos (todos en ensayo salvo dry_run:false / "aplicar"):
// 1) default { dry_run }: Odoo packs x4 -> list_price y regla Lista 2 (32) = v_lista_publica.prof_base.
// 2) { inspeccionar: [codigos] }: Odoo, solo lectura, variantes/templates/reglas por codigo.
// 3) { lista5: true, dry_run }: Odoo Lista 5 Tienda Online (56) = CEIL(L1*factor TN, redondeo) * (1 - promo TN del SKU).
// 4) { combos: {codigo: precio}, dry_run }: Odoo, list_price + recargo por variante de los combos.
// 5) { tienda_nube: "ensayo"|"aplicar" }: Tienda Nube. Suelto: price = CEIL(L1*factor, redondeo),
//    promotional_price = price*(1-promo). Combo (combos_canal): price = suma de sueltos TN,
//    promotional_price = price*(1-descuento_pct). "aplicar" no pide clave: solo puede dejar TN igual
//    a lo que calcula el Core (idempotente). Cada escritura queda en precios_canal_bitacora.
// 6) { prolijar: true, dry_run }: fix puntual ago-2026 (13312/10304 y duplicados -VIEJO).

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CTX = { allowed_company_ids: [2] };
const LISTA_PUBLICO = 53, LISTA_PROF = 32, LISTA_ONLINE = 56;
type Rec = Record<string, any>;

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<any> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> { if (_uid) return _uid; _uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); return _uid!; }
async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<any> {
  const uid = await auth(); kwargs.context = { ...CTX, ...((kwargs.context as any) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}
async function corePrecios(codes: string[]): Promise<Record<string, { l1: number | null; l2: number | null }>> {
  const out: Record<string, { l1: number | null; l2: number | null }> = {};
  for (const c of codes) out[c] = { l1: null, l2: null };
  const lista = codes.map((c) => `"${c}"`).join(",");
  const h = { apikey: SRK, Authorization: `Bearer ${SRK}` };
  const r1 = await fetch(`${SB_URL}/rest/v1/items_lista_precio?select=codigo_vendible,precio_publicado,precio_iva_incl,listas_precios!inner(tipo_lista,estado)&listas_precios.tipo_lista=eq.publico&listas_precios.estado=eq.vigente&codigo_vendible=in.(${lista})`, { headers: h });
  for (const row of await r1.json()) out[row.codigo_vendible].l1 = Number(row.precio_publicado ?? row.precio_iva_incl);
  const r2 = await fetch(`${SB_URL}/rest/v1/items_lista_precio?select=codigo_vendible,precio_publicado,precio_iva_incl,listas_precios!inner(es_base_descuentos,estado)&listas_precios.es_base_descuentos=is.true&listas_precios.estado=eq.vigente&codigo_vendible=in.(${lista})`, { headers: h });
  for (const row of await r2.json()) out[row.codigo_vendible].l2 = Number(row.precio_publicado ?? row.precio_iva_incl);
  return out;
}

// ---------- Tienda Nube ----------
const STORE = 385079;
const UA = "Rosaint Core (rosaint.ar@gmail.com)";
const sbH = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };
async function tnSbGet(path: string): Promise<Rec[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
  if (!r.ok) throw new Error(`Core ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function sbRpc(fn: string, args: Rec): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbH, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`Core rpc ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function sbInsert(table: string, rows: Rec[]) {
  if (!rows.length) return;
  await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const igual = (a: number | null, b: number | null) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 0.005);

async function tn(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  for (let intento = 0; intento < 5; intento++) {
    const r = await fetch(`https://api.tiendanube.com/v1/${STORE}${path}`, {
      method,
      headers: { Authentication: `bearer ${token}`, "User-Agent": UA, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { await sleep(1500 * (intento + 1)); continue; }
    const txt = await r.text();
    let data: any = txt; try { data = JSON.parse(txt); } catch { /* texto */ }
    return { status: r.status, data };
  }
  return { status: 429, data: "Tienda Nube limito los pedidos (429) despues de 5 intentos" };
}

async function leerTienda(token: string): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await tn(token, "GET", `/products?per_page=200&page=${page}&fields=id,name,published,variants`);
    if (r.status === 404) break; // TN devuelve 404 cuando la pagina no existe
    if (r.status !== 200) throw new Error(`Tienda Nube ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    for (const p of r.data) for (const v of p.variants || []) {
      out.push({ product_id: p.id, variant_id: v.id, nombre: p.name?.es || "", publicado: p.published, sku: String(v.sku || ""),
        price: num(v.price), promo: num(v.promotional_price) });
    }
    if (r.data.length < 200) break;
  }
  return out;
}

async function calcular(token: string) {
  const canal = (await tnSbGet("canales_venta?select=id,factor_lista,redondeo&nombre=eq.Tienda%20Nube"))[0];
  if (!canal) throw new Error("No encontre el canal Tienda Nube en el Core");
  const factor = Number(canal.factor_lista), red = Number(canal.redondeo) || 100;
  const l1 = await tnSbGet("items_lista_precio?select=codigo_vendible,precio_iva_incl,listas_precios!inner(tipo_lista,estado)&listas_precios.tipo_lista=eq.publico&listas_precios.estado=eq.vigente");
  const promos = await tnSbGet(`canal_descuento_sku?select=codigo_sku,descuento_promoc_pct&canal_id=eq.${canal.id}`);
  const combos = await tnSbGet("combos_canal?select=codigo,componentes,descuento_pct&activo=eq.true");
  const pct: Record<string, number> = {}; for (const p of promos) pct[p.codigo_sku] = Number(p.descuento_promoc_pct) || 0;
  const lista: Record<string, number> = {};
  for (const r of l1) if (r.precio_iva_incl != null) lista[r.codigo_vendible] = Math.ceil(Number(r.precio_iva_incl) * factor / red) * red;
  const objetivo: Record<string, { price: number; promo: number | null; tipo: string }> = {};
  for (const [cod, price] of Object.entries(lista)) {
    const d = pct[cod] || 0;
    objetivo[cod] = { price, promo: d > 0 ? Math.round(price * (1 - d / 100) * 100) / 100 : null, tipo: "producto" };
  }
  const combosSinPrecio: string[] = [];
  for (const c of combos) {
    const partes = (c.componentes as string[]).map((s) => lista[s]);
    if (partes.some((x) => x == null)) { combosSinPrecio.push(c.codigo); continue; }
    const price = partes.reduce((a, b) => a + b, 0);
    objetivo[c.codigo] = { price, promo: Math.round(price * (1 - Number(c.descuento_pct) / 100) * 100) / 100, tipo: "combo" };
  }
  const tienda = await leerTienda(token);
  const filas: Rec[] = []; const sinCore: Rec[] = [];
  for (const v of tienda) {
    const o = objetivo[v.sku];
    if (!o) { sinCore.push({ sku: v.sku, nombre: v.nombre }); continue; }
    const cambia = !igual(v.price, o.price) || !igual(v.promo, o.promo);
    filas.push({ ...v, tipo: o.tipo, price_nuevo: o.price, promo_nuevo: o.promo, cambia });
  }
  filas.sort((a, b) => a.sku.localeCompare(b.sku));
  return { factor, redondeo: red, filas, sinCore, combosSinPrecio };
}


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
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
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));

    // ---- Modo tienda_nube: { tienda_nube: "ensayo" | "aplicar" } ----
    if (body.tienda_nube) {
      const modo = body.tienda_nube === "aplicar" ? "aplicar" : "ensayo";
      const token = await sbRpc("tn_token_interno", { p_store: STORE });
      if (!token) throw new Error("No hay acceso guardado para la tienda");
      const plan = await calcular(token);
      const aCambiar = plan.filas.filter((f) => f.cambia);
      const resumen = { variantes: plan.filas.length, a_cambiar: aCambiar.length, sin_precio_en_core: plan.sinCore.length };
      if (modo === "ensayo") {
        return new Response(JSON.stringify({ ok: true, modo, ...plan, resumen }), { headers: cors });
      }
      const resultados: Rec[] = []; const bit: Rec[] = [];
      for (const f of aCambiar) {
        const cuerpo: Rec = { price: String(f.price_nuevo) };
        if (f.promo_nuevo !== null) cuerpo.promotional_price = String(f.promo_nuevo);
        else if (f.promo !== null) cuerpo.promotional_price = null; // sacar una promo que el Core ya no tiene
        const r = await tn(token, "PUT", `/products/${f.product_id}/variants/${f.variant_id}`, cuerpo);
        const ok = r.status >= 200 && r.status < 300;
        resultados.push({ sku: f.sku, ok, status: r.status });
        bit.push({ canal: "tienda_nube", codigo: f.sku, precio_antes: f.price, promo_antes: f.promo, precio_nuevo: f.price_nuevo, promo_nuevo: f.promo_nuevo, ok,
          detalle: ok ? null : `${r.status} ${JSON.stringify(r.data).slice(0, 300)}` });
        await sleep(350); // TN admite ~2 pedidos por segundo sostenidos
      }
      await sbInsert("precios_canal_bitacora", bit);
      const verif = await calcular(token); // releer la tienda y comparar de nuevo
      const pendientes = verif.filas.filter((f) => f.cambia).map((f) => ({ sku: f.sku, price: f.price, promo: f.promo, price_nuevo: f.price_nuevo, promo_nuevo: f.promo_nuevo }));
      return new Response(JSON.stringify({ ok: pendientes.length === 0, modo, resumen, escritos: resultados.filter((r) => r.ok).length,
        errores: resultados.filter((r) => !r.ok), verificacion: { variantes: verif.filas.length, distintas: pendientes.length, pendientes } }), { headers: cors });
    }

    // ---- Modo ventas_producto (solo lectura): renglones de pedidos de venta de un código ----
    if (body.ventas_producto) {
      const cod = String(body.ventas_producto);
      const vars = await call("product.product", "search_read", [[["default_code", "=", cod]], ["id"]], { context: { active_test: false } });
      const ids = vars.map((v: any) => v.id);
      const lineas = ids.length ? await call("sale.order.line", "search_read",
        [[["product_id", "in", ids], ["company_id", "=", 2]], ["order_id", "order_partner_id", "state", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "price_total", "create_date"]],
        { order: "create_date desc", limit: 50 }) : [];
      const ordIds = [...new Set(lineas.map((l: any) => l.order_id[0]))];
      const ords = ordIds.length ? await call("sale.order", "read", [ordIds, ["name", "date_order", "pricelist_id", "amount_untaxed", "amount_total", "state"]]) : [];
      const facturas = ids.length ? await call("account.move.line", "search_read",
        [[["product_id", "in", ids], ["company_id", "=", 2], ["move_id.move_type", "in", ["out_invoice", "out_refund"]], ["display_type", "=", "product"]],
         ["move_id", "partner_id", "date", "parent_state", "quantity", "price_unit", "discount", "price_subtotal", "price_total", "sale_line_ids"]],
        { order: "date desc", limit: 50 }) : [];
      // Todos los renglones de esas facturas (descuentos cargados aparte, envíos, otros productos)
      const movIds = [...new Set(facturas.map((f: any) => f.move_id[0]))];
      const renglones_factura = movIds.length ? await call("account.move.line", "search_read",
        [[["move_id", "in", movIds], ["display_type", "in", ["product", "line_note"]]], ["move_id", "product_id", "name", "quantity", "price_unit", "discount", "price_subtotal", "price_total"]]) : [];
      return new Response(JSON.stringify({ ok: true, codigo: cod, lineas, pedidos: ords, facturas, renglones_factura }, null, 2), { headers: cors });
    }

    // ---- Modo bom (solo lectura): listas de materiales de Odoo, abiertas hasta 3 niveles ----
    // { bom: [codigos] } o { bom_buscar: "texto" } (busca listas por nombre de producto o referencia)
    if (Array.isArray(body.bom) || body.bom_buscar) {
      const campos = ["id", "code", "product_tmpl_id", "product_id", "product_qty", "product_uom_id", "type", "active", "bom_line_ids"];
      let boms: any[] = [];
      if (body.bom_buscar) {
        const t = String(body.bom_buscar);
        boms = await call("mrp.bom", "search_read", [["|", "|", ["product_tmpl_id.name", "ilike", t], ["code", "ilike", t], ["product_tmpl_id.default_code", "ilike", t]], campos], { context: { active_test: false } });
      } else {
        const tmpl = await call("product.product", "search_read", [[["default_code", "in", body.bom.map(String)]], ["product_tmpl_id"]], { context: { active_test: false } });
        const tids = [...new Set(tmpl.map((v: any) => v.product_tmpl_id[0]))];
        boms = tids.length ? await call("mrp.bom", "search_read", [[["product_tmpl_id", "in", tids]], campos], { context: { active_test: false } }) : [];
      }
      const abrir = async (bom: any, nivel: number): Promise<any> => {
        const ls = bom.bom_line_ids.length ? await call("mrp.bom.line", "read", [bom.bom_line_ids, ["product_id", "product_qty", "product_uom_id"]]) : [];
        const pids = ls.map((l: any) => l.product_id[0]);
        const prods = pids.length ? await call("product.product", "read", [pids, ["default_code", "name", "standard_price", "uom_id", "product_tmpl_id"]], { context: { active_test: false } }) : [];
        const lineas: any[] = [];
        for (const l of ls) {
          const p = prods.find((x: any) => x.id === l.product_id[0]) || {};
          const fila: any = { codigo: p.default_code, nombre: p.name, cantidad: l.product_qty, unidad: l.product_uom_id?.[1], costo_unit: p.standard_price, unidad_costo: p.uom_id?.[1] };
          if (nivel < 3 && p.product_tmpl_id) {
            const sub = await call("mrp.bom", "search_read", [[["product_tmpl_id", "=", p.product_tmpl_id[0]]], campos], { limit: 1 });
            if (sub.length) fila.sub = await abrir(sub[0], nivel + 1);
          }
          lineas.push(fila);
        }
        return { bom_id: bom.id, ref: bom.code, producto: bom.product_tmpl_id?.[1], rinde: bom.product_qty, unidad: bom.product_uom_id?.[1], tipo: bom.type, activa: bom.active, lineas };
      };
      const out = [];
      for (const b of boms.slice(0, 15)) out.push(await abrir(b, 1));
      return new Response(JSON.stringify({ ok: true, listas: out }, null, 2), { headers: cors });
    }

    // ---- Modo crear_granel: granel nuevo copiando otro + su lista de materiales, y lo pone en la lista de un SKU ----
    // { crear_granel: { codigo, nombre, copiar_de, lineas: [{codigo, kg}], usar_en: "SKU", reemplaza: "granel viejo" }, dry_run }
    if (body.crear_granel) {
      const g = body.crear_granel; const dry = body.dry_run !== false; const pasos: any[] = [];
      const buscar = async (cod: string) => (await call("product.product", "search_read", [[["default_code", "=", cod]], ["id", "product_tmpl_id", "uom_id", "name"]], { context: { active_test: false } }))[0];
      const yaCreado = await buscar(g.codigo); // si una corrida anterior lo creó y falló después, se retoma
      if (yaCreado && (await call("mrp.bom", "search_count", [[["product_tmpl_id", "=", yaCreado.product_tmpl_id[0]]]]))) throw new Error(`Ya existe ${g.codigo} en Odoo y tiene lista de materiales`);
      const base = await buscar(g.copiar_de); if (!base) throw new Error(`No encontré ${g.copiar_de}`);
      const comps: any[] = [];
      for (const l of g.lineas) { const p = await buscar(l.codigo); if (!p) throw new Error(`No encontré el componente ${l.codigo}`); comps.push({ ...l, id: p.id, uom: p.uom_id[0], nombre: p.name }); }
      const total = comps.reduce((a, c) => a + Number(c.kg), 0);
      if (Math.abs(total - 1) > 0.0005) throw new Error(`Las cantidades suman ${total} kg, deben sumar 1 kg`);
      const sku = await buscar(g.usar_en); if (!sku) throw new Error(`No encontré ${g.usar_en}`);
      const bomSku = (await call("mrp.bom", "search_read", [[["product_tmpl_id", "=", sku.product_tmpl_id[0]]], ["id", "bom_line_ids"]]))[0];
      if (!bomSku) throw new Error(`${g.usar_en} no tiene lista de materiales`);
      const viejo = await buscar(g.reemplaza);
      const lineasSku = await call("mrp.bom.line", "read", [bomSku.bom_line_ids, ["product_id", "product_qty"]]);
      const lineaVieja = lineasSku.find((l: any) => l.product_id[0] === viejo?.id);
      if (!lineaVieja) throw new Error(`La lista de ${g.usar_en} no usa ${g.reemplaza}`);
      pasos.push({ paso: "crear producto", codigo: g.codigo, nombre: g.nombre, copia_de: `${g.copiar_de} (categoría, unidad, rutas)` });
      pasos.push({ paso: "crear lista de materiales (1 kg)", lineas: comps.map((c) => ({ codigo: c.codigo, nombre: c.nombre, kg: c.kg })) });
      pasos.push({ paso: `en la lista de ${g.usar_en}`, cambia: `${g.reemplaza} → ${g.codigo}`, kg: lineaVieja.product_qty });
      if (dry) return new Response(JSON.stringify({ ok: true, dry_run: true, pasos }, null, 2), { headers: cors });
      let nuevoTmpl = yaCreado ? yaCreado.product_tmpl_id[0] : await call("product.template", "copy", [base.product_tmpl_id[0], { name: g.nombre, default_code: g.codigo }]);
      if (Array.isArray(nuevoTmpl)) nuevoTmpl = nuevoTmpl[0]; // Odoo 17+ devuelve una lista
      const [nuevoVar] = await call("product.product", "search_read", [[["product_tmpl_id", "=", nuevoTmpl]], ["id"]]);
      const bomId = await call("mrp.bom", "create", [{ product_tmpl_id: nuevoTmpl, product_qty: 1, product_uom_id: base.uom_id[0], type: "normal",
        bom_line_ids: comps.map((c) => [0, 0, { product_id: c.id, product_qty: Number(c.kg), product_uom_id: c.uom }]) }]);
      await call("mrp.bom.line", "write", [[lineaVieja.id], { product_id: nuevoVar.id }]);
      const verif = await call("mrp.bom.line", "read", [bomSku.bom_line_ids, ["product_id", "product_qty"]]);
      return new Response(JSON.stringify({ ok: true, dry_run: false, producto_tmpl: nuevoTmpl, bom: bomId, lista_sku: verif.map((l: any) => ({ producto: l.product_id[1], qty: l.product_qty })) }, null, 2), { headers: cors });
    }

    // ---- Modo renombrar: cambia código y nombre de un producto (template) ----
    // { renombrar: { de, a, nombre }, dry_run }
    if (body.renombrar) {
      const r = body.renombrar; const dry = body.dry_run !== false;
      const [v] = await call("product.product", "search_read", [[["default_code", "=", String(r.de)]], ["product_tmpl_id", "display_name"]], { context: { active_test: false } });
      if (!v) throw new Error(`No encontré ${r.de} en Odoo`);
      const choca = await call("product.product", "search_count", [[["default_code", "=", String(r.a)]]], { context: { active_test: false } });
      if (choca) throw new Error(`Ya existe ${r.a} en Odoo`);
      if (!dry) await call("product.template", "write", [[v.product_tmpl_id[0]], { default_code: String(r.a), ...(r.nombre ? { name: String(r.nombre) } : {}) }]);
      const [t] = await call("product.template", "read", [[v.product_tmpl_id[0]], ["default_code", "name"]]);
      return new Response(JSON.stringify({ ok: true, dry_run: dry, antes: v.display_name, ahora: t }, null, 2), { headers: cors });
    }

    // ---- Modo costo_desde_bom: "Calcular costo desde lista de materiales" de Odoo, en orden ----
    // { costo_desde_bom: [codigos], dry_run }
    if (Array.isArray(body.costo_desde_bom)) {
      const dry = body.dry_run !== false; const out: any[] = [];
      for (const cod of body.costo_desde_bom.map(String)) {
        const [v] = await call("product.product", "search_read", [[["default_code", "=", cod]], ["id", "product_tmpl_id", "standard_price"]]);
        if (!v) { out.push({ codigo: cod, error: "no está en Odoo" }); continue; }
        if (!dry) await call("product.product", "button_bom_cost", [[v.id]]);
        const [d] = await call("product.product", "read", [[v.id], ["standard_price"]]);
        out.push({ codigo: cod, antes: v.standard_price, ahora: d.standard_price });
      }
      return new Response(JSON.stringify({ ok: true, dry_run: dry, costos: out }, null, 2), { headers: cors });
    }

    // ---- Modo categorias (solo lectura): configuración contable de las categorías de producto ----
    if (body.categorias) {
      const campos = ["id", "complete_name", "property_valuation", "property_cost_method", "property_account_expense_categ_id", "property_account_income_categ_id",
        "property_stock_valuation_account_id", "property_stock_account_input_categ_id", "property_stock_account_output_categ_id", "property_stock_account_production_cost_id"];
      let cats: any[];
      try { cats = await call("product.category", "search_read", [[], campos]); }
      catch { cats = await call("product.category", "search_read", [[], campos.filter((c) => c !== "property_stock_account_production_cost_id")]); }
      for (const c of cats) c.productos = await call("product.template", "search_count", [[["categ_id", "=", c.id]]]);
      return new Response(JSON.stringify({ ok: true, categorias: cats }, null, 2), { headers: cors });
    }

    // ---- Modo fijar_costo: { fijar_costo: {codigo: costo}, dry_run } ----
    // Solo productos de categorías SIN valuación automática (manual_periodic): ahí cambiar el costo no genera asientos.
    if (body.fijar_costo && typeof body.fijar_costo === "object") {
      const dry = body.dry_run !== false; const out: any[] = [];
      for (const [cod, valor] of Object.entries(body.fijar_costo)) {
        const [v] = await call("product.product", "search_read", [[["default_code", "=", cod]], ["id", "standard_price", "categ_id"]]);
        if (!v) { out.push({ codigo: cod, error: "no está en Odoo" }); continue; }
        const [c] = await call("product.category", "read", [[v.categ_id[0]], ["property_valuation"]]);
        if (c.property_valuation !== "manual_periodic") { out.push({ codigo: cod, error: `categoría ${v.categ_id[1]} con valuación automática: no se toca` }); continue; }
        if (!dry) await call("product.product", "write", [[v.id], { standard_price: Number(valor) }]);
        const [d] = await call("product.product", "read", [[v.id], ["standard_price"]]);
        out.push({ codigo: cod, categoria: v.categ_id[1], antes: v.standard_price, ahora: d.standard_price });
      }
      return new Response(JSON.stringify({ ok: out.every((o) => !o.error), dry_run: dry, costos: out }, null, 2), { headers: cors });
    }

    // ---- Modo vincular_nc: marca a qué factura de proveedor corrige una NC cargada suelta ----
    // { vincular_nc: { nc: "NC-A 00002-00000369", factura: "FA-A 00002-00007607" }, dry_run }
    // Solo escribe reversed_entry_id en la NC: no toca importes, asientos, stock ni el pedido de compra.
    if (body.vincular_nc && typeof body.vincular_nc === "object") {
      const dry = body.dry_run !== false;
      const { nc, factura } = body.vincular_nc as { nc: string; factura: string };
      const campos = ["id", "name", "move_type", "state", "partner_id", "invoice_date", "amount_untaxed", "reversed_entry_id"];
      const [n] = await call("account.move", "search_read", [[["name", "=", String(nc)]], campos]);
      const [f] = await call("account.move", "search_read", [[["name", "=", String(factura)]], campos]);
      if (!n || !f) throw new Error(`No encontré ${!n ? nc : factura}`);
      if (n.move_type !== "in_refund" || f.move_type !== "in_invoice") throw new Error("La NC tiene que ser NC de proveedor y la factura, factura de proveedor");
      if (n.partner_id?.[0] !== f.partner_id?.[0]) throw new Error("La NC y la factura son de proveedores distintos");
      if (n.reversed_entry_id && n.reversed_entry_id[0] !== f.id) throw new Error(`La NC ya está vinculada a ${n.reversed_entry_id[1]}`);
      if (!dry) await call("account.move", "write", [[n.id], { reversed_entry_id: f.id }]);
      const [d] = await call("account.move", "read", [[n.id], campos]);
      return new Response(JSON.stringify({ ok: true, dry_run: dry, factura: f, nc_antes: n, nc_ahora: d }, null, 2), { headers: cors });
    }

    // ---- Modo cambiar_componente: en UNA orden de fabricación no terminada, cambia un componente por otro ----
    // { cambiar_componente: { orden: "WH/MO/xxxxx", de: "cod", a: "cod" }, dry_run }
    if (body.cambiar_componente) {
      const r = body.cambiar_componente; const dry = body.dry_run !== false;
      const [mo] = await call("mrp.production", "search_read", [[["name", "=", String(r.orden)]], ["id", "state", "product_id", "move_raw_ids"]]);
      if (!mo) throw new Error(`No encontré la orden ${r.orden}`);
      if (["done", "cancel"].includes(mo.state)) throw new Error(`La orden está ${mo.state}: no se toca`);
      const buscar = async (cod: string) => (await call("product.product", "search_read", [[["default_code", "=", cod]], ["id", "uom_id"]]))[0];
      const de = await buscar(String(r.de)), a = await buscar(String(r.a));
      if (!de || !a) throw new Error("No encontré alguno de los productos");
      const movs = await call("stock.move", "read", [mo.move_raw_ids, ["id", "product_id", "product_uom_qty", "quantity", "state", "product_uom"]]);
      const m = movs.find((x: any) => x.product_id[0] === de.id);
      if (!m) throw new Error(`La orden no usa ${r.de}`);
      if (m.quantity) throw new Error(`El componente ya tiene ${m.quantity} reservado/consumido: revisar a mano`);
      const plan = { orden: r.orden, estado: mo.state, cambia: `${r.de} → ${r.a}`, cantidad: m.product_uom_qty, unidad: m.product_uom[1] };
      if (dry) return new Response(JSON.stringify({ ok: true, dry_run: true, plan }, null, 2), { headers: cors });
      await call("mrp.production", "write", [[mo.id], { move_raw_ids: [[1, m.id, { product_id: a.id, product_uom: a.uom_id[0] }]] }]);
      try { await call("mrp.production", "action_assign", [[mo.id]]); } catch (_e) { /* si no hay stock queda sin reservar */ }
      const despues = await call("stock.move", "read", [(await call("mrp.production", "read", [[mo.id], ["move_raw_ids"]]))[0].move_raw_ids, ["product_id", "product_uom_qty", "quantity", "state"]]);
      const [mo2] = await call("mrp.production", "read", [[mo.id], ["state", "components_availability"]]);
      return new Response(JSON.stringify({ ok: true, dry_run: false, plan, orden: mo2, componentes: despues.map((x: any) => ({ producto: x.product_id[1], pedido: x.product_uom_qty, reservado: x.quantity, estado: x.state })) }, null, 2), { headers: cors });
    }

    // ---- Modo conteo (solo lectura): quants con cantidad contada cargada (Inventario físico) ----
    if (body.conteo) {
      const qs = await call("stock.quant", "search_read", [[["inventory_quantity_set", "=", true], ["company_id", "=", 2]],
        ["id", "product_id", "location_id", "lot_id", "quantity", "inventory_quantity", "inventory_diff_quantity", "inventory_date", "user_id", "write_date"]], { order: "product_id" });
      const pids = [...new Set(qs.map((q: any) => q.product_id[0]))];
      const prods = pids.length ? await call("product.product", "read", [pids, ["default_code", "standard_price", "uom_id"]], { context: { active_test: false } }) : [];
      for (const q of qs) { const p = prods.find((x: any) => x.id === q.product_id[0]); q.codigo = p?.default_code; q.costo = p?.standard_price; q.unidad = p?.uom_id?.[1]; }
      return new Response(JSON.stringify({ ok: true, quants: qs }, null, 2), { headers: cors });
    }

    // ---- Modo ajuste_inventario: { ajuste_inventario: {codigo: cantidad_final}, dry_run } ----
    // Productos con lote: faltante = se descuenta de los lotes más viejos primero; sobrante = se suma al lote más nuevo.
    // Se aplica como ajuste de inventario de Odoo (stock.quant.action_apply_inventory).
    if (body.ajuste_inventario && typeof body.ajuste_inventario === "object") {
      const dry = body.dry_run !== false; const out: any[] = [];
      const r4 = (x: number) => Math.round(x * 10000) / 10000;
      for (const [cod, finalQ] of Object.entries(body.ajuste_inventario)) {
        const [p] = await call("product.product", "search_read", [[["default_code", "=", cod]], ["id", "tracking", "uom_id", "standard_price"]]);
        if (!p) { out.push({ codigo: cod, error: "no está en Odoo" }); continue; }
        const qs = await call("stock.quant", "search_read", [[["product_id", "=", p.id], ["location_id.usage", "=", "internal"], ["company_id", "=", 2], ["quantity", "!=", 0]],
          ["id", "location_id", "lot_id", "quantity", "in_date"]], { order: "in_date asc, id asc" });
        const total = r4(qs.reduce((a: number, q: any) => a + q.quantity, 0));
        const dif = r4(Number(finalQ) - total);
        const mov: { qid: number; lote: string; ubic: string; antes: number; despues: number }[] = [];
        if (dif < 0) { let falta = -dif;
          for (const q of qs) { if (falta <= 1e-9) break; if (q.quantity <= 0) continue; const saca = Math.min(q.quantity, falta);
            mov.push({ qid: q.id, lote: q.lot_id?.[1] || "-", ubic: q.location_id[1], antes: q.quantity, despues: r4(q.quantity - saca) }); falta = r4(falta - saca); }
          if (falta > 1e-9) { out.push({ codigo: cod, error: `no alcanza el stock por lote (faltan ${falta})` }); continue; }
        } else if (dif > 0) { const q = qs[qs.length - 1];
          if (!q) { out.push({ codigo: cod, error: "sin lote con stock donde sumar: hacerlo a mano" }); continue; }
          mov.push({ qid: q.id, lote: q.lot_id?.[1] || "-", ubic: q.location_id[1], antes: q.quantity, despues: r4(q.quantity + dif) }); }
        const fila: any = { codigo: cod, unidad: p.uom_id[1], stock_odoo: total, final: Number(finalQ), diferencia: dif, valor_dif: Math.round(dif * p.standard_price),
          lotes: qs.map((q: any) => `${q.lot_id?.[1] || "-"} (${q.location_id[1]}): ${q.quantity}`), cambios: mov.map((m) => `lote ${m.lote}: ${m.antes} → ${m.despues}`) };
        if (!dry) {
          for (const m of mov) { await call("stock.quant", "write", [[m.qid], { inventory_quantity: m.despues }]); await call("stock.quant", "action_apply_inventory", [[m.qid]]); }
          const [pp] = await call("product.product", "read", [[p.id], ["qty_available"]]); fila.stock_despues = pp.qty_available;
        }
        out.push(fila);
      }
      return new Response(JSON.stringify({ ok: out.every((o) => !o.error), dry_run: dry, ajustes: out }, null, 2), { headers: cors });
    }

    // ---- Modo producciones (solo lectura): órdenes de fabricación de unos códigos con lo consumido ----
    if (Array.isArray(body.producciones)) {
      const vars = await call("product.product", "search_read", [[["default_code", "in", body.producciones.map(String)]], ["id"]], { context: { active_test: false } });
      const ids = vars.map((v: any) => v.id);
      const ops = ids.length ? await call("mrp.production", "search_read",
        [[["product_id", "in", ids]], ["name", "origin", "product_id", "product_qty", "qty_produced", "state", "date_start", "bom_id", "move_raw_ids"]],
        { order: "date_start desc", limit: Number(body.limite) || 12 }) : [];
      for (const o of ops) {
        const mv = o.move_raw_ids.length ? await call("stock.move", "read", [o.move_raw_ids, ["product_id", "product_uom_qty", "quantity", "product_uom"]]) : [];
        o.consumos = mv.map((m: any) => ({ producto: m.product_id[1], previsto: m.product_uom_qty, real: m.quantity, unidad: m.product_uom?.[1] }));
        delete o.move_raw_ids;
      }
      return new Response(JSON.stringify({ ok: true, ordenes: ops }, null, 2), { headers: cors });
    }

    // ---- Modo inspeccionar (solo lectura) ----
    if (Array.isArray(body.inspeccionar) && body.inspeccionar.length) {
      const codes = body.inspeccionar.map(String);
      const vars = await call("product.product", "search_read",
        [[["default_code", "in", codes]], ["id", "default_code", "active", "product_tmpl_id", "lst_price", "price_extra", "display_name", "qty_available", "standard_price", "value_svl"]],
        { context: { active_test: false } });
      const tmplIds = [...new Set(vars.map((v: any) => v.product_tmpl_id[0]))];
      const tmpls = tmplIds.length ? await call("product.template", "read",
        [tmplIds, ["id", "name", "active", "list_price", "default_code", "categ_id", "sale_ok", "product_variant_count"]],
        { context: { active_test: false } }) : [];
      const varIds = vars.map((v: any) => v.id);
      const reglas = varIds.length ? await call("product.pricelist.item", "search_read",
        [["|", ["product_id", "in", varIds], ["product_tmpl_id", "in", tmplIds]],
         ["pricelist_id", "product_id", "product_tmpl_id", "fixed_price", "compute_price", "applied_on", "min_quantity"]],
        { context: { active_test: false } }) : [];
      return new Response(JSON.stringify({ ok: true, variantes: vars, templates: tmpls, reglas_tarifa: reglas }, null, 2), { headers: cors });
    }

    // ---- Modo lista5: Lista 5 Tienda Online (56) = CEIL(L1*1,2,100) * (1 - promo TN) ----
    if (body.lista5 === true) {
      const dry = body.dry_run !== false;
      const h = { apikey: SRK, Authorization: `Bearer ${SRK}` };
      const cv = await (await fetch(`${SB_URL}/rest/v1/canales_venta?select=id,factor_lista,redondeo&nombre=eq.Tienda%20Nube`, { headers: h })).json();
      if (!cv.length) throw new Error("No encontre el canal Tienda Nube en Core");
      const factor = Number(cv[0].factor_lista), red = Number(cv[0].redondeo) || 100, canalId = cv[0].id;
      const l1rows = await (await fetch(`${SB_URL}/rest/v1/items_lista_precio?select=codigo_vendible,precio_iva_incl,listas_precios!inner(tipo_lista,estado)&listas_precios.tipo_lista=eq.publico&listas_precios.estado=eq.vigente`, { headers: h })).json();
      const promos = await (await fetch(`${SB_URL}/rest/v1/canal_descuento_sku?select=codigo_sku,descuento_promoc_pct&canal_id=eq.${canalId}`, { headers: h })).json();
      const pct: Record<string, number> = {}; for (const p of promos) pct[p.codigo_sku] = Number(p.descuento_promoc_pct) || 0;
      const objetivo: Record<string, number> = {};
      for (const r of l1rows) if (r.precio_iva_incl != null) {
        const lista = Math.ceil(Number(r.precio_iva_incl) * factor / red) * red;
        objetivo[r.codigo_vendible] = Math.round(lista * (1 - (pct[r.codigo_vendible] || 0) / 100) * 100) / 100;
      }
      const reglas = await call("product.pricelist.item", "search_read",
        [[["pricelist_id", "=", LISTA_ONLINE], ["applied_on", "=", "1_product"]], ["id", "product_tmpl_id", "fixed_price"]]);
      const tmplIds = [...new Set(reglas.map((x: any) => x.product_tmpl_id[0]))];
      const tmpls = tmplIds.length ? await call("product.template", "read", [tmplIds, ["id", "default_code"]], { context: { active_test: false } }) : [];
      const codPorTmpl: Record<number, string> = {}; for (const t of tmpls) codPorTmpl[t.id] = String(t.default_code || "");
      const plan: any[] = []; const sinCore: string[] = [];
      for (const it of reglas) {
        const cod = codPorTmpl[it.product_tmpl_id[0]];
        const obj = objetivo[cod];
        if (obj == null) { sinCore.push(cod || String(it.product_tmpl_id[1])); continue; }
        const cambia = Math.abs(it.fixed_price - obj) > 0.005;
        if (cambia && !dry) await call("product.pricelist.item", "write", [[it.id], { fixed_price: obj }]);
        plan.push({ code: cod, antes: it.fixed_price, objetivo: obj, promo_pct: pct[cod] || 0, accion: cambia ? (dry ? "cambiaria" : "cambiado") : "ya OK" });
      }
      plan.sort((a, b) => a.code.localeCompare(b.code));
      let verif: any = null;
      if (!dry) {
        const r2 = await call("product.pricelist.item", "search_read", [[["pricelist_id", "=", LISTA_ONLINE], ["applied_on", "=", "1_product"]], ["product_tmpl_id", "fixed_price"]]);
        const mal = r2.filter((x: any) => { const o = objetivo[codPorTmpl[x.product_tmpl_id[0]]]; return o != null && Math.abs(x.fixed_price - o) > 0.005; });
        verif = { reglas: r2.length, distintas: mal.length };
      }
      return new Response(JSON.stringify({ ok: true, dry_run: dry, factor, redondeo: red, cambios: plan.filter(p => p.accion !== "ya OK").length, plan, reglas_sin_precio_core: sinCore, verificacion: verif }, null, 2), { headers: cors });
    }

    // ---- Modo combos: { combos: {codigo: precio_con_iva}, dry_run } ----
    // Precio de un combo con variantes = list_price del template + price_extra del valor de atributo.
    // Se pone list_price = el precio mas bajo entre sus variantes y el resto va como recargo.
    if (body.combos && typeof body.combos === "object") {
      const dry = body.dry_run !== false;
      const pedido: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.combos)) pedido[String(k)] = Number(v);
      const vars = await call("product.product", "search_read",
        [[["default_code", "in", Object.keys(pedido)], ["active", "=", true]], ["id", "default_code", "product_tmpl_id", "lst_price", "product_template_attribute_value_ids"]]);
      const porTmpl: Record<number, any[]> = {};
      for (const v of vars) (porTmpl[v.product_tmpl_id[0]] ||= []).push(v);
      const plan: any[] = []; const problemas: string[] = [];
      for (const [tidS, vs] of Object.entries(porTmpl)) {
        const tid = Number(tidS);
        const tmplVars = await call("product.product", "search_read", [[["product_tmpl_id", "=", tid], ["active", "=", true]], ["id", "default_code"]]);
        const faltan = tmplVars.filter((x: any) => pedido[x.default_code] == null).map((x: any) => x.default_code);
        if (faltan.length) { problemas.push(`Template ${tid}: faltan precios para ${faltan.join(",")}`); continue; }
        const base = Math.min(...vs.map((v: any) => pedido[v.default_code]));
        const [t] = await call("product.template", "read", [[tid], ["list_price", "name"]]);
        plan.push({ tmpl_id: tid, nombre: t.name, que: "list_price", antes: t.list_price, ahora: base });
        const extras: { ptav: number; extra: number; code: string }[] = [];
        let ok = true;
        for (const v of vs) {
          const ids = v.product_template_attribute_value_ids || [];
          const extra = Math.round((pedido[v.default_code] - base) * 100) / 100;
          if (ids.length > 1) { problemas.push(`${v.default_code}: tiene ${ids.length} atributos, no se ajusta solo`); ok = false; continue; }
          if (!ids.length) { if (extra !== 0) { problemas.push(`${v.default_code}: sin atributo y necesita recargo ${extra}`); ok = false; } continue; }
          extras.push({ ptav: ids[0], extra, code: v.default_code });
        }
        const ptavs = extras.length ? await call("product.template.attribute.value", "read", [extras.map(e => e.ptav), ["id", "name", "price_extra"]]) : [];
        for (const e of extras) {
          const p = ptavs.find((x: any) => x.id === e.ptav);
          plan.push({ tmpl_id: tid, code: e.code, que: `recargo "${p?.name}"`, antes: p?.price_extra, ahora: e.extra, precio_final: base + e.extra });
        }
        if (!dry && ok) {
          await call("product.template", "write", [[tid], { list_price: base }]);
          for (const e of extras) await call("product.template.attribute.value", "write", [[e.ptav], { price_extra: e.extra }]);
        }
      }
      let verif: any = null;
      if (!dry) {
        const v2 = await call("product.product", "search_read", [[["default_code", "in", Object.keys(pedido)], ["active", "=", true]], ["default_code", "lst_price"]]);
        verif = v2.map((v: any) => ({ code: v.default_code, precio: v.lst_price, objetivo: pedido[v.default_code], ok: Math.abs(v.lst_price - pedido[v.default_code]) < 0.005 }));
      }
      const sinOdoo = Object.keys(pedido).filter(c => !vars.find((v: any) => v.default_code === c));
      return new Response(JSON.stringify({ ok: problemas.length === 0, dry_run: dry, plan, problemas, sin_odoo: sinOdoo, verificacion: verif }, null, 2), { headers: cors });
    }

    // ---- Modo prolijar ----
    if (body.prolijar === true) {
      const dry = body.dry_run !== false;
      const acciones: any[] = [];
      const TARGETS = ["13312", "10304"];
      const precios = await corePrecios(TARGETS);
      const activos = await call("product.product", "search_read",
        [[["default_code", "in", TARGETS], ["active", "=", true]], ["id", "default_code", "product_tmpl_id"]]);
      for (const v of activos) {
        const code = v.default_code, tmplId = v.product_tmpl_id[0];
        const { l1, l2 } = precios[code] || {};
        if (l1 == null || l2 == null) { acciones.push({ code, error: "sin precio en Core", l1, l2 }); continue; }
        const [t] = await call("product.template", "read", [[tmplId], ["list_price"]]);
        if (Math.abs(t.list_price - l1) > 0.005) {
          if (!dry) await call("product.template", "write", [[tmplId], { list_price: l1 }]);
          acciones.push({ code, que: "list_price", antes: t.list_price, ahora: l1 });
        } else acciones.push({ code, que: "list_price", estado: "ya OK", valor: t.list_price });
        for (const [listaId, precio] of [[LISTA_PUBLICO, l1], [LISTA_PROF, l2]] as [number, number][]) {
          const reglas = await call("product.pricelist.item", "search_read",
            [[["pricelist_id", "=", listaId], ["product_tmpl_id", "=", tmplId], ["applied_on", "=", "1_product"]],
             ["id", "fixed_price"]]);
          if (!reglas.length) {
            let nuevoId = null;
            if (!dry) nuevoId = await call("product.pricelist.item", "create",
              [{ pricelist_id: listaId, applied_on: "1_product", product_tmpl_id: tmplId, compute_price: "fixed", fixed_price: precio, min_quantity: 0 }]);
            acciones.push({ code, que: `regla lista ${listaId}`, accion: "crear", fixed_price: precio, id: nuevoId });
          } else if (Math.abs(reglas[0].fixed_price - precio) > 0.005) {
            if (!dry) await call("product.pricelist.item", "write", [[reglas[0].id], { fixed_price: precio }]);
            acciones.push({ code, que: `regla lista ${listaId}`, accion: "actualizar", antes: reglas[0].fixed_price, ahora: precio });
          } else acciones.push({ code, que: `regla lista ${listaId}`, estado: "ya OK", valor: reglas[0].fixed_price });
        }
      }
      const DUPES = ["13310", "13311", "13312"];
      const archivados = await call("product.template", "search_read",
        [[["default_code", "in", DUPES], ["active", "=", false]], ["id", "name", "default_code"]],
        { context: { active_test: false } });
      for (const t of archivados) {
        const nuevo = t.default_code + "-VIEJO";
        if (!dry) await call("product.template", "write", [[t.id], { default_code: nuevo }]);
        acciones.push({ tmpl_id: t.id, nombre: t.name, que: "default_code", antes: t.default_code, ahora: nuevo });
        const reglas = await call("product.pricelist.item", "search_read",
          [[["product_tmpl_id", "=", t.id]], ["id", "pricelist_id", "fixed_price"]], { context: { active_test: false } });
        if (reglas.length) {
          if (!dry) await call("product.pricelist.item", "unlink", [reglas.map((r: any) => r.id)]);
          acciones.push({ tmpl_id: t.id, que: "reglas_borradas", reglas: reglas.map((r: any) => ({ id: r.id, lista: r.pricelist_id[1], fixed: r.fixed_price })) });
        }
      }
      return new Response(JSON.stringify({ ok: true, dry_run: dry, acciones }, null, 2), { headers: cors });
    }

    // ---- Modo default: packs x4 -> list_price + regla Lista 2 (32) ----
    const dry = body.dry_run !== false;
    const r = await fetch(`${SB_URL}/rest/v1/v_lista_publica?tipo=eq.PACK&select=codigo,nombre,prof_base`,
      { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    if (!r.ok) throw new Error("Core: " + (await r.text()));
    const packs: { codigo: string; nombre: string; prof_base: string | null }[] = await r.json();
    const preciosPacks: Record<string, number> = {};
    for (const p of packs) if (p.prof_base != null) preciosPacks[p.codigo] = Number(p.prof_base);
    const codes = Object.keys(preciosPacks);
    if (!codes.length) throw new Error("Core no devolvio packs con precio");
    const vars = await call("product.product", "search_read",
      [[["default_code", "in", codes], ["active", "=", true]], ["default_code", "product_tmpl_id"]]);
    const tmplIds = [...new Set(vars.map((v: any) => v.product_tmpl_id[0]))];
    const tmpls = tmplIds.length ? await call("product.template", "read", [tmplIds, ["list_price"]]) : [];
    const lpPorTmpl: Record<number, number> = {};
    for (const t of tmpls) lpPorTmpl[t.id] = t.list_price;
    const reglasL2 = tmplIds.length ? await call("product.pricelist.item", "search_read",
      [[["pricelist_id", "=", LISTA_PROF], ["product_tmpl_id", "in", tmplIds], ["applied_on", "=", "1_product"]],
       ["id", "product_tmpl_id", "fixed_price", "min_quantity"]]) : [];
    const reglaPorTmpl: Record<number, any> = {};
    for (const it of reglasL2) {
      const tid = it.product_tmpl_id[0];
      if (!reglaPorTmpl[tid] || (it.min_quantity || 0) < (reglaPorTmpl[tid].min_quantity || 0)) reglaPorTmpl[tid] = it;
    }
    const plan: any[] = [];
    for (const v of vars) {
      const objetivo = preciosPacks[v.default_code];
      const tmplId = v.product_tmpl_id[0];
      const lpAntes = lpPorTmpl[tmplId];
      const lpCambia = Math.abs(lpAntes - objetivo) > 0.005;
      const regla = reglaPorTmpl[tmplId];
      const l2Antes = regla ? regla.fixed_price : null;
      const l2Accion = !regla ? "crear" : (Math.abs(regla.fixed_price - objetivo) > 0.005 ? "actualizar" : "ya OK");
      if (!dry) {
        if (lpCambia) await call("product.template", "write", [[tmplId], { list_price: objetivo }]);
        if (l2Accion === "crear") await call("product.pricelist.item", "create",
          [{ pricelist_id: LISTA_PROF, applied_on: "1_product", product_tmpl_id: tmplId, compute_price: "fixed", fixed_price: objetivo, min_quantity: 0 }]);
        else if (l2Accion === "actualizar") await call("product.pricelist.item", "write", [[regla.id], { fixed_price: objetivo }]);
      }
      plan.push({ code: v.default_code, tmpl_id: tmplId, objetivo, list_price_antes: lpAntes, list_price: lpCambia ? (dry ? "cambiaria" : "cambiado") : "ya OK", l2_antes: l2Antes, l2: l2Accion });
    }
    const sinOdoo = codes.filter((c) => !vars.find((v: any) => v.default_code === c));
    let verif: any = null;
    if (!dry) {
      const t2 = await call("product.template", "read", [tmplIds, ["list_price"]]);
      const r2 = await call("product.pricelist.item", "search_read",
        [[["pricelist_id", "=", LISTA_PROF], ["product_tmpl_id", "in", tmplIds], ["applied_on", "=", "1_product"]], ["product_tmpl_id", "fixed_price"]]);
      verif = vars.map((v: any) => {
        const tid = v.product_tmpl_id[0];
        const lp = t2.find((t: any) => t.id === tid)?.list_price;
        const l2 = r2.filter((x: any) => x.product_tmpl_id[0] === tid).map((x: any) => x.fixed_price);
        const obj = preciosPacks[v.default_code];
        return { code: v.default_code, list_price: lp, l2, ok: Math.abs(lp - obj) < 0.005 && l2.length > 0 && l2.every((x: number) => Math.abs(x - obj) < 0.005) };
      });
    }
    return new Response(JSON.stringify({ ok: true, dry_run: dry, total_core: codes.length, plan, sin_odoo: sinOdoo, verificacion: verif }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
