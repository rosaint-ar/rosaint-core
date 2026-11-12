// ═══════════════════════════════════════════════════════════════════════════
//  Edge Function: ml-ads-auto  (v2, nov-2026) — Publicidad inteligente + Competencia
//  La v1 (motor que pausaba anuncios) quedó en simulación porque Mercado Ads no deja escribir por API
//  a apps no certificadas (401 mclics). Respaldo de la v1: scratchpad ml-ads-auto.v1.bak.ts.
//
//  Acciones (body):
//   {accion:'traer_ads'}    métricas por anuncio en 7 y 30 días → ml_ads_metricas
//                           (el análisis y las recomendaciones salen de la vista v_ml_ads_analisis)
//   {accion:'competencia'}  por cada búsqueda de ml_competencia_busquedas: productos de catálogo de la
//                           competencia del mismo tamaño, vendedores y precio más bajo, Full, y el
//                           puesto en "más vendidos" de la categoría → ml_competencia (foto diaria)
//   {accion:'todo'}         las dos (cron diario ml-ads-competencia)
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const ADVERTISER = 8126;
const SELLER = 157540060;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const diasAtras = (n: number) => new Date(Date.now() - 3 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

async function asegurarToken(supabase: any): Promise<string> {
  const { data: auth, error } = await supabase.from("ml_auth").select("*").eq("id", 1).single();
  if (error || !auth) throw new Error("No hay credenciales de ML.");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;
  const body = new URLSearchParams({
    grant_type: "refresh_token", client_id: Deno.env.get("ML_APP_ID")!, client_secret: Deno.env.get("ML_SECRET")!, refresh_token: auth.refresh_token,
  });
  const resp = await fetch(ML_TOKEN_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const data = await resp.json();
  if (!resp.ok) throw new Error("No renovó token: " + JSON.stringify(data));
  await supabase.from("ml_auth").update({
    access_token: data.access_token, refresh_token: data.refresh_token,
    token_expira_en: new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString(), actualizado_en: new Date().toISOString(),
  }).eq("id", 1);
  return data.access_token;
}

async function getJSON(url: string, headers: any, intentos = 3): Promise<any> {
  for (let i = 0; i < intentos; i++) {
    const r = await fetch(url, { headers });
    if (r.ok) return await r.json();
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await espera(1500 * (i + 1)); continue; }
    throw new Error(`${url.replace(ML_API, "")}: HTTP ${r.status}`);
  }
  return null;
}

// ───────────── Publicidad ─────────────
async function traerAds(supabase: any, headers: any) {
  const h2 = { ...headers, "Api-Version": "2" };
  const camp = await getJSON(`${ML_API}/marketplace/advertising/MLA/advertisers/${ADVERTISER}/product_ads/campaigns/search?limit=50`, h2);
  const nombreCamp = new Map((camp?.results || []).map((c: any) => [Number(c.id), `${c.name}${c.status !== "active" ? " (pausada)" : ""}`]));
  const metr = "cost,clicks,prints,acos,direct_units_quantity,indirect_units_quantity,organic_units_quantity,direct_amount,total_amount,organic_units_amount";
  const res: Record<string, number> = {};
  for (const [ventana, dias] of [["7d", 7], ["30d", 30]] as const) {
    const desde = diasAtras(dias), hasta = diasAtras(1);
    const filas: any[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const d = await getJSON(`${ML_API}/marketplace/advertising/MLA/advertisers/${ADVERTISER}/product_ads/ads/search?limit=50&offset=${offset}&date_from=${desde}&date_to=${hasta}&metrics=${metr}`, h2);
      const rs = d?.results || [];
      for (const a of rs) {
        const m = a.metrics || {};
        filas.push({
          ventana, item_id: a.item_id, campaign_id: a.campaign_id || null, campana: nombreCamp.get(Number(a.campaign_id)) || (a.campaign_id ? String(a.campaign_id) : "sin campaña"),
          estado: a.status, costo: m.cost || 0, clics: m.clicks || 0, impresiones: m.prints || 0,
          u_directas: m.direct_units_quantity || 0, u_indirectas: m.indirect_units_quantity || 0, u_organicas: m.organic_units_quantity || 0,
          monto_directo: m.direct_amount || 0, monto_total: m.total_amount || 0, monto_organico: m.organic_units_amount || 0, acos: m.acos ?? null,
          desde, hasta, traido_en: new Date().toISOString(),
        });
      }
      if (rs.length < 50 || offset + 50 >= (d?.paging?.total ?? 0)) break;
    }
    if (filas.length) {
      await supabase.from("ml_ads_metricas").delete().eq("ventana", ventana);
      const { error } = await supabase.from("ml_ads_metricas").insert(filas);
      if (error) throw new Error("ml_ads_metricas: " + error.message);
    }
    res[ventana] = filas.length;
  }

  // Campañas con su objetivo, presupuesto y métricas 7/30 días → ml_ads_campanas
  const mc = "cost,acos,direct_units_quantity,indirect_units_quantity,total_amount";
  const campMet: Record<string, Map<number, any>> = {};
  for (const [v, dias] of [["7", 7], ["30", 30]] as const) {
    const d = await getJSON(`${ML_API}/marketplace/advertising/MLA/advertisers/${ADVERTISER}/product_ads/campaigns/search?limit=50&date_from=${diasAtras(dias)}&date_to=${diasAtras(1)}&metrics=${mc}`, h2);
    campMet[v] = new Map((d?.results || []).map((c: any) => [Number(c.id), c.metrics || {}]));
  }
  const campanas = (camp?.results || []).map((c: any) => {
    const m7 = campMet["7"].get(Number(c.id)) || {}, m30 = campMet["30"].get(Number(c.id)) || {};
    return {
      id: c.id, nombre: c.name, estado: c.status, estrategia: c.strategy, roas_target: c.roas_target ?? null,
      acos_target: c.acos_target ?? (c.roas_target ? Math.round(10000 / c.roas_target) / 100 : null), presupuesto: c.budget ?? null,
      costo7: m7.cost ?? 0, acos7: m7.acos ?? null, u_ads7: (m7.direct_units_quantity || 0) + (m7.indirect_units_quantity || 0),
      costo30: m30.cost ?? 0, acos30: m30.acos ?? null, u_ads30: (m30.direct_units_quantity || 0) + (m30.indirect_units_quantity || 0),
      monto30: m30.total_amount ?? 0, traido_en: new Date().toISOString(),
    };
  });
  if (campanas.length) {
    await supabase.from("ml_ads_campanas").upsert(campanas, { onConflict: "id" });
    await supabase.from("ml_ads_campanas").delete().not("id", "in", `(${campanas.map((c: any) => c.id).join(",")})`);
  }
  res.campanas = campanas.length;

  // Por día (90 días): gasto de Product Ads (todas las campañas) y ventas pagadas en ML → ml_ads_diario
  const dias: Record<string, any> = {};
  const fila = (f: string) => (dias[f] = dias[f] || { fecha: f, costo_pads: 0, costo_display: null, ventas_monto: 0, ordenes: 0, unidades: 0 });
  const daily = await getJSON(`${ML_API}/marketplace/advertising/MLA/advertisers/${ADVERTISER}/product_ads/campaigns/search?limit=100&date_from=${diasAtras(90)}&date_to=${diasAtras(1)}&metrics=cost&aggregation_type=DAILY`, h2);
  for (const r of daily?.results || []) if (r.date) fila(String(r.date).slice(0, 10)).costo_pads += Number(r.cost || 0);
  const desdeOrd = `${diasAtras(90)}T00:00:00.000-03:00`, hastaOrd = `${diasAtras(1)}T23:59:59.999-03:00`;
  for (let offset = 0; offset < 3000; offset += 50) {
    const o = await getJSON(`${ML_API}/orders/search?seller=${SELLER}&order.status=paid&order.date_created.from=${encodeURIComponent(desdeOrd)}&order.date_created.to=${encodeURIComponent(hastaOrd)}&limit=50&offset=${offset}&sort=date_asc`, headers);
    const rs = o?.results || [];
    for (const x of rs) {
      const f = new Date(new Date(x.date_created).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const d = fila(f); d.ventas_monto += Number(x.total_amount || 0); d.ordenes += 1;
      d.unidades += (x.order_items || []).reduce((s: number, it: any) => s + Number(it.quantity || 0), 0);
    }
    if (rs.length < 50) break;
  }
  // Display (campaña de seguidores): el gasto diario lo trae Vendra en ml_vendra_resumen (mes) → por_dia
  const { data: vr } = await supabase.from("ml_vendra_resumen").select("por_dia").eq("clave", "mes").maybeSingle();
  for (const p of (vr?.por_dia || []) as any[]) if (p?.dia && dias[p.dia]) dias[p.dia].costo_display = Number(p.display || 0);
  const filasDia = Object.values(dias).map((d: any) => ({ ...d, traido_en: new Date().toISOString() }));
  if (filasDia.length) await supabase.from("ml_ads_diario").upsert(filasDia, { onConflict: "fecha" });
  res.dias = filasDia.length;
  return res;
}

// ───────────── Competencia ─────────────
function aGramos(txt: string | null | undefined): number | null {
  if (!txt) return null;
  const m = String(txt).toLowerCase().replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(kg|kilo|g|gr|gramos|l|lt|litros?|ml|cc)\b/);
  if (!m) return null;
  const n = Number(m[1]), u = m[2];
  if (["kg", "kilo", "l", "lt", "litro", "litros"].includes(u)) return Math.round(n * 1000);
  return Math.round(n); // g, ml, cc (densidad ≈ 1)
}
function tamanoProducto(p: any): number | null {
  const at = (id: string) => (p.attributes || []).find((a: any) => a.id === id)?.value_name;
  const unidades = Number(at("UNITS_PER_PACK") || 1) || 1;
  const g = aGramos(at("UNIT_WEIGHT")) ?? aGramos(at("UNIT_VOLUME")) ?? aGramos(at("NET_WEIGHT")) ?? aGramos(p.name);
  return g == null ? null : g * unidades;
}

const sinAcentos = (t: string) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

async function competencia(supabase: any, headers: any) {
  const { data: busq } = await supabase.from("ml_competencia_busquedas").select("*").eq("activo", true);
  if (!busq?.length) return { busquedas: 0 };
  const { data: excl } = await supabase.from("ml_competencia_excluidos").select("item_id,product_id");
  const excluido = new Set((excl || []).map((e: any) => `${e.item_id}|${e.product_id}`));
  // categoría y producto de catálogo de cada publicación nuestra
  const ids = busq.map((b: any) => b.item_id);
  const items = await getJSON(`${ML_API}/items?ids=${ids.join(",")}&attributes=id,category_id,catalog_product_id`, headers);
  const nuestra = new Map((items || []).map((x: any) => [x.body?.id, x.body]));
  const { data: pubs } = await supabase.from("ml_publicaciones").select("item_id,activa");
  const fecha = hoyAR();
  const cacheItems = new Map<string, any>();
  const itemsDe = async (pid: string) => {
    let its = cacheItems.get(pid);
    if (its === undefined) { its = (await getJSON(`${ML_API}/products/${pid}/items?limit=50`, headers))?.results || []; cacheItems.set(pid, its); }
    return its;
  };
  const marcaDe = (p: any) => (p?.attributes || []).find((a: any) => a.id === "BRAND")?.value_name || null;

  // "Más vendidos" por categoría (top 20 de ML), con nombre, marca y precio más bajo → ml_competencia_top
  const rank = new Map<string, Map<string, number>>();
  const topFilas: any[] = [];
  const nuestrosCat = new Set([...nuestra.values()].map((x: any) => x?.catalog_product_id).filter(Boolean));
  for (const cat of new Set([...nuestra.values()].map((x: any) => x?.category_id).filter(Boolean))) {
    const h = await getJSON(`${ML_API}/highlights/MLA/category/${cat}`, headers);
    const cont = h?.content || [];
    rank.set(cat as string, new Map(cont.map((c: any) => [c.id, c.position])));
    for (const c of cont.slice(0, 20)) {
      let nombre = null, marca = null, precio = null;
      if (c.type === "PRODUCT") {
        const p = await getJSON(`${ML_API}/products/${c.id}`, headers);
        nombre = p?.name || null; marca = marcaDe(p);
        const its = await itemsDe(c.id);
        if (its.length) precio = Math.min(...its.map((x: any) => Number(x.price)));
      } else {
        const it = await getJSON(`${ML_API}/items/${c.id}?attributes=title,price,attributes`, headers);
        nombre = it?.title || null; precio = it?.price ?? null; marca = marcaDe(it);
      }
      topFilas.push({ fecha, categoria: cat, posicion: c.position, id: c.id, tipo: c.type, nombre, marca, precio,
        es_rosaint: nuestrosCat.has(c.id) || /rosaint/i.test(marca || "") });
    }
  }

  const filas: any[] = [];
  for (const b of busq) {
    const mia: any = nuestra.get(b.item_id) || {};
    const rk = rank.get(mia.category_id) || new Map();
    const inc = b.incluye ? new RegExp(b.incluye, "i") : null, exc = b.excluye ? new RegExp(b.excluye, "i") : null;
    const s = await getJSON(`${ML_API}/products/search?site_id=MLA&status=active&limit=40&q=${encodeURIComponent(b.q)}`, headers);
    let pos = 0;
    const candidatos = (s?.results || []).map((p: any) => ({ p, pos: ++pos }))
      .filter(({ p }: any) => {
        const nom = sinAcentos(p.name);
        if (inc && !inc.test(nom)) return false;             // tiene que ser el mismo tipo de producto
        if (exc && exc.test(nom)) return false;              // sin kits, combos ni otros usos
        if (excluido.has(`${b.item_id}|${p.id}`)) return false; // marcado "no es competencia" en el Core
        const g = tamanoProducto(p); return g != null && Math.abs(g - b.gramos) <= b.gramos * 0.05;
      });
    if (mia.catalog_product_id && !candidatos.some((c: any) => c.p.id === mia.catalog_product_id)) {
      const pr = await getJSON(`${ML_API}/products/${mia.catalog_product_id}`, headers);
      if (pr) candidatos.push({ p: pr, pos: null });
    }
    for (const { p, pos } of candidatos.slice(0, 15)) {
      const its = await itemsDe(p.id);
      if (!its.length) continue;
      const masBarato = its.reduce((a: any, x: any) => (Number(x.price) < Number(a.price) ? x : a), its[0]);
      const marca = marcaDe(p);
      filas.push({
        fecha, item_id: b.item_id, product_id: p.id, posicion: pos, nombre: p.name, marca, gramos: tamanoProducto(p),
        precio: Number(masBarato.price), precio_lista: masBarato.original_price ? Number(masBarato.original_price) : null,
        vendedores: its.length, es_full: its.some((x: any) => x.shipping?.logistic_type === "fulfillment"),
        envio_gratis: !!masBarato.shipping?.free_shipping, ranking_cat: rk.get(p.id) ?? (p.parent_id ? rk.get(p.parent_id) : undefined) ?? null,
        es_rosaint: p.id === mia.catalog_product_id || /rosaint/i.test(marca || ""), categoria: mia.category_id || null,
      });
    }
  }
  if (filas.length) {
    await supabase.from("ml_competencia").delete().eq("fecha", fecha);
    const { error } = await supabase.from("ml_competencia").insert(filas);
    if (error) throw new Error("ml_competencia: " + error.message);
  }
  if (topFilas.length) {
    await supabase.from("ml_competencia_top").delete().eq("fecha", fecha);
    await supabase.from("ml_competencia_top").insert(topFilas);
  }
  await supabase.from("ml_competencia").delete().lt("fecha", diasAtras(120));
  await supabase.from("ml_competencia_top").delete().lt("fecha", diasAtras(120));

  // Aviso por mail (una vez por día): la competencia bajó fuerte el precio o apareció alguien más barato
  const { data: res } = await supabase.from("v_ml_competencia_resumen").select("*");
  const { data: ayer } = await supabase.from("ml_competencia").select("item_id,product_id").eq("fecha", diasAtras(1));
  const visto = new Set((ayer || []).map((x: any) => `${x.item_id}|${x.product_id}`));
  const alertas: string[] = [];
  for (const r of res || []) {
    if (r.cambio_min_7d_pct != null && Number(r.cambio_min_7d_pct) <= -10)
      alertas.push(`<li><b>${r.titulo}</b>: el más barato de la competencia bajó ${Math.abs(r.cambio_min_7d_pct)}% en 7 días (hoy $${Math.round(r.minimo).toLocaleString("es-AR")}, ${r.mas_barato}).</li>`);
    const nuevos = filas.filter((f) => f.item_id === r.item_id && !f.es_rosaint && !visto.has(`${f.item_id}|${f.product_id}`) && Number(f.precio) < Number(r.precio_hoy));
    if ((ayer || []).length && nuevos.length)
      alertas.push(`<li><b>${r.titulo}</b>: competidor nuevo más barato que vos — ${nuevos.map((n) => `${n.marca || n.nombre} $${Math.round(n.precio).toLocaleString("es-AR")}`).join(", ")}.</li>`);
  }
  if (alertas.length) {
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/odoo-enviar-mail`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ to: "rosaint.ar@gmail.com", subject: `ML competencia: ${alertas.length} aviso(s)`,
          body_html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>Movimientos de la competencia en Mercado Libre:</p><ul>${alertas.join("")}</ul><p><a href="https://rosaint-ar.github.io/rosaint-core/comercial/canales.html#ml">Ver en el Core (Canales → Mercado Libre → Competencia)</a></p></div>` }),
      });
    } catch (_) { /* el aviso no frena */ }
  }
  return { busquedas: busq.length, productos: filas.length, top: topFilas.length, alertas: alertas.length };
}

// ───────────── Acceso: sesión del Core, clave interna o el secreto de ml_config (cron) ─────────────
async function accesoPermitido(req: Request, supabase: any): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  const proxy = req.headers.get("x-proxy-secret") || "";
  if (proxy) {
    const { data } = await supabase.from("ml_config").select("valor").eq("clave", "proxy_secret").maybeSingle();
    if (data?.valor && data.valor === proxy) return true;
  }
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (srk && a.slice(7) === srk) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    return r.ok && !!(await r.json())?.id;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!(await accesoPermitido(req, supabase))) return out({ ok: false, error: "No autorizado: iniciá sesión en Core" }, 401);
  try {
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* vacío */ }
    const accion = body.accion || "todo";
    const headers = { Authorization: `Bearer ${await asegurarToken(supabase)}` };
    const res: any = { ok: true };
    if (accion === "traer_ads" || accion === "todo") res.ads = await traerAds(supabase, headers);
    if (accion === "competencia" || accion === "todo") res.competencia = await competencia(supabase, headers);
    await supabase.from("ml_ads_bitacora").insert({ accion: "corrida", motivo: `v2 ${accion}`, detalle: res, resultado: "ok" });
    return out(res);
  } catch (e) {
    return out({ ok: false, error: (e as Error).message }, 500);
  }
});
