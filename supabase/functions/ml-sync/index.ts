// v26: captura precio Meli+ (tier buyer_loyalty de /items/{id}/prices) en precio_meli,
// ademas del standard (precio) y el general (precio_con_descuento). Todo del MISMO
// pedido /prices (traerPrecios), sin llamadas extra. Sirve para el control de descuentos.
// v25: precio de lista REAL = precio 'standard' de /prices. El original_price de /items
// viene TOPEADO por ML y no es el real.
// v24: guarda `estado` crudo de ML. v23: FIX doble conteo de cuotas (comision base gold_special;
// el 8,4% de cuotas lo suma la vista como costo_cuotas). con_cuotas del sale_term INSTALLMENTS_CAMPAIGN.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const LOTE = 8;
const ZIP_REF = "2000";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function asegurarToken(supabase: any): Promise<string> {
  const { data: auth, error } = await supabase.from("ml_auth").select("*").eq("id", 1).single();
  if (error || !auth) throw new Error("No hay credenciales de ML");
  if (!auth.refresh_token) throw new Error("Falta refresh token");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: Deno.env.get("ML_APP_ID")!,
    client_secret: Deno.env.get("ML_SECRET")!,
    refresh_token: auth.refresh_token,
  });
  const resp = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("No renovó token: " + JSON.stringify(data));
  const expiraEn = new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString();
  await supabase.from("ml_auth").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expira_en: expiraEn,
    actualizado_en: new Date().toISOString(),
  }).eq("id", 1);
  return data.access_token;
}

async function traerTodosLosItemIds(sellerId: string, headers: any): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const r = await fetch(`${ML_API}/users/${sellerId}/items/search?limit=100&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`items/search HTTP ${r.status}`);
    const data = await r.json();
    const results: string[] = data?.results || [];
    if (results.length === 0) break;
    ids.push(...results);
    const total = data?.paging?.total ?? 0;
    offset += 100;
    if (offset >= total) break;
  }
  return ids;
}

// Lee /items/{id}/prices y devuelve los 3 precios que importan:
//  standard = precio de lista real; general = mejor promo sin buyer_loyalty;
//  meli = mejor promo con buyer_loyalty (precio para compradores Meli+).
async function traerPrecios(itemId: string, headers: any): Promise<{ standard: number | null; general: number | null; meli: number | null }> {
  try {
    const r = await fetch(`${ML_API}/items/${itemId}/prices`, { headers });
    if (!r.ok) return { standard: null, general: null, meli: null };
    const data = await r.json();
    const arr = Array.isArray(data?.prices) ? data.prices : [];
    let standard: number | null = null, general: number | null = null, meli: number | null = null;
    for (const p of arr) {
      const amount = Number(p.amount);
      if (!amount || amount <= 0) continue;
      if (p.type === "standard") {
        if (standard == null || amount > standard) standard = amount;
        continue;
      }
      if (p.type === "promotion") {
        const ctx = (p.conditions && Array.isArray(p.conditions.context_restrictions)) ? p.conditions.context_restrictions : [];
        const esMeli = ctx.some((c: any) => String(c).startsWith("buyer_loyalty"));
        if (esMeli) { if (meli == null || amount < meli) meli = amount; }
        else { if (general == null || amount < general) general = amount; }
      }
    }
    return { standard, general, meli };
  } catch { return { standard: null, general: null, meli: null }; }
}

async function traerMayorDescuento(itemId: string, headers: any): Promise<number | null> {
  try {
    const r = await fetch(`${ML_API}/seller-promotions/items/${itemId}?app_version=v2`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    const promos = Array.isArray(data) ? data : (data?.results || []);
    let menor: number | null = null;
    for (const promo of promos) {
      const estado = (promo.status || "").toLowerCase();
      if (!["started", "active"].includes(estado)) continue;
      const price = Number(promo.price);
      if (!price || price <= 0) continue;
      if (menor === null || price < menor) menor = price;
    }
    return menor;
  } catch { return null; }
}

async function traerEnvio(itemId: string, headers: any): Promise<number | null> {
  try {
    const r = await fetch(`${ML_API}/items/${itemId}/shipping_options?zip_code=${ZIP_REF}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    const opciones = data?.options;
    if (!Array.isArray(opciones) || opciones.length === 0) return null;
    const rec = opciones.find((o: any) => o.display === "recommended") || opciones[0];
    return rec?.list_cost != null ? Number(rec.list_cost) : null;
  } catch { return null; }
}

async function traerVisitas(itemId: string, dias: number, headers: any): Promise<number | null> {
  try {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
    const f = (d: Date) => d.toISOString().slice(0, 10);
    const r = await fetch(`${ML_API}/items/visits?ids=${itemId}&date_from=${f(desde)}&date_to=${f(hasta)}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    const fila = Array.isArray(data) ? data[0] : data;
    return fila?.total_visits != null ? Number(fila.total_visits) : null;
  } catch { return null; }
}

async function traerVentas7d(itemId: string, headers: any, sellerId: string): Promise<number | null> {
  try {
    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${ML_API}/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${desde}&item=${itemId}&limit=50`,
      { headers },
    );
    if (!r.ok) return null;
    const data = await r.json();
    let unidades = 0;
    for (const o of (data?.results || [])) {
      for (const it of (o.order_items || [])) {
        if (it?.item?.id === itemId) unidades += Number(it.quantity || 0);
      }
    }
    return unidades;
  } catch { return null; }
}

async function sincronizarItem(itemId: string, headers: any, supabase: any, sellerId: string): Promise<void> {
  const r = await fetch(`${ML_API}/items/${itemId}`, { headers });
  if (!r.ok) throw new Error(`items HTTP ${r.status}`);
  const item = await r.json();

  const campaign = Array.isArray(item.sale_terms)
    ? item.sale_terms.find((t: any) => t.id === "INSTALLMENTS_CAMPAIGN")
    : null;
  const conCuotas = !!campaign;
  const cuotasN = campaign ? (parseInt(String(campaign.value_name), 10) || 3) : null;

  const precioListaFallback = item.original_price && Number(item.original_price) > Number(item.price)
    ? Number(item.original_price) : Number(item.price);
  const envioGratis = item?.shipping?.free_shipping === true;

  const comisionPromise = (async () => {
    try {
      if (item.price && item.category_id) {
        const rf = await fetch(
          `${ML_API}/sites/MLA/listing_prices?price=${item.price}&listing_type_id=gold_special&category_id=${item.category_id}`,
          { headers },
        );
        if (rf.ok) {
          const fee = await rf.json();
          const f = Array.isArray(fee) ? fee[0] : fee;
          const det = f?.sale_fee_details || {};
          return { monto: f?.sale_fee_amount ?? null, pct: det.percentage_fee ?? null };
        }
      }
    } catch { }
    return null;
  })();

  const [precios, precioPromoRaw, v150, v7, ventas7, envioRaw, comisionRaw] = await Promise.all([
    traerPrecios(itemId, headers),
    traerMayorDescuento(itemId, headers),
    traerVisitas(itemId, 150, headers),
    traerVisitas(itemId, 7, headers),
    traerVentas7d(itemId, headers, sellerId),
    envioGratis ? traerEnvio(itemId, headers) : Promise.resolve(0),
    comisionPromise,
  ]);

  // Precio de lista REAL = standard de /prices; si no está, fallback al viejo criterio.
  const precioLista = precios.standard != null ? precios.standard : precioListaFallback;

  // General: preferimos /prices; si no, el criterio viejo (seller-promotions / item.price).
  let precioPromo = precios.general != null ? precios.general : precioPromoRaw;
  if (item.price && Number(item.price) < precioLista) {
    precioPromo = precioPromo != null ? Math.min(precioPromo, Number(item.price)) : Number(item.price);
  }
  const tienePromo = precioPromo != null && precioPromo < precioLista;

  // Meli+ (buyer_loyalty): solo si existe y es menor que la lista.
  const precioMeli = (precios.meli != null && precios.meli < precioLista) ? precios.meli : null;

  const row: Record<string, unknown> = {
    item_id: itemId,
    titulo: item.title || null,
    listing_type_id: item.listing_type_id || null,
    tipo_publicacion: item.catalog_listing === true ? "catalogo" : "tradicional",
    con_cuotas: conCuotas,
    cuotas_cantidad: cuotasN,
    product_number: item.catalog_product_id || null,
    precio: precioLista,
    precio_con_descuento: tienePromo ? precioPromo : null,
    precio_meli: precioMeli,
    estado: item.status || null,
    activa: item.status === "active",
    envio_gratis: envioGratis,
    ventas_total: item.sold_quantity != null ? Number(item.sold_quantity) : null,
    metricas_en: new Date().toISOString(),
    sincronizado_en: new Date().toISOString(),
    actualizado_en: new Date().toISOString(),
  };
  if (v150 != null) row.visitas_total = v150;
  if (v7 != null) row.visitas_7d = v7;
  if (ventas7 != null) row.ventas_7d = ventas7;
  if (envioRaw != null) row.envio_real = envioRaw;
  if (comisionRaw && comisionRaw.pct != null) {
    row.comision_pct_real = Number(comisionRaw.pct);
    row.comision_real = comisionRaw.monto != null ? Number(comisionRaw.monto) : null;
    row.comision_especial = conCuotas;
  }

  const { error } = await supabase.from("ml_publicaciones").upsert(row, { onConflict: "item_id" });
  if (error) throw new Error(error.message);
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
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let soloItem: string | null = null;
    let debugPromos: string | null = null;
    try {
      const b = await req.json();
      if (b && typeof b.item_id === "string") soloItem = b.item_id;
      if (b && typeof b.debug_promos === "string") debugPromos = b.debug_promos;
    } catch { }
    const token = await asegurarToken(supabase);
    const headers = { "Authorization": `Bearer ${token}` };
    const { data: authRow } = await supabase.from("ml_auth").select("ml_user_id").eq("id", 1).single();
    const sellerId = authRow?.ml_user_id || "";
    if (!sellerId) throw new Error("No hay ml_user_id");

    if (debugPromos) {
      const r = await fetch(`${ML_API}/seller-promotions/items/${debugPromos}?app_version=v2`, { headers });
      const raw = await r.json();
      return new Response(JSON.stringify({ ok: true, status: r.status, promos: raw }), { headers: { ...cors, "content-type": "application/json" } });
    }

    let itemIds: string[];
    let nuevas = 0, eliminadas = 0;
    if (soloItem) itemIds = [soloItem];
    else {
      const mlItems = await traerTodosLosItemIds(sellerId, headers);
      const mlSet = new Set(mlItems);
      const { data: dbPubs } = await supabase.from("ml_publicaciones").select("item_id");
      const dbSet = new Set((dbPubs || []).map((p: any) => p.item_id));
      const toDelete = Array.from(dbSet).filter((id) => !mlSet.has(id));
      nuevas = mlItems.filter((id) => !dbSet.has(id)).length;
      eliminadas = toDelete.length;
      if (toDelete.length > 0) {
        await supabase.from("ml_ads_gasto").delete().in("item_id", toDelete);
        await supabase.from("ml_publicaciones").delete().in("item_id", toDelete);
      }
      itemIds = mlItems;
    }
    let actualizadas = 0;
    const errores: string[] = [];
    for (let i = 0; i < itemIds.length; i += LOTE) {
      const tanda = itemIds.slice(i, i + LOTE);
      const resultados = await Promise.allSettled(tanda.map((id) => sincronizarItem(id, headers, supabase, sellerId)));
      resultados.forEach((res, idx) => {
        if (res.status === "fulfilled") actualizadas++;
        else errores.push(`${tanda[idx]}: ${(res as PromiseRejectedResult).reason?.message || (res as PromiseRejectedResult).reason}`);
      });
    }
    return new Response(JSON.stringify({ ok: true, total: itemIds.length, actualizadas, nuevas, eliminadas, errores: errores.slice(0, 10) }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});
