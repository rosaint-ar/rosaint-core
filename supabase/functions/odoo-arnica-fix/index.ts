import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-arnica-fix (v2, 2-nov-2026) — ajuste puntual de inventario en Odoo, company 2.
// Nació para el árnica (20106); ahora sirve para cualquier código, con control de acceso.
// Acciones:
//   inspect  {codigo}                         → producto + renglones de stock (lotes) en ubicaciones internas
//   ajustar  {codigo, objetivo, esperado}     → deja el stock total en `objetivo`. NO escribe si el stock actual
//            no es `esperado` (± 0,0005): así nunca se pisa algo que cambió desde que se miró.
//            Si baja: descuenta de los lotes más viejos primero; si sube: suma al lote más nuevo.
//            Un renglón negativo se lleva primero a 0.
//   receta     {codigo}                                    → listas de materiales y renglones
//   receta_set {codigo, componente, cantidad, esperado}    → cambia la cantidad de un componente (freno si no es `esperado`)
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const CTX = { allowed_company_ids: [COMPANY_ID], company_id: COMPANY_ID, lang: "es_ES" };
type Row = Record<string, unknown>;
const m2oName = (v: unknown): string => (Array.isArray(v) ? String(v[1] ?? "") : "");
const r4 = (x: number) => Math.round(x * 10000) / 10000;

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> { if (_uid) return _uid; const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid) throw new Error("Auth Odoo fallida"); _uid = uid as number; return _uid; }
async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await auth(); const ctx = { ...CTX, ...((kwargs.context as Record<string, unknown>) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: ctx }]);
}
async function producto(cod: string): Promise<Row> {
  const r = await call("product.product", "search_read", [[["default_code", "=", cod]]], { fields: ["id", "name", "qty_available", "virtual_available", "uom_id"] }) as Row[];
  if (!r.length) throw new Error("No existe " + cod); return r[0];
}
async function renglones(pid: number): Promise<Row[]> {
  return await call("stock.quant", "search_read", [[["product_id", "=", pid], ["location_id.usage", "=", "internal"], ["company_id", "=", COMPANY_ID]]],
    { fields: ["id", "location_id", "lot_id", "quantity", "reserved_quantity", "in_date"], order: "in_date asc, id asc" }) as Row[];
}
const ver = (q: Row[]) => q.map((x) => ({ id: x.id, ubicacion: m2oName(x.location_id), lote: m2oName(x.lot_id) || null, cantidad: x.quantity, reservado: x.reserved_quantity, entrada: x.in_date }));

// ===== Control de acceso: sesión de Core o clave interna (x-cron-key) =====
async function accesoPermitido(req: Request): Promise<string | null> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return "proceso interno";
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || "", Authorization: a } });
    if (!r.ok) return null; const u = await r.json(); return u?.email || null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const quien = await accesoPermitido(req);
  if (!quien) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: cors });
  try {
    let body: Record<string, unknown> = {}; try { body = await req.json(); } catch { /* */ }
    const accion = String(body.accion || "inspect");
    const cod = String(body.codigo || "").trim();
    if (!cod) throw new Error("Falta codigo");
    const p = await producto(cod); const pid = p.id as number;

    if (accion === "inspect") {
      const q = await renglones(pid);
      return new Response(JSON.stringify({ ok: true, accion, producto: p, suma: r4(q.reduce((a, x) => a + Number(x.quantity || 0), 0)), renglones: ver(q) }), { headers: cors });
    }

    if (accion === "ajustar") {
      const objetivo = Number(body.objetivo), esperado = Number(body.esperado);
      if (!Number.isFinite(objetivo) || objetivo < 0) throw new Error("objetivo inválido");
      if (!Number.isFinite(esperado)) throw new Error("Falta esperado (el stock que se vio antes de ajustar)");
      const q = await renglones(pid);
      const suma = r4(q.reduce((a, x) => a + Number(x.quantity || 0), 0));
      if (Math.abs(suma - esperado) > 0.0005) throw new Error(`El stock cambió: se esperaba ${esperado} y hay ${suma}. No se ajustó nada.`);
      if (!q.length) throw new Error("No hay renglón de stock interno para ajustar");
      const nuevo: Record<number, number> = {}; for (const x of q) nuevo[x.id as number] = Number(x.quantity || 0);
      let delta = r4(objetivo - suma);
      // 1) renglones negativos a 0 (absorben parte de la diferencia)
      for (const x of q) { const v = nuevo[x.id as number]; if (v < 0) { delta = r4(delta + v); nuevo[x.id as number] = 0; } }
      if (delta < 0) {
        // 2) falta: se descuenta de los lotes más viejos primero
        for (const x of q) { if (delta >= 0) break; const id = x.id as number; const saca = Math.min(nuevo[id], -delta); nuevo[id] = r4(nuevo[id] - saca); delta = r4(delta + saca); }
        if (delta < -0.0005) throw new Error("No alcanza el stock para bajar hasta el objetivo");
      } else if (delta > 0) {
        // 3) sobra: se suma al lote más nuevo
        const ult = q[q.length - 1].id as number; nuevo[ult] = r4(nuevo[ult] + delta); delta = 0;
      }
      const cambia = q.filter((x) => Math.abs(nuevo[x.id as number] - Number(x.quantity || 0)) > 1e-6);
      for (const x of cambia) await call("stock.quant", "write", [[x.id], { inventory_quantity: nuevo[x.id as number] }]);
      if (cambia.length) await call("stock.quant", "action_apply_inventory", [cambia.map((x) => x.id)]);
      const despues = await renglones(pid); const p2 = await producto(cod);
      return new Response(JSON.stringify({ ok: true, accion, codigo: cod, por: quien, antes: suma, objetivo, despues: p2.qty_available, virtual_despues: p2.virtual_available,
        cambios: cambia.map((x) => ({ id: x.id, lote: m2oName(x.lot_id) || null, de: x.quantity, a: nuevo[x.id as number] })), renglones: ver(despues) }), { headers: cors });
    }
    if (accion === "pendientes") {
      // movimientos sin terminar del producto (qué tiene apartado / por entrar)
      const mv = await call("stock.move", "search_read", [[["product_id", "=", pid], ["state", "not in", ["done", "cancel", "draft"]], ["company_id", "=", COMPANY_ID]]],
        { fields: ["id", "reference", "origin", "date", "state", "product_uom_qty", "quantity", "raw_material_production_id", "production_id", "location_id", "location_dest_id"] }) as Row[];
      return new Response(JSON.stringify({ ok: true, accion, codigo: cod, movimientos: mv.map((m) => ({ id: m.id, ref: m.reference, origen: m.origin, fecha: m.date, estado: m.state, qty: m.product_uom_qty, hecho: m.quantity,
        consume_mo: m.raw_material_production_id ? m2oName(m.raw_material_production_id) : null, produce_mo: m.production_id ? m2oName(m.production_id) : null, de: m2oName(m.location_id), a: m2oName(m.location_dest_id) })) }), { headers: cors });
    }

    if (accion === "mo_ver" || accion === "mo_confirmar") {
      // mo_ver {codigo, mo} → estado y componentes; mo_confirmar {codigo, mo, consumos:{codigoComp: qty}} → fija consumos y la marca hecha
      const nombre = String(body.mo || "").trim(); if (!nombre) throw new Error("Falta mo");
      const mos = await call("mrp.production", "search_read", [[["name", "=", nombre], ["company_id", "=", COMPANY_ID]]],
        { fields: ["id", "name", "state", "product_id", "product_qty", "qty_producing", "lot_producing_id", "move_raw_ids", "move_finished_ids"] }) as Row[];
      if (mos.length !== 1) throw new Error("No encuentro la orden " + nombre);
      const mo = mos[0];
      if (m2oName(mo.product_id).indexOf(`[${cod}]`) < 0) throw new Error(`La orden ${nombre} no es de ${cod}`);
      const leerRaw = async () => await call("stock.move", "read", [mo.move_raw_ids as number[]], { fields: ["id", "product_id", "product_uom_qty", "quantity", "picked", "state"] }) as Row[];
      const raw = await leerRaw();
      const verRaw = (rs: Row[]) => rs.map((m) => ({ id: m.id, componente: m2oName(m.product_id), a_consumir: m.product_uom_qty, consumido: m.quantity, estado: m.state }));
      if (accion === "mo_ver") return new Response(JSON.stringify({ ok: true, accion, mo: { id: mo.id, estado: mo.state, producto: m2oName(mo.product_id), qty: mo.product_qty, producing: mo.qty_producing, lote: m2oName(mo.lot_producing_id) }, componentes: verRaw(raw) }), { headers: cors });
      if (["done", "cancel"].includes(String(mo.state))) throw new Error(`La orden ya está ${mo.state}`);
      const consumos = (body.consumos || {}) as Record<string, number>;
      if (!mo.lot_producing_id && body.lote) {
        const pp = (mo.product_id as unknown[])[0] as number; const ln = String(body.lote);
        const ex = await call("stock.lot", "search", [[["name", "=", ln], ["product_id", "=", pp], ["company_id", "=", COMPANY_ID]]]) as number[];
        const lid = ex.length ? ex[0] : await call("stock.lot", "create", [{ name: ln, product_id: pp, company_id: COMPANY_ID }]) as number;
        await call("mrp.production", "write", [[mo.id], { lot_producing_id: lid }]);
      }
      if (!Number(mo.qty_producing)) await call("mrp.production", "write", [[mo.id], { qty_producing: mo.product_qty }]);
      await call("mrp.production", "action_assign", [[mo.id]]);  // reserva de lotes antes de fijar cantidades
      for (const m of raw) {
        const comp = m2oName(m.product_id); const k = Object.keys(consumos).find((c) => comp.includes(`[${c}]`));
        const q = k ? Number(consumos[k]) : Number(m.product_uom_qty);
        await call("stock.move", "write", [[m.id], { product_uom_qty: q, quantity: q, picked: true }]);
      }
      const res = await call("mrp.production", "button_mark_done", [[mo.id]]);
      const fin = await call("mrp.production", "read", [[mo.id]], { fields: ["state"] }) as Row[];
      return new Response(JSON.stringify({ ok: fin[0].state === "done", accion, mo: nombre, estado: fin[0].state, por: quien, wizard: (res && typeof res === "object") ? (res as Row).res_model || res : null, componentes: verRaw(await leerRaw()) }), { headers: cors });
    }

    if (accion === "receta" || accion === "receta_set") {
      // receta {codigo} → listas de materiales del producto; receta_set {codigo, componente, cantidad, esperado}
      const boms = await call("mrp.bom", "search_read", [[["product_tmpl_id.product_variant_ids", "in", [pid]], ["company_id", "in", [COMPANY_ID, false]], ["active", "=", true]]],
        { fields: ["id", "code", "product_qty", "product_uom_id", "bom_line_ids", "type"] }) as Row[];
      const lineas: Row[] = [];
      for (const b of boms) {
        const ls = await call("mrp.bom.line", "read", [b.bom_line_ids as number[]], { fields: ["id", "product_id", "product_qty", "product_uom_id"] }) as Row[];
        for (const l of ls) lineas.push({ bom: b.id, bom_qty: b.product_qty, linea: l.id, componente: m2oName(l.product_id), cantidad: l.product_qty, uom: m2oName(l.product_uom_id) });
      }
      if (accion === "receta") return new Response(JSON.stringify({ ok: true, accion, producto: p, boms: boms.map((b) => ({ id: b.id, code: b.code, qty: b.product_qty, tipo: b.type })), lineas }), { headers: cors });
      const comp = String(body.componente || "").trim(); const cant = Number(body.cantidad), esp = Number(body.esperado);
      if (!comp || !Number.isFinite(cant) || cant <= 0 || !Number.isFinite(esp)) throw new Error("Faltan componente, cantidad o esperado");
      const hits = lineas.filter((l) => String(l.componente).includes(`[${comp}]`));
      if (hits.length !== 1) throw new Error(`Se esperaba 1 renglón con [${comp}] y hay ${hits.length}. No se cambió nada.`);
      const h = hits[0];
      if (Math.abs(Number(h.cantidad) - esp) > 0.0005) throw new Error(`La receta cambió: se esperaba ${esp} y tiene ${h.cantidad}. No se cambió nada.`);
      await call("mrp.bom.line", "write", [[h.linea], { product_qty: cant }]);
      const r = await call("mrp.bom.line", "read", [[h.linea]], { fields: ["product_qty"] }) as Row[];
      return new Response(JSON.stringify({ ok: true, accion, codigo: cod, por: quien, componente: h.componente, de: h.cantidad, a: r[0].product_qty, bom: h.bom }), { headers: cors });
    }
    throw new Error("accion desconocida: " + accion);
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), { headers: cors }); }
});
