// ml-promos-sync v1: trae las campañas de promoción del vendedor
// (GET /seller-promotions/users/{id}) + los productos de cada una, y los guarda
// en ml_promos / ml_promo_items. Para el panel de Promociones (Canales -> ML).
// Reemplaza el set completo en cada corrida: las que ML ya no devuelve (terminadas)
// se borran. body {} = todo.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;

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

async function traerItemsDePromo(promoId: string, tipo: string, headers: any): Promise<Map<string, { price: number | null; original_price: number | null }>> {
  const mapa = new Map<string, { price: number | null; original_price: number | null }>();
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const url = `${ML_API}/seller-promotions/promotions/${promoId}/items?promotion_type=${encodeURIComponent(tipo)}&app_version=v2&limit=50&offset=${offset}`;
    const r = await fetch(url, { headers });
    // si falla una página se corta: con la lista a medias se borrarían productos que siguen en la promo
    if (!r.ok) throw new Error(`items de ${promoId} página ${page + 1}: HTTP ${r.status} (se dejan los que estaban)`);
    const data = await r.json();
    const results: any[] = data?.results || [];
    for (const it of results) {
      const id = it.id;
      if (!id) continue;
      const price = it.price != null ? Number(it.price) : null;
      const orig = it.original_price != null ? Number(it.original_price) : null;
      const prev = mapa.get(id);
      // Nos quedamos con el precio de promo más bajo visto para ese item.
      if (!prev || (price != null && (prev.price == null || price < prev.price))) {
        mapa.set(id, { price, original_price: orig });
      }
    }
    const total = data?.paging?.total ?? results.length;
    offset += 50;
    if (offset >= total || results.length === 0) break;
  }
  return mapa;
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
    const token = await asegurarToken(supabase);
    const headers = { "Authorization": `Bearer ${token}` };
    const { data: authRow } = await supabase.from("ml_auth").select("ml_user_id").eq("id", 1).single();
    const sellerId = authRow?.ml_user_id || "";
    if (!sellerId) throw new Error("No hay ml_user_id");

    // 1) Campañas del vendedor
    const rc = await fetch(`${ML_API}/seller-promotions/users/${sellerId}?app_version=v2`, { headers });
    if (!rc.ok) throw new Error(`seller-promotions/users HTTP ${rc.status}`);
    const campData = await rc.json();
    const campanias: any[] = campData?.results || [];
    // si ML devolvió la lista incompleta, no se borra ninguna campaña "que ya no está"
    const listaCompleta = (campData?.paging?.total ?? campanias.length) <= campanias.length;

    const idsVigentes: string[] = [];
    let itemsGuardados = 0;
    const errores: string[] = [];

    for (const c of campanias) {
      if (!c.id) continue;
      idsVigentes.push(c.id);
      const { error: eUp } = await supabase.from("ml_promos").upsert({
        id: c.id,
        tipo: c.type || null,
        nombre: c.name || null,
        estado: c.status || null,
        start_date: c.start_date || null,
        finish_date: c.finish_date || null,
        deadline_date: c.deadline_date || null,
        sincronizado_en: new Date().toISOString(),
      }, { onConflict: "id" });
      if (eUp) { errores.push(`${c.id}: ${eUp.message}`); continue; }

      // 2) Productos de la campaña (best-effort)
      try {
        const mapa = await traerItemsDePromo(c.id, c.type, headers);
        // Primero se guardan los nuevos y DESPUÉS se sacan los que ya no están (si algo falla en el medio,
        // la promo no queda vacía).
        if (mapa.size > 0) {
          const filas = Array.from(mapa.entries()).map(([item_id, v]) => ({
            promo_id: c.id,
            item_id,
            price: v.price,
            original_price: v.original_price,
            sincronizado_en: new Date().toISOString(),
          }));
          const { error: eIt } = await supabase.from("ml_promo_items").upsert(filas, { onConflict: "promo_id,item_id" });
          if (eIt) { errores.push(`${c.id} items: ${eIt.message}`); continue; }
          itemsGuardados += filas.length;
        }
        const vigentesIt = Array.from(mapa.keys());
        let del = supabase.from("ml_promo_items").delete().eq("promo_id", c.id);
        if (vigentesIt.length) del = del.not("item_id", "in", `(${vigentesIt.map((x) => `"${x}"`).join(",")})`);
        await del;
      } catch (e) {
        errores.push(`${c.id} items: ${(e as Error).message}`);
      }
    }

    // 3) Borrar campañas que ML ya no devuelve (terminadas/removidas). Cascade borra sus items.
    let eliminadas = 0;
    const { data: existentes } = await supabase.from("ml_promos").select("id");
    const aBorrar = (existentes || []).map((p: any) => p.id).filter((id: string) => !idsVigentes.includes(id));
    if (aBorrar.length > 0 && listaCompleta) {
      await supabase.from("ml_promos").delete().in("id", aBorrar);
      eliminadas = aBorrar.length;
    }

    return new Response(JSON.stringify({
      ok: true,
      promos: idsVigentes.length,
      items: itemsGuardados,
      eliminadas,
      errores: errores.slice(0, 10),
    }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});
