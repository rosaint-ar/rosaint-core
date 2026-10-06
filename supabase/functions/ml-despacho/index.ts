// ══════════════════════════════════════════════════════════════════
//  Edge Function: ml-despacho  (v3)
//  Lista de PICKING de Mercado Libre agrupada POR PRODUCTO (no por orden).
//  - Ordenes pagas NO entregadas → envios listos que TODAVIA estan en Rosaint.
//  - v3: filtra por SUBSTATUS. status=ready_to_ship persiste aunque el paquete ya
//    haya salido (correo xd_drop_off pasa a picked_up/in_hub sin cambiar status).
//    Solo cuentan los que faltan despachar: substatus vacio, ready_to_print o printed.
//  - SLA (expected_date) por envio → HOY / MANANA / ATRASADO.
//  - Abre combos en componentes con pack_componentes.
// ══════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const SELLER = 157540060;

// Substatus (dentro de ready_to_ship) que significan "todavia lo tengo que despachar".
// Cualquier otro (picked_up, in_hub, dropped_off, in_warehouse, out_for_delivery, delivered, ...) = ya salio.
const PENDIENTES = new Set(["", "ready_to_print", "printed", "ready_to_ship", "invoice_pending"]);

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

// Conserva la variante entre « » (Clasica/Masajes/Natural); saca solo el ruido "Efecto Intenso".
const limpiarNombre = (s: string) =>
  (s || "")
    .replace(/\[COMBO\]/ig, "")
    .replace(/«\s*efecto intenso\s*»/ig, "")
    .replace(/[«»]/g, "")
    .replace(/ - Rosaint.*$/i, "")
    .replace(/Rosaint®?\s*Profesional/ig, "")
    .replace(/\s+/g, " ").trim();

function fechaAR(offsetDias = 0): string {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + offsetDias * 86400000);
  return d.toISOString().slice(0, 10);
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
    const H = { "Authorization": `Bearer ${token}` };
    const get = async (path: string, headers: any = {}) => {
      const r = await fetch(`${ML_API}${path}`, { headers: { ...H, ...headers } });
      if (!r.ok) return null;
      return await r.json();
    };

    const { data: items } = await supabase.from("items").select("codigo, nombre, tipo, sku_externo");
    const { data: comps } = await supabase.from("pack_componentes").select("codigo_pack, codigo_sku, cantidad");
    const nombreDe: Record<string, string> = {};
    const comboBySkuExt: Record<string, string> = {};
    for (const it of (items || [])) {
      nombreDe[it.codigo] = limpiarNombre(it.nombre || it.codigo);
      if (it.tipo === "COMBO" && it.sku_externo) comboBySkuExt[String(it.sku_externo)] = it.codigo;
    }
    const compDePack: Record<string, Array<{ sku: string; cant: number }>> = {};
    for (const c of (comps || [])) {
      (compDePack[c.codigo_pack] ||= []).push({ sku: c.codigo_sku, cant: Number(c.cantidad) || 1 });
    }

    const cand: Record<string, Array<{ sku: string; title: string; qty: number }>> = {};
    for (let page = 0; page < 6; page++) {
      const d = await get(`/orders/search?seller=${SELLER}&order.status=paid&sort=date_desc&limit=50&offset=${page * 50}`);
      const results = d?.results || [];
      let nd = 0;
      for (const o of results) {
        if (!(o.tags || []).includes("not_delivered") || o.fulfilled === true) continue;
        nd++;
        const sid = o.shipping?.id; if (!sid) continue;
        (cand[sid] ||= []);
        for (const it of (o.order_items || [])) {
          cand[sid].push({ sku: String(it.item?.seller_sku || it.item?.id || ""), title: it.item?.title || "", qty: it.quantity || 0 });
        }
      }
      if (results.length < 50) break;
      if (page > 0 && nd === 0) break;
    }

    const hoy = fechaAR(0), manana = fechaAR(1);
    const buckets: Record<string, { paquetes: number; prod: Record<string, number> }> = {
      atrasado: { paquetes: 0, prod: {} },
      hoy: { paquetes: 0, prod: {} },
      manana: { paquetes: 0, prod: {} },
      proximos: { paquetes: 0, prod: {} },
    };

    for (const sid of Object.keys(cand)) {
      const s = await get(`/shipments/${sid}`, { "x-format-new": "true" });
      if (!s || s.status !== "ready_to_ship") continue;
      // Aunque status siga en ready_to_ship, si el substatus indica que ya salio (picked_up,
      // in_hub, dropped_off, ...) NO va a la lista: ya se despacho desde Rosaint.
      const sub = (s.substatus || "").toString();
      if (!PENDIENTES.has(sub)) continue;
      const sla = await get(`/shipments/${sid}/sla`);
      const exp = (sla?.expected_date || "").slice(0, 10);
      let key = "hoy";
      if (!exp) key = "hoy";
      else if (exp < hoy) key = "atrasado";
      else if (exp === hoy) key = "hoy";
      else if (exp === manana) key = "manana";
      else key = "proximos";
      const b = buckets[key];
      b.paquetes++;
      for (const it of cand[sid]) {
        const packCod = comboBySkuExt[it.sku];
        const lineas = packCod && compDePack[packCod]
          ? compDePack[packCod].map((c) => ({ sku: c.sku, qty: c.cant * it.qty }))
          : [{ sku: it.sku, qty: it.qty }];
        for (const l of lineas) b.prod[l.sku] = (b.prod[l.sku] || 0) + l.qty;
      }
    }

    const armar = (b: { paquetes: number; prod: Record<string, number> }) => {
      const productos = Object.entries(b.prod)
        .map(([sku, qty]) => ({ sku, nombre: nombreDe[sku] || sku, qty }))
        .sort((a, z) => z.qty - a.qty);
      const unidades = productos.reduce((s, p) => s + p.qty, 0);
      return { paquetes: b.paquetes, unidades, productos };
    };

    return new Response(JSON.stringify({
      ok: true,
      generado_en: new Date().toISOString(),
      fecha_hoy: hoy, fecha_manana: manana,
      atrasado: armar(buckets.atrasado),
      hoy: armar(buckets.hoy),
      manana: armar(buckets.manana),
      proximos: { paquetes: buckets.proximos.paquetes, unidades: armar(buckets.proximos).unidades },
    }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...cors, "content-type": "application/json" },
    });
  }
});
