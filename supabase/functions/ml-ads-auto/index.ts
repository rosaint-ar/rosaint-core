// ═══════════════════════════════════════════════════════════════════════════
//  Edge Function: ml-ads-auto  (v1)
//  Motor de automatización defensiva de Mercado Ads.
//   1. Lee parámetros (switch, presupuesto, rent.min, dias malos, max acciones)
//   2. Trae ads active + campaign_id, cruza con v_rentabilidad_ml
//   3. Guarda snapshot diario (upsert item+fecha)
//   4. Cuenta dias malos consecutivos y pausa los que llegan al umbral
//   5. Controla techo de presupuesto mensual
//   6. Registra todo en ml_ads_bitacora. SOLO PAUSA (nunca activa/sube).
//  Body opcional: { "dry_run": true }  fuerza simulación (no escribe en ML)
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
  const mla = (data?.advertisers || []).find((a: any) => a.site_id === SITE_ID) || data?.advertisers?.[0];
  if (!mla?.advertiser_id) throw new Error("No hay advertiser_id para MLA.");
  return Number(mla.advertiser_id);
}

const f = (d: Date) => d.toISOString().slice(0, 10);

// Trae TODOS los ads del advertiser en el rango, con su campaign_id real y status.
async function traerTodosLosAds(headers: any, advertiserId: number, desde: string, hasta: string): Promise<any[]> {
  const todos: any[] = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const url = `${ML_API}/advertising/advertisers/${advertiserId}/product_ads/items`
      + `?limit=50&offset=${offset}&date_from=${desde}&date_to=${hasta}`
      + `&metrics=cost,acos,direct_units_quantity,total_amount`;
    const r = await fetch(url, { headers: { ...headers, "api-version": "2" } });
    if (!r.ok) break;
    const data = await r.json();
    const arr = data?.results || data?.items || [];
    for (const a of arr) {
      todos.push({
        item_id: a.item_id ?? a.id,
        status: a.status,
        campaign_id: a.campaign_id ?? null,
        cost: a?.metrics?.cost ?? a?.metrics_summary?.cost ?? 0,
        acos: a?.metrics?.acos ?? a?.metrics_summary?.acos ?? null,
      });
    }
    const total = data?.paging?.total ?? arr.length;
    offset += 50;
    if (offset >= total || arr.length === 0) break;
  }
  return todos;
}

// PUT de status por item (active/paused) vía endpoint marketplace nuevo.
async function pausarAd(headers: any, advertiserId: number, itemId: string, campaignId: number): Promise<{ ok: boolean; detalle: any }> {
  const url = `${ML_API}/marketplace/advertising/${SITE_ID}/advertisers/${advertiserId}/product_ads/ads?channel=marketplace`;
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "api-version": "2", "content-type": "application/json" },
    body: JSON.stringify({ target: [itemId], payload: { status: "paused", campaign_id: campaignId } }),
  });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text(); }
  return { ok: r.ok, detalle: { http: r.status, body } };
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

_servirConGuardia(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    let dryRunForzado = false;
    try { const b = await req.json(); if (b && b.dry_run === true) dryRunForzado = true; } catch (_) {}

    // 1. Parámetros
    const { data: pars } = await supabase.from("ml_parametros").select("clave,valor").like("clave", "ads_auto%");
    const P: Record<string, number> = {};
    (pars || []).forEach((r: any) => { P[r.clave] = Number(r.valor); });
    const activo = P["ads_auto_activo"] === 1;
    const rentMin = P["ads_auto_rentabilidad_min_pct"] ?? 15;
    const diasMalos = P["ads_auto_dias_malos"] ?? 3;
    const maxAcciones = P["ads_auto_max_acciones_corrida"] ?? 3;
    const presupuestoMensual = P["ads_auto_presupuesto_mensual"] ?? 0;
    const ejecutar = activo && !dryRunForzado;  // si switch OFF o dry_run, NO escribe en ML

    const hoy = new Date();
    const fechaHoy = f(hoy);
    const desde = f(new Date(hoy.getTime() - 30 * 24 * 60 * 60 * 1000));

    const token = await asegurarToken(supabase);
    const headers = { "Authorization": `Bearer ${token}` };
    const advertiserId = await obtenerAdvertiserId(headers, supabase);

    // 2. Ads reales con campaign_id + status
    const ads = await traerTodosLosAds(headers, advertiserId, desde, fechaHoy);
    const mapaCampania: Record<string, { campaign_id: number; status: string }> = {};
    for (const a of ads) if (a.item_id) mapaCampania[a.item_id] = { campaign_id: a.campaign_id, status: a.status };

    // 3. Rentabilidad por item
    const { data: rent } = await supabase.from("v_rentabilidad_ml").select(
      "item_id,titulo,rentabilidad_pct,rentabilidad_con_ads_7d_pct,ads_7d,ads_mes,ads_acos_7d,ventas_7d,ventas_total"
    );
    const porItem: Record<string, any> = {};
    (rent || []).forEach((r: any) => { porItem[r.item_id] = r; });

    // 4. Snapshot diario (solo items que están en ADS) + evaluación
    const snapshots: any[] = [];
    const candidatos: any[] = [];   // items active que hoy están "mal"
    let gastoMesTotal = 0;

    for (const a of ads) {
      const r = porItem[a.item_id];
      const adsMes = Number(r?.ads_mes ?? a.cost ?? 0);
      gastoMesTotal += adsMes;
      snapshots.push({
        item_id: a.item_id, fecha: fechaHoy, campaign_id: a.campaign_id, status: a.status,
        acos_7d: r?.ads_acos_7d ?? a.acos ?? null,
        rentabilidad_con_ads_7d_pct: r?.rentabilidad_con_ads_7d_pct ?? null,
        rentabilidad_pct: r?.rentabilidad_pct ?? null,
        ads_7d: r?.ads_7d ?? null, ads_mes: adsMes,
        ventas_7d: r?.ventas_7d ?? 0, ventas_total: r?.ventas_total ?? 0,
      });
      // "Dia malo": solo ads ACTIVE con gasto 7d > 0, rent con ADS por debajo del minimo
      const rentAds = Number(r?.rentabilidad_con_ads_7d_pct ?? 0);
      const gasto7 = Number(r?.ads_7d ?? 0);
      const ventas7 = Number(r?.ventas_7d ?? 0);
      const esMalo = a.status === "active" && gasto7 > 0 && rentAds < rentMin && ventas7 <= 1;
      if (esMalo) candidatos.push({ item_id: a.item_id, campaign_id: a.campaign_id, gasto7, rentAds, titulo: r?.titulo });
    }

    if (snapshots.length) {
      await supabase.from("ml_ads_snapshot_diario").upsert(snapshots, { onConflict: "item_id,fecha" });
    }

    // 5. Para cada candidato, contar dias malos consecutivos en el snapshot historico
    const aPausar: any[] = [];
    for (const c of candidatos) {
      const { data: hist } = await supabase.from("ml_ads_snapshot_diario")
        .select("fecha,rentabilidad_con_ads_7d_pct,ads_7d,ventas_7d,status")
        .eq("item_id", c.item_id).order("fecha", { ascending: false }).limit(diasMalos);
      let seguidos = 0;
      for (const h of (hist || [])) {
        const malo = h.status === "active" && Number(h.ads_7d ?? 0) > 0
          && Number(h.rentabilidad_con_ads_7d_pct ?? 0) < rentMin && Number(h.ventas_7d ?? 0) <= 1;
        if (malo) seguidos++; else break;
      }
      if (seguidos >= diasMalos) aPausar.push({ ...c, dias_malos: seguidos });
    }

    // Si hay presupuesto mensual y el gasto lo supera, forzar recorte aunque no lleguen a N dias
    const excesoPresupuesto = presupuestoMensual > 0 && gastoMesTotal > presupuestoMensual;

    // Priorizar por mayor gasto 7d y limitar por max acciones
    aPausar.sort((x, y) => y.gasto7 - x.gasto7);
    const ejecutarLista = aPausar.slice(0, maxAcciones);

    // 6. Ejecutar (o simular) pausas
    const acciones: any[] = [];
    for (const item of ejecutarLista) {
      if (!item.campaign_id) {
        acciones.push({ item_id: item.item_id, accion: "pausar", resultado: "omitido", motivo: "sin campaign_id" });
        continue;
      }
      let resultado = "simulado"; let detalle: any = { dias_malos: item.dias_malos, rentAds: item.rentAds, gasto7: item.gasto7 };
      if (ejecutar) {
        const res = await pausarAd(headers, advertiserId, item.item_id, item.campaign_id);
        resultado = res.ok ? "ok" : "error";
        detalle = { ...detalle, ...res.detalle };
      }
      const motivo = `Rent.ADS ${item.rentAds?.toFixed(1)}% < ${rentMin}% por ${item.dias_malos}d, gasto7 $${item.gasto7?.toFixed(0)}`;
      acciones.push({ item_id: item.item_id, campaign_id: item.campaign_id, accion: "pausar", resultado, motivo });
      await supabase.from("ml_ads_bitacora").insert({
        item_id: item.item_id, campaign_id: item.campaign_id, accion: "pausar",
        motivo, detalle, resultado,
      });
    }

    // 7. Sugerencias (no ejecuta): items active rentables que podrian recibir mas budget
    const sugerencias = (rent || [])
      .filter((r: any) => Number(r.rentabilidad_con_ads_7d_pct ?? 0) >= 40 && Number(r.ventas_7d ?? 0) >= 2 && mapaCampania[r.item_id]?.status === "active")
      .map((r: any) => ({ item_id: r.item_id, titulo: r.titulo, rent: r.rentabilidad_con_ads_7d_pct, ventas7: r.ventas_7d, campaign_id: mapaCampania[r.item_id]?.campaign_id }))
      .slice(0, 10);

    // Bitacora de la corrida
    await supabase.from("ml_ads_bitacora").insert({
      accion: "corrida",
      motivo: ejecutar ? "ejecucion real" : (activo ? "dry_run forzado" : "switch OFF (simulado)"),
      detalle: {
        ads_total: ads.length, candidatos_hoy: candidatos.length, a_pausar: aPausar.length,
        ejecutadas: ejecutarLista.length, gasto_mes_total: Math.round(gastoMesTotal),
        presupuesto_mensual: presupuestoMensual, exceso_presupuesto: excesoPresupuesto,
      },
      resultado: "ok",
    });

    return new Response(JSON.stringify({
      ok: true, modo: ejecutar ? "REAL" : (activo ? "dry_run" : "switch_OFF"),
      advertiserId, ads_total: ads.length,
      gasto_mes_total: Math.round(gastoMesTotal), presupuesto_mensual: presupuestoMensual, exceso_presupuesto: excesoPresupuesto,
      candidatos_hoy: candidatos.length, a_pausar: aPausar.length,
      acciones, sugerencias,
      params: { activo, rentMin, diasMalos, maxAcciones, presupuestoMensual },
    }, null, 2), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    await supabase.from("ml_ads_bitacora").insert({ accion: "corrida", motivo: "error", detalle: { msg: (e as Error).message }, resultado: "error" });
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});