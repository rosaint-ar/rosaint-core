import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-tienda-comparar — SOLO LECTURA. Por codigo devuelve:
//  core_tienda = precio Tienda Online calculado en Core (L1 c/IVA x factor, ^redondeo)
//  odoo_l5     = fixed_price de la Lista 5 Tienda Online (pricelist 56) en Odoo
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const LISTA_TIENDA = 56;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
async function sbGet(path: string): Promise<Rec[]> { const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }); if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text())); return await res.json(); }

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [COMPANY_ID] };

    // Core: precio Tienda Online (canal 1) por codigo
    const rc = await sbGet("v_rentabilidad_canal?select=codigo,l1_iva_incl,lista&canal_id=eq.1");
    const core: Record<string, { l1: number; tienda: number }> = {};
    for (const r of rc) { const c = String(r.codigo); if (!core[c]) core[c] = { l1: Number(r.l1_iva_incl), tienda: Number(r.lista) }; }

    // Odoo: mapa tmpl->default_code y fixed_price de Lista 5
    const its = await execKw(uid, "product.pricelist.item", "search_read", [[["pricelist_id", "=", LISTA_TIENDA]]], { fields: ["product_tmpl_id", "fixed_price", "min_quantity"], context: ctx, limit: 3000 }) as Rec[];
    const tmplIds = [...new Set(its.filter(i => Array.isArray(i.product_tmpl_id)).map(i => (i.product_tmpl_id as unknown[])[0] as number))];
    const tmpls = tmplIds.length ? await execKw(uid, "product.template", "read", [tmplIds], { fields: ["default_code"], context: ctx }) as Rec[] : [];
    const codeOf: Record<number, string> = {}; for (const t of tmpls) codeOf[t.id as number] = String(t.default_code);
    const odooL5: Record<string, number> = {};
    for (const it of its) { const tid = Array.isArray(it.product_tmpl_id) ? (it.product_tmpl_id as unknown[])[0] as number : null; if (tid == null) continue; const c = codeOf[tid]; if (!c) continue; const minq = Number(it.min_quantity) || 0; if (!(c in odooL5) || minq === 0) odooL5[c] = Number(it.fixed_price); }

    const codigos = [...new Set([...Object.keys(core), ...Object.keys(odooL5)])].sort();
    const filas = codigos.map(c => ({ codigo: c, l1: core[c]?.l1 ?? null, core_tienda: core[c]?.tienda ?? null, odoo_l5: (c in odooL5) ? odooL5[c] : null }));
    return new Response(JSON.stringify({ ok: true, filas }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
