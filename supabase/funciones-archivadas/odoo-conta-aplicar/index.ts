import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-aplicar v8 (JSON-RPC) - ESCRITURA CONTROLADA, es_ES
// Batch "grupos": renombra account.tax.group (company 2) por nombre actual -> nuevo.

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;

type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }

const MAPA_GRUPOS: Record<string, string> = {
  "Perc IIBB ARBA": "Percepción IIBB Buenos Aires",
  "Perc IIBB CABA": "Percepción IIBB CABA",
  "Perc IIBB Catamarca": "Percepción IIBB Catamarca",
  "Perc IIBB Chaco": "Percepción IIBB Chaco",
  "Perc IIBB Chubut": "Percepción IIBB Chubut",
  "Perc IIBB Corrientes": "Percepción IIBB Corrientes",
  "Perc IIBB Córdoba": "Percepción IIBB Córdoba",
  "Perc IIBB Entre Ríos": "Percepción IIBB Entre Ríos",
  "Perc IIBB Formosa": "Percepción IIBB Formosa",
  "Perc IIBB Jujuy": "Percepción IIBB Jujuy",
  "Perc IIBB La Pampa": "Percepción IIBB La Pampa",
  "Perc IIBB La Rioja": "Percepción IIBB La Rioja",
  "Perc IIBB Mendoza": "Percepción IIBB Mendoza",
  "Perc IIBB Misiones": "Percepción IIBB Misiones",
  "Perc IIBB Neuquén": "Percepción IIBB Neuquén",
  "Perc IIBB Río Negro": "Percepción IIBB Río Negro",
  "Perc IIBB Salta": "Percepción IIBB Salta",
  "Perc IIBB San Juan": "Percepción IIBB San Juan",
  "Perc IIBB San Luis": "Percepción IIBB San Luis",
  "Perc IIBB Santa Cruz": "Percepción IIBB Santa Cruz",
  "Perc IIBB Santa Fe": "Percepción IIBB Santa Fe",
  "Perc IIBB Santiago del Estero": "Percepción IIBB Santiago del Estero",
  "Perc IIBB Tierra del Fuego": "Percepción IIBB Tierra del Fuego",
  "Perc IIBB Tucumán": "Percepción IIBB Tucumán",
  "Percepción de los beneficios": "Percepción Ganancias",
};

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    if (body.batch !== "grupos") return new Response(JSON.stringify({ ok: false, error: "batch no soportado en v8 (usar 'grupos')" }), { headers: cors });
    const dryRun = body.dry_run === true;
    const uid = await authenticate();
    const ctx = { lang: "es_ES" };
    const grupos = await execKw(uid, "account.tax.group", "search_read", [[["company_id", "=", COMPANY_ID]]], { fields: ["id", "name"], context: ctx }) as Rec[];
    const cambios: Rec[] = [];
    for (const g of grupos) {
      const actual = g.name as string;
      const nuevo = MAPA_GRUPOS[actual];
      if (!nuevo || nuevo === actual) continue;
      if (!dryRun) await execKw(uid, "account.tax.group", "write", [[g.id], { name: nuevo }], { context: ctx });
      cambios.push({ id: g.id, antes: actual, despues: nuevo });
    }
    const verif = await execKw(uid, "account.tax.group", "search_read", [[["company_id", "=", COMPANY_ID]]], { fields: ["id", "name"], order: "name", context: ctx });
    return new Response(JSON.stringify({ ok: true, dry_run: dryRun, cambios_aplicados: cambios.length, cambios, verificacion: verif }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
