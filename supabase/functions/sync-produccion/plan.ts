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
    { fields: ["product_id", "product_qty", "date_start"] }) as Row[];
  const moHP = await productos([...new Set(moHechas.map((m) => m2o(m.product_id)).filter(Boolean))] as number[]);
  const mo = moHechas.map((m) => ({ c: String(moHP.get(m2o(m.product_id))?.default_code || "").trim(), q: Number(m.product_qty), f: dia(m.date_start) })).filter((m) => m.c);

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
