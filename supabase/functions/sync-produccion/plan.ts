// ====== Programador de producción (modos "plan" y "etiquetar") ======
// "plan": SOLO LECTURA de Odoo (salvo crear la etiqueta 🔄 Entrega parcial si falta).
//   Guarda la foto completa en prod_plan_snapshot y devuelve solo un resumen
//   (los datos de clientes no viajan sin login: la página los lee de la tabla).
// "etiquetar": cambia la etiqueta de prioridad de UN pedido. Exige usuario logueado.
// JSON-RPC (no el parser XML de index.ts: es O(n²) y revienta con respuestas grandes).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const CTX = { allowed_company_ids: [2], lang: "es_ES" };

export const TAG_PARCIAL = "🔄 Entrega parcial";
const ML_SOURCE = 15;      // utm.source "🟡 Mercado Libre"
const TN_SOURCE = 16;      // utm.source Tienda Nube

type Row = Record<string, any>;

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<any> {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  const j = await r.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid = 0;
async function uid(): Promise<number> {
  if (_uid) return _uid;
  const u = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!u || typeof u !== "number") throw new Error("Auth Odoo fallida");
  return (_uid = u);
}
async function ex(model: string, method: string, args: unknown[], kw: Row = {}): Promise<any> {
  return jsonrpc("object", "execute_kw", [ODOO_DB, await uid(), ODOO_KEY, model, method, args, { ...kw, context: CTX }]);
}
const m2o = (v: any) => (Array.isArray(v) ? v[0] : null);
const m2oName = (v: any) => (Array.isArray(v) ? String(v[1] ?? "") : "");
const dia = (s: any) => (s ? String(s).slice(0, 10) : null);

// Devuelve el usuario logueado (o null). Valida el token contra Supabase Auth.
export async function usuarioValido(req: Request): Promise<Row | null> {
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  const apikey = req.headers.get("apikey") || PUB;
  try { const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Lleva una cantidad a su unidad base según la unidad con que se cargó: kg (peso), L (volumen), u (unidades).
// Nunca se adivina por el número: 500 g son 0,5 kg; "0,6 g" son 0,0006 kg (y si Odoo dice 0,6 kg, es una inconsistencia).
export function aBase(q: number, unidad: string): { q: number; u: string } {
  const n = String(unidad || "").toLowerCase().trim();
  if (["g", "gr", "gramo", "gramos"].includes(n)) return { q: q / 1000, u: "kg" };
  if (["kg", "kgs", "kilo", "kilos", "kilogramo", "kilogramos"].includes(n)) return { q, u: "kg" };
  if (["cc", "ml", "mililitro", "mililitros"].includes(n)) return { q: q / 1000, u: "L" };
  if (["l", "lt", "lts", "litro", "litros"].includes(n)) return { q, u: "L" };
  if (n === "un" || n === "u" || n.startsWith("unidad")) return { q, u: "u" };
  return { q, u: n || "?" };
}
const fechaAR = (utc: any) => utc ? new Date(new Date(String(utc).replace(" ", "T") + "Z").getTime() - 3 * 3600e3).toISOString().slice(0, 10) : null;

// ====== Control Hoja de Producción (Core) ↔ Fabricación (Odoo) ======
// La planta carga en la hoja y después pasa eso a Odoo a mano (asignando lotes de MP).
// Tienen que coincidir siempre, día por día y producto por producto. Deja los hallazgos en
// control_alertas (Inicio los muestra). Corre por cron cada 15 min y desde "Programar el día".
export async function modoControl() {
  const t0 = Date.now();
  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const hoyAR = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const desde = new Date(Date.now() - 21 * 864e5 - 3 * 3600e3).toISOString().slice(0, 10);

  const { data: hoja, error: eh } = await sb.from("prod_hoja_diaria").select("id,fecha,hora,producto_sku,producto_nombre,cantidad,unidad,tipo,iniciales").gte("fecha", desde).range(0, 9999);
  if (eh) throw new Error("hoja: " + eh.message);
  const mos = await ex("mrp.production", "search_read", [[["company_id", "=", 2], ["state", "!=", "cancel"], ["date_start", ">=", desde + " 00:00:00"]]],
    { fields: ["name", "product_id", "product_qty", "product_uom_id", "state", "date_start"] }) as Row[];
  const prodM = await productos([...new Set(mos.map((m) => m2o(m.product_id)).filter(Boolean))] as number[]);
  // desmontajes terminados (mrp.unbuild): deshacen total o parcialmente una orden → se restan de esa orden
  const unb = mos.length ? await ex("mrp.unbuild", "search_read", [[["mo_id", "in", mos.map((m) => m.id)], ["state", "=", "done"]]], { fields: ["name", "mo_id", "product_qty", "product_uom_id"] }) as Row[] : [];
  const desmontadoDe = new Map<number, { q: number; refs: string[] }>();
  for (const u of unb) { const k = m2o(u.mo_id); const d = desmontadoDe.get(k) || { q: 0, refs: [] }; d.q += aBase(Number(u.product_qty) || 0, m2oName(u.product_uom_id)).q; d.refs.push(u.name); desmontadoDe.set(k, d); }

  type Lado = { fecha: string; c: string; nombre: string; q: number; u: string; det: Row[] };
  const H: Record<string, Lado> = {}, OD: Record<string, Lado & { abiertas: Row[] }> = {};
  for (const h of hoja || []) {
    const c = String(h.producto_sku || "").trim(); if (!c) continue;
    const b = aBase(Number(h.cantidad) || 0, h.unidad);
    const k = h.fecha + "|" + c;
    const x = (H[k] = H[k] || { fecha: h.fecha, c, nombre: h.producto_nombre || c, q: 0, u: b.u, det: [] });
    x.q += b.q; x.det.push({ hora: String(h.hora || "").slice(0, 5), cantidad: Number(h.cantidad), unidad: h.unidad, quien: h.iniciales || "" });
  }
  for (const m of mos) {
    const c = String(prodM.get(m2o(m.product_id))?.default_code || "").trim(); if (!c) continue;
    const fecha = fechaAR(m.date_start)!; if (fecha < desde) continue;
    const b = aBase(Number(m.product_qty) || 0, m2oName(m.product_uom_id));
    const k = fecha + "|" + c;
    const x = (OD[k] = OD[k] || { fecha, c, nombre: prodM.get(m2o(m.product_id))?.name || c, q: 0, u: b.u, det: [], abiertas: [] });
    const desm = desmontadoDe.get(m.id);
    if (m.state === "done") {
      const neto = Math.max(0, b.q - (desm?.q || 0));
      x.q += neto;
      if (neto > 1e-9) x.det.push({ mo: m.name + (desm ? ` (desmontada en parte: ${desm.refs.join(", ")})` : ""), cantidad: neto, unidad: b.u });
    }
    else x.abiertas.push({ mo: m.name, estado: m.state, cantidad: Number(m.product_qty), unidad: m2oName(m.product_uom_id) });
  }

  const habiles = (a: string, b: string) => { let n = 0; const d = new Date(a + "T12:00:00"); const f = new Date(b + "T12:00:00"); while (d < f) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) n++; } return n; };
  const fc = (f: string) => f.split("-").reverse().slice(0, 2).join("/");
  const n2 = (x: number) => Math.round(x * 1000) / 1000;
  const alertas: Row[] = [];
  const pendHoy: Row[] = [];
  // 1) Hoy: solo se informa lo que falta pasar (lo van pasando durante el día)
  const pasados: string[] = [];
  for (const k of new Set([...Object.keys(H), ...Object.keys(OD)])) {
    const h = H[k], o = OD[k];
    const fecha = (h || o).fecha;
    if (fecha >= hoyAR) { if (h && !(o && (o.q > 0 || o.abiertas.length))) pendHoy.push({ c: h.c, nombre: h.nombre, q: n2(h.q), u: h.u }); continue; }
    pasados.push(k);
    if (o && o.abiertas.length) {
      const atraso = habiles(fecha, hoyAR);
      alertas.push({ fecha_ref: fecha, codigo: o.c, datos: { hoja: h || null, odoo: o }, clave: `sin_validar|${fecha}|${o.c}`, tipo: "sin_validar", severidad: atraso >= 2 ? "critico" : "warn",
        titulo: `Orden de fabricación sin validar: ${o.nombre} (${fc(fecha)})`, detalle: o.abiertas.map((a) => `${a.mo} · ${a.cantidad} ${a.unidad} · ${a.estado}`).join(" · ") });
    }
  }
  // 2) Días anteriores: diferencia hoja − Odoo por producto y día
  type Dif = { k: string; fecha: string; c: string; nombre: string; dq: number; h?: Lado; o?: Lado & { abiertas: Row[] }; usado?: boolean };
  const difs: Dif[] = [];
  for (const k of pasados) {
    const h = H[k], o = OD[k];
    if (o && o.abiertas.length && !(o.q > 0) && !h) continue;          // solo orden abierta: ya avisado
    const hq = h ? h.q : 0, oq = o ? o.q : 0;
    const tol = Math.max(0.005, 0.01 * Math.max(hq, oq));
    if (h && o && h.u !== o.u && oq > 0) { difs.push({ k, fecha: (h || o).fecha, c: (h || o).c, nombre: (h || o).nombre, dq: hq - oq, h, o }); continue; }
    if (Math.abs(hq - oq) <= tol) continue;
    if (h && !(oq > 0) && o && o.abiertas.length) continue;              // está, pero sin validar: ya avisado
    difs.push({ k, fecha: (h || o).fecha, c: (h || o).c, nombre: (h || o).nombre, dq: hq - oq, h, o });
  }
  // 3) Misma cantidad anotada en días distintos (±3 días hábiles) → un solo aviso "fecha distinta"
  for (const a of difs) {
    if (a.usado || a.dq <= 0) continue;
    const b = difs.find((x) => !x.usado && x !== a && x.c === a.c && x.dq < 0 && Math.abs(a.dq + x.dq) <= Math.max(0.005, 0.01 * a.dq)
      && Math.abs(habiles(a.fecha < x.fecha ? a.fecha : x.fecha, a.fecha < x.fecha ? x.fecha : a.fecha)) <= 3);
    if (!b) continue;
    a.usado = b.usado = true;
    alertas.push({ fecha_ref: a.fecha, codigo: a.c, datos: { hoja: a.h || null, odoo: b.o || null }, clave: `fecha_distinta|${a.fecha}|${b.fecha}|${a.c}`, tipo: "fecha_distinta", severidad: "info",
      titulo: `Fecha distinta: ${a.nombre} ${n2(a.dq)} ${a.h?.u || ""} — en la Hoja el ${fc(a.fecha)}, en Odoo el ${fc(b.fecha)}`,
      detalle: `Es la misma cantidad cargada en días distintos. Conviene corregir la fecha de la orden en Odoo (${(b.o?.det || []).map((d) => d.mo).join(", ")}) para que el día coincida con lo que se hizo.` });
  }
  // 4) Lo que queda: pendiente de cargar / solo en Odoo / cantidad distinta
  for (const d of difs) {
    if (d.usado) continue;
    const h = d.h, o = d.o, fecha = d.fecha, c = d.c, nombre = d.nombre;
    const base = { fecha_ref: fecha, codigo: c, datos: { hoja: h || null, odoo: o || null } };
    const atraso = habiles(fecha, hoyAR);
    if (h && !(o && o.q > 0)) alertas.push({ ...base, clave: `pendiente_odoo|${fecha}|${c}`, tipo: "pendiente_odoo", severidad: atraso >= 2 ? "critico" : "warn",
      titulo: `Pendiente de cargar en Odoo: ${nombre} ${n2(h.q)} ${h.u} (${fc(fecha)})`, detalle: `Está en la Hoja de Producción y no hay orden de fabricación en Odoo. Cargado: ${h.det.map((x) => `${x.hora} ${x.cantidad} ${x.unidad} ${x.quien}`).join(" · ")}` });
    else if (!h && o) alertas.push({ ...base, clave: `solo_odoo|${fecha}|${c}`, tipo: "solo_odoo", severidad: "warn",
      titulo: `En Odoo pero no en la Hoja: ${nombre} ${n2(o.q)} ${o.u} (${fc(fecha)})`, detalle: `Orden(es) ${o.det.map((x) => `${x.mo} ${x.cantidad} ${x.unidad}`).join(" · ")}. No hay nada cargado en la Hoja de Producción ese día.` });
    else if (h && o) {
      const factor = Math.max(h.q, o.q) / Math.max(1e-9, Math.min(h.q, o.q));
      alertas.push({ ...base, clave: `distinto|${fecha}|${c}`, tipo: "distinto", severidad: factor >= 10 ? "critico" : "warn",
        titulo: `Cantidad distinta: ${nombre} (${fc(fecha)}) — Hoja ${n2(h.q)} ${h.u} · Odoo ${n2(o.q)} ${o.u}`,
        detalle: `Hoja: ${h.det.map((x) => `${x.hora} ${x.cantidad} ${x.unidad} ${x.quien}`).join(" · ")}. Odoo: ${o.det.map((x) => `${x.mo} ${x.cantidad} ${x.unidad}`).join(" · ")}.${factor >= 10 ? " La diferencia es de 10 veces o más: probablemente una unidad mal cargada (g / kg)." : ""}${h.u !== o.u ? " Las unidades no coinciden." : ""}` });
    }
  }
  if (pendHoy.length) alertas.push({ clave: `pendiente_hoy|${hoyAR}`, tipo: "pendiente_hoy", severidad: "info", fecha_ref: hoyAR, codigo: null,
    titulo: `Hoy: ${pendHoy.length} producto${pendHoy.length === 1 ? "" : "s"} de la Hoja todavía sin pasar a Odoo`, detalle: pendHoy.map((p) => `${p.nombre} ${p.q} ${p.u}`).join(" · "), datos: { items: pendHoy } });

  const ahora = new Date().toISOString();
  // lo que el usuario ya revisó y descartó no se vuelve a abrir
  const { data: desc } = await sb.from("control_alertas").select("clave").eq("area", "produccion").eq("estado", "descartada");
  const descartadas = new Set((desc || []).map((d) => d.clave));
  const filas = alertas.filter((a) => !descartadas.has(a.clave)).map((a) => ({ ...a, area: "produccion", estado: "abierta", ultima_vez: ahora, resuelta_en: null, href: "produccion/control.html" }));
  if (filas.length) { const { error } = await sb.from("control_alertas").upsert(filas, { onConflict: "clave" }); if (error) throw new Error("alertas: " + error.message); }
  // lo que estaba abierto y ya no aparece, se da por resuelto
  const { data: abiertas } = await sb.from("control_alertas").select("clave").eq("area", "produccion").eq("estado", "abierta");
  const vivas = new Set(filas.map((f) => f.clave));
  const resueltas = (abiertas || []).map((a) => a.clave).filter((k) => !vivas.has(k));
  if (resueltas.length) await sb.from("control_alertas").update({ estado: "resuelta", resuelta_en: ahora }).in("clave", resueltas);
  const cuenta: Record<string, number> = {}; for (const a of alertas) cuenta[a.tipo] = (cuenta[a.tipo] || 0) + 1;
  return { ok: true, duracion_ms: Date.now() - t0, desde, hoja: (hoja || []).length, ordenes: mos.length, alertas: cuenta, resueltas: resueltas.length, unidades_odoo: [...new Set(mos.map((m) => m2oName(m.product_uom_id)))] };
}

// ====== Conteo de inventario: sincronizar con Odoo ======
// Para cada producto del conteo trae los movimientos hechos en Odoo DESDE la foto (entregas, fabricaciones,
// consumos, recepciones) y calcula lo ESPERADO al momento en que se contó:
//   esperado = stock de la foto + movimientos anteriores a `contado_en`
// Así una entrega hecha antes de contar no aparece como faltante, y una hecha después no se descuenta
// (cuando se contó, la mercadería todavía estaba). Solo lee Odoo; escribe en Core.
export async function modoConteoSync(body: Row) {
  const id = Number(body.conteo_id);
  if (!id) throw new Error("Falta conteo_id");
  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: c, error: ec } = await sb.from("inv_conteos").select("*").eq("id", id).single();
  if (ec || !c) throw new Error("Conteo no encontrado");
  if (c.estado !== "abierto") throw new Error("El conteo ya está cerrado");
  const { data: lineas, error: el } = await sb.from("inv_conteo_lineas").select("codigo,odoo_qty,contado,contado_en,mov_override").eq("conteo_id", id).range(0, 4999);
  if (el) throw new Error(el.message);
  const foto = new Date(c.foto_odoo).getTime();
  const codigos = lineas!.map((l) => l.codigo);
  const prods = await ex("product.product", "search_read", [[["default_code", "in", codigos], ["active", "in", [true, false]]]], { fields: ["id", "default_code", "qty_available"] }) as Row[];
  const porId = new Map(prods.map((p) => [p.id, p]));
  const desde = new Date(foto - 60e3).toISOString().replace("T", " ").slice(0, 19);
  const movs = prods.length ? await ex("stock.move", "search_read", [[["product_id", "in", prods.map((p) => p.id)], ["state", "=", "done"], ["date", ">=", desde]]],
    { fields: ["product_id", "product_qty", "date", "location_id", "location_dest_id", "reference", "origin"] }) as Row[] : [];
  const locIds = [...new Set(movs.flatMap((m) => [m2o(m.location_id), m2o(m.location_dest_id)]).filter(Boolean))] as number[];
  const locs = locIds.length ? await ex("stock.location", "read", [locIds], { fields: ["id", "usage"] }) as Row[] : [];
  const interna = new Map(locs.map((l) => [l.id, l.usage === "internal"]));
  const porCod: Record<string, Row[]> = {};
  for (const m of movs) {
    const t = new Date(String(m.date).replace(" ", "T") + "Z").getTime();
    if (t <= foto) continue;                                     // ya estaba en la foto
    const entra = interna.get(m2o(m.location_dest_id)), sale = interna.get(m2o(m.location_id));
    if (entra === sale) continue;                                // movimiento interno: no cambia el total
    const cod = String(porId.get(m2o(m.product_id))?.default_code || "").trim();
    (porCod[cod] = porCod[cod] || []).push({ ref: m.reference || m.origin || "", q: (entra ? 1 : -1) * Number(m.product_qty), t, fecha: new Date(t).toISOString() });
  }
  const ahora = new Date().toISOString();
  const filas = lineas!.map((l) => {
    const ms = (porCod[l.codigo] || []).sort((a, b) => a.t - b.t);
    const corte = l.contado != null && l.contado_en ? new Date(l.contado_en).getTime() : Infinity;
    const ov = (l.mov_override || {}) as Record<string, boolean>;   // corrección a mano: "ya había salido/entrado cuando contaron"
    // Por defecto TODO movimiento ya validado cuenta como ocurrido: la mercadería sale (o entra) primero y se valida
    // en Odoo después. Se destilda a mano solo si de verdad pasó después de contar.
    const incluye = (m: Row) => (m.ref in ov ? !!ov[m.ref] : true);
    const antes = ms.filter(incluye).reduce((a, m) => a + m.q, 0);
    const p = prods.find((x) => String(x.default_code).trim() === l.codigo);
    return { conteo_id: id, codigo: l.codigo, esperado: Math.round((Number(l.odoo_qty || 0) + antes) * 10000) / 10000,
      odoo_actual: p ? Number(p.qty_available) : null,
      movimientos: ms.map((m) => ({ ref: m.ref, q: Math.round(m.q * 10000) / 10000, fecha: m.fecha, antes_de_contar: m.t <= corte })) };
  });
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await sb.from("inv_conteo_lineas").upsert(filas.slice(i, i + 200), { onConflict: "conteo_id,codigo" });
    if (error) throw new Error("guardar: " + error.message);
  }
  await sb.from("inv_conteos").update({ ultima_sync: ahora }).eq("id", id);
  return { ok: true, sincronizado: ahora, productos_con_movimientos: Object.keys(porCod).length, movimientos: movs.length };
}

// "Entrega de hoy": lo que un cliente retira/recibe un día puntual (ej. José pasa al mediodía).
// En Odoo marca sus entregas pendientes con la estrella (Urgente) y la fecha programada a esa hora;
// en Core guarda qué se lleva, y el programador lo pone como Hoy. quitar:true lo deshace.
export async function modoEntregaHoy(body: Row, usuario: Row) {
  const soId = Number(body.so_id);
  if (!soId) throw new Error("Falta so_id");
  const hoyAR = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const fecha = String(body.fecha || hoyAR).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error("Fecha inválida");
  const hora = String(body.hora || "12:00").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hora)) throw new Error("Hora inválida");
  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const [so] = await ex("sale.order", "read", [[soId]], { fields: ["name", "company_id", "state", "partner_id"] }) as Row[];
  if (!so) throw new Error("Pedido no encontrado");
  if (m2o(so.company_id) !== 2) throw new Error("El pedido no es de VELAZQUEZ");
  const picks = await ex("stock.picking", "search_read", [[["sale_id", "=", soId], ["picking_type_code", "=", "outgoing"], ["state", "not in", ["done", "cancel"]]]], { fields: ["id", "name"] }) as Row[];

  if (body.quitar) {
    if (picks.length) await ex("stock.picking", "write", [picks.map((p) => p.id), { priority: "0" }]);
    const { error } = await sb.from("prod_plan_entregas").delete().eq("so_id", soId).eq("fecha", fecha);
    if (error) throw new Error("borrar: " + error.message);
    return { ok: true, numero: so.name, quitada: true, entregas: picks.map((p) => p.name) };
  }

  const items = ((body.items as Row[]) || []).map((i) => ({ c: String(i.c), n: String(i.n || ""), q: Number(i.q) })).filter((i) => i.c && i.q > 0);
  if (!items.length) throw new Error("No hay nada para entregar");
  if (picks.length) {
    // hora Argentina (UTC-3) → UTC, que es como guarda Odoo
    const utc = new Date(`${fecha}T${hora}:00-03:00`).toISOString().replace("T", " ").slice(0, 19);
    await ex("stock.picking", "write", [picks.map((p) => p.id), { priority: "1", scheduled_date: utc }]);
  }
  const { error } = await sb.from("prod_plan_entregas").upsert({
    so_id: soId, fecha, numero: so.name, cliente: m2oName(so.partner_id), hora, items, nota: body.nota || null,
    pickings: picks.map((p) => p.name).join(", ") || null, creado: new Date().toISOString(), creado_por: usuario?.email || null,
  }, { onConflict: "so_id,fecha" });
  if (error) throw new Error("guardar: " + error.message);
  return { ok: true, numero: so.name, estado: so.state, entregas: picks.map((p) => p.name), sin_entrega_en_odoo: !picks.length };
}

// Postergar (o volver a programar) un pedido entero, un producto de un pedido, o algo para stock (so_id 0).
// Pedido entero → además mueve la fecha prevista de sus entregas pendientes en Odoo.
export async function modoPostergar(body: Row, usuario: Row) {
  const soId = Number(body.so_id || 0);
  const sku = String(body.sku || "*");
  const hasta = body.hasta ? String(body.hasta).slice(0, 10) : null;   // null = volver a programar
  if (hasta && !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new Error("Fecha inválida");
  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let numero: string | null = null;
  const odoo: Row = {};
  if (soId) {
    const [so] = await ex("sale.order", "read", [[soId]], { fields: ["name", "company_id"] }) as Row[];
    if (!so) throw new Error("Pedido no encontrado");
    if (m2o(so.company_id) !== 2) throw new Error("El pedido no es de VELAZQUEZ");
    numero = so.name;
    if (sku === "*") {
      const picks = await ex("stock.picking", "search_read", [[["sale_id", "=", soId], ["picking_type_code", "=", "outgoing"], ["state", "not in", ["done", "cancel"]]]], { fields: ["id", "name", "scheduled_date"] }) as Row[];
      // 12:00 hora Argentina = 15:00 UTC (Odoo guarda en UTC)
      const fecha = (hasta || new Date().toISOString().slice(0, 10)) + " 15:00:00";
      if (picks.length) await ex("stock.picking", "write", [picks.map((p) => p.id), { scheduled_date: fecha }]);
      odoo.entregas = picks.map((p) => ({ nombre: p.name, antes: p.scheduled_date, ahora: fecha }));
    }
  }
  if (hasta) {
    const { error } = await sb.from("prod_plan_postergados").upsert({ so_id: soId, numero, sku, hasta, motivo: body.motivo || null, creado: new Date().toISOString(), creado_por: usuario?.email || null }, { onConflict: "so_id,sku" });
    if (error) throw new Error("guardar: " + error.message);
  } else {
    const { error } = await sb.from("prod_plan_postergados").delete().eq("so_id", soId).eq("sku", sku);
    if (error) throw new Error("borrar: " + error.message);
  }
  return { ok: true, so_id: soId, numero, sku, hasta, odoo };
}

// Clasifica las etiquetas de prioridad por nombre (los ids quedan en la foto).
function clavePrioridad(nombre: string): string | null {
  const n = nombre.toLowerCase();
  if (n.includes("parcial")) return "parcial";
  if (n.includes("hoy")) return "hoy";
  if (n.includes("2-3")) return "23d";
  if (n.includes("1 día") || n.includes("1 dia")) return "1d";
  return null;
}

async function leerTags(): Promise<{ tags: Row[]; prioridad: Record<string, number> }> {
  const tags = await ex("crm.tag", "search_read", [[]], { fields: ["id", "name", "color"] }) as Row[];
  const prioridad: Record<string, number> = {};
  for (const t of tags) { const k = clavePrioridad(String(t.name)); if (k && !prioridad[k]) prioridad[k] = t.id; }
  return { tags, prioridad };
}

// default_code + datos de producto para un conjunto de ids
async function productos(ids: number[]): Promise<Map<number, Row>> {
  const out = new Map<number, Row>();
  for (let i = 0; i < ids.length; i += 300) {
    const r = await ex("product.product", "read", [ids.slice(i, i + 300)], { fields: ["id", "default_code", "name", "type", "is_storable", "uom_id"] }) as Row[];
    for (const p of r) out.set(p.id, p);
  }
  return out;
}

export async function modoPlan() {
  const t0 = Date.now();
  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: cfg } = await sb.from("prod_plan_config").select("*").eq("id", 1).maybeSingle();
  const ventana = Number(cfg?.ventana_dias ?? 120);
  const desde = new Date(Date.now() - ventana * 864e5).toISOString().slice(0, 10);

  // 1) Etiquetas (y crear 🔄 Entrega parcial si no existe — aprobado por el usuario 6-oct-2026)
  let { tags, prioridad } = await leerTags();
  let tagCreado = false;
  if (!prioridad.parcial) {
    await ex("crm.tag", "create", [{ name: TAG_PARCIAL, color: 4 }]);
    tagCreado = true;
    ({ tags, prioridad } = await leerTags());
  }

  // 2) Pedidos abiertos (confirmados + presupuestos) con lo que falta entregar
  const so = await ex("sale.order", "search_read", [[
    ["company_id", "=", 2], ["state", "in", ["draft", "sent", "sale"]], ["delivery_status", "!=", "full"],
  ]], { fields: ["id", "name", "partner_id", "state", "date_order", "commitment_date", "delivery_status", "tag_ids", "amount_total", "source_id", "client_order_ref"] }) as Row[];
  const soIds = so.map((s) => s.id);
  const lin = soIds.length ? await ex("sale.order.line", "search_read", [[["order_id", "in", soIds], ["display_type", "=", false]]],
    { fields: ["order_id", "product_id", "product_uom_qty", "qty_delivered"] }) as Row[] : [];
  const prodL = await productos([...new Set(lin.map((l) => m2o(l.product_id)).filter(Boolean))] as number[]);
  const lineasPorSo = new Map<number, Row[]>();
  for (const l of lin) {
    const p = prodL.get(m2o(l.product_id));
    if (!p || p.type === "service" || !p.default_code) continue;   // envíos, descuentos, retiro
    const pend = Number(l.product_uom_qty) - Number(l.qty_delivered);
    if (pend <= 0) continue;
    const k = m2o(l.order_id);
    if (!lineasPorSo.has(k)) lineasPorSo.set(k, []);
    lineasPorSo.get(k)!.push({ c: String(p.default_code).trim(), n: p.name, pedido: Number(l.product_uom_qty), entregado: Number(l.qty_delivered), pend });
  }
  const pedidos = so.map((s) => ({
    id: s.id, numero: s.name, cliente: m2oName(s.partner_id), partner_id: m2o(s.partner_id),
    estado: s.state, entrega: s.delivery_status || null,
    fecha: dia(s.date_order), compromiso: dia(s.commitment_date),
    tag_ids: s.tag_ids || [], monto: Number(s.amount_total || 0),
    origen_id: m2o(s.source_id), origen: m2oName(s.source_id),
    ml: m2o(s.source_id) === ML_SOURCE, tn: m2o(s.source_id) === TN_SOURCE,
    ref: s.client_order_ref || null,
    lineas: lineasPorSo.get(s.id) || [],
  })).filter((p) => p.lineas.length);

  // 3) Stock de todo lo inventariable con código (terminado 1/4, granel 9, MP 2, envases 3)
  const stockRaw = await ex("product.product", "search_read", [[["default_code", "!=", false], ["active", "=", true], ["is_storable", "=", true]]],
    { fields: ["default_code", "name", "qty_available", "free_qty", "uom_id"] }) as Row[];
  const stock = stockRaw.map((p) => ({ c: String(p.default_code).trim(), n: p.name, disp: Number(p.qty_available || 0), libre: Number(p.free_qty || 0), uom: m2oName(p.uom_id) }));

  // 4) Ventas confirmadas de la ventana, renglón por renglón (para separar goteo de pedidos grandes)
  const vl = await ex("sale.order.line", "search_read", [[
    ["order_id.company_id", "=", 2], ["order_id.state", "in", ["sale", "done"]], ["order_id.date_order", ">=", desde], ["display_type", "=", false],
  ]], { fields: ["order_id", "product_id", "product_uom_qty"] }) as Row[];
  const vSo = [...new Set(vl.map((l) => m2o(l.order_id)))] as number[];
  const soInfo = new Map<number, Row>();
  for (let i = 0; i < vSo.length; i += 500) {
    const r = await ex("sale.order", "read", [vSo.slice(i, i + 500)], { fields: ["name", "partner_id", "date_order", "source_id", "tag_ids"] }) as Row[];
    for (const o of r) soInfo.set(o.id, o);
  }
  const prodV = await productos([...new Set(vl.map((l) => m2o(l.product_id)).filter(Boolean))] as number[]);
  const ventas: Row[] = [];
  for (const l of vl) {
    const p = prodV.get(m2o(l.product_id)); const o = soInfo.get(m2o(l.order_id));
    if (!p || !o || p.type === "service" || !p.default_code) continue;
    ventas.push({ c: String(p.default_code).trim(), o: o.name, so: o.id, p: m2o(o.partner_id), cli: m2oName(o.partner_id), f: dia(o.date_order), q: Number(l.product_uom_qty), s: m2o(o.source_id), t: o.tag_ids || [] });
  }

  // 5) Producción hecha por día y producto (para calibrar la capacidad real)
  const prodRaw = await ex("mrp.production", "read_group", [[["company_id", "=", 2], ["state", "=", "done"], ["date_start", ">=", desde]], ["product_qty:sum"], ["product_id", "date_start:day"]], { lazy: false }) as Row[];
  const prodPids = [...new Set(prodRaw.map((r) => m2o(r.product_id)).filter(Boolean))] as number[];
  const prodP = await productos(prodPids);
  const produccion = prodRaw.map((r) => ({ c: String(prodP.get(m2o(r.product_id))?.default_code || "").trim(), d: r["date_start:day"], q: Number(r.product_qty || 0), n: Number(r.__count || 0) })).filter((r) => r.c);

  // 5b) Cada orden de fabricación hecha (para aprender lotes de elaboración y tandas de fraccionado)
  const moHechas = await ex("mrp.production", "search_read", [[["company_id", "=", 2], ["state", "=", "done"], ["date_start", ">=", desde]]],
    { fields: ["product_id", "product_qty", "product_uom_id", "date_start"] }) as Row[];
  const moHP = await productos([...new Set(moHechas.map((m) => m2o(m.product_id)).filter(Boolean))] as number[]);
  const mo = moHechas.map((m) => { const b = aBase(Number(m.product_qty), m2oName(m.product_uom_id)); return { c: String(moHP.get(m2o(m.product_id))?.default_code || "").trim(), q: b.q, u: b.u, f: fechaAR(m.date_start) }; }).filter((m) => m.c);

  // 5c) Historial de entregas (180 días): de a cuánto y cada cuánto se le entrega a cada cliente
  const desdeEnt = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const mv = await ex("stock.move", "search_read", [[["company_id", "=", 2], ["state", "=", "done"], ["location_dest_id.usage", "=", "customer"], ["date", ">=", desdeEnt]]],
    { fields: ["date", "product_id", "quantity", "picking_id", "origin"] }) as Row[];
  const mvP = await productos([...new Set(mv.map((m) => m2o(m.product_id)).filter(Boolean))] as number[]);
  const soNombres = [...new Set(mv.map((m) => m.origin).filter((o) => typeof o === "string" && o.startsWith("S")))] as string[];
  const soPartner = new Map<string, Row>();
  for (let i = 0; i < soNombres.length; i += 300) {
    const r = await ex("sale.order", "search_read", [[["name", "in", soNombres.slice(i, i + 300)]]], { fields: ["id", "name", "partner_id"] }) as Row[];
    for (const o of r) soPartner.set(o.name, o);
  }
  const entregas = mv.map((m) => {
    const o = soPartner.get(m.origin);
    return { c: String(mvP.get(m2o(m.product_id))?.default_code || "").trim(), q: Number(m.quantity), f: dia(m.date), pick: m2o(m.picking_id), so: o?.name || null, so_id: o?.id || null, p: o ? m2o(o.partner_id) : null, cli: o ? m2oName(o.partner_id) : null };
  }).filter((e) => e.c && e.so);

  // 6) Órdenes de fabricación abiertas
  const moAb = await ex("mrp.production", "search_read", [[["company_id", "=", 2], ["state", "in", ["draft", "confirmed", "progress", "to_close"]]]],
    { fields: ["name", "product_id", "product_qty", "state", "date_start", "origin"] }) as Row[];
  const moP = await productos([...new Set(moAb.map((m) => m2o(m.product_id)).filter(Boolean))] as number[]);
  const mo_abiertas = moAb.map((m) => ({ nombre: m.name, c: String(moP.get(m2o(m.product_id))?.default_code || "").trim(), q: Number(m.product_qty), estado: m.state, inicio: dia(m.date_start), origen: m.origin || null }));

  // 7) Kits (combos y packs = mrp.bom tipo phantom): para explotarlos en sus productos reales
  const boms = await ex("mrp.bom", "search_read", [[["type", "=", "phantom"], ["active", "=", true], "|", ["company_id", "=", 2], ["company_id", "=", false]]],
    { fields: ["id", "product_tmpl_id", "product_id", "product_qty", "bom_line_ids"] }) as Row[];
  const bl = boms.length ? await ex("mrp.bom.line", "read", [boms.flatMap((b) => b.bom_line_ids)], { fields: ["bom_id", "product_id", "product_qty"] }) as Row[] : [];
  const tmplIds = [...new Set(boms.filter((b) => !b.product_id).map((b) => m2o(b.product_tmpl_id)))] as number[];
  const variantes = tmplIds.length ? await ex("product.product", "search_read", [[["product_tmpl_id", "in", tmplIds]]], { fields: ["id", "default_code", "product_tmpl_id"] }) as Row[] : [];
  const blP = await productos([...new Set(bl.map((l) => m2o(l.product_id)).filter(Boolean))] as number[]);
  const kitP = await productos([...new Set(boms.map((b) => m2o(b.product_id)).filter(Boolean))] as number[]);
  const kits: Record<string, { c: string; q: number }[]> = {};
  for (const b of boms) {
    const comps = bl.filter((l) => m2o(l.bom_id) === b.id).map((l) => ({ c: String(blP.get(m2o(l.product_id))?.default_code || "").trim(), q: Number(l.product_qty) / Number(b.product_qty || 1) })).filter((x) => x.c);
    if (!comps.length) continue;   // receta vacía (ej. bom 324 duplicada)
    const codigos = b.product_id ? [kitP.get(m2o(b.product_id))?.default_code]
      : variantes.filter((v) => m2o(v.product_tmpl_id) === m2o(b.product_tmpl_id)).map((v) => v.default_code);
    for (const c of codigos) if (c && !kits[String(c).trim()]) kits[String(c).trim()] = comps;
  }

  const datos = {
    generado: new Date().toISOString(), ventana_dias: ventana, desde,
    tags, prioridad, ml_source: ML_SOURCE, tn_source: TN_SOURCE,
    pedidos, stock, ventas, produccion, mo, entregas, mo_abiertas, kits,
  };
  const { error } = await sb.from("prod_plan_snapshot").insert({ datos });
  if (error) throw new Error("guardar foto: " + error.message);
  // dejar solo las últimas 15 fotos
  const { data: viejas } = await sb.from("prod_plan_snapshot").select("id").order("id", { ascending: false }).range(15, 200);
  if (viejas?.length) await sb.from("prod_plan_snapshot").delete().in("id", viejas.map((v) => v.id));

  return {
    ok: true, duracion_ms: Date.now() - t0, tag_parcial_id: prioridad.parcial, tag_creado: tagCreado,
    resumen: { pedidos: pedidos.length, confirmados: pedidos.filter((p) => p.estado === "sale").length, lineas: pedidos.reduce((a, p) => a + p.lineas.length, 0), stock: stock.length, ventas: ventas.length, produccion: produccion.length, mo: mo.length, entregas: entregas.length, mo_abiertas: mo_abiertas.length, kits: Object.keys(kits).length },
  };
}

// Pone UNA etiqueta de prioridad en un pedido y saca las otras de prioridad
// (FLEX, Listo y cualquier otra etiqueta quedan como estaban).
export async function modoEtiquetar(body: Row) {
  const soId = Number(body.so_id);
  const clave = String(body.prioridad || "");
  if (!soId) throw new Error("Falta so_id");
  const { prioridad } = await leerTags();
  if (clave !== "ninguna" && !prioridad[clave]) throw new Error("Prioridad desconocida: " + clave);
  const [so] = await ex("sale.order", "read", [[soId]], { fields: ["name", "company_id", "tag_ids", "state"] }) as Row[];
  if (!so) throw new Error("Pedido no encontrado");
  if (m2o(so.company_id) !== 2) throw new Error("El pedido no es de VELAZQUEZ");
  const cmds: unknown[] = [];
  for (const [k, id] of Object.entries(prioridad)) if (k !== clave && (so.tag_ids || []).includes(id)) cmds.push([3, id]);
  if (clave !== "ninguna") cmds.push([4, prioridad[clave]]);
  await ex("sale.order", "write", [[soId], { tag_ids: cmds }]);
  const [desp] = await ex("sale.order", "read", [[soId]], { fields: ["tag_ids"] }) as Row[];
  return { ok: true, numero: so.name, antes: so.tag_ids, despues: desp.tag_ids };
}
