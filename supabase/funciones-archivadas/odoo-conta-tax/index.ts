import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-tax v1 - cambia SOLO el campo amount de account.tax (config, no toca asientos)
// Body: { operaciones: [{id, amount}], dry_run?: true }
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
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
let _uid: number | null = null;
async function auth(): Promise<number> {
  if (_uid) return _uid;
  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== "number") throw new Error("Auth Odoo fallida");
  _uid = uid; return uid;
}
const CTX = { lang: "es_ES", allowed_company_ids: [2], active_test: false };
async function kw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  kwargs.context = { ...CTX, ...((kwargs.context as Rec) || {}) };
  return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}
const F = ["id", "name", "amount", "amount_type", "type_tax_use", "active"];

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as { operaciones?: Rec[]; dry_run?: boolean };
    const ops = body.operaciones || [];
    if (!ops.length) throw new Error("Faltan operaciones");
    const uid = await auth();
    const ids = ops.map((o) => Number(o.id));

    const antes = await kw(uid, "account.tax", "read", [ids, F]) as Rec[];
    // cuantos apuntes ya posteados usan estos impuestos (para probar que no se tocan)
    const usoAntes = await kw(uid, "account.move.line", "search_count", [[["company_id", "=", 2], ["parent_state", "=", "posted"], ["tax_line_id", "in", ids]]]) as number;
    const sumaAntes = await kw(uid, "account.move.line", "read_group", [[["company_id", "=", 2], ["parent_state", "=", "posted"], ["tax_line_id", "in", ids]], ["balance"], []], { lazy: false }) as Rec[];

    if (body.dry_run) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, plan: ops, antes, apuntes_posteados: usoAntes, suma_posteada: sumaAntes }, null, 1), { headers: cors });
    }

    const aplicadas: Rec[] = [];
    for (const o of ops) {
      if (o.amount === undefined) continue;
      try {
        await kw(uid, "account.tax", "write", [[Number(o.id)], { amount: Number(o.amount) }]);
        aplicadas.push({ id: o.id, amount: o.amount, ok: true });
      } catch (e) { aplicadas.push({ id: o.id, ok: false, error: String((e as Error).message || e) }); }
    }

    const despues = await kw(uid, "account.tax", "read", [ids, F]) as Rec[];
    const usoDespues = await kw(uid, "account.move.line", "search_count", [[["company_id", "=", 2], ["parent_state", "=", "posted"], ["tax_line_id", "in", ids]]]) as number;
    const sumaDespues = await kw(uid, "account.move.line", "read_group", [[["company_id", "=", 2], ["parent_state", "=", "posted"], ["tax_line_id", "in", ids]], ["balance"], []], { lazy: false }) as Rec[];

    return new Response(JSON.stringify({ ok: true, aplicadas, antes, despues, apuntes_antes: usoAntes, apuntes_despues: usoDespues, suma_antes: sumaAntes, suma_despues: sumaDespues }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
