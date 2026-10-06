// ═════════════════════════════════════════════════════════════════════════
//  Edge Function: ml-ads-sync  (v10 — ruta correcta product_ads/ads/search)
//
//  v9 y anteriores usaban /advertising/product_ads/items/{id}, una ruta que
//  ML dio de baja: devolvía 404 para TODOS los ítems y la función los
//  reseteaba a 0. Resultado: el panel mostraba $0 de pauta siempre.
//
//  v10 usa la ruta que sí anda (probada 20-sep-2026):
//    GET /marketplace/advertising/MLA/advertisers/{id}/product_ads/ads/search
//    GET /marketplace/advertising/MLA/advertisers/{id}/product_ads/campaigns/search
//  con header Api-Version: 2. Una sola llamada por ventana (paginada), no una
//  por ítem. Trae cost/acos/unidades reales + estado del anuncio y de su
//  campaña (activa = anuncio active Y campaña active).
// ═════════════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const SITE_ID = "MLA";
const METRICS = "clicks,prints,cost,acos,ctr,cpc,total_amount,direct_amount,indirect_amount,direct_units_quantity,indirect_units_quantity,organic_units_quantity";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function asegurarToken(supabase: any): Promise<string> {
  const { data: auth, error } = await supabase.from("ml_auth").select("*").eq("id", 1).single();
  if (error || !auth) throw new Error("No hay credenciales de ML.");
  if (!auth.refresh_token) throw new Error("Falta el refresh token. Reconecta ML.");

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
  if (!resp.ok) throw new Error("No se pudo renovar el token: " + JSON.stringify(data));

  const expiraEn = new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString();
  await supabase.from("ml_auth").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expira_en: expiraEn,
    actualizado_en: new Date().toISOString(),
  }).eq("id", 1);
  return data.access_token;
}

async function obtenerAdvertiserId(headers: any, supabase: any): Promise<number> {
  const { data: par } = await supabase.from("ml_parametros").select("valor").eq("clave", "ads_advertiser_id").single();
  if (par && Number(par.valor) > 0) return Number(par.valor);

  const r = await fetch(`${ML_API}/advertising/advertisers?product_id=PADS`, {
    headers: { ...headers, "Api-Version": "1" },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`No se pudo obtener advertiser_id (HTTP ${r.status}). Detalle: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const advertisers = data?.advertisers || [];
  const mla = advertisers.find((a: any) => a.site_id === SITE_ID) || advertisers[0];
  if (!mla?.advertiser_id) throw new Error("No hay advertiser_id para MLA.");

  await supabase.from("ml_parametros").update({ valor: mla.advertiser_id, actualizado_en: new Date().toISOString() })
    .eq("clave", "ads_advertiser_id");
  return Number(mla.advertiser_id);
}

function primerDiaMes(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
const fISO = (d: Date) => d.toISOString().slice(0, 10);


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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let debug = false;
    try { const b = await req.json(); if (b && b.debug === true) debug = true; } catch (_) { }

    const token = await asegurarToken(supabase);
    const headers = { "Authorization": `Bearer ${token}` };
    const advertiserId = await obtenerAdvertiserId(headers, supabase);
    const base = `${ML_API}/marketplace/advertising/${SITE_ID}/advertisers/${advertiserId}/product_ads`;

    const hoy = new Date();
    const desdeMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
    const desde7 = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);
    const periodo = primerDiaMes(hoy);

    // ── Campañas: id → estado ────────────────────────────────────────────
    const campEstado: Record<string, string> = {};
    {
      const url = `${base}/campaigns/search?date_from=${fISO(desdeMes)}&date_to=${fISO(hoy)}&limit=100`;
      const r = await fetch(url, { headers: { ...headers, "Api-Version": "2" } });
      if (r.ok) {
        const d = await r.json();
        for (const c of (d.results || [])) campEstado[String(c.id)] = c.status;
      }
    }

    // ── Anuncios: trae todas las páginas de una ventana ──────────────────
    async function traerAds(dDesde: Date, dHasta: Date): Promise<any[]> {
      const out: any[] = [];
      let offset = 0;
      for (let i = 0; i < 20; i++) {
        const url = `${base}/ads/search?date_from=${fISO(dDesde)}&date_to=${fISO(dHasta)}`
          + `&limit=50&offset=${offset}&metrics=${METRICS}`;
        const r = await fetch(url, { headers: { ...headers, "Api-Version": "2" } });
        if (!r.ok) { if (i === 0) throw new Error(`ads/search HTTP ${r.status}: ${(await r.text()).slice(0,150)}`); break; }
        const d = await r.json();
        const res = d.results || [];
        out.push(...res);
        const total = d.paging?.total ?? out.length;
        offset += 50;
        if (offset >= total || res.length === 0) break;
      }
      return out;
    }

    const adsMes = await traerAds(desdeMes, hoy);
    const ads7 = await traerAds(desde7, hoy);

    if (debug) {
      const a = adsMes[0];
      return new Response(JSON.stringify({ ok: true, advertiserId, campañas: campEstado, ads_mes: adsMes.length, muestra: a }), {
        status: 200, headers: { ...cors, "content-type": "application/json" },
      });
    }

    const map7: Record<string, any> = {};
    for (const a of ads7) map7[a.item_id] = a.metrics || {};

    const { data: pubs } = await supabase.from("ml_publicaciones").select("item_id");
    const itemsPub = new Set((pubs || []).map((p: any) => p.item_id));

    const num = (v: any) => (v == null || isNaN(Number(v))) ? 0 : Number(v);
    const rows: any[] = [];
    const vistos = new Set<string>();

    for (const a of adsMes) {
      const m = a.metrics || {};
      const m7 = map7[a.item_id] || {};
      const campId = a.campaign_id != null ? Number(a.campaign_id) : null;
      const campSt = campId != null ? campEstado[String(campId)] : undefined;
      vistos.add(a.item_id);
      rows.push({
        item_id: a.item_id,
        periodo,
        costo: num(m.cost),
        clicks: num(m.clicks),
        impresiones: num(m.prints),
        acos: m.acos != null ? num(m.acos) : null,
        roas: num(m.cost) > 0 ? Math.round(num(m.total_amount) / num(m.cost) * 100) / 100 : null,
        ventas_directas: num(m.direct_units_quantity) + num(m.indirect_units_quantity),
        ventas_monto: num(m.total_amount),
        costo_7d: num(m7.cost),
        acos_7d: m7.acos != null ? num(m7.acos) : null,
        ventas_monto_7d: num(m7.total_amount),
        ventas_unidades_7d: num(m7.direct_units_quantity) + num(m7.indirect_units_quantity),
        ventas_organicas_7d: num(m7.organic_units_quantity),
        estado_anuncio: a.status || null,
        campana_id: campId,
        campana_activa: campSt != null ? (campSt === "active") : null,
        actualizado_en: new Date().toISOString(),
      });
    }

    // Ítems publicados que NO aparecen en ninguna campaña → gasto 0 real.
    for (const itemId of itemsPub) {
      if (vistos.has(itemId)) continue;
      rows.push({
        item_id: itemId, periodo, costo: 0, clicks: 0, impresiones: 0, acos: null, roas: null,
        ventas_directas: 0, ventas_monto: 0, costo_7d: 0, acos_7d: null, ventas_monto_7d: 0,
        ventas_unidades_7d: 0, ventas_organicas_7d: 0, estado_anuncio: null,
        campana_id: null, campana_activa: null, actualizado_en: new Date().toISOString(),
      });
    }

    let guardadas = 0, conGasto = 0;
    const errores: string[] = [];
    for (let i = 0; i < rows.length; i += 100) {
      const lote = rows.slice(i, i + 100);
      const { error } = await supabase.from("ml_ads_gasto").upsert(lote, { onConflict: "item_id,periodo" });
      if (error) errores.push(error.message);
      else { guardadas += lote.length; conGasto += lote.filter((r) => r.costo > 0).length; }
    }

    const gastoMes = Math.round(rows.reduce((s, r) => s + r.costo, 0));
    return new Response(JSON.stringify({
      ok: true, advertiserId, periodo, anuncios: adsMes.length,
      guardadas, conGasto, gastoMes, campañas: campEstado, errores: errores.slice(0, 10),
    }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...cors, "content-type": "application/json" },
    });
  }
});
