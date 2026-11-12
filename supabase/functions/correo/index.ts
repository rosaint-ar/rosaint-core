import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding@1/base64";

// ====== correo — conector COMPLETO de la casilla de Rosaint (leer, ordenar, borrar, carpetas, enviar) ======
// Ferozo bloquea las conexiones IMAP que salen de Supabase (corta apenas abre el TLS), así que el trabajo
// con la casilla lo hace `correo-puente.php`, alojado en el hosting de Rosaint (mismo servidor que el correo).
// Esta función: 1) controla quién entra, 2) le agrega la casilla y la contraseña (secretos de acá),
// 3) guarda los adjuntos en Storage y 4) anota en `correo_registro` todo lo que cambia algo.
//
// Secretos: MAIL_IMAP_USER · MAIL_IMAP_PASSWORD · CORREO_PUENTE_TOKEN · CORREO_PUENTE_URL (opcional)
// Pedido: POST { accion, ...datos } — mismas acciones que el puente:
//   estado · carpetas{conteos?} · buscar{carpeta,desde,hasta,de,para,asunto,texto,sin_leer,destacados,desde_uid,limite,pagina}
//   leer{carpeta,uid,marcar_leido?} · adjunto{carpeta,uid,parte,en_linea?} → enlace de 1 h (o base64 si en_linea)
//   marcar{carpeta,uids,leido?,destacado?,respondido?} · mover/copiar{carpeta,uids,destino}
//   borrar{carpeta,uids,definitivo?} (sin definitivo va a la Papelera)
//   crear_carpeta{nombre,padre?} · renombrar_carpeta{carpeta,nuevo} · borrar_carpeta{carpeta,forzar?}
//   enviar / guardar_borrador{para,cc,cco,asunto,texto,html,adjuntos:[{nombre,tipo,base64}|{ruta}],responder?,reenviar?}
//     (adjuntos con "ruta" = archivo ya subido al bucket correo-adjuntos)
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const BUCKET = "correo-adjuntos";
const PUENTE = Deno.env.get("CORREO_PUENTE_URL") || "https://rosaint.online/correo-puente.php";
// Solo estas cuentas del Core pueden usar el correo (el registro de usuarios de Supabase está abierto).
const PERMITIDOS = new Map([
  ["8a55f15a-184e-430b-9d2d-9067c1dbbd8a", "contacto@rosaint.com.ar"],
  ["c0e45351-4a9f-43ec-8197-784672a00653", "rosaint.ar@gmail.com"],
]);
const SOLO_LECTURA = new Set(["estado", "carpetas", "buscar", "leer", "adjunto", "remitentes", "reglas"]);
type Rec = Record<string, unknown>;

// devuelve quién llama (o null si no puede)
async function quien(req: Request): Promise<string | null> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return "sistema (clave interna)";
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  if (SRK && a.slice(7) === SRK) return "sistema (service role)";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || PUB, Authorization: a } });
    if (!r.ok) return null;
    const u = await r.json();
    return PERMITIDOS.get(String(u?.id || "")) || null;
  } catch { return null; }
}

const sbHeaders = (extra: Rec = {}) => ({ Authorization: `Bearer ${SRK}`, apikey: SRK, ...extra }) as Record<string, string>;

async function registrar(fila: Rec) {
  try {
    await fetch(`${SB_URL}/rest/v1/correo_registro`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(fila) });
  } catch { /* el registro no frena la acción */ }
}

async function bajarDeStorage(ruta: string): Promise<Uint8Array> {
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(ruta)}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`No se encontró el archivo a adjuntar: ${ruta}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function guardarAdjunto(carpeta: string, uid: number, nombre: string, tipo: string, datos: Uint8Array) {
  const seguro = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\\/:*?"<>|]+/g, "_").replace(/[^\x20-\x7e]/g, "_");   // Storage no admite tildes
  const ruta = `${carpeta.replace(/[^A-Za-z0-9._-]+/g, "_")}/${uid}/${seguro}`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: sbHeaders({ "Content-Type": tipo || "application/octet-stream", "x-upsert": "true" }), body: datos });
  if (!up.ok) throw new Error("No se pudo guardar el adjunto: " + (await up.text()).slice(0, 200));
  const sg = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: 3600 }) });
  const sj = await sg.json();
  return { ruta, enlace: sj.signedURL ? `${SB_URL}/storage/v1${encodeURI(decodeURI(sj.signedURL))}` : null };
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
  const responder = (o: Rec, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const usuario = await quien(req);
  if (!usuario) return responder({ ok: false, error: "No autorizado" }, 401);

  let body: Rec = {};
  try { body = await req.json(); } catch { return responder({ ok: false, error: "JSON inválido" }, 400); }
  delete body.cred;   // la casilla y la contraseña las pone esta función, nunca quien llama
  const accion = String(body.accion || body.modo || "");
  if (!accion) return responder({ ok: false, error: "Falta la acción" }, 400);
  body.accion = accion;

  const casilla = (Deno.env.get("MAIL_IMAP_USER") || "").trim();
  const clave = (Deno.env.get("MAIL_IMAP_PASSWORD") || "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const token = Deno.env.get("CORREO_PUENTE_TOKEN") || "";
  if (!casilla || !clave) return responder({ ok: false, error: "Falta configurar la casilla (secretos MAIL_IMAP_USER y MAIL_IMAP_PASSWORD)" });
  if (!token) return responder({ ok: false, error: "Falta el secreto CORREO_PUENTE_TOKEN" });

  try {
    // ---- reglas para ordenar (las elige la persona en Correo → Ordenar; viven en correo_reglas)
    const db = (ruta: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${ruta}`, { ...init, headers: sbHeaders({ "Content-Type": "application/json", ...(init.headers as Record<string, string> || {}) }) });
    if (accion === "reglas") {
      const r = await db("correo_reglas?select=*&order=carpeta,patron");
      return responder({ ok: true, reglas: await r.json() });
    }
    if (accion === "regla_guardar") {
      const patron = String(body.patron || "").trim().toLowerCase(), carpetaR = String(body.carpeta || "");
      if (!/^([^@\s]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(patron) || !carpetaR) return responder({ ok: false, error: "Regla inválida: hace falta remitente o @dominio, y la carpeta" });
      const r = await db("correo_reglas?on_conflict=patron", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ patron, carpeta: carpetaR, activa: body.activa !== false, creado_por: usuario }) });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, destino: carpetaR, para: patron, error: r.ok ? null : JSON.stringify(j).slice(0, 300) });
      return responder(r.ok ? { ok: true, regla: j[0] } : { ok: false, error: "No se pudo guardar la regla" });
    }
    if (accion === "regla_borrar") {
      const id = Number(body.id); if (!id) return responder({ ok: false, error: "Falta id" });
      const r = await db(`correo_reglas?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, para: j[0]?.patron ?? null, destino: j[0]?.carpeta ?? null });
      return responder({ ok: r.ok });
    }
    let reglasActivas: Rec[] = [];
    if (accion === "aplicar_reglas") {
      reglasActivas = await (await db("correo_reglas?select=id,patron,carpeta&activa=eq.true")).json();
      // primero las de una dirección puntual, después las de dominio: así una excepción gana sobre la regla general
      reglasActivas.sort((a, b) => Number(String(a.patron).startsWith("@")) - Number(String(b.patron).startsWith("@")));
      if (!reglasActivas.length) return responder({ ok: true, movidos: 0, reglas: [] });
      body = { accion: "ordenar", carpeta: "INBOX", simular: !!body.simular, reglas: reglasActivas.map((x) => ({ patron: x.patron, carpeta: x.carpeta })) };
    }

    // adjuntos para enviar que ya están en Storage → base64 para el puente
    if ((accion === "enviar" || accion === "guardar_borrador") && Array.isArray(body.adjuntos)) {
      const lista: Rec[] = [];
      for (const a of body.adjuntos as Rec[]) {
        if (a.ruta) {
          const datos = await bajarDeStorage(String(a.ruta));
          lista.push({ nombre: a.nombre || String(a.ruta).split("/").pop(), tipo: a.tipo || "application/octet-stream", base64: encodeBase64(datos) });
        } else lista.push(a);
      }
      body.adjuntos = lista;
    }

    const r = await fetch(PUENTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Puente-Token": token, "User-Agent": "rosaint-core-correo/1" },
      body: JSON.stringify({ ...body, cred: { usuario: casilla, clave } }),
      signal: AbortSignal.timeout(140000),
    });
    const txt = await r.text();
    let out: Rec;
    try { out = JSON.parse(txt); }
    catch { out = { ok: false, error: `El puente del hosting no respondió bien (HTTP ${r.status})`, detalle: txt.replace(clave, "***").slice(0, 300) }; }

    if (accion === "adjunto" && out.ok && !body.en_linea) {
      const datos = decodeBase64(String(out.base64 || ""));
      const g = await guardarAdjunto(String(body.carpeta || "INBOX"), Number(body.uid), String(out.nombre || "adjunto"), String(out.tipo || ""), datos);
      delete out.base64;
      out = { ...out, ...g };
    }

    // reglas aplicadas: cuándo y cuántos movió cada una
    if (accion === "aplicar_reglas" && out.ok && !out.simulado) {
      const ahora = new Date().toISOString();
      for (const f of (out.reglas as Rec[]) || []) {
        const regla = reglasActivas.find((x) => x.patron === f.patron);
        if (!regla) continue;
        const cambio: Rec = { ultima_vez: ahora };
        if (Number(f.movidos) > 0) {
          const act = await (await db(`correo_reglas?select=movidos&id=eq.${regla.id}`)).json();
          cambio.movidos = Number(act[0]?.movidos || 0) + Number(f.movidos);
        }
        await db(`correo_reglas?id=eq.${regla.id}`, { method: "PATCH", body: JSON.stringify(cambio) });
      }
    }

    // el cron aplica las reglas cada 10 min: solo se anota cuando movió algo (o falló)
    const anotar = accion === "aplicar_reglas" ? (!out.ok || Number(out.movidos) > 0) && !out.simulado : !SOLO_LECTURA.has(accion);
    if (anotar) {
      if (accion === "aplicar_reglas" || accion === "ordenar") {
        const hechas = ((out.reglas as Rec[]) || []).filter((f) => Number(f.movidos) > 0 || f.error).map((f) => ({ patron: f.patron, carpeta: f.carpeta, movidos: f.movidos, error: f.error }));
        await registrar({ usuario, accion, ok: !!out.ok, error: out.ok ? null : String(out.error || "").slice(0, 500), carpeta: body.carpeta ?? "INBOX",
          detalle: { movidos: out.movidos, simulado: out.simulado || undefined, reglas: hechas } });
        return responder(out);
      }
      const para = [body.para, body.cc, body.cco].flat().filter(Boolean).map((x) => typeof x === "string" ? x : (x as Rec).email).join(", ");
      await registrar({
        usuario, accion, ok: !!out.ok, error: out.ok ? null : String(out.error || "").slice(0, 500),
        carpeta: body.carpeta ?? null, uids: body.uids ?? (body.uid ? [body.uid] : null),
        destino: body.destino ?? body.nuevo ?? body.nombre ?? null,
        para: para || null, asunto: body.asunto ?? null,
        detalle: { definitivo: body.definitivo ?? undefined, forzar: body.forzar ?? undefined, responder: body.responder ?? undefined, reenviar: body.reenviar ?? undefined,
          adjuntos: Array.isArray(body.adjuntos) ? (body.adjuntos as Rec[]).map((a) => a.nombre) : undefined, message_id: out.message_id ?? undefined, aviso: out.aviso ?? undefined },
      });
    }
    return responder(out);
  } catch (e) {
    const msg = String((e as Error).message || e).replace(clave, "***");
    if (!SOLO_LECTURA.has(accion)) await registrar({ usuario, accion, ok: false, error: msg.slice(0, 500), carpeta: body.carpeta ?? null });
    return responder({ ok: false, error: msg });
  }
});
