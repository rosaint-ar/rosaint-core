import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-cuentas v1 (JSON-RPC) - ESCRITURA CONTROLADA de account.account, es_ES
// Solo recodifica (code) + renombra (name). Matchea por codigo actual. Muestra saldo posteado.

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

// {ca: codigo actual, cn: codigo nuevo, nm: nombre nuevo}
const LOTE_G1: Array<{ ca: string; cn: string; nm: string }> = [
  { ca: "5.2.1.01", cn: "5.2.1.01.990", nm: "Gastos comerciales varios" },
  { ca: "5.3.1.01", cn: "5.3.1.01.990", nm: "Gastos administrativos varios" },
  { ca: "5.1.1.01", cn: "5.1.1.01.900", nm: "Gastos de producción varios" },
  { ca: "5.1.2.01.14", cn: "5.1.2.01.140", nm: "Fletes sobre compras" },
  { ca: "5.1.2.020", cn: "5.1.2.01.150", nm: "Insumos de oficina" },
  { ca: "5.3.1.01.200", cn: "2.1.1.01.060", nm: "Cadeterías a pagar" },
  { ca: "5.3.1.01.210", cn: "2.1.1.01.070", nm: "Cadeterías corrientes a pagar" },
  { ca: "5.9.01.010", cn: "5.9.1.01.010", nm: "Gastos no deducibles / no operativos" },
];

async function saldoPosteado(uid: number, accId: number): Promise<Rec> {
  const g = await execKw(uid, "account.move.line", "read_group", [[["account_id", "=", accId], ["company_id", "=", COMPANY_ID], ["parent_state", "=", "posted"]], ["balance:sum"], []], { lazy: false }) as Rec[];
  return g[0] || {};
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    if (body.batch !== "g1") return new Response(JSON.stringify({ ok: false, error: "batch no soportado (usar 'g1')" }), { headers: cors });
    const dryRun = body.dry_run === true;
    const uid = await authenticate();
    const ctx = { lang: "es_ES" };
    const resultado: Rec[] = [];
    for (const op of LOTE_G1) {
      const found = await execKw(uid, "account.account", "search_read", [[["code", "=", op.ca], ["company_ids", "in", [COMPANY_ID]]]], { fields: ["id", "code", "name", "account_type"], context: ctx }) as Rec[];
      if (!found.length) { resultado.push({ codigo_buscado: op.ca, error: "no encontrada" }); continue; }
      const acc = found[0];
      const saldoAntes = await saldoPosteado(uid, acc.id as number);
      if (!dryRun) await execKw(uid, "account.account", "write", [[acc.id], { code: op.cn, name: op.nm }], { context: ctx });
      const desp = await execKw(uid, "account.account", "read", [[acc.id]], { fields: ["id", "code", "name", "account_type"], context: ctx }) as Rec[];
      const saldoDesp = await saldoPosteado(uid, acc.id as number);
      resultado.push({ id: acc.id, code_antes: op.ca, code_despues: desp[0]?.code, name_antes: acc.name, name_despues: desp[0]?.name, account_type: acc.account_type, saldo_antes: saldoAntes.balance || 0, saldo_despues: saldoDesp.balance || 0 });
    }
    return new Response(JSON.stringify({ ok: true, dry_run: dryRun, cantidad: resultado.length, resultado }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
