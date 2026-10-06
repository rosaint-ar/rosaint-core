// ═══════════════════════════════════════════════════════════════════════════
//  Edge Function: ml-ads-campaigns (v3 — ads por campaña vía filters[campaign_id], SOLO LECTURA)
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const SITE_ID = "MLA";

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
    access_token: data.access_token, refresh_token: data.refresh_token,
    token_expira_en: expiraEn, actualizado_en: new Date().toISOString(),
  }).eq("id", 1);
  return data.access_token;
}

async function obtenerAdvertiserId(headers: any, supabase: any): Promise<number> {
  const { data: par } = await supabase.from("ml_parametros").select("valor").eq("clave", "ads_advertiser_id").single();
  if (par && Number(par.valor) > 0) return Number(par.valor);
  const r = await fetch(`${ML_API}/advertising/advertisers?product_id=PADS`, { headers: { ...headers, "Api-Version": "1" } });
  if (!r.ok) throw new Error(`No se pudo obtener advertiser_id (HTTP ${r.status}).`);
  const data = await r.json();
  const advertisers = data?.advertisers || [];
  const mla = advertisers.find((a: any) => a.site_id === SITE_ID) || advertisers[0];
  if (!mla?.advertiser_id) throw new Error("No hay advertiser_id para MLA.");
  return Number(mla.advertiser_id);
}

const f = (d: Date) => d.toISOString().slice(0, 10);

// Lista los ads/items de una campaña usando filters[campaign_id] sobre el endpoint de items del advertiser.
async function adsDeCampania(headers: any, advertiserId: number, campaignId: number, desde: string, hasta: string): Promise<any> {
  const intentos = [
    { v: "items-filters", url: `${ML_API}/advertising/advertisers/${advertiserId}/product_ads/items?limit=50&offset=0&date_from=${desde}&date_to=${hasta}&filters[campaign_id]=${campaignId}&metrics=cost,acos,direct_units_quantity,total_amount` },
    { v: "ads-filters", url: `${ML_API}/advertising/advertisers/${advertiserId}/product_ads/ads?limit=50&offset=0&date_from=${desde}&date_to=${hasta}&filters[campaign_id]=${campaignId}&metrics=cost,acos,direct_units_quantity,total_amount` },
  ];
  let last: any = null;
  for (const intento of intentos) {
    const r = await fetch(intento.url, { headers: { ...headers, "api-version": "2" } });
    if (r.ok) {
      const data = await r.json();
      const arr = data?.results || data?.items || data?.ads || [];
      return {
        endpoint_ok: intento.v,
        total: data?.paging?.total ?? arr.length,
        ads: arr.map((a: any) => ({
          item_id: a.item_id ?? a.id,
          status: a.status,
          title: a.title,
          campaign_id: a.campaign_id,
          cost: a?.metrics?.cost ?? a?.metrics_summary?.cost ?? null,
          acos: a?.metrics?.acos ?? a?.metrics_summary?.acos ?? null,
        })),
      };
    }
    let body: any = null; try { body = await r.json(); } catch { body = await r.text(); }
    last = { endpoint_ok: null, http: r.status, intento: intento.v, body };
  }
  return last;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let conAds = true, soloCampania: number | null = null;
    try {
      const b = await req.json();
      if (b && b.con_ads === false) conAds = false;
      if (b && typeof b.campaign_id === "number") soloCampania = b.campaign_id;
    } catch (_) {}

    const token = await asegurarToken(supabase);
    const headers = { "Authorization": `Bearer ${token}` };
    const advertiserId = await obtenerAdvertiserId(headers, supabase);

    const hasta = new Date();
    const desde = new Date(hasta.getTime() - 30 * 24 * 60 * 60 * 1000);
    const dHasta = f(hasta), dDesde = f(desde);

    const url = `${ML_API}/advertising/advertisers/${advertiserId}/product_ads/campaigns?limit=50&offset=0`;
    const r = await fetch(url, { headers: { ...headers, "api-version": "2" } });
    const raw = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ ok: false, advertiserId, http: r.status, raw }), { status: 200, headers: { ...cors, "content-type": "application/json" } });

    let lista = (raw?.results || []).map((c: any) => ({ id: c.id, name: c.name, status: c.status, budget: c.budget, roas_target: c.roas_target }));
    if (soloCampania) lista = lista.filter((c: any) => c.id === soloCampania);

    if (conAds) {
      for (const c of lista) {
        c.ads = await adsDeCampania(headers, advertiserId, c.id, dDesde, dHasta);
      }
    }

    return new Response(JSON.stringify({ ok: true, advertiserId, rango: { dDesde, dHasta }, total: lista.length, campañas: lista }, null, 2), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});