import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Refresca el espejo de Odoo y completa en HubSpot lo que falte:
// documento (dni_o_cuil), condicion fiscal (afip_responsability_type)
// y nombre de fantasia (company -> "Company Name").
// El nombre de fantasia sale del campo propio x_studio_nombre_fantasia;
// si esta vacio cae al company_name viejo de Odoo.
// Solo llena lo vacio: nunca pisa un dato ya cargado. NO devuelve datos de personas.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HS = Deno.env.get("HUBSPOT_TOKEN") || "";
const FANTASIA = "x_studio_nombre_fantasia";

const CONDICIONES = new Set([
  "Consumidor Final", "Responsable Monotributo", "IVA Responsable Inscripto", "IVA Sujeto Exento",
  "Monotributista Social", "Cliente del Exterior", "IVA Liberado – Ley 19.640",
  "IVA No Alcanzado", "Monotributo Trabajador Independiente Promovido",
]);
function condicionHS(a: string) {
  return a.split("Nº ").join("").split(" / ").join(" ").trim();
}
function docValido(v: string) {
  const d = v.replace(/\D/g, "");
  return d.length >= 7 && d.length <= 11;
}

async function rpc(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}

async function refrescarEspejo() {
  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number;
  const rows = await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, "res.partner", "search_read",
    [[["email", "!=", false]]],
    { fields: ["id", "name", "email", "vat", "l10n_ar_afip_responsibility_type_id", "customer_rank", "company_name", FANTASIA], limit: 20000 }]) as Array<Record<string, unknown>>;
  const filas = rows.map((r) => {
    const a = r.l10n_ar_afip_responsibility_type_id;
    const propio = r[FANTASIA] ? String(r[FANTASIA]).trim() : "";
    const viejo = r.company_name ? String(r.company_name).trim() : "";
    return {
      partner_id: r.id as number,
      nombre: (r.name as string) || null,
      email: r.email ? String(r.email).toLowerCase().trim() : null,
      vat: r.vat ? String(r.vat).trim() : null,
      afip: Array.isArray(a) ? String(a[1]) : null,
      customer_rank: Number(r.customer_rank ?? 0),
      company_name: (propio || viejo) || null,
      updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < filas.length; i += 200) {
    const res = await fetch(`${SB_URL}/rest/v1/odoo_crm_contacto?on_conflict=partner_id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(filas.slice(i, i + 200)),
    });
    if (!res.ok) throw new Error(`espejo: ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
  const porMail: Record<string, { vat: Set<string>; afip: Set<string>; fantasia: Set<string> }> = {};
  for (const f of filas) {
    if (!f.email) continue;
    const e = (porMail[f.email] = porMail[f.email] || { vat: new Set(), afip: new Set(), fantasia: new Set() });
    if (f.vat) e.vat.add(f.vat);
    if (f.afip) e.afip.add(f.afip);
    if (f.company_name) e.fantasia.add(f.company_name);
  }
  return { total: filas.length, porMail, con_fantasia: filas.filter((f) => f.company_name).length };
}

async function hsBuscarIncompletos() {
  const faltan: Array<{ id: string; email: string; doc: boolean; afip: boolean; fantasia: boolean }> = [];
  let after: string | undefined;
  for (let vuelta = 0; vuelta < 60; vuelta++) {
    const body: Record<string, unknown> = {
      filterGroups: [
        { filters: [{ propertyName: "dni_o_cuil", operator: "NOT_HAS_PROPERTY" }, { propertyName: "email", operator: "HAS_PROPERTY" }] },
        { filters: [{ propertyName: "afip_responsability_type", operator: "NOT_HAS_PROPERTY" }, { propertyName: "email", operator: "HAS_PROPERTY" }] },
        { filters: [{ propertyName: "company", operator: "NOT_HAS_PROPERTY" }, { propertyName: "email", operator: "HAS_PROPERTY" }] },
      ],
      properties: ["email", "dni_o_cuil", "afip_responsability_type", "company"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST", headers: { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`hubspot buscar: ${r.status} ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    for (const c of j.results || []) {
      const em = String(c.properties?.email || "").toLowerCase().trim();
      if (em) faltan.push({
        id: c.id, email: em,
        doc: !!c.properties?.dni_o_cuil,
        afip: !!c.properties?.afip_responsability_type,
        fantasia: !!c.properties?.company,
      });
    }
    after = j.paging?.next?.after;
    if (!after) break;
    await new Promise((s) => setTimeout(s, 250));
  }
  return faltan;
}


// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
  // conectores (Claude / MCP) con su clave propia de Tienda Nube o Mercado Libre
  const proxy = req.headers.get("x-proxy-secret") || "";
  if (proxy && [Deno.env.get("TN_PROXY_SECRET"), Deno.env.get("ML_PROXY_SECRET")].some((x) => x && x === proxy)) return true;
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

_servirConGuardia(async () => {
  const h = { "Content-Type": "application/json" };
  try {
    const espejo = await refrescarEspejo();
    if (!HS) {
      return new Response(JSON.stringify({ ok: true, espejo_odoo: espejo.total, hubspot: "falta HUBSPOT_TOKEN: no se escribio nada" }), { headers: h });
    }
    const faltan = await hsBuscarIncompletos();
    const pendientes: Array<{ id: string; properties: Record<string, string> }> = [];
    let apartados = 0, condicionDesconocida = 0;
    for (const f of faltan) {
      const e = espejo.porMail[f.email];
      if (!e) continue;
      const props: Record<string, string> = {};
      if (!f.doc) {
        if (e.vat.size === 1) { const v = [...e.vat][0]; if (docValido(v)) props.dni_o_cuil = v; }
        else if (e.vat.size > 1) apartados++;
      }
      if (!f.afip) {
        if (e.afip.size === 1) {
          const a = condicionHS([...e.afip][0]);
          if (CONDICIONES.has(a)) props.afip_responsability_type = a; else condicionDesconocida++;
        } else if (e.afip.size > 1) apartados++;
      }
      if (!f.fantasia) {
        if (e.fantasia.size === 1) props.company = [...e.fantasia][0];
        else if (e.fantasia.size > 1) apartados++;
      }
      if (Object.keys(props).length) pendientes.push({ id: f.id, properties: props });
    }
    for (let i = 0; i < pendientes.length; i += 100) {
      const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/update", {
        method: "POST", headers: { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: pendientes.slice(i, i + 100) }),
      });
      if (!r.ok) throw new Error(`hubspot escribir: ${r.status} ${(await r.text()).slice(0, 160)}`);
      await new Promise((s) => setTimeout(s, 300));
    }
    return new Response(JSON.stringify({
      ok: true, espejo_odoo: espejo.total, odoo_con_nombre_fantasia: espejo.con_fantasia,
      hubspot_incompletos: faltan.length, completados: pendientes.length,
      documentos: pendientes.filter((p) => p.properties.dni_o_cuil).length,
      condiciones_fiscales: pendientes.filter((p) => p.properties.afip_responsability_type).length,
      nombres_fantasia: pendientes.filter((p) => p.properties.company).length,
      apartados_por_contradiccion: apartados, condicion_fuera_de_lista: condicionDesconocida,
    }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h });
  }
});
