import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// resenas-pedir v1 (31-oct-2026) — pide la opinión por mail a los compradores de rosaint.online.
// Cron cada 6 h (x-cron-key). Reglas acordadas con Diego:
//  · 10 días después del despacho; UN recordatorio a los 7 días si no contestó; nunca más.
//  · Sin incentivo. Se pide a todos (Google prohíbe pedir solo a los conformes).
//  · Tienda Nube no guarda la fecha de despacho: se anota la primera vez que el pedido aparece
//    despachado (shipped/delivered). Si ya aparece así al darlo de alta, se usa su updated_at.
//  · Sale por Resend de ROSAINT (secreto RESEND_API_KEY de ESTE proyecto, dominio rosaint.online).
//    Nunca la cuenta de Augusta. Sin clave → modo ensayo: registra y arma, no manda.
//  · Tope 95 mails por día (plan gratis de Resend: 100).
// Body opcional: {ensayo:true} fuerza no mandar · {prueba:"mail@..."} manda UN ejemplo a esa casilla.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const STORE_ID = 385079; // Rosaint (Augusta es 1142221: no tocar)
const TN_BASE = `https://api.tiendanube.com/2025-03/${STORE_ID}`;
const UA = "Rosaint Core - resenas (rosaint.ar@gmail.com)";
const SITE = "https://rosaint.online";
const REMITENTE = "Rosaint <opiniones@rosaint.online>";
const RESPONDER_A = "contacto@rosaint.com.ar";
// Pedidos creados desde esta fecha (antes los pedía Trusty).
const DESDE = "2026-10-20T00:00:00-03:00";
const DIAS_PRIMERO = 10, DIAS_RECORDATORIO = 7, TOPE_DIA = 95;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
type Rec = Record<string, unknown>;

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
async function getToken(): Promise<string> {
  const tok = await rest("rpc/tn_store_token", { method: "POST", body: "{}" });
  if (!tok || typeof tok !== "string") throw new Error("Sin token TN"); return tok;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const DIA = 86400000;

// 1) Alta de pedidos despachados en resenas_pedidos (idempotente).
async function registrarPedidos(): Promise<{ vistos: number; nuevos: number }> {
  const token = await getToken();
  const ya = new Set((await rest("resenas_pedidos?select=pedido_tn") as Rec[]).map((r) => Number(r.pedido_tn)));
  let vistos = 0; const nuevos: Rec[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${TN_BASE}/orders?payment_status=paid&per_page=200&page=${page}&created_at_min=${encodeURIComponent(DESDE)}`, { headers: { Authentication: `bearer ${token}`, "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 404) break; // "Last page is N"
    if (!r.ok) throw new Error(`TN ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const pedidos = await r.json() as Rec[];
    for (const o of pedidos) {
      vistos++;
      const despachado = ["shipped", "delivered"].includes(String(o.shipping_status)) && o.status !== "cancelled";
      const email = String(o.contact_email || "").trim().toLowerCase();
      if (!despachado || !email || ya.has(Number(o.id))) continue;
      const productos = new Map<string, Rec>();
      for (const p of (o.products as Rec[]) || []) {
        const sku = String(p.sku || "").trim();
        if (!sku || p.is_gift || productos.has(sku)) continue;
        productos.set(sku, { sku, nombre: String(p.name || ""), imagen: (p.image as Rec)?.src || null, variant_id: p.variant_id });
      }
      if (!productos.size) continue;
      const nombre = String(o.contact_name || (o.customer as Rec)?.name || "").trim();
      nuevos.push({ pedido_tn: o.id, numero: String(o.number), email, nombre, productos: [...productos.values()], despachado_en: new Date(Math.min(Date.parse(String(o.updated_at)) || Date.now(), Date.now())).toISOString() });
    }
    if (pedidos.length < 200) break;
  }
  if (nuevos.length) await rest("resenas_pedidos?on_conflict=pedido_tn", { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify(nuevos) });
  return { vistos, nuevos: nuevos.length };
}

function mail(p: Rec, recordatorio: boolean): { subject: string; html: string; text: string } {
  const nombre = String(p.nombre || "").split(" ")[0];
  const link = (extra = "") => `${SITE}/opinar/?t=${p.token}${extra}`;
  const productos = (p.productos as Rec[]);
  const filas = productos.map((x) => {
    const estrellas = [1, 2, 3, 4, 5].map((n) => `<a href="${esc(link(`&sku=${encodeURIComponent(String(x.sku))}&p=${n}`))}" style="color:#f93549;text-decoration:none;font-size:28px;line-height:1;padding:0 2px" title="${n} de 5">&#9734;</a>`).join("");
    return `<tr><td style="padding:14px 0;border-top:1px solid #d9dcd9;width:84px;vertical-align:top">${x.imagen ? `<img src="${esc(x.imagen)}" width="72" height="72" alt="" style="display:block;border-radius:8px;object-fit:cover">` : ""}</td>` +
      `<td style="padding:14px 0 14px 12px;border-top:1px solid #d9dcd9;vertical-align:top"><div style="font-size:15px;color:#34495e;font-weight:600;margin-bottom:6px">${esc(x.nombre)}</div><div>${estrellas}</div></td></tr>`;
  }).join("");
  const intro = recordatorio
    ? `Hace unos días te escribimos por tu compra en Rosaint. Si ya probaste ${productos.length > 1 ? "los productos" : "el producto"}, tu opinión ayuda a otras personas a elegir.`
    : `Ya pasaron unos días desde que despachamos tu pedido #${esc(p.numero)}. ¿Qué te pareció? Tu opinión ayuda a otras personas a elegir y a nosotros a mejorar.`;
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f7f5f2;font-family:Helvetica,Arial,sans-serif;color:#34495e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5f2"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;padding:28px">
<tr><td><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#536675">Rosaint · Cosmética profesional</div>
<h1 style="font-size:24px;line-height:1.25;margin:10px 0 12px;color:#34495e">${nombre ? `${esc(nombre)}, ` : ""}¿cómo te fue con tu compra?</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 8px">${intro}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 6px;color:#536675">Tocá las estrellas de cada producto: te lleva a una página para contarnos un poco más.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">${filas}</table>
<p style="margin:22px 0 4px"><a href="${esc(link())}" style="display:inline-block;background:#34495e;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:600;font-size:15px">Contar mi experiencia</a></p>
<p style="font-size:13px;line-height:1.5;color:#536675;margin:18px 0 0">Publicamos todas las opiniones, buenas y malas, salvo spam o insultos. No necesitás crear una cuenta.</p>
</td></tr></table>
<p style="font-size:12px;color:#61707b;line-height:1.5;margin:16px 0 0">Rosaint · Gutenberg 1733, Rosario · <a href="${SITE}" style="color:#61707b">rosaint.online</a><br>
Te escribimos porque compraste en nuestra tienda. <a href="${esc(link("&baja=1"))}" style="color:#61707b">No quiero recibir más pedidos de opinión por esta compra</a>.</p>
</td></tr></table></body></html>`;
  const text = `${nombre ? nombre + ", " : ""}¿cómo te fue con tu compra en Rosaint?\n\n${intro.replace(/<[^>]+>/g, "")}\n\nContanos tu experiencia: ${link()}\n\nRosaint · Gutenberg 1733, Rosario.\nNo recibir más pedidos de opinión por esta compra: ${link("&baja=1")}`;
  return { subject: recordatorio ? "¿Nos contás qué te pareció? (último aviso)" : `¿Qué te pareció tu compra en Rosaint?`, html, text };
}

async function enviar(para: string, m: { subject: string; html: string; text: string }, token: string): Promise<string | null> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: REMITENTE, to: [para], reply_to: RESPONDER_A, subject: m.subject, html: m.html, text: m.text,
      headers: { "List-Unsubscribe": `<${SITE}/opinar/?t=${token}&baja=1>` } }),
  });
  if (r.ok) return null;
  return `resend ${r.status}: ${(await r.text()).slice(0, 200)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!await _accesoPermitido(req)) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as Rec;
    // Nunca mandar un enlace roto: si /opinar/ no está publicada en la web, todo queda en ensayo.
    const paginaLista = await fetch(`${SITE}/opinar/`, { method: "GET" }).then(async (r) => r.ok && (await r.text()).includes("data-opinar")).catch(() => false);
    const ensayo = !RESEND_KEY || body.ensayo === true || !paginaLista;
    const alta = await registrarPedidos();
    const ahora = Date.now(), hoy = new Date(ahora - 3 * 3600000).toISOString().slice(0, 10);

    if (typeof body.prueba === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.prueba)) {
      // Pedido de PRUEBA propio (pedido_tn -1, baja=true para que el cron nunca lo mande): así el enlace
      // del ejemplo no es el de una clienta real. Las opiniones que entren por él quedan rechazadas como prueba.
      const [ultimo] = await rest("resenas_pedidos?pedido_tn=gt.0&select=productos&order=creado_en.desc&limit=1") as Rec[];
      if (!ultimo) return new Response(JSON.stringify({ ok: false, error: "sin pedidos para armar el ejemplo" }), { headers: cors });
      const [p] = await rest("resenas_pedidos?on_conflict=pedido_tn", { method: "POST", headers: { Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify({ pedido_tn: -1, numero: "PRUEBA", email: body.prueba, nombre: "Prueba", productos: ultimo.productos, despachado_en: new Date().toISOString(), baja: true }) }) as Rec[];
      const m = mail(p, false);
      const error = ensayo ? (RESEND_KEY ? "ensayo: /opinar/ no está publicada" : "ensayo: sin RESEND_API_KEY") : await enviar(body.prueba, m, String(p.token));
      return new Response(JSON.stringify({ ok: !error, prueba: body.prueba, asunto: m.subject, error }), { headers: cors });
    }

    const todos = await rest("resenas_pedidos?baja=eq.false&respondido_en=is.null&recordatorio_en=is.null&select=*&order=despachado_en.asc") as Rec[];
    const enviadosHoy = (await rest(`resenas_pedidos?or=(enviado_en.gte.${hoy}T03:00:00Z,recordatorio_en.gte.${hoy}T03:00:00Z)&select=pedido_tn`) as Rec[]).length;
    let cupo = Math.max(0, TOPE_DIA - enviadosHoy);
    const plan: Rec[] = [], hechos: Rec[] = [], errores: Rec[] = [];
    for (const p of todos) {
      const primero = !p.enviado_en && ahora - Date.parse(String(p.despachado_en)) >= DIAS_PRIMERO * DIA;
      const recordar = !!p.enviado_en && ahora - Date.parse(String(p.enviado_en)) >= DIAS_RECORDATORIO * DIA;
      if (!primero && !recordar) continue;
      plan.push({ pedido: p.numero, tipo: primero ? "primero" : "recordatorio" });
      if (ensayo || cupo <= 0) continue;
      const error = await enviar(String(p.email), mail(p, !primero), String(p.token));
      if (error) { errores.push({ pedido: p.numero, error }); await rest(`resenas_pedidos?pedido_tn=eq.${p.pedido_tn}`, { method: "PATCH", body: JSON.stringify({ ultimo_error: error }) }); continue; }
      cupo--; hechos.push({ pedido: p.numero, tipo: primero ? "primero" : "recordatorio" });
      await rest(`resenas_pedidos?pedido_tn=eq.${p.pedido_tn}`, { method: "PATCH", body: JSON.stringify(primero ? { enviado_en: new Date().toISOString(), ultimo_error: null } : { recordatorio_en: new Date().toISOString(), ultimo_error: null }) });
    }
    return new Response(JSON.stringify({ ok: errores.length === 0, ensayo, resend: !!RESEND_KEY, pagina_opinar: paginaLista, alta, para_enviar: plan.length, enviados: hechos.length, sin_cupo: !ensayo && cupo <= 0, errores, plan: plan.slice(0, 50) }), { headers: cors });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { status: 500, headers: cors });
  }
});

// ===== Control de acceso (patrón de la auditoría 6-oct-2026) =====
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  if (SB_SERVICE && a.slice(7) === SB_SERVICE) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}
