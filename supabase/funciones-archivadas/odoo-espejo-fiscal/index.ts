import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Refresca el espejo public.odoo_crm_contacto con el documento, la condicion fiscal,
// el customer_rank (mayor a 0 = compro) y el company_name (nombre de fantasia) de Odoo.
// NO devuelve datos de personas: solo contadores.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rpc(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}

Deno.serve(async () => {
  const h = { "Content-Type": "application/json" };
  try {
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number;
    const rows = await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, "res.partner", "search_read",
      [[["email", "!=", false]]],
      { fields: ["id", "name", "email", "vat", "l10n_ar_afip_responsibility_type_id", "customer_rank", "company_name"], limit: 20000 }]) as Array<Record<string, unknown>>;

    const filas = rows.map((r) => {
      const a = r.l10n_ar_afip_responsibility_type_id;
      return {
        partner_id: r.id as number,
        nombre: (r.name as string) || null,
        email: r.email ? String(r.email).toLowerCase().trim() : null,
        vat: r.vat ? String(r.vat).trim() : null,
        afip: Array.isArray(a) ? String(a[1]) : null,
        customer_rank: Number(r.customer_rank ?? 0),
        company_name: r.company_name ? String(r.company_name).trim() : null,
        updated_at: new Date().toISOString(),
      };
    });

    for (let i = 0; i < filas.length; i += 200) {
      const res = await fetch(`${SB_URL}/rest/v1/odoo_crm_contacto?on_conflict=partner_id`, {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(filas.slice(i, i + 200)),
      });
      if (!res.ok) throw new Error(`guardar: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    return new Response(JSON.stringify({
      ok: true,
      leidos: filas.length,
      con_documento: filas.filter((f) => f.vat).length,
      con_condicion_fiscal: filas.filter((f) => f.afip).length,
      compraron: filas.filter((f) => (f.customer_rank || 0) > 0).length,
      con_nombre_fantasia: filas.filter((f) => f.company_name).length,
    }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h });
  }
});
