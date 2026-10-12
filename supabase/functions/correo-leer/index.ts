import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ImapFlow } from "npm:imapflow@1.0.164";

// ====== correo-leer — lectura de la casilla de correo de Rosaint (SOLO LECTURA) ======
// Servidor IMAP de Ferozo (c229.ferozo.com:993). El buzón se abre en modo consulta (EXAMINE):
// no marca como leído, no borra, no mueve. Credenciales en secretos de Supabase:
//   MAIL_IMAP_HOST (c229.ferozo.com) · MAIL_IMAP_USER (la casilla) · MAIL_IMAP_PASSWORD (la carga el usuario)
// Modos (body.modo):
//   carpetas                               → lista de carpetas
//   buscar  {carpeta?, desde?, hasta?, de?, asunto?, texto?, limite?} → correos (más nuevos primero)
//   leer    {uid, carpeta?}                → texto del correo + lista de adjuntos
//   adjunto {uid, parte, carpeta?}         → guarda el adjunto en Storage (bucket privado correo-adjuntos)
//                                            y devuelve un enlace temporal de 1 hora
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const BUCKET = "correo-adjuntos";
// Solo estas cuentas del Core pueden leer el correo (el registro de usuarios de Supabase está abierto).
const PERMITIDOS = new Set([
  "8a55f15a-184e-430b-9d2d-9067c1dbbd8a", // contacto@rosaint.com.ar
  "c0e45351-4a9f-43ec-8197-784672a00653", // rosaint.ar@gmail.com
]);
type Rec = Record<string, unknown>;

async function permitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  if (SRK && a.slice(7) === SRK) return true;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || PUB, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return PERMITIDOS.has(String(u?.id || ""));
  } catch { return false; }
}

function cliente() {
  const host = Deno.env.get("MAIL_IMAP_HOST") || "c229.ferozo.com";
  const user = (Deno.env.get("MAIL_IMAP_USER") || "").trim();     // sin espacios pegados por error
  const pass = (Deno.env.get("MAIL_IMAP_PASSWORD") || "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!user || !pass) throw new Error("Falta configurar la casilla: secretos MAIL_IMAP_USER y MAIL_IMAP_PASSWORD");
  return new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 60000 });
}

// recorre la estructura MIME y junta las partes que son adjuntos
function adjuntosDe(nodo: Rec | undefined, out: Rec[] = []): Rec[] {
  if (!nodo) return out;
  const hijos = (nodo.childNodes as Rec[]) || [];
  if (hijos.length) { hijos.forEach(h => adjuntosDe(h, out)); return out; }
  const disp = String(nodo.disposition || "").toLowerCase();
  const params = { ...((nodo.parameters as Rec) || {}), ...((nodo.dispositionParameters as Rec) || {}) };
  const nombre = (params.filename || params.name) as string | undefined;
  if (disp === "attachment" || (nombre && !String(nodo.type || "").startsWith("text/"))) {
    out.push({ parte: nodo.part || "1", nombre: nombre || "(sin nombre)", tipo: nodo.type, tamano: nodo.size });
  }
  return out;
}
// todas las partes "hoja" del correo (texto, html, adjuntos)
function partesDe(nodo: Rec | undefined, out: Rec[] = []): Rec[] {
  if (!nodo) return out;
  const hijos = (nodo.childNodes as Rec[]) || [];
  if (hijos.length) { hijos.forEach(h => partesDe(h, out)); return out; }
  out.push(nodo); return out;
}
// deshace la codificación de transporte (base64 / quoted-printable)
function decodificar(raw: Uint8Array, enc: string): Uint8Array {
  const e = enc.toLowerCase();
  if (e === "base64") {
    const b = atob(new TextDecoder("windows-1252").decode(raw).replace(/[^A-Za-z0-9+/=]/g, ""));
    const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out;
  }
  if (e === "quoted-printable") {
    const t = new TextDecoder("windows-1252").decode(raw).replace(/=\r?\n/g, ""); const out: number[] = [];
    for (let i = 0; i < t.length; i++) { if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; } else out.push(t.charCodeAt(i) & 255); }
    return new Uint8Array(out);
  }
  return raw;
}
function aTexto(b: Uint8Array, charset: string): string { try { return new TextDecoder(charset.toLowerCase()).decode(b); } catch { return new TextDecoder("windows-1252").decode(b); } }

// ---- Conexión IMAP directa (solo para traer UNA parte de UN correo, en modo consulta) ----
// Comandos: LOGIN, EXAMINE (solo lectura), UID FETCH n (BODY.PEEK[parte]) — PEEK no marca como leído.
async function parteCruda(carpeta: string, uid: number, parte: string): Promise<Uint8Array> {
  if (!/^[\x20-\x7e]+$/.test(carpeta)) throw new Error("carpeta con caracteres especiales");
  const host = Deno.env.get("MAIL_IMAP_HOST") || "c229.ferozo.com";
  const user = (Deno.env.get("MAIL_IMAP_USER") || "").trim();
  const pass = (Deno.env.get("MAIL_IMAP_PASSWORD") || "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const q = (x: string) => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const conn = await Deno.connectTls({ hostname: host, port: 993 });
  const enc = new TextEncoder();
  let buf = new Uint8Array(0);
  const leerMas = async () => {
    const t = new Uint8Array(65536); const n = await conn.read(t);
    if (n === null) throw new Error("el servidor cerró la conexión");
    const nb = new Uint8Array(buf.length + n); nb.set(buf); nb.set(t.subarray(0, n), buf.length); buf = nb;
  };
  const latin = (b: Uint8Array) => new TextDecoder("windows-1252").decode(b);
  // espera la respuesta con la etiqueta dada; devuelve todo lo recibido hasta esa línea
  const esperar = async (tag: string): Promise<Uint8Array> => {
    while (true) {
      const txt = latin(buf);
      const m = new RegExp("(^|\\r\\n)" + tag + " (OK|NO|BAD)[^\\r\\n]*\\r\\n").exec(txt);
      if (m) {
        const fin = m.index + m[0].length; const r = buf.subarray(0, fin); buf = buf.subarray(fin);
        if (m[2] !== "OK") throw new Error("Servidor de correo: " + m[0].trim().slice(0, 120));
        return r;
      }
      await leerMas();
    }
  };
  try {
    await leerMas();                                           // saludo
    buf = new Uint8Array(0);
    await conn.write(enc.encode("a1 LOGIN " + q(user) + " " + q(pass) + "\r\n")); await esperar("a1");
    await conn.write(enc.encode("a2 EXAMINE " + q(carpeta) + "\r\n")); await esperar("a2");
    await conn.write(enc.encode("a3 UID FETCH " + uid + " (BODY.PEEK[" + parte + "])\r\n"));
    const r = await esperar("a3");
    // la parte viene como literal {N}\r\n seguido de N bytes
    const cab = latin(r.subarray(0, Math.min(r.length, 400)));
    const lit = /\{(\d+)\}\r\n/.exec(cab);
    if (!lit) throw new Error("El correo no tiene esa parte");
    const desde = new TextEncoder().encode(cab.slice(0, lit.index + lit[0].length)).length;
    const n = Number(lit[1]);
    // si el literal es más largo que lo recibido (no debería, esperar() ya leyó hasta el OK), se corta igual
    return r.slice(desde, desde + n);
  } finally {
    try { await conn.write(enc.encode("a9 LOGOUT\r\n")); } catch { /* */ }
    try { conn.close(); } catch { /* */ }
  }
}
const dir = (a: unknown) => ((a as Rec[]) || []).map(x => x.name ? `${x.name} <${x.address}>` : String(x.address || "")).join(", ");

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await permitido(req))) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: cors });
  let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
  const modo = String(body.modo || "buscar");
  const carpeta = String(body.carpeta || "INBOX");
  let imap: ImapFlow | null = null;
  try {
    imap = cliente();
    await imap.connect();

    if (modo === "carpetas") {
      const l = await imap.list();
      return new Response(JSON.stringify({ ok: true, carpetas: l.map(c => ({ ruta: c.path, nombre: c.name, especial: c.specialUse || null })) }), { headers: cors });
    }

    await imap.mailboxOpen(carpeta, { readOnly: true });   // EXAMINE: no cambia nada en el buzón

    if (modo === "buscar") {
      const crit: Rec = {};
      if (body.desde) crit.since = new Date(String(body.desde));
      if (body.hasta) crit.before = new Date(String(body.hasta));
      if (body.de) crit.from = String(body.de);
      if (body.asunto) crit.subject = String(body.asunto);
      if (body.texto) crit.body = String(body.texto);
      const limite = Math.min(200, Math.max(1, Number(body.limite) || 50));
      const uids = (await imap.search(Object.keys(crit).length ? crit : { all: true }, { uid: true })) || [];
      const elegidos = uids.slice(-limite);
      const correos: Rec[] = [];
      if (elegidos.length) {
        for await (const m of imap.fetch(elegidos, { uid: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
          const e = (m.envelope || {}) as Rec;
          correos.push({ uid: m.uid, fecha: e.date || m.internalDate, de: dir(e.from), para: dir(e.to), asunto: e.subject || "", tamano: m.size, adjuntos: adjuntosDe(m.bodyStructure as unknown as Rec) });
        }
      }
      correos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
      return new Response(JSON.stringify({ ok: true, carpeta, encontrados: uids.length, mostrados: correos.length, correos }), { headers: cors });
    }

    // Leer y bajar usan el mismo camino que buscar (imap.fetch) y piden SOLO la parte necesaria:
    // fetchOne/download con el correo completo se colgaban en este entorno (WORKER_RESOURCE_LIMIT).
    const estructura = async (uid: number) => {
      let r: any = null;   // se recorre entero (salir a mitad deja la conexión trabada)
      for await (const m of imap!.fetch([uid], { uid: true, envelope: true, bodyStructure: true }, { uid: true })) r = m;
      if (!r) throw new Error("No existe ese correo");
      return r;
    };
    const traerParte = async (uid: number, parte: string): Promise<Uint8Array> => {
      if (/^[\x20-\x7e]+$/.test(carpeta)) return await parteCruda(carpeta, uid, parte);
      let v: Uint8Array | undefined;
      for await (const m of imap!.fetch([uid], { uid: true, bodyParts: [parte] }, { uid: true })) {
        const bp = m.bodyParts as Map<string, Uint8Array> | undefined;
        v = bp?.get(parte) || bp?.get(parte.toLowerCase()) || (bp ? [...bp.values()][0] : undefined) || v;
      }
      if (!v) throw new Error("No se pudo leer esa parte del correo");
      return new Uint8Array(v);
    };

    const leerUno = async (uid: number) => {
      const m = await estructura(uid);
      const e = (m.envelope || {}) as Rec;
      const hojas = partesDe(m.bodyStructure as unknown as Rec);
      const noAdj = (p: Rec) => String(p.disposition || "") !== "attachment";
      const plano = hojas.find(p => p.type === "text/plain" && noAdj(p));
      const html = hojas.find(p => p.type === "text/html" && noAdj(p));
      const leerParte = async (p: Rec) => aTexto(decodificar(await traerParte(uid, String(p.part || "1")), String(p.encoding || "")), String(((p.parameters as Rec) || {}).charset || "utf-8"));
      let texto = plano ? await leerParte(plano) : "";
      let txt = plano;
      const enlaces: { texto: string; url: string }[] = [];
      if (html) {
        const h = await leerParte(html);
        // enlaces del correo (los avisos del estudio traen la declaración como enlace, no como adjunto)
        for (const a of h.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const url = a[1].replace(/&amp;/g, "&"); if (!/^https?:/i.test(url)) continue;
          enlaces.push({ texto: a[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120), url });
        }
        if (texto.replace(/\s+/g, "").length < 60) {   // el texto plano es un relleno: manda el HTML
          texto = h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          txt = html;
        }
      }
      return ({ ok: true, uid, fecha: e.date, de: dir(e.from), para: dir(e.to), asunto: e.subject || "", formato: txt?.type || null, enlaces,
        texto: texto.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").slice(0, 60000), adjuntos: adjuntosDe(m.bodyStructure as unknown as Rec) });
    };

    if (modo === "leer") {
      const uid = Number(body.uid); if (!uid) throw new Error("Falta uid");
      return new Response(JSON.stringify(await leerUno(uid)), { headers: cors });
    }

    if (modo === "leer_varios") {
      const uids = ((body.uids as unknown[]) || []).map(Number).filter(Boolean).slice(0, 40);
      const largo = Math.min(4000, Math.max(200, Number(body.largo) || 800));
      const out: Rec[] = [];
      for (const uid of uids) {   // de a uno: el servidor de correo no acepta muchos pedidos juntos
        try { const r = await leerUno(uid) as Rec; out.push({ ...r, texto: String(r.texto || "").slice(0, largo) }); }
        catch (e) { out.push({ ok: false, uid, error: String((e as Error).message || e) }); }
      }
      return new Response(JSON.stringify({ ok: true, correos: out }), { headers: cors });
    }



    if (modo === "adjunto") {
      const uid = Number(body.uid), parte = String(body.parte || ""); if (!uid || !parte) throw new Error("Falta uid o parte");
      const m = await estructura(uid);
      const nodo = partesDe(m.bodyStructure as unknown as Rec).find(p => String(p.part || "1") === parte);
      if (!nodo) throw new Error("Ese correo no tiene la parte " + parte);
      const params = { ...((nodo.parameters as Rec) || {}), ...((nodo.dispositionParameters as Rec) || {}) };
      const datos = decodificar(await traerParte(uid, parte), String(nodo.encoding || ""));
      const nombre = String(params.filename || params.name || body.nombre || `adjunto-${parte}`).replace(/[\\/:*?"<>|]+/g, "_");
      const nombreSeguro = nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");   // Storage no admite tildes
      const ruta = `${carpeta.replace(/[^A-Za-z0-9._-]+/g, "_")}/${uid}/${nombreSeguro}`;
      const tipo = String(nodo.type || "application/octet-stream");
      const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, "Content-Type": tipo, "x-upsert": "true" }, body: datos });
      if (!up.ok) throw new Error("No se pudo guardar el adjunto: " + (await up.text()).slice(0, 200));
      const sg = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) });
      const sj = await sg.json();
      return new Response(JSON.stringify({ ok: true, nombre, tipo, tamano: datos.length, ruta, enlace: sj.signedURL ? `${SB_URL}/storage/v1${encodeURI(decodeURI(sj.signedURL))}` : null }), { headers: cors });
    }

    throw new Error("modo desconocido");
  } catch (e) {
    const x = e as Rec;
    // detalle del servidor (nunca incluye la contraseña): ayuda a distinguir clave mal, usuario mal o bloqueo
    const detalle = { autenticacion_fallida: !!x.authenticationFailed, respuesta: x.responseText || null, estado: x.responseStatus || null, codigo: x.serverResponseCode || x.code || null,
      // nunca mostrar el contenido de los secretos: solo si el usuario tiene forma de dirección de correo y de qué dominio
      usuario_es_direccion: /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test((Deno.env.get("MAIL_IMAP_USER") || "").trim()),
      dominio: (/^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec((Deno.env.get("MAIL_IMAP_USER") || "").trim()) || [])[1] || null };
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e), detalle }), { headers: cors });
  } finally {
    try { await imap?.logout(); } catch { /* */ }
  }
});
