import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ====== odoo-rpc (v7) — proxy JSON-RPC genérico para Rosaint ======
// JSON-RPC (más rápido que XML-RPC para respuestas grandes).
// verify_jwt=false pero valida el token del usuario logueado adentro (CORS-safe).
// Body: { model, method, args, kwargs }. Contexto: SOLO compañía 2 (Velázquez).
// v7: validar el usuario con el apikey que llega en el request (la clave
// publishable del front). La SUPABASE_ANON_KEY legacy quedó rechazada y hacía
// que /auth/v1/user fallara siempre -> "No autorizado" aunque la sesión fuera válida.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const CTX = { allowed_company_ids: [2] };

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid; return uid;
}

async function usuarioValido(req: Request): Promise<boolean> {
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return false;
  const apikey = req.headers.get("apikey") || PUB || SB_ANON;
  try { const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey, Authorization: a } }); return r.ok; } catch { return false; }
}

const ALLOW: Record<string, string[]> = {
  "res.partner": ["search_read", "read", "search_count", "write", "create", "message_post"],
  "res.country.state": ["search_read"],
  "res.partner.category": ["search_read"],
  "l10n_ar.afip.responsibility.type": ["search_read"],
  "l10n_latam.identification.type": ["search_read"],
  "sale.order": ["search_read", "read_group", "read"],
  "sale.order.line": ["read_group", "search_read"],
};

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!(await usuarioValido(req))) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { headers: cors, status: 200 });
    const body = await req.json() as { model: string; method: string; args?: unknown[]; kwargs?: Record<string, unknown> };
    const { model, method } = body;
    if (!model || !method) return new Response(JSON.stringify({ ok: false, error: "Falta model o method" }), { headers: cors, status: 200 });
    if (!ALLOW[model] || !ALLOW[model].includes(method))
      return new Response(JSON.stringify({ ok: false, error: `No permitido: ${model}.${method}` }), { headers: cors, status: 200 });
    const args = body.args || [];
    const kwargs = { ...(body.kwargs || {}) } as Record<string, unknown>;
    // la empresa la fija el servidor: la pantalla no puede cambiarla (solo VELAZQUEZ)
    kwargs.context = { ...((kwargs.context as Record<string, unknown>) || {}), ...CTX };
    const uid = await auth();
    const result = await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
    return new Response(JSON.stringify({ ok: true, result }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
