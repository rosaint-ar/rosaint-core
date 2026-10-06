import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-conta-leer v1 — lector generico SOLO LECTURA (Rosaint) ======
// Body: { model, method?, args?, kwargs?, company? } o { consultas: [...] }
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;

const LECTURA = new Set([
  "search_read", "read", "search", "search_count", "read_group",
  "fields_get", "name_search", "default_get",
]);

type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}

let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid;
  return uid;
}

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as Rec;
    const uid = await auth();

    const correr = async (q: Rec) => {
      const model = q.model as string;
      const method = (q.method as string) || "search_read";
      if (!model) throw new Error("Falta model");
      if (!LECTURA.has(method)) throw new Error(`Metodo no permitido (solo lectura): ${method}`);
      const args = (q.args as unknown[]) || [[]];
      const kwargs = { ...((q.kwargs as Rec) || {}) };
      const companies = (q.company as number[]) || (body.company as number[]) || [2];
      kwargs.context = {
        lang: "es_ES",
        allowed_company_ids: companies,
        ...((kwargs.context as Rec) || {}),
      };
      return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
    };

    if (Array.isArray(body.consultas)) {
      const out: Rec = {};
      for (const q of (body.consultas as Rec[])) {
        const clave = (q.clave as string) || (q.model as string);
        try { out[clave] = await correr(q); }
        catch (e) { out[clave] = { error: String((e as Error).message || e) }; }
      }
      return new Response(JSON.stringify({ ok: true, result: out }), { headers: cors });
    }

    const result = await correr(body);
    return new Response(JSON.stringify({ ok: true, result }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
