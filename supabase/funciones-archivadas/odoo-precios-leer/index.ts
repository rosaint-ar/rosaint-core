import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-precios-leer (v2) — SOLO LECTURA / SIMULACIÓN.
// Cruza precios de Core (Supabase, rol servicio) contra product.template de Odoo
// (company 2), emparejando por default_code = codigo SKU. No escribe nada.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function odooAuth(): Promise<number> {
  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  return uid;
}
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}
async function sbGet(path: string): Promise<Rec[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text()));
  return await res.json();
}
const num = (v: unknown) => v == null ? null : Number(v);

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // ---- Odoo: productos vendibles (codigo 1xxxx) ----
    const uid = await odooAuth();
    const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };
    const prods = await execKw(uid, "product.template", "search_read",
      [[["default_code", "!=", false]]],
      { fields: ["default_code", "name", "list_price"], context: ctx, limit: 5000 }) as Rec[];
    const odoo: Record<string, { list_price: number; nombre: string }> = {};
    for (const p of prods) {
      const c = String(p.default_code);
      if (/^1\d{4}$/.test(c)) odoo[c] = { list_price: Number(p.list_price) || 0, nombre: String(p.name || "") };
    }

    // ---- Core: listas vigentes + precios ----
    const listas = await sbGet("listas_precios?select=id,tipo_lista,es_base_descuentos,estado&estado=eq.vigente");
    const l1 = listas.find(l => l.tipo_lista === "publico")?.id as number | undefined;
    const l2 = listas.find(l => l.es_base_descuentos === true)?.id as number | undefined;
    const items = await sbGet("items?select=codigo,nombre,estado&tipo=eq.SKU");
    const p1 = l1 ? await sbGet(`items_lista_precio?select=codigo_vendible,precio_iva_incl,precio_iva_excl&lista_id=eq.${l1}`) : [];
    const p2 = l2 ? await sbGet(`items_lista_precio?select=codigo_vendible,precio_iva_incl&lista_id=eq.${l2}`) : [];
    const mapItem: Record<string, Rec> = {}; for (const it of items) mapItem[String(it.codigo)] = it;
    const mapP1: Record<string, Rec> = {}; for (const r of p1) mapP1[String(r.codigo_vendible)] = r;
    const mapP2: Record<string, Rec> = {}; for (const r of p2) mapP2[String(r.codigo_vendible)] = r;

    // ---- Cruce ----
    const codigos = new Set<string>([...Object.keys(mapItem), ...Object.keys(odoo)]);
    const filas = [...codigos].map(c => {
      const it = mapItem[c];
      const core_l1_civa = num(mapP1[c]?.precio_iva_incl);
      const core_l1_neto = num(mapP1[c]?.precio_iva_excl);
      const core_l2_civa = num(mapP2[c]?.precio_iva_incl);
      const od = odoo[c];
      const odoo_precio = od ? od.list_price : null;
      let cmp: string;
      if (!it) cmp = "solo_odoo";
      else if (!od) cmp = "solo_core";
      else if (core_l1_civa == null) cmp = "core_sin_precio";
      else cmp = Math.round(core_l1_civa) === Math.round(odoo_precio || 0) ? "igual" : "distinto";
      return {
        codigo: c,
        nombre: (it?.nombre as string) || od?.nombre || "",
        estado: (it?.estado as string) || null,
        core_l1_civa, core_l1_neto, core_l2_civa,
        odoo_precio,
        diff: (core_l1_civa != null && odoo_precio != null) ? Math.round((core_l1_civa - odoo_precio) * 100) / 100 : null,
        cmp,
      };
    }).sort((a, b) => a.codigo.localeCompare(b.codigo));

    const resumen = {
      total: filas.length,
      distinto: filas.filter(f => f.cmp === "distinto").length,
      igual: filas.filter(f => f.cmp === "igual").length,
      solo_core: filas.filter(f => f.cmp === "solo_core").length,
      solo_odoo: filas.filter(f => f.cmp === "solo_odoo").length,
      core_sin_precio: filas.filter(f => f.cmp === "core_sin_precio").length,
    };
    return new Response(JSON.stringify({ ok: true, company_id: COMPANY_ID, lista_l1: l1 ?? null, lista_l2: l2 ?? null, resumen, filas }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
