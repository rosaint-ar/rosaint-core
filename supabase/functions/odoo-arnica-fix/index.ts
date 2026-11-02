import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-arnica-fix (v2, 2-nov-2026) — ajuste puntual de inventario en Odoo, company 2.
// Nació para el árnica (20106); ahora sirve para cualquier código, con control de acceso.
// Acciones:
//   inspect  {codigo}                         → producto + renglones de stock (lotes) en ubicaciones internas
//   ajustar  {codigo, objetivo, esperado}     → deja el stock total en `objetivo`. NO escribe si el stock actual
//            no es `esperado` (± 0,0005): así nunca se pisa algo que cambió desde que se miró.
//            Si baja: descuenta de los lotes más viejos primero; si sube: suma al lote más nuevo.
//            Un renglón negativo se lleva primero a 0.
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
    throw new Error("accion desconocida: " + accion);
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), { headers: cors }); }
});
