import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== tn-eventos (v1, 01-11-2026) ======
// Eventos de Tienda Nube (CyberMonday, Black Friday…) armados en Core → Tienda Nube → Eventos.
// El descuento de cada producto se escribe como precio promocional NATIVO de Tienda Nube (se ve tachado en la web,
// el checkout y Google) y al terminar se vuelve al precio que tenía. Tablas tn_eventos / tn_evento_items.
// Acciones (POST JSON):
//   { accion: "ensayo",   evento_id }  calcula qué haría sin escribir nada
//   { accion: "aplicar",  evento_id }  escribe los precios del evento (lo usa también el reloj)
//   { accion: "revertir", evento_id }  vuelve cada producto a su precio anterior, si nadie lo cambió en el medio
//   { accion: "estado",   evento_id }  compara la tienda con lo esperado
//   { accion: "tick" }                 reloj (cron cada minuto): arranca y termina eventos programados en su hora
// Nunca sube un precio: si el precio del evento no mejora el actual, el producto queda «omitido».

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Rosaint Core (rosaint.ar@gmail.com)";
type Rec = Record<string, any>;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
const sbH = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const igual = (a: number | null, b: number | null) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 0.005);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function sb(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init.headers || {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Core ${r.status}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}
const patch = (path: string, body: Rec, ret = false) =>
  sb(path, { method: "PATCH", headers: { Prefer: ret ? "return=representation" : "return=minimal" }, body: JSON.stringify(body) });

async function tn(store: number, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  for (let intento = 0; intento < 5; intento++) {
    const r = await fetch(`https://api.tiendanube.com/v1/${store}${path}`, {
      method, headers: { Authentication: `bearer ${token}`, "User-Agent": UA, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { await sleep(1500 * (intento + 1)); continue; }
    const txt = await r.text();
    let data: any = txt; try { data = JSON.parse(txt); } catch { /* texto */ }
    return { status: r.status, data };
  }
  return { status: 429, data: "Tienda Nube limitó los pedidos (429) después de 5 intentos" };
}

async function token(store: number): Promise<string> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tn_token_interno`, { method: "POST", headers: sbH, body: JSON.stringify({ p_store: store }) });
  if (!r.ok) throw new Error(`No pude leer el acceso de la tienda (${r.status})`);
  const t = await r.json();
  if (!t) throw new Error("No hay acceso guardado para la tienda");
  return t;
}

// Variantes de la tienda por SKU (precio de lista y promocional actuales).
async function variantes(store: number, tk: string): Promise<Map<string, Rec>> {
  const out = new Map<string, Rec>();
  for (let page = 1; page <= 10; page++) {
    const r = await tn(store, tk, "GET", `/products?per_page=200&page=${page}&fields=id,name,published,variants`);
    if (r.status === 404) break;
    if (r.status !== 200) throw new Error(`Tienda Nube ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    for (const p of r.data) for (const v of p.variants || []) {
      const sku = String(v.sku || "").trim();
      if (sku && !out.has(sku)) out.set(sku, { product_id: p.id, variant_id: v.id, nombre: p.name?.es || "", publicado: p.published, price: num(v.price), promo: num(v.promotional_price) });
    }
    if (r.data.length < 200) break;
  }
  return out;
}

// Precio promocional del evento según el modo frente a la promo vigente. null = no mejora el precio actual.
function precioEvento(modo: string, price: number, promo: number | null, pct: number): number | null {
  const f = 1 - pct / 100;
  let p = modo === "suma" ? (promo ?? price) * f : modo === "mejor" ? Math.min(promo ?? Infinity, price * f) : price * f;
  p = r2(p);
  const actual = promo ?? price;
  return p < actual - 0.005 ? p : null;
}

async function plan(ev: Rec, tk: string) {
  const items: Rec[] = await sb(`tn_evento_items?select=*&evento_id=eq.${ev.id}&order=sku`);
  const tienda = await variantes(ev.store_id, tk);
  return items.map((it) => {
    const v = tienda.get(it.sku);
    if (!v) return { it, v: null, accion: "omitir", motivo: "No está en Tienda Nube" };
    if (it.estado === "aplicado") return { it, v, accion: "ya", motivo: "Ya aplicado" };
    const p = precioEvento(ev.modo_promo, v.price, v.promo, it.descuento_pct);
    if (p === null) return { it, v, accion: "omitir", motivo: "El evento no mejora el precio que ya tiene" };
    return { it, v, accion: "aplicar", promo_evento: p };
  });
}

async function aplicar(ev: Rec) {
  const tk = await token(ev.store_id);
  const filas: Rec[] = await plan(ev, tk);
  let escritos = 0; const errores: Rec[] = [];
  for (const f of filas) {
    const base = { product_id: f.v?.product_id ?? null, variant_id: f.v?.variant_id ?? null, nombre: f.it.nombre || f.v?.nombre || null };
    if (f.accion === "omitir") { await patch(`tn_evento_items?id=eq.${f.it.id}`, { ...base, estado: "omitido", detalle: f.motivo }); continue; }
    if (f.accion !== "aplicar") continue;
    const r = await tn(ev.store_id, tk, "PUT", `/products/${f.v.product_id}/variants/${f.v.variant_id}`, { promotional_price: String(f.promo_evento) });
    const ok = r.status >= 200 && r.status < 300;
    await patch(`tn_evento_items?id=eq.${f.it.id}`, ok
      ? { ...base, price_antes: f.v.price, promo_antes: f.v.promo, promo_evento: f.promo_evento, estado: "aplicado", aplicado_en: new Date().toISOString(), detalle: null }
      : { ...base, estado: "error", detalle: `${r.status} ${JSON.stringify(r.data).slice(0, 250)}` });
    if (ok) escritos++; else errores.push({ sku: f.it.sku, status: r.status });
    await sleep(350); // Tienda Nube admite ~2 pedidos por segundo sostenidos
  }
  await patch(`tn_eventos?id=eq.${ev.id}`, { aplicado_en: new Date().toISOString(), actualizado_en: new Date().toISOString() });
  return { escritos, errores, verificacion: await estado(ev, tk) };
}

async function revertir(ev: Rec) {
  const tk = await token(ev.store_id);
  const items: Rec[] = await sb(`tn_evento_items?select=*&evento_id=eq.${ev.id}&estado=eq.aplicado`);
  const tienda = await variantes(ev.store_id, tk);
  let vueltos = 0; const conflictos: Rec[] = [], errores: Rec[] = [];
  for (const it of items) {
    const v = tienda.get(it.sku);
    // Solo se toca si sigue exactamente como lo dejó el evento: si alguien cambió el precio en el medio, gana lo de esa persona.
    if (!v || !igual(v.promo, num(it.promo_evento)) || !igual(v.price, num(it.price_antes))) {
      const detalle = !v ? "Ya no está en Tienda Nube" : `Cambió durante el evento: lista ${v.price}, promo ${v.promo ?? "sin promo"}`;
      await patch(`tn_evento_items?id=eq.${it.id}`, { estado: "conflicto", detalle });
      conflictos.push({ sku: it.sku, detalle }); continue;
    }
    const antes = num(it.promo_antes);
    const r = await tn(ev.store_id, tk, "PUT", `/products/${it.product_id}/variants/${it.variant_id}`, { promotional_price: antes === null ? null : String(antes) });
    const ok = r.status >= 200 && r.status < 300;
    await patch(`tn_evento_items?id=eq.${it.id}`, ok ? { estado: "revertido", revertido_en: new Date().toISOString(), detalle: null }
      : { detalle: `No pude volver: ${r.status} ${JSON.stringify(r.data).slice(0, 250)}` });
    if (ok) vueltos++; else errores.push({ sku: it.sku, status: r.status });
    await sleep(350);
  }
  await patch(`tn_eventos?id=eq.${ev.id}`, { revertido_en: new Date().toISOString(), actualizado_en: new Date().toISOString() });
  return { vueltos, conflictos, errores };
}

// Compara la tienda con lo que el evento espera de cada producto.
async function estado(ev: Rec, tk?: string) {
  tk = tk || await token(ev.store_id);
  const items: Rec[] = await sb(`tn_evento_items?select=*&evento_id=eq.${ev.id}&order=sku`);
  const tienda = await variantes(ev.store_id, tk);
  const cuenta: Rec = {}; const distintos: Rec[] = [];
  for (const it of items) {
    cuenta[it.estado] = (cuenta[it.estado] || 0) + 1;
    if (it.estado !== "aplicado") continue;
    const v = tienda.get(it.sku);
    if (!v || !igual(v.promo, num(it.promo_evento))) distintos.push({ sku: it.sku, esperado: num(it.promo_evento), tienda: v?.promo ?? null });
  }
  return { productos: items.length, por_estado: cuenta, aplicados_distintos: distintos };
}

async function evento(id: number): Promise<Rec> {
  const [ev] = await sb(`tn_eventos?select=*&id=eq.${Number(id)}`);
  if (!ev) throw new Error("No encontré el evento");
  return ev;
}

// Reloj: arranca los programados al llegar `desde` y termina los activos al llegar `hasta`.
// El cambio de estado se «reserva» con un PATCH condicional, así dos relojes no aplican lo mismo a la vez.
async function tick() {
  const ahora = new Date().toISOString(), hecho: Rec[] = [];
  const arrancar: Rec[] = await sb(`tn_eventos?select=*&estado=eq.programado&desde=lte.${ahora}&hasta=gt.${ahora}`);
  for (const ev of arrancar) {
    const [tomado] = await patch(`tn_eventos?id=eq.${ev.id}&estado=eq.programado`, { estado: "activo" }, true) || [];
    if (tomado) hecho.push({ evento: ev.id, arranco: await aplicar(tomado) });
  }
  const vencidos: Rec[] = await sb(`tn_eventos?select=*&estado=in.(programado,activo)&hasta=lte.${ahora}`);
  for (const ev of vencidos) {
    const [tomado] = await patch(`tn_eventos?id=eq.${ev.id}&estado=eq.${ev.estado}`, { estado: "terminado" }, true) || [];
    if (tomado) hecho.push({ evento: ev.id, termino: await revertir(tomado) });
  }
  return hecho;
}

// ===== Control de acceso: usuario con sesión de Core, reloj con x-cron-key o service role =====
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  if (SRK && a.slice(7) === SRK) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await _accesoPermitido(req))) return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), { status: 401, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const accion = String(body.accion || "");
    if (accion === "tick") return new Response(JSON.stringify({ ok: true, hecho: await tick() }), { headers: cors });
    const ev = await evento(body.evento_id);
    if (accion === "ensayo") {
      const filas = await plan(ev, await token(ev.store_id));
      return new Response(JSON.stringify({ ok: true, evento: ev.nombre, filas: filas.map((f) => ({ sku: f.it.sku, pct: f.it.descuento_pct, accion: f.accion, motivo: f.motivo || null,
        lista: f.v?.price ?? null, promo_actual: f.v?.promo ?? null, promo_evento: f.promo_evento ?? null })) }), { headers: cors });
    }
    if (accion === "aplicar") return new Response(JSON.stringify({ ok: true, ...(await aplicar(ev)) }), { headers: cors });
    if (accion === "revertir") return new Response(JSON.stringify({ ok: true, ...(await revertir(ev)) }), { headers: cors });
    if (accion === "estado") return new Response(JSON.stringify({ ok: true, ...(await estado(ev)) }), { headers: cors });
    return new Response(JSON.stringify({ ok: false, error: "Acción desconocida" }), { status: 400, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 500, headers: cors });
  }
});
