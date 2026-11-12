// ====== Facturas que llegan por correo (tarjeta «Facturas» de Ventas → Correo) ======
// 1) detectar: en cada pasada del cron (antes de aplicar las reglas) mira lo NUEVO de la Bandeja y de Spam,
//    reconoce las facturas por el asunto, deja una COPIA en la carpeta «Facturas» y la anota en correo_facturas.
//    El original sigue su camino (las reglas lo llevan a la carpeta del proveedor).
// 2) cruzarOdoo: busca cada factura entre las facturas de proveedor de Odoo (empresa 2):
//    mismo número → «cargada»; sin número, mismo proveedor y fecha cercana → «revisar»; si no → «falta cargar».
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
type Rec = Record<string, unknown>;
export type Puente = (b: Rec) => Promise<Rec>;
export type Db = (ruta: string, init?: RequestInit) => Promise<Response>;

export const CARPETA_FACTURAS = "INBOX.Facturas";
const CASILLA_PROPIA = /@rosaint\.com\.ar$/i;

// ---------------- qué es una factura (por el asunto)
const QUITAR = /\*{2,}\s*spam\s*\*{2,}/gi;
const NO_ES = /vencid|vencer|vencimiento|impag|recordatorio|record[aá]t|pr[oó]xim[ao] a|reclamo|no fue posible|fe de erratas|^\s*(re|rv|fw|fwd|reenv\w*)\s*:|respuesta autom|\brecibo\b|pago aprobado|orden de compra|cotizaci|presupuesto|sub[ií]\s+(la|tu)|carg[aá]\s+(la|tu)|deb[eé]s?\s+(subir|presentar|emitir)|solicit/i;
const ES = /factura|\bFC\s*[-\dA-C]|\bFA-?[ABCM]\b|nota de (cr[eé]dito|d[eé]bito)|\bN[CD]-?[ABC]\s*\d|comprobante\s+(electr[oó]nico|formulario|tipo|fiscal)|formulario electr[oó]nico/i;
const ES_CON_PDF = /facturaci[oó]n/i;   // «FACTURACION-NO RESPONDER»: solo si trae un PDF

export function limpiarAsunto(s: string) { return String(s || "").replace(QUITAR, "").replace(/\s+/g, " ").trim(); }
export function pareceFactura(asunto: string, deEmail: string, tieneAdjuntos: boolean): boolean {
  if (CASILLA_PROPIA.test(deEmail || "")) return false;          // las que manda Odoo a los clientes desde contacto@
  const a = limpiarAsunto(asunto);
  if (!a || NO_ES.test(a)) return false;
  return ES.test(a) || (tieneAdjuntos && ES_CON_PDF.test(a));
}

// ---------------- número, tipo y letra (asunto, nombres de los PDF y texto del correo)
function numeroDe(textos: string[]): string | null {
  for (const t of textos) {
    if (!t) continue;
    let m = /\b(\d{4,5})([ABCM])(\d{8})\b/.exec(t);                                   // Andreani: 04148A00422501
    if (m) return `${m[1].padStart(5, "0")}-${m[3]}`;
    m = /\b(?:FAC?|NC|ND)([ABCM])(\d{5})(\d{8})\b/i.exec(t);                          // DHACAM: FACA0000600029492.pdf
    if (m) return `${m[2]}-${m[3]}`;
    m = /(?<!\d)(\d{4,5})\s*[-–_ ]\s*(\d{8})(?!\d)/.exec(t);                           // 0003-00022035 · 00016-00005371
    if (m) return `${m[1].padStart(5, "0")}-${m[2]}`;
    m = /punto\s+de\s+venta\W{0,4}(\d{1,5})[\s\S]{0,80}?comp(?:robante)?\.?\s*n(?:ro|°|º|ú?mero)?\.?\W{0,4}(\d{1,8})/i.exec(t);
    if (m) return `${m[1].padStart(5, "0")}-${m[2].padStart(8, "0")}`;
  }
  return null;
}
function tipoDe(t: string) { return /nota de cr[eé]dito|\bNC-?[ABC]?\b/i.test(t) ? "Nota de crédito" : /nota de d[eé]bito|\bND-?[ABC]?\b/i.test(t) ? "Nota de débito" : "Factura"; }
function letraDe(t: string) {
  const m = /\b(?:FA|FC|NC|ND|factura|tipo)\s*[-"“]?\s*([ABCM])\b/i.exec(t) || /\b\d{4,5}([ABCM])\d{8}\b/.exec(t);
  return m ? m[1].toUpperCase() : null;
}

// ---------------- texto de un PDF (los generados por sistema lo traen; los escaneados son una foto y no)
const latin1 = new TextDecoder("latin1");
async function inflar(datos: Uint8Array): Promise<string> {
  // el stream termina con un salto de línea antes de «endstream»: sobra y el descompresor de Supabase
  // descarta todo si encuentra basura al final. Se recorta y se manda de a pedazos (lo que salga, sirve).
  let fin = datos.length;
  while (fin > 0 && (datos[fin - 1] === 10 || datos[fin - 1] === 13 || datos[fin - 1] === 32)) fin--;
  datos = datos.subarray(0, fin);
  const ds = new DecompressionStream("deflate");
  const w = ds.writable.getWriter();
  (async () => { try { for (let i = 0; i < datos.length; i += 2048) await w.write(datos.subarray(i, i + 2048)); await w.close(); } catch { /* corta */ } })();
  const r = ds.readable.getReader(); const partes: Uint8Array[] = [];
  try { for (;;) { const { value, done } = await r.read(); if (done) break; partes.push(value); } }
  catch { /* basura al final del stream: sirve lo que ya salió */ }
  let n = 0; for (const p of partes) n += p.length;
  const todo = new Uint8Array(n); let i = 0; for (const p of partes) { todo.set(p, i); i += p.length; }
  return latin1.decode(todo);
}
export async function textoPdf(pdf: Uint8Array): Promise<string> {
  const s = latin1.decode(pdf), out: string[] = [];
  const re = /stream\r?\n/g; let m: RegExpExecArray | null, vueltas = 0;
  while ((m = re.exec(s)) && vueltas++ < 80) {
    const ini = m.index + m[0].length, fin = s.indexOf("endstream", ini);
    if (fin < 0) break;
    if (fin - ini > 400000) { re.lastIndex = fin; continue; }   // imágenes grandes: no tienen texto
    const t = await inflar(pdf.subarray(ini, fin));
    re.lastIndex = fin;
    if (!/T[jJ*]|Td/.test(t)) continue;
    const partes: string[] = [];
    const rt = /\((?:\\.|[^\\)])*\)|\bT\*|\bT[dD]\b|\bET\b/g; let x: RegExpExecArray | null;
    while ((x = rt.exec(t))) {
      const v = x[0];
      if (v[0] === "(") partes.push(v.slice(1, -1).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1"));
      else partes.push("\n");
    }
    out.push(partes.join(""));
  }
  return out.join("\n").replace(/[ \t]+/g, " ").slice(0, 30000);
}

// ---------------- datos del comprobante: CUIT de quien factura, fecha, vencimiento de pago, total, si ya está pagada
const CUITS_PROPIOS = new Set(["20310924130"]);   // Diego Martín Velázquez
const isoFecha = (d: string, m: string, a: string) => {
  const anio = a.length === 2 ? "20" + a : a, mes = m.padStart(2, "0"), dia = d.padStart(2, "0");
  const f = `${anio}-${mes}-${dia}`;
  return Number(mes) >= 1 && Number(mes) <= 12 && Number(dia) >= 1 && Number(dia) <= 31 && Number(anio) >= 2020 && Number(anio) <= 2035 ? f : null;
};
const importe = (s: string) => { const v = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s); return Number.isFinite(v) && v > 0 ? v : null; };
export function datosComprobante(textos: string[]) {
  const t = textos.filter(Boolean).join("\n");
  let vence: string | null = null, emitida: string | null = null, total: number | null = null, cuit: string | null = null;
  // vencimiento de PAGO (el «Vto. CAE» no: es la validez del código de ARCA)
  const rv = /(?:venc(?:imiento)?|vto)\.?(?:\s+(?:para\s+el\s+|de\s+)?pago)?\s*(?:1[°º]?\s*)?:?\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/gi;
  for (const x of t.matchAll(rv)) { if (/cae/i.test(t.slice(Math.max(0, x.index! - 12), x.index! + 4))) continue; vence = isoFecha(x[1], x[2], x[3]); if (vence) break; }
  const re = /fecha(?:\s+de\s+emisi[oó]n)?\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(t);
  if (re) emitida = isoFecha(re[1], re[2], re[3]);
  const rt = /(?:importe\s+)?total(?:\s+a\s+pagar)?\s*:?\s*\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+(?:[.,]\d{2}))/i.exec(t);
  if (rt) total = importe(rt[1]);
  for (const x of t.matchAll(/(?<!\d)(20|23|24|27|30|33|34)-?(\d{8})-?(\d)(?!\d)/g)) { const c = x[1] + x[2] + x[3]; if (!CUITS_PROPIOS.has(c)) { cuit = c; break; } }
  const pagada = /ya fueron abonados|ya fue abonad[oa]|no es necesario realizar ning[uú]n (pago|acci)|d[eé]bito autom[aá]tico|se debitar[aá] (de|en) tu/i.test(t) ? true : null;
  return { vence, emitida, total, cuit, pagada };
}

// ---------------- detectar
async function estado(db: Db, clave: string): Promise<Rec | null> {
  const r = await (await db(`correo_estado?select=valor&clave=eq.${encodeURIComponent(clave)}`)).json();
  return r[0]?.valor ?? null;
}
async function guardarEstado(db: Db, clave: string, valor: Rec) {
  await db("correo_estado?on_conflict=clave", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ clave, valor, actualizado: new Date().toISOString() }) });
}
async function asegurarCarpeta(puente: Puente) {
  const c = await puente({ accion: "carpetas" });
  if (!((c.carpetas as Rec[]) || []).some((x) => x.ruta === CARPETA_FACTURAS)) {
    const r = await puente({ accion: "crear_carpeta", nombre: "Facturas", padre: "INBOX" });
    if (!r.ok) throw new Error("No se pudo crear la carpeta Facturas: " + r.error);
  }
}

// Lee un correo de factura (texto y PDF) y saca todo lo que se pueda del comprobante.
async function analizar(puente: Puente, carpeta: string, uid: number, asuntoCrudo: string) {
  const l = await puente({ accion: "leer", carpeta, uid });
  if (!l.ok) throw new Error(`leer ${carpeta}/${uid}: ${l.error}`);
  const pdfs = ((l.adjuntos as Rec[]) || []).filter((a) => /pdf/i.test(String(a.tipo)) || /\.pdf$/i.test(String(a.nombre)))
    .map((a) => ({ parte: a.parte, nombre: a.nombre, tamano: a.tamano }));
  const asunto = limpiarAsunto(asuntoCrudo || String(l.asunto || ""));
  const nombres = pdfs.map((p) => String(p.nombre));
  const texto = String(l.texto || "").slice(0, 20000);
  // el texto de los PDF (hasta 2): número, vencimiento, total y CUIT de quien factura
  let textoPdfs = "";
  for (const p of pdfs.slice(0, 2)) {
    if (Number(p.tamano) > 6e6) continue;
    try {
      const a = await puente({ accion: "adjunto", carpeta, uid, parte: p.parte, en_linea: true });
      if (a.ok && a.base64) textoPdfs += "\n" + await textoPdf(decodeBase64(String(a.base64)));
    } catch { /* sin texto */ }
  }
  const dc = datosComprobante([textoPdfs, texto, asunto]);
  let letra = letraDe(asunto + " " + nombres.join(" "));
  if (!letra && textoPdfs) letra = (/FACTURA\s*\n?\s*([ABCM])\b|\n([ABCM])\n/.exec(textoPdfs) || []).slice(1).find(Boolean) || null;
  return {
    asunto, pdfs,
    datos: {
      tipo: tipoDe(asunto + " " + nombres.join(" ")), letra,
      numero: numeroDe([asunto, ...nombres, textoPdfs, texto]),
      a_nombre_de: /RST\s+COSMETICS/i.test(asunto + " " + texto + " " + textoPdfs) ? "RST Cosmetics" : null,
      cuit_emisor: dc.cuit, emitida: dc.emitida, total: dc.total,
      vence: dc.vence, vence_origen: dc.vence ? (textoPdfs && datosComprobante([textoPdfs]).vence === dc.vence ? "pdf" : "correo") : null,
      pagada: dc.pagada, pago_origen: dc.pagada ? "correo" : null,
    } as Rec,
  };
}

// Anota una factura (ya reconocida): la analiza, la copia a Facturas y la guarda.
export async function registrarFactura(puente: Puente, db: Db, carpeta: string, m: Rec): Promise<Rec> {
  const fecha = String(m.fecha || m.recibido || "");
  const clave = String(m.message_id || "").trim() || `${m.de_email}|${fecha}|${m.asunto}`;
  const ya = await (await db(`correo_facturas?select=id&clave=eq.${encodeURIComponent(clave)}`)).json();
  if (ya.length) return { id: ya[0].id, repetida: true };
  const an = await analizar(puente, carpeta, Number(m.uid), String(m.asunto || ""));
  let uidCopia: number | null = null;
  if (carpeta !== CARPETA_FACTURAS) {
    const c = await puente({ accion: "copiar", carpeta, uids: [m.uid], destino: CARPETA_FACTURAS });
    if (!c.ok) throw new Error(`copiar ${carpeta}/${m.uid}: ${c.error}`);
    uidCopia = c.uids_nuevos ? Number(String(c.uids_nuevos).split(/[,:]/)[0]) : null;
  } else uidCopia = Number(m.uid);
  const fila = {
    clave, recibido: m.recibido || m.fecha || null, de_email: String(m.de_email || "").toLowerCase(), de_nombre: m.de_nombre || null, asunto: an.asunto,
    origen_carpeta: carpeta, origen_uid: m.uid, carpeta: CARPETA_FACTURAS, uid: uidCopia, pdfs: an.pdfs, ...an.datos,
  };
  const r = await db("correo_facturas?on_conflict=clave", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(fila) });
  if (!r.ok) throw new Error("No se pudo guardar la factura: " + (await r.text()).slice(0, 200));
  const j = await r.json();
  return { id: j[0]?.id, numero: an.datos.numero, vence: an.datos.vence, pdfs: an.pdfs.length };
}

// Vuelve a leer facturas ya anotadas (desde su copia en Facturas) y completa lo que falte.
// No pisa lo que vino de Odoo ni lo que se marcó a mano.
export async function releer(puente: Puente, db: Db, ids: number[]): Promise<Rec[]> {
  const filas: Rec[] = await (await db(`correo_facturas?select=*&id=in.(${ids.join(",")})`)).json();
  const res: Rec[] = [];
  for (const f of filas) {
    try {
      const an = await analizar(puente, String(f.carpeta), Number(f.uid), String(f.asunto || ""));
      const d = an.datos, cambios: Rec = { pdfs: an.pdfs };
      for (const k of ["tipo", "letra", "numero", "a_nombre_de", "cuit_emisor", "emitida", "total"]) if (d[k] != null) cambios[k] = d[k];
      if (f.vence_origen !== "odoo" && d.vence) { cambios.vence = d.vence; cambios.vence_origen = d.vence_origen; }
      if (f.pago_origen !== "odoo" && f.pago_origen !== "manual" && d.pagada != null) { cambios.pagada = d.pagada; cambios.pago_origen = d.pago_origen; }
      await db(`correo_facturas?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify(cambios) });
      res.push({ id: f.id, numero: cambios.numero ?? f.numero, vence: cambios.vence ?? f.vence, cuit: cambios.cuit_emisor ?? null });
    } catch (e) { res.push({ id: f.id, error: String((e as Error).message || e) }); }
  }
  return res;
}

// Lo nuevo de la Bandeja y de Spam desde la última pasada. La primera vez solo marca dónde empezar.
export async function detectar(puente: Puente, db: Db): Promise<Rec> {
  const est = await puente({ accion: "estado" });
  const spam = ((est.especiales as Rec) || {})["\\Junk"];
  const carpetas = ["INBOX", ...(spam ? [String(spam)] : [])];
  const out: Rec = { revisados: 0, facturas: 0, errores: [] as string[] };
  let carpetaLista = false;
  for (const carpeta of carpetas) {
    const clave = "facturas:" + carpeta;
    const e = await estado(db, clave);
    const b = await puente({ accion: "buscar", carpeta, desde_uid: e ? Number(e.ultimo) + 1 : undefined, limite: e ? 300 : 1 });
    if (!b.ok) { (out.errores as string[]).push(`${carpeta}: ${b.error}`); continue; }
    const validez = Number(b.uid_validez), siguiente = Number(b.uid_siguiente);
    if (!e || Number(e.validez) !== validez) { await guardarEstado(db, clave, { validez, ultimo: siguiente - 1 }); continue; }
    const correos = ((b.correos as Rec[]) || []).sort((x, y) => Number(x.uid) - Number(y.uid));
    let ultimo = Number(e.ultimo);
    for (const m of correos) {
      out.revisados = Number(out.revisados) + 1;
      if (pareceFactura(String(m.asunto), String(m.de_email), !!m.tiene_adjuntos)) {
        try {
          if (!carpetaLista) { await asegurarCarpeta(puente); carpetaLista = true; }
          const r = await registrarFactura(puente, db, carpeta, m);
          if (!r.repetida) out.facturas = Number(out.facturas) + 1;
        } catch (err) { (out.errores as string[]).push(String((err as Error).message || err)); break; }   // se reintenta en la próxima pasada
      }
      ultimo = Math.max(ultimo, Number(m.uid));
    }
    await guardarEstado(db, clave, { validez, ultimo });
  }
  return out;
}

// ---------------- Odoo
const ODOO_URL = Deno.env.get("ODOO_URL") || "", ODOO_DB = Deno.env.get("ODOO_DB") || "", ODOO_LOGIN = Deno.env.get("ODOO_LOGIN") || "", ODOO_KEY = Deno.env.get("ODOO_KEY") || "";
const CTX = { allowed_company_ids: [2], company_id: 2, lang: "es_ES" };
let uidOdoo: number | null = null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  let texto = "";
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 700 * i));
    const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }) });
    texto = await res.text();
    if (res.ok && texto.trimStart().startsWith("{")) break;
  }
  const j = JSON.parse(texto);
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message));
  return j.result;
}
async function odoo(model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  if (!uidOdoo) uidOdoo = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number;
  return rpc("object", "execute_kw", [ODOO_DB, uidOdoo, ODOO_KEY, model, method, args, { ...kwargs, context: CTX }]);
}
const PUBLICOS = new Set(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.ar", "live.com", "icloud.com", "fibertel.com.ar", "speedy.com.ar"]);
function dominioBase(d: string) { const p = d.split("."); if (p.length <= 2) return d; const dos = p.slice(-2).join("."); return /^(com|gov|gob|org|net|edu)\.[a-z]{2}$/.test(dos) ? p.slice(-3).join(".") : dos; }

// proveedor en Odoo: por el CUIT del comprobante; si no, por quién manda el correo
// (la ficha del Core —proveedores.email— o el correo de un contacto de Odoo)
async function proveedorDe(db: Db, email: string, cuit: string | null): Promise<{ id: number; nombre: string } | null> {
  if (cuit) {
    const c = `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
    const r = await odoo("res.partner", "search_read", [[["vat", "in", [cuit, c]]]], { fields: ["commercial_partner_id"], limit: 1 }) as Rec[];
    if (r.length) { const cp = r[0].commercial_partner_id as [number, string]; return { id: cp[0], nombre: cp[1] }; }
  }
  const dom = email.split("@")[1] || "";
  if (!dom) return null;
  const base = dominioBase(dom), publico = PUBLICOS.has(dom);
  const patron = publico ? email : "@" + base;
  const p = await (await db(`proveedores?select=odoo_partner_id,odoo_nombre,nombre&odoo_partner_id=not.is.null&email=ilike.*${encodeURIComponent(patron)}*&limit=1`)).json();
  if (p.length) return { id: p[0].odoo_partner_id, nombre: p[0].odoo_nombre || p[0].nombre };
  const r = await odoo("res.partner", "search_read", [[["email", "ilike", patron]]], { fields: ["commercial_partner_id", "supplier_rank"], limit: 20, order: "supplier_rank desc" }) as Rec[];
  const x = r.find((y) => Number(y.supplier_rank) > 0) || r[0];
  if (x) return { id: (x.commercial_partner_id as [number, string])[0], nombre: (x.commercial_partner_id as [number, string])[1] };
  // último intento: un proveedor cuyo nombre sea el del dominio (tiendanube.com → «Tiendanube»), si hay uno solo
  const palabra = publico ? "" : base.split(".")[0];
  if (palabra.length >= 5) {
    const n = await odoo("res.partner", "search_read", [[["name", "ilike", palabra], ["supplier_rank", ">", 0], ["parent_id", "=", false]]], { fields: ["id", "name"], limit: 2 }) as Rec[];
    if (n.length === 1) return { id: Number(n[0].id), nombre: String(n[0].name) };
  }
  return null;
}

const PAGADA = new Set(["paid", "in_payment", "reversed"]);
// Cruza con Odoo (últimos 150 días) las que no están cargadas seguro o todavía no figuran pagadas.
// Si la encuentra: trae el vencimiento y si está pagada (Odoo manda sobre lo que decía el PDF).
export async function cruzarOdoo(db: Db, soloIds?: number[]): Promise<Rec> {
  if (!ODOO_URL) return { error: "Faltan los datos de Odoo" };
  const desde = new Date(Date.now() - 150 * 864e5).toISOString();
  const filtro = soloIds?.length ? `id=in.(${soloIds.join(",")})`
    : `descartada=eq.false&a_nombre_de=is.null&recibido=gte.${desde}&or=(odoo_move_id.is.null,odoo_estado.neq.posted,odoo_coincide.eq.fecha,pagada.is.null,pagada.eq.false)`;
  const filas: Rec[] = await (await db(`correo_facturas?select=*&${filtro}&order=recibido.desc&limit=300`)).json();
  if (!filas.length) return { revisadas: 0 };
  // las facturas de proveedor de los últimos 200 días, de una sola vez
  const desdeF = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const movs = await odoo("account.move", "search_read",
    [[["move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", 2], ["state", "!=", "cancel"], "|", ["invoice_date", ">=", desdeF], ["invoice_date", "=", false]]],
    { fields: ["name", "ref", "l10n_latam_document_number", "commercial_partner_id", "invoice_date", "invoice_date_due", "state", "amount_total", "amount_residual", "payment_state", "move_type"], limit: 4000 }) as Rec[];
  const usados = new Set<number>((await (await db(`correo_facturas?select=odoo_move_id&odoo_move_id=not.is.null&odoo_coincide=eq.numero`)).json()).map((x: Rec) => Number(x.odoo_move_id)));
  let cargadas = 0;
  for (const f of filas) {
    let partner = f.partner_id ? { id: Number(f.partner_id), nombre: String(f.proveedor || "") } : null;
    if (!partner) { try { partner = await proveedorDe(db, String(f.de_email || ""), f.cuit_emisor ? String(f.cuit_emisor) : null); } catch { /* sin proveedor */ } }
    const delProv = partner ? movs.filter((x) => (x.commercial_partner_id as [number, string])?.[0] === partner!.id) : [];
    const tipoOdoo = f.tipo === "Nota de crédito" ? "in_refund" : "in_invoice";
    let hit: Rec | undefined, como: string | null = null;
    if (f.numero) {
      const [pv, nro] = String(f.numero).split("-");
      const re = new RegExp(`(^|[^0-9])0*${Number(pv)}[^0-9]+0*${Number(nro)}($|[^0-9])`);
      const base = delProv.length ? delProv : movs;
      // primero el número propio del comprobante; la referencia solo si es del mismo tipo
      // (una nota de crédito lleva en la referencia el número de la factura que anula)
      hit = base.find((x) => re.test(`${x.name || ""} ${x.l10n_latam_document_number || ""}`))
        || base.find((x) => x.move_type === tipoOdoo && re.test(String(x.ref || "")));
      if (hit) como = "numero";
    }
    if (!hit && partner && f.recibido) {
      const t = new Date(String(f.emitida || f.recibido)).getTime();
      const cerca = delProv.filter((x) => x.move_type === tipoOdoo && x.invoice_date && !usados.has(Number(x.id)) && Math.abs(new Date(String(x.invoice_date)).getTime() - t) <= 12 * 864e5
          && (!f.total || Math.abs(Number(x.amount_total) - Number(f.total)) < 1))
        .sort((a, b) => Math.abs(new Date(String(a.invoice_date)).getTime() - t) - Math.abs(new Date(String(b.invoice_date)).getTime() - t));
      if (cerca.length) { hit = cerca[0]; como = "fecha"; }
    }
    if (hit && como === "numero") usados.add(Number(hit.id));
    if (hit && como === "numero" && hit.state === "posted") cargadas++;
    const cambios: Rec = {
      partner_id: partner?.id ?? null, proveedor: partner?.nombre ?? null,
      odoo_move_id: hit ? hit.id : null, odoo_nombre: hit ? hit.name : null, odoo_estado: hit ? hit.state : null,
      odoo_total: hit ? hit.amount_total : null, odoo_saldo: hit ? hit.amount_residual : null,
      odoo_coincide: como, odoo_revisado: new Date().toISOString() };
    if (hit) {
      if (hit.invoice_date_due) { cambios.vence = hit.invoice_date_due; cambios.vence_origen = "odoo"; }
      if (f.pago_origen !== "manual" && hit.state === "posted") { cambios.pagada = PAGADA.has(String(hit.payment_state)); cambios.pago_origen = "odoo"; }
    } else if (f.vence_origen === "odoo") { cambios.vence = null; cambios.vence_origen = null; }
    await db(`correo_facturas?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify(cambios) });
  }
  return { revisadas: filas.length, cargadas };
}

// ---------------- lo que ve la pantalla
export async function listar(db: Db, dias = 90): Promise<Rec> {
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const filas = await (await db(`correo_facturas?select=*&recibido=gte.${desde}&order=recibido.desc&limit=500`)).json();
  return { ok: true, facturas: filas };
}
