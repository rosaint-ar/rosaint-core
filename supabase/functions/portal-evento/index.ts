// ============================================================================
// portal-evento — registro propio del portal profesional de Rosaint (rosaint.odoo.com)
//
// 1) Eventos (PÚBLICO, --no-verify-jwt): lo manda el bloque «rosaint-eventos» de la cabecera del portal con
//    navigator.sendBeacon (text/plain, sin preflight): el portal no puede llevar ninguna clave.
//    Entrada: {p: partner_id, s: sesión, e: [{t: tipo, r: ruta, d: {…}}]} → tabla portal_evento.
//    Frenos: sólo tipos conocidos, tope por envío y por IP, textos recortados, dato plano. El partner_id se
//    acepta sólo si es de un usuario de Odoo (si no, 0 = sin sesión). Ningún dato que la persona escriba
//    en formularios: sólo su contacto (de su propia sesión de Odoo) y qué hizo.
// 2) Cabecera (SOLO con sesión del Core de las cuentas permitidas): {accion:'cabecera'} la lee y
//    {accion:'publicar', bloque} reemplaza lo que está entre las marcas <!-- rosaint-eventos --> en
//    website.custom_code_head, guarda la cabecera anterior en portal_cabecera_copias y verifica releyendo.
// Lo lee el Core: Portal profesional › Métricas y los avisos en vivo (shared/portal-vivo.js).
// Copiado del portal-evento de EyG (2/11/2026), adaptado a Rosaint.
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TIPOS = new Set(["pagina", "busqueda", "carrito", "alta_paso", "alta_enviada", "whatsapp", "descarga", "login_error"]);
const MAX_EV = 40;              // por envío
const MAX_IP = 400;             // por IP cada 10 minutos
const MAX_BODY = 24000;
const WEBSITE = 1;
const MARCA_INI = "<!-- rosaint-eventos -->", MARCA_FIN = "<!-- /rosaint-eventos -->";
const PERMITIDOS = new Set([
  "8a55f15a-184e-430b-9d2d-9067c1dbbd8a", // contacto@rosaint.com.ar
  "c0e45351-4a9f-43ec-8197-784672a00653", // rosaint.ar@gmail.com
]);

// ---------------------------------------------------------------- Odoo -----
const OD_URL = Deno.env.get("ODOO_URL")?.replace(/\/+$/, "") || "";
const OD_DB = Deno.env.get("ODOO_DB") || "";
const OD_LOGIN = Deno.env.get("ODOO_LOGIN") || "";
const OD_KEY = Deno.env.get("ODOO_KEY") || "";
let _uid: number | null = null;
async function odooCall(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${OD_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const t = await r.text();
  if (!t.trimStart().startsWith("{")) throw new Error(`Odoo no respondió bien (HTTP ${r.status})`);
  const d = JSON.parse(t);
  if (d.error) throw new Error(d.error?.data?.message || d.error?.message || "Error de Odoo");
  return d.result;
}
async function kw(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}) {
  if (!_uid) _uid = await odooCall("common", "authenticate", [OD_DB, OD_LOGIN, OD_KEY, {}]) as number;
  return await odooCall("object", "execute_kw", [OD_DB, _uid, OD_KEY, model, method, args, { ...kwargs, context: { allowed_company_ids: [2] } }]);
}

/* Contactos que tienen usuario (portal o interno). Se refresca cada 30 minutos; si un usuario es nuevo y
   todavía no está, se vuelve a mirar Odoo esa vez. */
let USUARIOS = new Set<number>(), USU_TS = 0;
async function usuarios(forzar = false) {
  if (!forzar && Date.now() - USU_TS < 30 * 60 * 1000 && USUARIOS.size) return USUARIOS;
  const u = await kw("res.users", "search_read", [[["active", "=", true]]], { fields: ["partner_id"], limit: 0 }) as any[];
  USUARIOS = new Set(u.map((x) => x.partner_id && x.partner_id[0]).filter(Boolean));
  USU_TS = Date.now();
  return USUARIOS;
}
async function partnerValido(pid: number) {
  if (!pid || pid < 1) return 0;
  try {
    if ((await usuarios()).has(pid)) return pid;
    if (Date.now() - USU_TS > 60 * 1000 && (await usuarios(true)).has(pid)) return pid;
  } catch { /* si Odoo no responde, el evento igual se guarda, sin contacto */ }
  return 0;
}

// ------------------------------------------------------------ Supabase -----
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
async function sbInsert(tabla: string, filas: unknown) {
  return await fetch(`${SB_URL}/rest/v1/${tabla}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(filas),
  });
}
async function usuarioCore(req: Request): Promise<string | null> {
  const a = req.headers.get("authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || PUB, Authorization: a } });
  if (!r.ok) return null;
  const u = await r.json();
  return PERMITIDOS.has(String(u?.id || "")) ? String(u.email || u.id) : null;
}

// --------------------------------------------------------------- frenos ----
const porIP = new Map<string, { n: number; t: number }>();
function cupo(ip: string, n: number) {
  const ahora = Date.now(), x = porIP.get(ip);
  if (!x || ahora - x.t > 10 * 60 * 1000) { porIP.set(ip, { n, t: ahora }); return true; }
  x.n += n;
  return x.n <= MAX_IP;
}
const corto = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/* El dato es un objeto plano de pocos campos: texto recortado, números o booleanos. */
function limpiarDato(d: unknown) {
  const out: Record<string, unknown> = {};
  if (!d || typeof d !== "object" || Array.isArray(d)) return out;
  for (const [k, v] of Object.entries(d as Record<string, unknown>).slice(0, 12)) {
    const key = corto(k, 30).replace(/[^a-z0-9_]/gi, "");
    if (!key) continue;
    if (typeof v === "number" && isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else if (typeof v === "string") out[key] = corto(v, 160);
  }
  return out;
}

// ------------------------------------------------------------ cabecera -----
async function cabecera(req: Request, b: any) {
  const quien = await usuarioCore(req);
  if (!quien) return resp({ ok: false, error: "No autorizado" }, 401);
  const leer = async () => String(((await kw("website", "read", [[WEBSITE], ["custom_code_head"]]) as any[])[0]?.custom_code_head) || "");
  const antes = await leer();
  if (b.accion === "cabecera") return resp({ ok: true, cabecera: antes, tiene_bloque: antes.includes(MARCA_INI) });
  if (b.accion !== "publicar") return resp({ ok: false, error: "Acción desconocida" }, 400);
  const bloque = String(b.bloque || "");
  if (!bloque.startsWith(MARCA_INI) || !bloque.trimEnd().endsWith(MARCA_FIN)) return resp({ ok: false, error: "El bloque tiene que ir entre las marcas rosaint-eventos" }, 400);
  const i = antes.indexOf(MARCA_INI), f = antes.indexOf(MARCA_FIN);
  const despues = i >= 0 && f > i ? antes.slice(0, i) + bloque.trimEnd() + antes.slice(f + MARCA_FIN.length) : (antes ? antes.trimEnd() + "\n" : "") + bloque.trimEnd();
  await sbInsert("portal_cabecera_copias", [{ publicada_por: quien, antes, despues }]);
  await kw("website", "write", [[WEBSITE], { custom_code_head: despues }]);
  const verificado = await leer();
  return resp({ ok: verificado === despues, reemplazo: i >= 0, largo_antes: antes.length, largo_despues: verificado.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resp({ ok: false }, 405);
  try {
    const txt = await req.text();
    if (txt.length > 400000) return resp({ ok: false, error: "muy grande" }, 413);
    const b = JSON.parse(txt || "{}");
    if (b.accion) return await cabecera(req, b);
    if (txt.length > MAX_BODY) return resp({ ok: false, error: "muy grande" }, 413);
    const ev = Array.isArray(b.e) ? b.e.slice(0, MAX_EV) : [];
    const filas = ev
      .filter((x: any) => x && TIPOS.has(String(x.t)))
      .map((x: any) => ({ tipo: String(x.t), ruta: corto(x.r, 200), dato: limpiarDato(x.d) }));
    if (!filas.length) return resp({ ok: true, n: 0 });
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
    if (!cupo(ip, filas.length)) return resp({ ok: false, error: "demasiados" }, 429);
    const pid = await partnerValido(Number(b.p) || 0);
    const sesion = corto(b.s, 40).replace(/[^a-z0-9-]/gi, "");
    const r = await sbInsert("portal_evento", filas.map((f: any) => ({ ...f, partner_id: pid, sesion })));
    if (!r.ok) return resp({ ok: false, error: "no se pudo guardar" }, 500);
    return resp({ ok: true, n: filas.length });
  } catch (e) {
    return resp({ ok: false, error: String((e as Error).message || e).slice(0, 160) }, 400);
  }
});
