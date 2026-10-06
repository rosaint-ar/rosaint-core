import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-fixlineas v3 - corrige renglones + borrador/repost + reconciliar
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const PERMITIDOS = new Set(["product_id", "name", "price_unit", "quantity", "tax_ids"]);
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
const CTX = { lang: "es_ES", allowed_company_ids: [2] };
async function kw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  kwargs.context = { ...CTX, ...((kwargs.context as Rec) || {}) };
  return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}

const CL = ["id", "move_id", "move_name", "display_type", "product_id", "name", "account_id", "quantity", "price_unit", "debit", "credit", "balance", "tax_ids", "tax_tag_ids", "tax_line_id", "reconciled", "amount_residual"];
const CM = ["id", "name", "state", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "invoice_date", "date"];

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as { move_ids?: number[]; operaciones?: Array<Rec>; a_borrador?: boolean; repostear?: boolean; reconciliar?: number[][]; solo_leer?: boolean };
    const uid = await auth();
    const ops = body.operaciones || [];

    let moveIds: number[] = body.move_ids || [];
    if (!moveIds.length && ops.length) {
      const base = await kw(uid, "account.move.line", "read", [ops.map((o) => Number(o.id)), ["move_id"]]) as Rec[];
      moveIds = [...new Set(base.map((l) => (l.move_id as [number, string])[0]))];
    }
    if (!moveIds.length) throw new Error("Faltan move_ids u operaciones");

    const antesL = await kw(uid, "account.move.line", "search_read", [[["move_id", "in", moveIds]]], { fields: CL, order: "move_name,id" }) as Rec[];
    const antesM = await kw(uid, "account.move", "read", [moveIds, CM]) as Rec[];
    if (body.solo_leer) return new Response(JSON.stringify({ ok: true, antes_moves: antesM, antes_lineas: antesL }, null, 1), { headers: cors });

    const pasos: Rec[] = [];
    const paso = async (nombre: string, fn: () => Promise<unknown>) => {
      try { const r = await fn(); pasos.push({ paso: nombre, ok: true, r }); return true; }
      catch (e) { pasos.push({ paso: nombre, ok: false, error: String((e as Error).message || e) }); return false; }
    };

    if (body.a_borrador) { if (!await paso("a_borrador", () => kw(uid, "account.move", "button_draft", [moveIds]))) {
      const l = await kw(uid, "account.move.line", "search_read", [[["move_id", "in", moveIds]]], { fields: CL, order: "move_name,id" });
      const m = await kw(uid, "account.move", "read", [moveIds, CM]);
      return new Response(JSON.stringify({ ok: false, corte: "no se pudo pasar a borrador", pasos, antes_moves: antesM, despues_moves: m, antes_lineas: antesL, despues_lineas: l }, null, 1), { headers: cors });
    } }

    const aplicadas: Rec[] = [];
    for (const o of ops) {
      const vals: Rec = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === "id") continue;
        if (!PERMITIDOS.has(k)) throw new Error(`Campo no permitido: ${k}`);
        vals[k] = v;
      }
      if (!Object.keys(vals).length) continue;
      try {
        await kw(uid, "account.move.line", "write", [[Number(o.id)], vals], { context: { check_move_validity: false } });
        aplicadas.push({ id: o.id, vals, ok: true });
      } catch (e) {
        aplicadas.push({ id: o.id, vals, ok: false, error: String((e as Error).message || e) });
      }
    }

    if (body.repostear) await paso("repostear", () => kw(uid, "account.move", "action_post", [moveIds]));
    if (body.reconciliar) for (const grupo of body.reconciliar) await paso("reconciliar " + JSON.stringify(grupo), () => kw(uid, "account.move.line", "reconcile", [grupo]));

    const despL = await kw(uid, "account.move.line", "search_read", [[["move_id", "in", moveIds]]], { fields: CL, order: "move_name,id" }) as Rec[];
    const despM = await kw(uid, "account.move", "read", [moveIds, CM]) as Rec[];

    return new Response(JSON.stringify({ ok: true, pasos, aplicadas, antes_moves: antesM, despues_moves: despM, antes_lineas: antesL, despues_lineas: despL }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
