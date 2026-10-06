import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// test companias
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error(j.error?.data?.message || JSON.stringify(j.error)); return j.result;
}
Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
    const out: Record<string, unknown> = { uid };
    for (const [k, comps] of [["c2", [2]], ["c12", [1, 2]]] as [string, number[]][]) {
      try {
        const n = await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, "res.partner", "search_count", [[["customer_rank", ">", 0]]], { context: { allowed_company_ids: comps } }]);
        out[k] = { ok: true, clientes: n };
      } catch (e) { out[k] = { ok: false, error: String((e as Error).message || e) }; }
    }
    return new Response(JSON.stringify(out), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors }); }
});
