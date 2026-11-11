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

async function traerItemsDePromo(promoId: string, tipo: string, headers: any): Promise<Map<string, { price: number | null; original_price: number | null; estado: string | null; raw: any }>> {
  const mapa = new Map<string, { price: number | null; original_price: number | null; estado: string | null; raw: any }>();
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
        mapa.set(id, { price, original_price: orig, estado: it.status || null, raw: it });
      }
    }
    const total = data?.paging?.total ?? results.length;
    offset += 50;
    if (offset >= total || results.length === 0) break;
  }
  return mapa;
}


async function _proxySecretBase(): Promise<string> {
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await sb.from("ml_config").select("valor").eq("clave", "proxy_secret").maybeSingle();
    return data?.valor || "";
  } catch { return ""; }
}

// ===================================================================================================
// PROMOS AUTOMÁTICAS (nov-2026). Barre las campañas que ML ofrece y entra solo a las que respetan los
// topes de descuento de Rosaint (ml_reglas_descuento: desc_meli_pct = tope; desc_general_pct = el
// descuento general de la grilla). Lo que se pasa del tope por pocos puntos (ml_parametros
// promos_tolerancia_pts) queda "a_decidir" y avisa por mail; lo que se pasa más, "fuera_de_tope".
//  · DEAL: precio general = min(lista × (1 − general%), máximo que pide ML); Meli+ = lista × (1 − tope%)
//    si queda ≥3% abajo del general (regla de ML), si no, sin Meli+ (queda el de la otra promo).
//    Se compara el descuento general contra el tope.
//  · SMART (ofertas compartidas): ML fija el precio; se compara la parte del vendedor contra el tope.
//  · Relámpago y otras: no se tocan (no_soportado).
// Registro en ml_promos_auto (una fila por campaña y producto; lo rechazado no se vuelve a proponer).
// ===================================================================================================
const AVISO_A = "rosaint.ar@gmail.com";
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const r2 = (n: number) => Math.round(n * 100) / 100;

function tamanoDe(titulo: string): string | null {
  const t = (titulo || "").toLowerCase();
  if (/combo/.test(t)) return /crema/.test(t) ? "combo-crema" : "combo-gel";
  if (/\b10\s*kg/.test(t)) return "10kg";
  if (/\b4\s*kg/.test(t)) return "4kg";
  if (/\b1\s*kg/.test(t)) return "1kg";
  if (/500\s*g/.test(t)) return "500g";
  return null;
}

async function entrarAPromo(headers: any, itemId: string, body: Record<string, unknown>) {
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(`${ML_API}/seller-promotions/items/${itemId}?app_version=v2`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const t = await r.text();
    if (r.ok) return { ok: true, status: r.status, data: t };
    // 500 suelto de ML o "No candidates found" justo después de otro cambio: esperar y reintentar
    if (r.status >= 500 || /No candidates found/i.test(t)) { await espera(8000); continue; }
    return { ok: false, status: r.status, data: t.slice(0, 300) };
  }
  return { ok: false, status: 500, data: "ML devolvió error 3 veces seguidas" };
}

function cuerpoDeEntrada(p: any) {
  if (p.tipo === "SMART") return { promotion_id: p.promo_id, promotion_type: "SMART", offer_id: p.offer_id };
  const b: any = { promotion_id: p.promo_id, promotion_type: "DEAL", deal_price: Number(p.precio_general) };
  if (p.precio_meli && Number(p.precio_meli) <= Number(p.precio_general) * 0.97) b.top_deal_price = Number(p.precio_meli);
  return b;
}

async function barrerPromos(supabase: any, headers: any, sellerId: string, aplicar: boolean) {
  const par = async (k: string, d: number) => {
    const { data } = await supabase.from("ml_parametros").select("valor").eq("clave", k).maybeSingle();
    return data?.valor != null ? Number(data.valor) : d;
  };
  const auto = (await par("promos_auto", 0)) === 1;
  const tol = await par("promos_tolerancia_pts", 3);
  const { data: reglas } = await supabase.from("ml_reglas_descuento").select("*");
  const regla = new Map((reglas || []).map((x: any) => [x.tamano, x]));
  const { data: pubs } = await supabase.from("ml_publicaciones").select("item_id,titulo,activa");
  const pub = new Map((pubs || []).map((x: any) => [x.item_id, x]));
  const { data: previas } = await supabase.from("ml_promos_auto").select("promo_id,item_id,estado");
  const yaVisto = new Map((previas || []).map((x: any) => [`${x.promo_id}|${x.item_id}`, x.estado]));

  const rc = await fetch(`${ML_API}/seller-promotions/users/${sellerId}?app_version=v2`, { headers });
  if (!rc.ok) throw new Error(`seller-promotions/users HTTP ${rc.status}`);
  const campanias: any[] = (await rc.json())?.results || [];
  const res = { auto, aplicadas: 0, a_decidir: 0, fuera_de_tope: 0, errores: 0, nuevas_a_decidir: [] as any[], aplicadas_lista: [] as any[] };

  for (const c of campanias) {
    if (!["started", "pending"].includes(c.status)) continue;
    let mapa;
    try { mapa = await traerItemsDePromo(c.id, c.type, headers); } catch { continue; }
    for (const [itemId, v] of mapa) {
      if (v.estado !== "candidate") continue;               // ya estamos adentro
      const p = pub.get(itemId);
      if (!p || p.activa === false) continue;               // solo publicaciones activas
      const clave = `${c.id}|${itemId}`;
      const previo = yaVisto.get(clave);
      if (previo && previo !== "error") continue;           // ya propuesta/decidida antes
      const tam = tamanoDe(p.titulo || v.raw?.title || "");
      const rg: any = tam ? regla.get(tam) : null;
      const it = v.raw || {};
      const lista = Number(it.original_price || v.original_price || 0);
      const fila: any = {
        promo_id: c.id, promo_nombre: c.name || c.id, tipo: c.type, promo_inicio: c.start_date || null, promo_fin: c.finish_date || null,
        item_id: itemId, titulo: p.titulo, tamano: tam, precio_lista: lista || null, actualizado_en: new Date().toISOString(),
      };
      if (!rg || !lista) { fila.estado = "no_soportado"; fila.detalle = "Sin regla de descuento para este producto"; }
      else if (c.type === "SMART") {
        const s = Number(it.seller_percentage ?? NaN);
        if (!isFinite(s) || !it.offer_id) { fila.estado = "no_soportado"; fila.detalle = "ML no informa la parte del vendedor"; }
        else {
          fila.seller_pct = s; fila.desc_pct = r2(s + Number(it.meli_percentage || 0)); fila.tope_pct = Number(rg.desc_meli_pct);
          fila.precio_general = it.price ? Number(it.price) : null; fila.offer_id = it.offer_id;
          fila.exceso_pts = r2(s - fila.tope_pct);
        }
      } else if (c.type === "DEAL") {
        const g = Number(rg.desc_general_pct), m = Number(rg.desc_meli_pct);
        const mx = it.max_discounted_price != null ? Math.floor(Number(it.max_discounted_price)) : Infinity;
        const mn = it.min_discounted_price != null ? Number(it.min_discounted_price) : 0;
        const general = Math.min(Math.round(lista * (1 - g / 100)), mx);
        const meli = Math.round(lista * (1 - m / 100));
        fila.precio_general = general; fila.precio_meli = meli <= general * 0.97 ? meli : null;
        fila.desc_pct = r2(100 * (1 - general / lista)); fila.tope_pct = m;
        fila.exceso_pts = r2(fila.desc_pct - m);
        if (general < mn) { fila.estado = "no_soportado"; fila.detalle = "ML pide un precio mínimo más alto"; }
      } else { fila.estado = "no_soportado"; fila.detalle = `Tipo ${c.type}: se gestiona a mano`; }

      if (!fila.estado) {
        if (fila.exceso_pts <= 0.05) fila.estado = auto && aplicar ? "aplicar" : "a_decidir";
        else if (fila.exceso_pts <= tol) fila.estado = "a_decidir";
        else fila.estado = "fuera_de_tope";
        if (fila.estado === "a_decidir" && fila.exceso_pts <= 0.05) fila.detalle = "Dentro del tope (automático apagado)";
        else if (fila.estado === "a_decidir") fila.detalle = `Se pasa ${fila.exceso_pts} pts del tope`;
        else if (fila.estado === "fuera_de_tope") fila.detalle = `Se pasa ${fila.exceso_pts} pts del tope (más que la tolerancia de ${tol})`;
      }
      if (fila.estado === "aplicar") {
        const e = await entrarAPromo(headers, itemId, cuerpoDeEntrada(fila));
        fila.estado = e.ok ? "aplicada" : "error";
        fila.detalle = e.ok ? "Aplicada sola: dentro del tope" : `ML ${e.status}: ${e.data}`;
        if (e.ok) { res.aplicadas++; res.aplicadas_lista.push(fila); fila.decidido_en = new Date().toISOString(); } else res.errores++;
        await espera(2500); // de a una: en paralelo ML devuelve 500
      }
      if (fila.estado === "a_decidir") { res.a_decidir++; if (!previo) res.nuevas_a_decidir.push(fila); }
      if (fila.estado === "fuera_de_tope") res.fuera_de_tope++;
      await supabase.from("ml_promos_auto").upsert(fila, { onConflict: "promo_id,item_id" });
    }
  }
  if (res.nuevas_a_decidir.length || res.aplicadas_lista.length) await avisarPromos(supabase, res);
  return { ...res, nuevas_a_decidir: res.nuevas_a_decidir.length, aplicadas_lista: undefined };
}

async function avisarPromos(supabase: any, res: any) {
  const fmt = (n: any) => n == null ? "—" : Number(n).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  const filas = (xs: any[], conExceso: boolean) => xs.map((f) => `<tr><td>${esc(f.promo_nombre)}</td><td>${esc(f.titulo)}</td><td style="text-align:right">$${fmt(f.precio_general)}</td><td style="text-align:right">${f.tipo === "SMART" ? `vos ponés ${f.seller_pct}%` : `${f.desc_pct}%`}</td><td style="text-align:right">tope ${f.tope_pct}%</td>${conExceso ? `<td style="text-align:right;color:#b45309"><b>+${f.exceso_pts} pts</b></td>` : ""}</tr>`).join("");
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">`;
  if (res.nuevas_a_decidir.length) html += `<p><b>Promos de Mercado Libre para decidir</b> (se pasan un poco del tope):</p><table cellpadding="6" style="border-collapse:collapse;font-size:13px">${filas(res.nuevas_a_decidir, true)}</table>`;
  if (res.aplicadas_lista.length) html += `<p><b>Promos aplicadas solas</b> (dentro del tope):</p><table cellpadding="6" style="border-collapse:collapse;font-size:13px">${filas(res.aplicadas_lista, false)}</table>`;
  html += `<p>Aprobalas o rechazalas en el Core: Canales → Mercado Libre → Promociones → Automático.<br><a href="https://rosaint-ar.github.io/rosaint-core/comercial/canales.html#ml">Abrir el Core</a></p></div>`;
  const asunto = res.nuevas_a_decidir.length ? `ML: ${res.nuevas_a_decidir.length} promo(s) para decidir` : `ML: ${res.aplicadas_lista.length} promo(s) aplicadas solas`;
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/odoo-enviar-mail`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ to: AVISO_A, subject: asunto, body_html: html }),
    });
    const ids = [...res.nuevas_a_decidir, ...res.aplicadas_lista].map((f: any) => `${f.promo_id}|${f.item_id}`);
    for (const k of ids) { const [p, i] = k.split("|"); await supabase.from("ml_promos_auto").update({ avisado_en: new Date().toISOString() }).eq("promo_id", p).eq("item_id", i); }
  } catch (_) { /* el aviso no frena */ }
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
  if (proxy && proxy === await _proxySecretBase()) return true; // el mismo secreto que usa ml-api (tabla ml_config; lo usa el cron)
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
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* body vacío = sincronizar */ }
    const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "content-type": "application/json" } });

    // ── Promos automáticas ──
    if (body.accion === "barrer") return ok({ ok: true, ...(await barrerPromos(supabase, headers, sellerId, body.aplicar !== false)) });
    if (body.accion === "aprobar" || body.accion === "rechazar") {
      const { data: f } = await supabase.from("ml_promos_auto").select("*").eq("id", Number(body.id)).maybeSingle();
      if (!f) return ok({ ok: false, error: "No existe esa propuesta" });
      if (!["a_decidir", "fuera_de_tope", "error"].includes(f.estado)) return ok({ ok: false, error: `Ya está ${f.estado}` });
      if (body.accion === "rechazar") {
        await supabase.from("ml_promos_auto").update({ estado: "rechazada", decidido_en: new Date().toISOString(), actualizado_en: new Date().toISOString() }).eq("id", f.id);
        return ok({ ok: true });
      }
      const e = await entrarAPromo(headers, f.item_id, cuerpoDeEntrada(f));
      await supabase.from("ml_promos_auto").update({
        estado: e.ok ? "aplicada" : "error", origen: "aprobada", detalle: e.ok ? `Aprobada a mano (${f.detalle || ""})` : `ML ${e.status}: ${e.data}`,
        decidido_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
      }).eq("id", f.id);
      return ok({ ok: e.ok, error: e.ok ? null : `ML ${e.status}: ${e.data}` });
    }
    if (body.accion === "aplicar_lote") {
      // [{item_id, promo_id, tipo:'DEAL'|'SMART', deal_price?, top_deal_price?, offer_id?, nota?}] de a uno, con registro
      const out: any[] = [];
      for (const x of (body.items || []).slice(0, 40)) {
        const fila = { promo_id: x.promo_id, tipo: x.tipo, precio_general: x.deal_price ?? null, precio_meli: x.top_deal_price ?? null, offer_id: x.offer_id ?? null };
        const e = await entrarAPromo(headers, x.item_id, cuerpoDeEntrada(fila));
        await supabase.from("ml_promos_auto").upsert({
          ...fila, item_id: x.item_id, promo_nombre: x.promo_nombre || x.promo_id, titulo: x.titulo || null, estado: e.ok ? "aplicada" : "error", origen: "manual",
          detalle: e.ok ? (x.nota || "Cargada a mano") : `ML ${e.status}: ${e.data}`, decidido_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
        }, { onConflict: "promo_id,item_id" });
        out.push({ item_id: x.item_id, ok: e.ok, status: e.status, data: e.ok ? undefined : e.data });
        await espera(2500);
      }
      return ok({ ok: out.every((o) => o.ok), resultados: out });
    }

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
            estado: v.estado, // started/pending = adentro · candidate = ML lo ofrece y no entramos
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
