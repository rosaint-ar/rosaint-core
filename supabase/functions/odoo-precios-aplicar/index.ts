import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-precios-aplicar v2 — Sincroniza Core -> Odoo (company 2).
// Match por codigo=default_code, solo productos en AMBOS canales.
//  body.objetivo = "publico"     => Core L1 c/IVA -> Precio de Venta (list_price) + Lista 1 Público (53)
//                = "profesional" => Core L2 c/IVA -> Lista 2 Profesionales (32)   (NO toca list_price)
//  body.dry_run  = true (default, no escribe) | false (escribe)
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type Rec = Record<string, unknown>;

const CONF: Record<string, { pricelist: number; setListPrice: boolean; coreLista: "publico" | "profesional" }> = {
  publico:     { pricelist: 53, setListPrice: true,  coreLista: "publico" },
  profesional: { pricelist: 32, setListPrice: false, coreLista: "profesional" },
};

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
async function sbGet(path: string): Promise<Rec[]> { const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }); if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text())); return await res.json(); }
const eq = (a: number, b: number) => Math.round(a) === Math.round(b);


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (srk && a.slice(7) === srk) return true;
  const apikey = req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey, Authorization: a } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}
function _servirConGuardia(...args: any[]) {
  const h = args[args.length - 1];
  args[args.length - 1] = async (req: Request, info: any) => {
    if (req.method === "OPTIONS" || await _accesoPermitido(req)) return h(req, info);
    return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), {
      status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  };
  return (Deno.serve as any)(...args);
}

_servirConGuardia(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const objetivo = (body.objetivo as string) || "publico";
    const conf = CONF[objetivo];
    if (!conf) throw new Error("objetivo invalido (publico|profesional)");
    const dryRun = body.dry_run !== false;
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };

    // Core: precio de la lista objetivo, c/IVA, por codigo
    const listas = await sbGet("listas_precios?select=id,tipo_lista,es_base_descuentos,estado&estado=eq.vigente");
    const listaId = conf.coreLista === "publico"
      ? listas.find(l => l.tipo_lista === "publico")?.id as number | undefined
      : listas.find(l => l.es_base_descuentos === true)?.id as number | undefined;
    if (!listaId) throw new Error("No se encontro la lista Core (" + conf.coreLista + ") vigente");
    const cp = await sbGet(`items_lista_precio?select=codigo_vendible,precio_iva_incl&lista_id=eq.${listaId}`);
    const corePrice: Record<string, number> = {};
    for (const r of cp) if (r.precio_iva_incl != null) corePrice[String(r.codigo_vendible)] = Number(r.precio_iva_incl);

    // Odoo: templates vendibles (1xxxx)
    const prods = await execKw(uid, "product.template", "search_read", [[["default_code", "!=", false]]], { fields: ["id", "default_code", "name", "list_price"], context: ctx, limit: 5000 }) as Rec[];
    const odoo: Record<string, { id: number; nombre: string; list_price: number }> = {};
    for (const p of prods) { const c = String(p.default_code); if (/^1\d{4}$/.test(c)) odoo[c] = { id: p.id as number, nombre: String(p.name || ""), list_price: Number(p.list_price) || 0 }; }

    // Odoo: reglas existentes en la tarifa objetivo (elige menor min_quantity por producto)
    const its = await execKw(uid, "product.pricelist.item", "search_read", [[["pricelist_id", "=", conf.pricelist]]], { fields: ["id", "product_tmpl_id", "fixed_price", "min_quantity"], context: ctx, limit: 3000 }) as Rec[];
    const item: Record<number, { id: number; fixed: number; minq: number }> = {};
    for (const it of its) {
      const tid = Array.isArray(it.product_tmpl_id) ? (it.product_tmpl_id as unknown[])[0] as number : null;
      if (tid == null) continue;
      const minq = Number(it.min_quantity) || 0;
      if (!item[tid] || minq < item[tid].minq) item[tid] = { id: it.id as number, fixed: Number(it.fixed_price) || 0, minq };
    }

    const rows: Rec[] = [];
    let n_lp = 0, n_upd = 0, n_new = 0, n_ok = 0, n_sin_core = 0;
    for (const codigo of Object.keys(odoo)) {
      const target = corePrice[codigo];
      const od = odoo[codigo];
      if (target == null) { n_sin_core++; continue; } // producto en Odoo sin precio en esta lista de Core
      const it = item[od.id];
      const lpCambia = conf.setListPrice && !eq(od.list_price, target);
      const itemCambia = !it || !eq(it.fixed, target);
      let accion_item = "sin_cambio";
      if (!it) accion_item = "crear"; else if (itemCambia) accion_item = "actualizar";
      if (!lpCambia && !itemCambia) { n_ok++; continue; }

      if (!dryRun) {
        if (lpCambia) await execKw(uid, "product.template", "write", [[od.id], { list_price: target }], { context: ctx });
        if (!it) await execKw(uid, "product.pricelist.item", "create", [{ pricelist_id: conf.pricelist, applied_on: "1_product", product_tmpl_id: od.id, compute_price: "fixed", fixed_price: target, min_quantity: 0 }], { context: ctx });
        else if (itemCambia) await execKw(uid, "product.pricelist.item", "write", [[it.id], { fixed_price: target }], { context: ctx });
      }
      if (lpCambia) n_lp++;
      if (accion_item === "actualizar") n_upd++;
      if (accion_item === "crear") n_new++;
      rows.push({ codigo, nombre: od.nombre, precio_nuevo: target, tarifa_antes: it ? it.fixed : null, list_price_antes: conf.setListPrice ? od.list_price : null, accion_item });
    }
    rows.sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));

    return new Response(JSON.stringify({
      ok: true, objetivo, tarifa_odoo: conf.pricelist, dry_run: dryRun,
      resumen: { productos_a_cambiar: rows.length, precio_venta_updates: n_lp, tarifa_updates: n_upd, tarifa_nuevos: n_new, ya_ok: n_ok, odoo_sin_precio_core: n_sin_core },
      cambios: rows,
    }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
