// ====== Orden automático de la casilla (corre en cada pasada del cron correo-reglas) ======
// 1) promociones: lo NUEVO de la Bandeja cuyo remitente no tiene regla, no está en la lista blanca y no es
//    cliente ni proveedor de Odoo, y que trae el link de «darse de baja» → carpeta Promociones (no se borra).
//    Queda anotado en correo_promos para la tarjeta «Promociones nuevas» (Papelera siempre / No es publicidad).
// 2) separarImpuestos: lo que cae en «Impuestos y organismos» se lee y va a Velázquez o a RST Cosmetics
//    según el CUIT o el nombre que trae el correo.
import { pareceFactura } from "./facturas.ts";
type Rec = Record<string, unknown>;
type Puente = (b: Rec) => Promise<Rec>;
type Db = (ruta: string, init?: RequestInit) => Promise<Response>;

export const CARPETA_PROMOS = "INBOX.Promociones";
export const CARPETA_IMPUESTOS = "INBOX.Impuestos y organismos";
const IMP_VELAZQUEZ = CARPETA_IMPUESTOS + ".Velázquez";
const IMP_RST = CARPETA_IMPUESTOS + ".RST Cosmetics";

async function estado(db: Db, clave: string): Promise<Rec | null> {
  const r = await (await db(`correo_estado?select=valor&clave=eq.${encodeURIComponent(clave)}`)).json();
  return r[0]?.valor ?? null;
}
async function guardarEstado(db: Db, clave: string, valor: Rec) {
  await db("correo_estado?on_conflict=clave", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ clave, valor, actualizado: new Date().toISOString() }) });
}
function coincide(email: string, patron: string) {
  email = email.toLowerCase();
  if (patron.startsWith("*@")) return (email.split("@")[1] || "") === patron.slice(2);
  if (patron[0] !== "@") return email === patron;
  const d = email.split("@")[1] || "", dom = patron.slice(1);
  return d === dom || d.endsWith("." + dom);
}
const PUBLICOS = new Set(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.ar", "live.com", "icloud.com", "hotmail.com.ar", "live.com.ar", "outlook.com.ar"]);
function dominioBase(d: string) { const p = d.split("."); if (p.length <= 2) return d; const dos = p.slice(-2).join("."); return /^(com|gov|gob|org|net|edu)\.[a-z]{2}$/.test(dos) ? p.slice(-3).join(".") : dos; }

// ¿es alguien con quien trabajamos? (cliente, proveedor o persona de una empresa en Odoo)
async function conocido(db: Db, email: string): Promise<boolean> {
  const dom = email.split("@")[1] || "";
  const filtro = PUBLICOS.has(dom) ? `email=ilike.${encodeURIComponent(email)}` : `email=ilike.*${encodeURIComponent("@" + dominioBase(dom))}`;
  for (const t of ["cliente_metricas", "odoo_contactos", "proveedores"]) {
    const r = await (await db(`${t}?select=email&${filtro}&limit=1`)).json();
    if (Array.isArray(r) && r.length) return true;
  }
  return false;
}
const BAJA = /unsubscribe|desuscrib|darte de baja|dar de baja|date de baja|dejar de recibir|cancelar (la |tu )?suscripci|anular (la )?suscripci|opt-?out|preferencias de (correo|e-?mail|comunicaci|suscripci)|manage (your )?preferences|email preferences|no quiero recibir/i;

export async function promociones(puente: Puente, db: Db, opciones: { soloCarpeta?: string; maxLeer?: number } = {}): Promise<Rec> {
  const carpeta = opciones.soloCarpeta || "INBOX";
  const clave = "promos:" + carpeta;
  const e = await estado(db, clave);
  const b = await puente({ accion: "buscar", carpeta, desde_uid: e ? Number(e.ultimo) + 1 : undefined, limite: e ? 300 : 1 });
  if (!b.ok) return { error: String(b.error) };
  const validez = Number(b.uid_validez), siguiente = Number(b.uid_siguiente);
  if (!e || Number(e.validez) !== validez) { await guardarEstado(db, clave, { validez, ultimo: siguiente - 1 }); return { revisados: 0, iniciado: true }; }
  const correos = ((b.correos as Rec[]) || []).sort((x, y) => Number(x.uid) - Number(y.uid));
  if (!correos.length) return { revisados: 0, promos: 0 };
  const reglas: Rec[] = await (await db("correo_reglas?select=patron&activa=eq.true")).json();
  const blanca: Rec[] = await (await db("correo_lista_blanca?select=patron")).json();
  const patrones = [...reglas, ...blanca].map((x) => String(x.patron));
  const cacheConocido = new Map<string, boolean>();
  let ultimo = Number(e.ultimo), leidos = 0, promos = 0;
  const aMover: number[] = [], filas: Rec[] = [];
  for (const m of correos) {
    if (leidos >= (opciones.maxLeer ?? 25)) break;   // el resto, en la próxima pasada
    ultimo = Math.max(ultimo, Number(m.uid));
    const de = String(m.de_email || "").toLowerCase();
    if (!de || /@rosaint\.com\.ar$/.test(de)) continue;
    if (patrones.some((p) => coincide(de, p))) continue;                       // tiene regla o está en la lista blanca
    if (pareceFactura(String(m.asunto || ""), de, !!m.tiene_adjuntos)) continue;
    if (!cacheConocido.has(de)) cacheConocido.set(de, await conocido(db, de));
    if (cacheConocido.get(de)) continue;
    leidos++;
    const l = await puente({ accion: "leer", carpeta, uid: m.uid });
    if (!l.ok) continue;
    const enlaces = ((l.enlaces as Rec[]) || []).map((x) => `${x.texto} ${x.url}`).join(" ");
    const cola = String(l.texto || "").slice(-3000);
    const motivo = BAJA.test(enlaces) ? "link para darse de baja" : BAJA.test(cola) ? "texto para darse de baja" : null;
    if (!motivo) continue;
    aMover.push(Number(m.uid));
    filas.push({ clave: String(m.message_id || "").trim() || `${de}|${m.fecha}|${m.asunto}`, recibido: m.recibido || m.fecha || null,
      de_email: de, de_nombre: m.de_nombre || null, asunto: String(m.asunto || "").slice(0, 300), motivo, _uid: Number(m.uid) });
  }
  if (aMover.length) {
    const r = await puente({ accion: "mover", carpeta, uids: aMover, destino: CARPETA_PROMOS });
    if (!r.ok) return { error: "mover a Promociones: " + r.error };
    // uids nuevos en Promociones (COPYUID: «a:b,c» en el mismo orden que los originales)
    const nuevos: number[] = [];
    for (const p of String(r.uids_nuevos || "").split(",").filter(Boolean)) { const [a, z] = p.split(":").map(Number); for (let i = a; i <= (z || a); i++) nuevos.push(i); }
    const orden = [...aMover].sort((a, z) => a - z);
    for (const f of filas) { const i = orden.indexOf(Number(f._uid)); f.uid = nuevos[i] ?? null; delete f._uid; }
    await db("correo_promos?on_conflict=clave", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(filas) });
    promos = filas.length;
  }
  await guardarEstado(db, clave, { validez, ultimo });
  return { revisados: correos.length, leidos, promos };
}

// La persona decide desde la tarjeta: «papelera» = regla para siempre + lo que haya en Promociones a la Papelera;
// «bandeja» = no es publicidad: a la lista blanca y lo que haya en Promociones vuelve a la Bandeja.
export async function decidirPromo(puente: Puente, db: Db, email: string, decision: string, usuario: string): Promise<Rec> {
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new Error("Dirección inválida");
  const destino = decision === "papelera" ? "INBOX.Trash" : "INBOX";
  if (decision === "papelera") {
    await db("correo_reglas?on_conflict=patron", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ patron: email, carpeta: "INBOX.Trash", activa: true, creado_por: usuario }) });
  } else {
    await db("correo_lista_blanca?on_conflict=patron", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ patron: email, nota: "No es publicidad (tarjeta Promociones)", creado_por: usuario }) });
  }
  const o = await puente({ accion: "ordenar", origenes: [CARPETA_PROMOS], reglas: [{ patron: email, carpeta: destino }] });
  await db(`correo_promos?de_email=eq.${encodeURIComponent(email)}&estado=eq.nueva`, { method: "PATCH", body: JSON.stringify({ estado: decision === "papelera" ? "papelera" : "bandeja" }) });
  return { ok: !!o.ok, movidos: o.movidos ?? 0, error: o.ok ? undefined : o.error };
}

export async function listarPromos(db: Db): Promise<Rec> {
  // todas las que siguen sin decidir (están en la carpeta Promociones hasta que se elija)
  const filas = await (await db(`correo_promos?select=*&estado=eq.nueva&order=recibido.desc&limit=500`)).json();
  return { ok: true, promos: filas };
}

// ---------------- Impuestos: Velázquez o RST Cosmetics
const ES_RST = /RST\s*COSMETICS|30-?71820815-?3/i;
const ES_VELAZQUEZ = /VEL[AÁ]ZQUEZ\s*,?\s*DIEGO|DIEGO\s+MART[IÍ]N\s+VEL[AÁ]ZQUEZ|20-?31092413-?0/i;
const SOLO_RST = /@(dgrcorrientes\.gov\.ar|agencia\.rionegro\.gov\.ar)$/i;   // Diego: las intimaciones de Corrientes y Río Negro son de RST

export async function separarImpuestos(puente: Puente, db: Db, maxLeer = 30): Promise<Rec> {
  const clave = "impuestos:ultimo";
  const e = await estado(db, clave);
  const b = await puente({ accion: "buscar", carpeta: CARPETA_IMPUESTOS, desde_uid: e ? Number(e.ultimo) + 1 : undefined, limite: 500 });
  if (!b.ok) return { error: String(b.error) };
  const validez = Number(b.uid_validez);
  const desde = e && Number(e.validez) === validez ? Number(e.ultimo) : 0;
  const correos = ((b.correos as Rec[]) || []).filter((m) => Number(m.uid) > desde).sort((x, y) => Number(x.uid) - Number(y.uid));
  const a: Record<string, number[]> = { [IMP_RST]: [], [IMP_VELAZQUEZ]: [] };
  let ultimo = desde, leidos = 0, quedan = 0;
  for (const m of correos) {
    if (leidos >= maxLeer) { quedan++; continue; }
    const de = String(m.de_email || "");
    let destino: string | null = null;
    const asunto = String(m.asunto || "");
    if (ES_RST.test(asunto)) destino = IMP_RST;
    else if (ES_VELAZQUEZ.test(asunto)) destino = IMP_VELAZQUEZ;
    else {
      leidos++;
      const l = await puente({ accion: "leer", carpeta: CARPETA_IMPUESTOS, uid: m.uid });
      const t = `${asunto}\n${l.para || ""}\n${String(l.texto || "").slice(0, 30000)}`;
      const rst = t.search(ES_RST), vel = t.search(ES_VELAZQUEZ);
      if (rst >= 0 && (vel < 0 || rst < vel)) destino = IMP_RST;
      else if (vel >= 0) destino = IMP_VELAZQUEZ;
      else if (SOLO_RST.test(de)) destino = IMP_RST;
    }
    if (destino) a[destino].push(Number(m.uid));
    ultimo = Math.max(ultimo, Number(m.uid));
  }
  const movidos: Rec = {};
  for (const [destino, uids] of Object.entries(a)) {
    if (!uids.length) continue;
    const r = await puente({ accion: "mover", carpeta: CARPETA_IMPUESTOS, uids, destino });
    if (!r.ok) return { error: `mover a ${destino}: ${r.error}` };
    movidos[destino.split(".").pop()!] = uids.length;
  }
  await guardarEstado(db, clave, { validez, ultimo });
  return { revisados: correos.length - quedan, leidos, movidos, quedan };
}
