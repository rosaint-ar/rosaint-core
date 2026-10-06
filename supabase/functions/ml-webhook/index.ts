import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
// ═══ ml-webhook — receptor de notificaciones de Mercado Libre + respondedor de preguntas ═══
// 1) Órdenes/pagos (topic orders_v2 / payments): responde 200 al instante y dispara
//    ml-odoo-cargar {modo:auto} en segundo plano (sin cambios respecto de v8).
// 2) Preguntas (topic questions, o {accion:'poll'} desde pg_cron cada 2 min): registra la
//    pregunta en ml_preguntas y, si ml_parametros.preguntas_auto = 1, arma la respuesta con
//    la guía (ml_respuestas_guia) + la descripción de la publicación y la envía por la API.
//    Lo que la guía marca como "escalar" (reclamos, temas sin dato) queda para Rosaint.
// 3) Desde el Core (con sesión): {accion:'estado'} y {accion:'responder', question_id, texto}.
// verify_jwt=false (ML llama sin auth): poll exige x-proxy-secret; las acciones del Core, JWT de usuario.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CARGAR_URL = `${SB_URL}/functions/v1/ml-odoo-cargar`;
const ML_API = `${SB_URL}/functions/v1/ml-api`;
const SELLER_ID = 157540060;
const MODELO = "claude-opus-5-5";
const FIRMA = "Saludos :: ROSAINT Cosmética Profesional";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ─── PostgREST con service role ───
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
  });
  const t = await r.text();
  let d: any = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`db ${path}: ${r.status} ${t.slice(0, 200)}`);
  return d;
}

let SECRET_CACHE = "";
async function proxySecret() {
  if (SECRET_CACHE) return SECRET_CACHE;
  const r = await db("ml_config?select=valor&clave=eq.proxy_secret");
  SECRET_CACHE = r?.[0]?.valor || "";
  return SECRET_CACHE;
}

async function ml(method: string, path: string, query?: Record<string, string>, body?: unknown) {
  const r = await fetch(ML_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": await proxySecret() },
    body: JSON.stringify({ method, path, query, body }),
  });
  return await r.json().catch(() => ({ ok: false, status: r.status }));
}

async function autoActivado() {
  const r = await db("ml_parametros?select=valor&clave=eq.preguntas_auto");
  return Number(r?.[0]?.valor || 0) === 1;
}

// ─── Contexto de la publicación: título + descripción que ve el comprador ───
async function contextoItem(itemId: string) {
  const it = await ml("GET", `/items/${itemId}`);
  const d = it?.data || {};
  let desc = "";
  if (d.catalog_product_id) {
    const p = await ml("GET", `/products/${d.catalog_product_id}`);
    desc = p?.data?.short_description?.content || "";
  }
  if (!desc) {
    const de = await ml("GET", `/items/${itemId}/description`);
    desc = de?.data?.plain_text || "";
  }
  return { titulo: String(d.title || itemId), descripcion: desc.slice(0, 6000) };
}

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    accion: { type: "string", enum: ["responder", "escalar"] },
    tema: { type: "string" },
    respuesta: { type: "string" },
    motivo: { type: "string" },
  },
  required: ["accion", "tema", "respuesta", "motivo"],
};

function reglas(guia: any[]) {
  const temas = guia.map((g) =>
    `- [${g.accion.toUpperCase()}] ${g.tema} (aplica a: ${g.aplica_a})\n  Cuándo: ${g.cuando}\n  Qué responder: ${g.respuesta}`
  ).join("\n");
  return `Respondés preguntas de compradores en Mercado Libre para ROSAINT Cosmética Profesional, marca argentina de cosmética profesional (Rosario). Productos: Gel Criógeno, Gel Termogénico, Cremas Base Neutras (Clásica, Para Masajes, 100% Natural), aceites para masajes y combos.

Reglas que no se rompen:
1. Sólo usás la información de la DESCRIPCIÓN de la publicación y de la GUÍA. Si la respuesta no sale de ahí, accion = "escalar". Nunca inventes datos, plazos, stock, precios ni compatibilidades.
2. Son cosméticos de uso externo. Nunca digas que tratan, curan, desinflaman, reducen grasa o eliminan celulitis, ni que sirven para dolores, lesiones o enfermedades. Usá "acompaña tratamientos", "aporta sensación de…".
3. Prohibido incluir teléfonos, WhatsApp, mails, direcciones, links, redes sociales, nombres de otras páginas o invitar a comprar por fuera de Mercado Libre.
4. Si la pregunta encaja en un tema marcado [ESCALAR], o cuenta un problema con una compra ya hecha (no llegó, faltó algo, vino roto, reclamo, devolución), accion = "escalar" y respuesta vacía.
5. Una sola respuesta por pregunta: tiene que ser completa. Español rioplatense, cordial y concreto, sin tecnicismos de más. Entre 1 y 4 oraciones, máximo 450 caracteres. Empezá con "¡Hola!" y terminá exactamente con "${FIRMA}".
6. Si el comprador escribe con su nombre, podés saludarlo por el nombre. No uses emojis.
7. motivo: una línea para Rosaint explicando qué tema de la guía usaste o por qué escalás.

GUÍA DE RESPUESTAS:
${temas}`;
}

const PROHIBIDO = /(https?:\/\/|www\.|\.com\b|\.online\b|@[a-z0-9]|whats ?app|wsp|\b\d{2,4}[\s-]?\d{3,4}[\s-]?\d{4}\b|instagram|facebook)/i;

async function redactar(q: any, ctx: { titulo: string; descripcion: string }, guia: any[]) {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const res: any = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
    system: [{ type: "text", text: reglas(guia), cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: `PUBLICACIÓN: ${ctx.titulo}\n\nDESCRIPCIÓN DE LA PUBLICACIÓN:\n${ctx.descripcion || "(sin descripción)"}\n\nPREGUNTA DEL COMPRADOR:\n${q.text}`,
    }],
  } as any);
  const u = res.usage || {};
  const costo = ((u.input_tokens || 0) * 4 + (u.cache_read_input_tokens || 0) * 0.2 + (u.cache_creation_input_tokens || 0) * 5 + (u.output_tokens || 0) * 20) / 1e6;
  if (res.stop_reason === "refusal") return { accion: "escalar", tema: "-", respuesta: "", motivo: "El modelo no quiso responder (refusal).", costo };
  const txt = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  let out: any;
  try { out = JSON.parse(txt); } catch { return { accion: "escalar", tema: "-", respuesta: "", motivo: "Respuesta del modelo ilegible.", costo }; }
  out.costo = costo;
  // Controles duros antes de publicar
  if (out.accion === "responder") {
    let r = String(out.respuesta || "").trim();
    if (!r.endsWith(FIRMA)) r = r.replace(/\s*Saludos[^]*$/i, "").trim() + " " + FIRMA;
    if (!r || r.length > 1500 || PROHIBIDO.test(r.replace(FIRMA, ""))) {
      return { ...out, accion: "escalar", respuesta: r, motivo: `Bloqueada por control (largo o dato de contacto): ${out.motivo || ""}` };
    }
    out.respuesta = r;
  }
  return out;
}

// ─── Aviso por mail (vía Odoo) cuando una pregunta queda para revisar o falla el envío ───
const AVISO_A = "rosaint.ar@gmail.com";
const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
async function avisar(id: number, tipo: "revisar" | "error", q: any, titulo: string, detalle: string) {
  // Una sola vez por pregunta
  const marcada = await db(`ml_preguntas?question_id=eq.${id}&avisado_en=is.null`, { method: "PATCH", body: JSON.stringify({ avisado_en: new Date().toISOString() }) });
  if (!marcada?.length) return;
  const asunto = tipo === "revisar" ? `Pregunta de ML para revisar: ${titulo}` : `No se pudo responder una pregunta de ML: ${titulo}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <p><b>${tipo === "revisar" ? "Una pregunta de Mercado Libre quedó para que la respondas vos." : "El asistente armó la respuesta pero Mercado Libre no la aceptó."}</b></p>
    <p><b>Publicación:</b> ${escHtml(titulo)}<br><b>Pregunta:</b> “${escHtml(q.text)}”</p>
    <p><b>Motivo:</b> ${escHtml(detalle)}</p>
    <p>Respondela desde el Core (Canales → Mercado Libre → Preguntas):<br>
    <a href="https://rosaint-ar.github.io/rosaint-core/comercial/canales.html#ml">https://rosaint-ar.github.io/rosaint-core/comercial/canales.html#ml</a><br>
    o desde el panel de Mercado Libre: <a href="https://www.mercadolibre.com.ar/preguntas/vendedor">Preguntas</a>.</p></div>`;
  try {
    await fetch(`${SB_URL}/functions/v1/odoo-enviar-mail`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
      body: JSON.stringify({ to: AVISO_A, subject: asunto, body_html: html }),
    });
  } catch (_) { /* el aviso no frena el resto */ }
}

async function guardar(id: number, campos: Record<string, unknown>) {
  await db(`ml_preguntas?question_id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...campos, actualizado_en: new Date().toISOString() }) });
}

// ─── Procesa una pregunta (idempotente: varias llamadas no duplican) ───
async function procesar(q: any, auto: boolean) {
  const id = Number(q.id);
  if (!id) return { id, r: "sin id" };
  const base = { question_id: id, item_id: q.item_id, texto: q.text, from_id: q.from?.id ?? null, fecha: q.date_created };
  if (q.status !== "UNANSWERED") {
    await db("ml_preguntas?on_conflict=question_id", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ ...base, estado: "respondida_fuera", respuesta: q.answer?.text ?? null, respondida_en: q.answer?.date_created ?? null }),
    });
    // Si la teníamos pendiente y la respondieron por otro lado (panel de ML), se marca como tal.
    await db(`ml_preguntas?question_id=eq.${id}&estado=in.(nueva,error,escalada)`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "respondida_fuera", respuesta: q.answer?.text ?? null, respondida_en: q.answer?.date_created ?? null, actualizado_en: new Date().toISOString() }),
    });
    return { id, r: "ya respondida" };
  }
  await db("ml_preguntas?on_conflict=question_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify(base) });
  if (!auto) return { id, r: "registrada (auto apagado)" };
  // Toma la pregunta en forma atómica: sólo si está nueva o en error con pocos intentos
  const tomada = await db(`ml_preguntas?question_id=eq.${id}&or=(estado.eq.nueva,and(estado.eq.error,intentos.lt.5))`, {
    method: "PATCH", body: JSON.stringify({ estado: "procesando", actualizado_en: new Date().toISOString() }),
  });
  if (!tomada?.length) return { id, r: "ya tomada" };
  const intentos = (tomada[0].intentos || 0) + 1;
  try {
    const guia = await db("ml_respuestas_guia?select=*&activo=eq.true&order=orden");
    const ctx = await contextoItem(q.item_id);
    const out = await redactar(q, ctx, guia);
    const comunes = { item_titulo: ctx.titulo, tema: out.tema, motivo: out.motivo, costo_usd: out.costo, intentos };
    if (out.accion !== "responder") {
      await guardar(id, { ...comunes, estado: "escalada", respuesta: out.respuesta || null });
      await avisar(id, "revisar", q, ctx.titulo, out.motivo || "");
      return { id, r: "escalada" };
    }
    const env = await ml("POST", "/answers", undefined, { question_id: id, text: out.respuesta });
    if (env?.ok) {
      await guardar(id, { ...comunes, estado: "respondida_auto", respuesta: out.respuesta, error: null, respondida_en: new Date().toISOString() });
      return { id, r: "respondida" };
    }
    const errTxt = `ML ${env?.status}: ${JSON.stringify(env?.data || {}).slice(0, 300)}`;
    await guardar(id, { ...comunes, estado: "error", respuesta: out.respuesta, error: errTxt });
    await avisar(id, "error", q, ctx.titulo, `${errTxt}. Respuesta que se iba a mandar: ${out.respuesta}`);
    return { id, r: "error al enviar" };
  } catch (e) {
    await guardar(id, { estado: "error", intentos, error: String((e as Error).message || e).slice(0, 300) });
    return { id, r: "error" };
  }
}

async function poll() {
  const auto = await autoActivado();
  const s = await ml("GET", "/questions/search", { seller_id: String(SELLER_ID), status: "UNANSWERED", api_version: "4", sort_fields: "date_created", sort_types: "DESC", limit: "50" });
  const preguntas = s?.data?.questions || [];
  const res = [];
  for (const q of preguntas) res.push(await procesar(q, auto));
  // Las que tenemos pendientes y ML ya no lista como sin responder: se respondieron por otro lado.
  const listadas = new Set(preguntas.map((q: any) => Number(q.id)));
  const pend = await db("ml_preguntas?select=question_id&estado=in.(nueva,error,escalada)");
  for (const p of pend || []) {
    if (listadas.has(Number(p.question_id))) continue;
    const q = await ml("GET", `/questions/${p.question_id}`, { api_version: "4" });
    if (q?.ok) await procesar(q.data, false);
  }
  return { ok: true, auto, sin_responder: preguntas.length, resultados: res };
}

async function usuarioValido(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SRK, Authorization: `Bearer ${token}` } });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return new Response("ok", { status: 200 });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* ML manda JSON */ }

  // ── Acciones del Core / cron ──
  if (body.accion) {
    if (body.accion === "poll") {
      if (req.headers.get("x-proxy-secret") !== (await proxySecret())) return json({ ok: false, error: "no autorizado" }, 401);
      return json(await poll());
    }
    if (body.accion === "probar_aviso") {
      if (req.headers.get("x-proxy-secret") !== (await proxySecret())) return json({ ok: false, error: "no autorizado" }, 401);
      const r = await fetch(`${SB_URL}/functions/v1/odoo-enviar-mail`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
        body: JSON.stringify({ to: AVISO_A, subject: "Prueba: avisos de preguntas de Mercado Libre", body_html: "<p>Este es un mail de prueba. A partir de ahora vas a recibir un aviso así cada vez que una pregunta de Mercado Libre quede para que la respondas vos.</p>" }),
      });
      return json(await r.json().catch(() => ({ ok: false })));
    }
    if (body.accion === "probar") {
      // Borrador sin publicar nada: {item_id, texto}. Para revisar la calidad antes de activar.
      const okSecret = req.headers.get("x-proxy-secret") === (await proxySecret());
      if (!okSecret && !(await usuarioValido(req))) return json({ ok: false, error: "no autorizado" }, 401);
      const guia = await db("ml_respuestas_guia?select=*&activo=eq.true&order=orden");
      const ctx = await contextoItem(String(body.item_id));
      const out = await redactar({ text: String(body.texto || "") }, ctx, guia);
      return json({ ok: true, publicacion: ctx.titulo, ...out });
    }
    if (!(await usuarioValido(req))) return json({ ok: false, error: "Necesita sesión del Core" }, 401);
    if (body.accion === "estado") {
      const me = await ml("GET", "/users/me");
      const s = await ml("GET", "/questions/search", { seller_id: String(SELLER_ID), status: "UNANSWERED", api_version: "4", limit: "1" });
      const err = await db("ml_preguntas?select=error,actualizado_en&error=not.is.null&order=actualizado_en.desc&limit=1");
      return json({
        ok: true,
        cuenta: me?.data?.nickname || null,
        token_ok: !!me?.ok,
        lectura_preguntas: !!s?.ok,
        sin_responder_en_ml: s?.data?.total ?? null,
        ultimo_error: err?.[0] || null,
        auto: await autoActivado(),
        ia_configurada: !!Deno.env.get("ANTHROPIC_API_KEY"),
      });
    }
    if (body.accion === "responder") {
      const id = Number(body.question_id);
      const texto = String(body.texto || "").trim();
      if (!id || !texto) return json({ ok: false, error: "Falta pregunta o texto" }, 400);
      const env = await ml("POST", "/answers", undefined, { question_id: id, text: texto });
      if (!env?.ok) return json({ ok: false, error: `ML ${env?.status}: ${JSON.stringify(env?.data || {}).slice(0, 300)}` });
      await guardar(id, { estado: "respondida_manual", respuesta: texto, error: null, respondida_en: new Date().toISOString() });
      return json({ ok: true });
    }
    if (body.accion === "poll_ahora") return json(await poll());
    return json({ ok: false, error: "acción desconocida" }, 400);
  }

  // ── Notificaciones de ML ──
  const topic = String(body.topic || body.type || "");
  const resource = String(body.resource || "");
  if (/question/i.test(topic) || /\/questions\//.test(resource)) {
    const id = resource.split("/").filter(Boolean).pop();
    const tarea = (async () => {
      const q = await ml("GET", `/questions/${id}`, { api_version: "4" });
      if (q?.ok && Number(q.data?.seller_id) === SELLER_ID) await procesar(q.data, await autoActivado());
    })().catch(() => {});
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(tarea); } catch (_) { }
    return new Response("ok", { status: 200 });
  }
  const relevante = /order|payment/i.test(topic) || /order|payment/i.test(resource);
  if (relevante) {
    // ml-odoo-cargar exige credencial (auditoría 6-oct): va con la del servidor
    const tarea = fetch(CARGAR_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` }, body: JSON.stringify({ modo: "auto" }) }).then(() => {}).catch(() => {});
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(tarea); } catch (_) { }
  }
  return new Response("ok", { status: 200 });
});
