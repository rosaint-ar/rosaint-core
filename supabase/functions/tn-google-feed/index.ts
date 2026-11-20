// tn-google-feed — Core → Tienda Nube → Google Shopping.
// Arma el archivo COMPLEMENTARIO de Merchant Center (130292706) con todo lo que Tienda Nube no manda:
// fichas técnicas del Core (descripción, beneficios, principios activos, textura, aroma, pH, vida útil,
// modo de uso, INCI), costo (v_costos_skus), combos (pack_componentes), línea, códigos de barras y
// ventas de Odoo, y el link a la ficha de rosaint.online. Lo escrito a mano en google_feed_ajustes gana.
// PRECIO, OFERTA Y STOCK NO VAN ACÁ: los manda Tienda Nube al instante por Content API.
//
//   GET  ?k=<clave>              → XML (RSS 2.0 con g:) para que Merchant lo baje todos los días. Público con clave.
//   GET  ?k=<clave>&formato=json → lo mismo en JSON (para revisar).
//   POST {accion:"vista"}        → (con sesión de Core) productos + avisos para la pantalla Google Shopping.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ODOO_URL = Deno.env.get("ODOO_URL") || "";
const ODOO_DB = Deno.env.get("ODOO_DB") || "";
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN") || "";
const ODOO_KEY = Deno.env.get("ODOO_KEY") || "";
const UA = "Rosaint Core - google feed (https://rosaint.online)";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key" };
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

// ---------- utilidades
const es = (n: any) => (n && typeof n === "object" ? (n.es ?? Object.values(n)[0] ?? "") : String(n ?? ""));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const sinHtml = (s: string) => String(s || "")
  .replace(/<br\s*\/?>/gi, " ").replace(/<\/(p|li|h\d)>/gi, " ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();
function corte(s: string, max: number): string {
  s = (s || "").trim();
  if (s.length <= max) return s;
  const c = s.slice(0, max);
  const p = c.lastIndexOf(". ");
  if (p > max * 0.5) return c.slice(0, p + 1);
  const w = c.lastIndexOf(" ");
  return (w > max * 0.6 ? c.slice(0, w) : c).replace(/[,;:]$/, "") + "…";
}
const xml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const PEQ = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "con", "para", "en", "a"]);
const titulo = (s: string) => (s || "").toLowerCase().split(/\s+/).map((w, i) => (i && PEQ.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const lista = (v: any): string[] => (Array.isArray(v) ? v.map((x) => sinHtml(typeof x === "string" ? x : (x?.texto ?? x?.text ?? JSON.stringify(x)))).filter(Boolean) : []);

function gtinValido(c: string | null | undefined): boolean {
  const s = String(c || "").trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const d = s.split("").map(Number); const chk = d.pop()!;
  let sum = 0; d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === chk;
}

// "CREMA «RELAJANTE» CORPORAL 1 KG" → { size: "1 kg", cant: 1, unidad: "kg" }
function tamanio(texto: string): { size: string; cant: number; unidad: string } | null {
  const m = String(texto || "").match(/(\d+(?:[.,]\d+)?)\s*(KG|KGS|G|GR|LTS?|L|CC|ML)\b/i);
  if (!m) return null;
  const cant = Number(m[1].replace(",", "."));
  const u = m[2].toUpperCase();
  const unidad = u.startsWith("K") ? "kg" : u.startsWith("G") ? "g" : u.startsWith("L") ? "l" : "ml";
  return { size: `${String(cant).replace(".", ",")} ${unidad}`, cant, unidad };
}

// Categoría de Google (taxonomía oficial, ids).
function categoriaGoogle(nombre: string, esCombo: boolean): string {
  const n = nombre.toUpperCase();
  if (esCombo) return "567";                      // Cosméticos > Cuidado de la piel
  if (/ACEITE/.test(n)) return "5664";            // Masaje y relajación > Aceites para masaje
  if (/EXFOLIANTE/.test(n)) return "6262";        // Cuidado de la piel > Máscaras y peelings
  if (/ÓLEO|OLEO/.test(n)) return "567";          // Cuidado de la piel
  if (/CREMA|GEL/.test(n) && !/CONDUCTOR/.test(n)) return "2592"; // Cuidado de la piel > Loción
  return "567";
}

// Secciones de la descripción de Tienda Nube: <h3 data-tab>Título</h3> ... → { "Descripción": html, ... }
function secciones(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const partes = String(html || "").split(/<h3[^>]*>/i);
  if (partes.length < 2) { out["Descripción"] = html; return out; }
  for (const p of partes.slice(1)) {
    const i = p.toLowerCase().indexOf("</h3>");
    if (i < 0) continue;
    out[sinHtml(p.slice(0, i))] = p.slice(i + 5);
  }
  return out;
}
const items_li = (html: string) => [...String(html || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => sinHtml(m[1])).filter(Boolean);

// ---------- fuentes
async function sb(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
  if (!r.ok) throw new Error(`Core ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}
async function sbInsert(tabla: string, fila: Rec) {
  await fetch(`${SB_URL}/rest/v1/${tabla}`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(fila) }).catch(() => {});
}
async function tnToken(store: number): Promise<string> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_store_token`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_store_id: store }) });
  if (!r.ok) throw new Error("token rpc " + r.status);
  const t = await r.json(); if (!t || typeof t !== "string") throw new Error("Sin token de Tienda Nube para " + store); return t;
}
async function tnProductos(store: number): Promise<Rec[]> {
  const tok = await tnToken(store);
  const out: Rec[] = [];
  for (let page = 1; page <= 10; page++) {
    let r: Response | null = null;
    for (let intento = 0; intento < 4; intento++) {
      r = await fetch(`https://api.tiendanube.com/2025-03/${store}/products?per_page=200&page=${page}&published=true`, { headers: { Authentication: `bearer ${tok}`, "User-Agent": UA, Accept: "application/json" } });
      if (r.status !== 429) break;
      await new Promise((ok) => setTimeout(ok, 1200 * (intento + 1)));
    }
    if (!r || r.status === 404) break;
    if (!r.ok) throw new Error(`Tienda Nube ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const lote = await r.json();
    out.push(...lote);
    if (lote.length < 200) break;
  }
  return out;
}

async function odoo(model: string, method: string, args: unknown[], kwargs: Rec): Promise<any> {
  if (!ODOO_URL) throw new Error("Odoo sin configurar");
  const call = async (service: string, m: string, a: unknown[]) => {
    let texto = "";
    for (let intento = 0; intento < 4; intento++) {
      if (intento) await new Promise((r) => setTimeout(r, 600 * intento));
      const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method: m, args: a }, id: Date.now() }) });
      texto = await res.text();
      if (res.ok && texto.trimStart().startsWith("{")) break;
    }
    const j = JSON.parse(texto);
    if (j.error) throw new Error("Odoo: " + (j.error?.data?.message || j.error?.message));
    return j.result;
  };
  const uid = await call("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  return await call("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: { allowed_company_ids: [2] } }]);
}

// Link de cada variante en rosaint.online: sale del catálogo que publica la web (data-vNN.js).
async function linksWeb(origen: string): Promise<{ links: Map<string, string>; archivo: string | null }> {
  const links = new Map<string, string>();
  try {
    const home = await (await fetch(origen + "/", { headers: { "User-Agent": UA } })).text();
    const m = home.match(/src="(\/data-v\d+\.js)[^"]*"/);
    if (!m) return { links, archivo: null };
    const js = await (await fetch(origen + m[1], { headers: { "User-Agent": UA } })).text();
    for (const x of js.matchAll(/"variantId":(\d+),[^{}]*?"url":"(\/productos\/[^"]+)"/g)) links.set(x[1], origen + x[2]);
    return { links, archivo: m[1] };
  } catch { return { links, archivo: null }; }
}

// ---------- armado
async function armar() {
  const t0 = Date.now();
  const [cfg] = await sb("google_feed_config?id=eq.1&select=*");
  if (!cfg) throw new Error("Falta la configuración (google_feed_config)");
  const avisosGenerales: string[] = [];

  const [productos, ajustes, pres, items, lineas, fichas, costos, packs, web] = await Promise.all([
    tnProductos(Number(cfg.tienda)),
    sb("google_feed_ajustes?select=*"),
    sb("presentaciones?select=codigo_sku,codigo_granel,tamanio_kg"),
    sb("items?select=codigo,linea_id"),
    sb("lineas?select=id,nombre"),
    sb("fichas?select=codigo_granel,nombre_comercial,descripcion,aplicaciones,beneficios,caracteristicas,principios_activos,modo_uso,aspecto,color,olor,ph_min,ph_max,vida_util_meses,conservacion,precauciones,advertencias,inci_publicado,inci_aprobado,sin_ficha_motivo"),
    sb("v_costos_skus?select=codigo_sku,costo_total_sku"),
    sb("pack_componentes?select=codigo_pack,codigo_sku,cantidad"),
    linksWeb(String(cfg.web_origen || "https://rosaint.online").replace(/\/$/, "")),
  ]);
  if (!web.archivo) avisosGenerales.push("No se pudo leer el catálogo de rosaint.online: los links quedan los de Tienda Nube.");

  const ajusteDe = new Map(ajustes.map((a: Rec) => [String(a.offer_id), a]));
  const presDe = new Map(pres.map((p: Rec) => [String(p.codigo_sku), p]));
  const lineaDeItem = new Map(items.map((i: Rec) => [String(i.codigo), i.linea_id]));
  const nombreLinea = new Map(lineas.map((l: Rec) => [l.id, titulo(l.nombre)]));
  const fichaDe = new Map(fichas.map((f: Rec) => [String(f.codigo_granel), f]));
  const costoDe = new Map(costos.map((c: Rec) => [String(c.codigo_sku), Number(c.costo_total_sku) || 0]));
  const packDe = new Map<string, Rec[]>();
  for (const p of packs) { const k = String(p.codigo_pack); if (!packDe.has(k)) packDe.set(k, []); packDe.get(k)!.push(p); }

  // SKUs de la tienda → códigos de barras y ventas de 90 días en Odoo
  const skus = [...new Set(productos.flatMap((p: Rec) => (p.variants || []).map((v: Rec) => String(v.sku || "")).filter(Boolean)))];
  const barrasOdoo = new Map<string, string>();
  const ventas = new Map<string, number>();
  try {
    const prods = await odoo("product.product", "search_read", [[["default_code", "in", skus]]], { fields: ["default_code", "barcode"] });
    for (const p of prods) if (p.default_code && p.barcode) barrasOdoo.set(String(p.default_code), String(p.barcode).trim());
    const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10) + " 00:00:00";
    const grupos = await odoo("sale.order.line", "read_group",
      [[["state", "in", ["sale", "done"]], ["order_id.date_order", ">=", desde], ["company_id", "=", 2]], ["product_uom_qty:sum"], ["product_id"]],
      { lazy: false });
    for (const g of grupos) {
      const cod = String(g.product_id?.[1] || "").match(/^\[([^\]]+)\]/)?.[1];
      if (cod) ventas.set(cod, (ventas.get(cod) || 0) + Number(g.product_uom_qty || 0));
    }
    // Combos de la tienda que no están en pack_componentes: sus componentes salen del kit (mrp.bom) de Odoo.
    const sinPack = skus.filter((s) => !packDe.has(s) && /^6\d{4}$/.test(s));
    if (sinPack.length) {
      const prodCombo = await odoo("product.product", "search_read", [[["default_code", "in", sinPack]]], { fields: ["default_code", "product_tmpl_id"] });
      const tmplA = new Map<number, string>(prodCombo.map((p: Rec) => [p.product_tmpl_id[0], String(p.default_code)]));
      const prodA = new Map<number, string>(prodCombo.map((p: Rec) => [p.id, String(p.default_code)]));
      if (tmplA.size) {
        const boms = await odoo("mrp.bom", "search_read", [[["product_tmpl_id", "in", [...tmplA.keys()]]]], { fields: ["product_tmpl_id", "product_id", "bom_line_ids", "product_qty"] });
        const lineIds = boms.flatMap((b: Rec) => b.bom_line_ids);
        const lineas = lineIds.length ? await odoo("mrp.bom.line", "read", [lineIds, ["bom_id", "product_id", "product_qty"]], {}) : [];
        for (const b of boms) {
          const combo = (b.product_id && prodA.get(b.product_id[0])) || tmplA.get(b.product_tmpl_id[0]);
          if (!combo || packDe.has(combo)) continue;
          const comp = lineas.filter((l: Rec) => l.bom_id[0] === b.id).map((l: Rec) => ({
            codigo_pack: combo, codigo_sku: String(l.product_id?.[1] || "").match(/^\[([^\]]+)\]/)?.[1] || "", cantidad: Number(l.product_qty || 1) / Number(b.product_qty || 1),
          })).filter((c: Rec) => c.codigo_sku);
          if (comp.length) packDe.set(combo, comp);
        }
      }
    }
  } catch (e) { avisosGenerales.push("Odoo no respondió (códigos de barras, ventas o combos): " + (e as Error).message); }
  const vendidos = [...ventas.entries()].filter(([s]) => skus.includes(s)).sort((a, b) => b[1] - a[1]);
  const corteTop = Math.max(1, Math.round(vendidos.length * Number(cfg.top_ventas_pct || 0.2)));
  const top = new Set(vendidos.slice(0, corteTop).map(([s]) => s));

  const out: Rec[] = [];
  for (const p of productos) {
    const nombreP = es(p.name);
    const seo = es(p.seo_title).replace(/\s*\|\s*Rosaint.*$/i, "").trim();
    const sec = secciones(es(p.description));
    const variantes = p.variants || [];
    for (const v of variantes) {
      const id = String(v.id);
      const sku = String(v.sku || "");
      const aj: Rec = ajusteDe.get(id) || {};
      const valores = (v.values || []).map(es).filter(Boolean).join(" / ");
      const esCombo = packDe.has(sku) || /^COMBO\b/i.test(nombreP);
      const pr = presDe.get(sku);
      const ficha: Rec | undefined = pr ? fichaDe.get(String(pr.codigo_granel)) : undefined;
      const tam = tamanio(nombreP) || tamanio(valores);
      const g: Rec = {};        // atributos que van a Google
      const o: Rec = {};        // de dónde salió cada uno
      const avisos: string[] = [];

      // Título: el título SEO de Tienda Nube («… Profesional 1 Kg»), + variante si hay varias, + marca.
      if (aj.titulo) { g.title = aj.titulo; o.title = "manual"; }
      else if (seo) { g.title = corte(`${seo}${variantes.length > 1 && valores ? " – " + valores : ""} | Rosaint`, 150).replace(/(\d)\s*Kg\b/g, "$1 kg"); o.title = "tienda (SEO)"; }

      // Descripción: ficha técnica del Core (+ aplicaciones); si no hay ficha, la sección «Descripción» de Tienda Nube.
      const aplic = ficha ? lista(ficha.aplicaciones) : items_li(sec["Aplicaciones"] || "");
      if (aj.descripcion) { g.description = corte(aj.descripcion, 5000); o.description = "manual"; }
      else {
        const base = ficha?.descripcion ? sinHtml(ficha.descripcion) : sinHtml(sec["Descripción"] || sec["Descripcion"] || "");
        if (base) {
          let d = base;
          if (aplic.length) d += ` Aplicaciones: ${aplic.join("; ")}.`;
          g.description = corte(d, 1000); o.description = ficha?.descripcion ? "ficha" : "tienda";
        }
      }
      if (!g.description) avisos.push("Sin descripción propia (queda la de Tienda Nube)");
      else if (g.description.length < 300) avisos.push("Descripción corta (menos de 300 letras)");

      // Destacados
      const benef = aj.destacados?.length ? aj.destacados : (ficha ? lista(ficha.beneficios) : items_li(sec["Beneficios"] || ""));
      g.product_highlight = benef.slice(0, Number(cfg.max_destacados ?? 6)).map((b: string) => corte(b, 150));
      o.product_highlight = aj.destacados?.length ? "manual" : ficha ? "ficha" : "tienda";
      if (!g.product_highlight.length) { delete g.product_highlight; avisos.push("Sin destacados"); }

      // Detalles técnicos (tabla «Detalles del producto» de Google)
      const det: [string, string, string][] = [];
      const pa = ficha ? lista(ficha.principios_activos) : items_li(sec["Principios activos"] || "");
      for (const x of pa.slice(0, 8)) {
        const i = x.indexOf(":");
        const val = i > 0 ? x.slice(i + 1).trim() : x;
        det.push(["Principios activos", corte(i > 0 ? x.slice(0, i) : "Activo", 140), corte(val.charAt(0).toUpperCase() + val.slice(1), 1000)]);
      }
      if (ficha?.aspecto) det.push(["Características", "Textura", corte(ficha.aspecto, 1000)]);
      if (ficha?.olor) det.push(["Características", "Aroma", corte(ficha.olor, 1000)]);
      if (ficha?.color) det.push(["Características", "Color", corte(ficha.color, 1000)]);
      if (ficha?.ph_min != null || ficha?.ph_max != null) {
        const a = ficha.ph_min != null ? String(ficha.ph_min).replace(".", ",") : "", b = ficha.ph_max != null ? String(ficha.ph_max).replace(".", ",") : "";
        det.push(["Características", "pH", a && b && a !== b ? `${a} a ${b}` : (a || b)]);
      }
      if (tam && !esCombo) det.push(["Características", "Contenido neto", tam.size]);
      if (esCombo && valores) det.push(["Características", "Presentación", valores]);
      if (ficha?.vida_util_meses) det.push(["Características", "Vida útil", `${ficha.vida_util_meses} meses`]);
      if (aplic.length) det.push(["Uso", "Aplicaciones", corte(aplic.join("; "), 1000)]);
      const modo = ficha?.modo_uso ? sinHtml(ficha.modo_uso) : sinHtml(sec["Modo de uso"] || "");
      if (modo) det.push(["Uso", "Modo de uso", corte(modo, 1000)]);
      const prec = sinHtml([ficha?.precauciones, ficha?.advertencias].filter(Boolean).join(" "));
      if (prec) det.push(["Uso", "Precauciones", corte(prec, 1000)]);
      if (ficha?.conservacion) det.push(["Uso", "Conservación", corte(sinHtml(ficha.conservacion), 1000)]);
      const inci = sinHtml(ficha?.inci_publicado || ficha?.inci_aprobado || sec["Ingredientes (INCI)"] || "");
      if (inci) det.push(["Composición", "Ingredientes (INCI)", corte(inci, 1000)]);
      if (det.length) { g.product_detail = det; o.product_detail = ficha ? "ficha" : "tienda"; }
      if (!ficha && !esCombo) avisos.push("Sin ficha técnica en el Core");

      // Código de barras: Tienda Nube ya lo manda; si falta, el de Odoo.
      if (!v.barcode) {
        const b = barrasOdoo.get(sku);
        if (b && gtinValido(b)) { g.gtin = b; o.gtin = "odoo"; }
        else if (!esCombo) avisos.push(b ? `Código de barras de Odoo inválido (${b})` : "Sin código de barras");
      }

      // Tamaño y precio por unidad (los combos traen varios tamaños: no llevan uno solo)
      if (tam && !esCombo) {
        g.size = tam.size; o.size = "nombre";
        const chico = tam.unidad === "g" || tam.unidad === "ml";
        g.unit_pricing_measure = `${tam.cant}${tam.unidad}`;
        g.unit_pricing_base_measure = chico ? `100${tam.unidad}` : `1${tam.unidad}`;
      }

      // Combo
      if (esCombo) { g.is_bundle = "yes"; o.is_bundle = "core"; }

      // Costo (materiales: granel + envase; combos = suma de sus componentes)
      let costo = costoDe.get(sku) || 0;
      if (!costo && packDe.has(sku)) costo = packDe.get(sku)!.reduce((s, c) => s + (costoDe.get(String(c.codigo_sku)) || 0) * Number(c.cantidad || 1), 0);
      const precio = num(v.promotional_price) ?? num(v.price) ?? 0;
      if (costo > 0 && cfg.incluir_costo) { g.cost_of_goods_sold = `${costo.toFixed(2)} ARS`; o.cost_of_goods_sold = "core"; }
      if (!costo) avisos.push("Sin costo en el Core");

      // Link a la web propia
      const link = web.links.get(id);
      if (link) { g.link = link; g.mobile_link = link; o.link = "web"; }
      else avisos.push("Sin ficha en rosaint.online (queda el link de Tienda Nube)");

      // Categoría de Google
      g.google_product_category = aj.categoria || categoriaGoogle(nombreP, esCombo);
      o.google_product_category = aj.categoria ? "manual" : "regla";

      // Etiquetas para publicidad
      const lin = lineaDeItem.get(sku);
      g.custom_label_0 = esCombo ? "Packs" : (lin != null ? nombreLinea.get(lin) : null) || "Sin línea";
      const neto = precio / 1.21;
      const margen = costo > 0 && neto > 0 ? (neto - costo) / neto : null;
      g.custom_label_1 = margen == null ? "Margen sin dato" : "";   // se completa abajo, por tercios del catálogo
      (g as Rec)._margen = margen;
      const u90 = ventas.get(sku) || 0;
      g.custom_label_2 = top.has(sku) ? "Más vendido" : u90 > 0 ? "Con ventas" : "Sin ventas 90 días";
      g.custom_label_3 = !tam ? "Sin tamaño" : (tam.unidad === "kg" || tam.unidad === "l") ? "Tamaño profesional" : "Tamaño chico";
      g.custom_label_4 = num(v.promotional_price) ? "En oferta" : "Precio de lista";

      // Envío gratis: manual por producto, o la regla general por monto
      const gratis = aj.envio_gratis ?? (cfg.envio_gratis_desde != null && precio >= Number(cfg.envio_gratis_desde));
      if (gratis) { g.shipping = { country: "AR", price: "0 ARS" }; g.shipping_label = "Envío gratis"; o.shipping = aj.envio_gratis != null ? "manual" : "regla"; }

      if (aj.excluir) { g.excluded_destination = ["Shopping_ads", "Free_listings"]; o.excluded_destination = "manual"; }

      out.push({
        id, product_id: p.id, sku, nombre: nombreP + (variantes.length > 1 && valores ? ` – ${valores}` : ""),
        precio, precio_lista: num(v.price), stock: v.stock, ventas_90: u90, margen, costo,
        gtin_tienda: v.barcode || null, ficha: ficha ? String(pr!.codigo_granel) : null,
        g, origen: o, avisos, ajuste: ajusteDe.get(id) || null,
      });
    }
  }
  // Margen: con costo de materiales casi todo queda arriba del 60%, así que se reparte en tercios del catálogo
  // (alto = el tercio que más deja). Sirve para separar campañas, no es un número contable.
  const ms = out.map((i) => i.g._margen).filter((m) => m != null).sort((a, b) => a - b);
  const t1 = ms[Math.floor(ms.length / 3)], t2 = ms[Math.floor((ms.length * 2) / 3)];
  for (const i of out) {
    const m = i.g._margen; delete i.g._margen;
    if (m != null) i.g.custom_label_1 = m >= t2 ? "Margen alto" : m >= t1 ? "Margen medio" : "Margen bajo";
  }
  out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return { cfg, items: out, avisos: avisosGenerales, web: web.archivo, ms: Date.now() - t0 };
}

function aXml(items: Rec[]): string {
  const L: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">', "<channel>",
    "<title>Rosaint · complementario del Core</title>", "<link>https://rosaint.online</link>",
    `<description>Datos complementarios generados por Rosaint Core el ${new Date().toISOString()}. Precio y stock los manda Tienda Nube.</description>`];
  const simple = (k: string, v: unknown) => L.push(`  <g:${k}>${xml(v)}</g:${k}>`);
  for (const it of items) {
    const g = it.g;
    L.push("<item>");
    simple("id", it.id);
    for (const k of ["title", "description", "link", "mobile_link", "gtin", "size", "unit_pricing_measure", "unit_pricing_base_measure", "is_bundle", "cost_of_goods_sold", "google_product_category", "custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4", "shipping_label"])
      if (g[k] != null && g[k] !== "") simple(k, g[k]);
    for (const h of g.product_highlight || []) simple("product_highlight", h);
    for (const [s, n, v] of g.product_detail || [])
      L.push(`  <g:product_detail><g:section_name>${xml(s)}</g:section_name><g:attribute_name>${xml(n)}</g:attribute_name><g:attribute_value>${xml(v)}</g:attribute_value></g:product_detail>`);
    if (g.shipping) L.push(`  <g:shipping><g:country>${g.shipping.country}</g:country><g:price>${xml(g.shipping.price)}</g:price></g:shipping>`);
    for (const d of g.excluded_destination || []) simple("excluded_destination", d);
    L.push("</item>");
  }
  L.push("</channel>", "</rss>");
  return L.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    // Merchant Center (y quien tenga la clave): el archivo.
    if (req.method === "GET") {
      const k = url.searchParams.get("k") || "";
      const [cfg] = await sb("google_feed_config?id=eq.1&select=clave");
      if (!k || !cfg || k !== cfg.clave) return new Response("No autorizado", { status: 401, headers: cors });
      const r = await armar();
      const items = r.items;
      await sbInsert("google_feed_lecturas", { agente: (req.headers.get("user-agent") || "").slice(0, 160), items: items.length, ms: r.ms });
      if (url.searchParams.get("formato") === "json")
        return new Response(JSON.stringify({ ok: true, avisos: r.avisos, items: items.map((i) => ({ id: i.id, sku: i.sku, nombre: i.nombre, avisos: i.avisos, ...i.g })) }, null, 1), { headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
      return new Response(aXml(items), { headers: { ...cors, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } });
    }
    // Pantalla del Core
    if (!(await _accesoPermitido(req))) return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const body = await req.json().catch(() => ({}));
    if (body.accion === "vista") {
      const r = await armar();
      const lecturas = await sb("google_feed_lecturas?select=en,agente,items&order=en.desc&limit=5");
      return new Response(JSON.stringify({ ok: true, items: r.items, avisos: r.avisos, web: r.web, ms: r.ms, lecturas,
        url: `${SB_URL}/functions/v1/tn-google-feed?k=${r.cfg.clave}` }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: "Acción desconocida" }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
