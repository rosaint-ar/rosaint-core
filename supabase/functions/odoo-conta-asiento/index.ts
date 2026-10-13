import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// ====== odoo-conta-asiento v1 — asientos contables de lote FIJO (Rosaint, company 2) ======
// Solo hace operaciones predefinidas y aprobadas por Dirección; nada genérico.
// Entra únicamente con la clave interna (x-cron-key): no se llama desde las pantallas.
// Body: { lote: "<nombre>", paso: "...", dry_run?: true }
//
// Lote "iva_combustible" (aprobado 13-oct-2026): el IVA de 12 tickets de combustible
// ($104.742,11) no se computó en las DDJJ F.2051 de mayo a agosto 2026 (decisión/error del
// contador anterior); se toma en la DDJJ de septiembre.
//   paso "reclasificar" (31/08/2026): IVA crédito fiscal → IVA crédito fiscal a recuperar.
//   paso "recuperar"    (30/09/2026): la vuelta, cuando la contadora confirme que lo computó.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2;
const CTX = { lang: "es_ES", allowed_company_ids: [C] };
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function uid(): Promise<number> {
  if (_uid) return _uid;
  const u = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!u || typeof u !== "number") throw new Error("Auth Odoo fallida");
  return (_uid = u);
}
const ex = async (model: string, method: string, args: unknown[], kw: Rec = {}) =>
  rpc("object", "execute_kw", [ODOO_DB, await uid(), ODOO_KEY, model, method, args, { ...kw, context: { ...CTX, ...((kw.context as Rec) || {}) } }]);

const LOTE = {
  importe: 104742.11,
  cuenta_iva: "1.1.4.04.010",
  cuenta_nueva: { code: "1.1.4.04.060", name: "IVA crédito fiscal a recuperar (no computado)" },
  detalle: "IVA combustible no computado en DDJJ may-ago 2026 (may 28.092,46 · jun 19.214,29 · jul 28.601,27 · ago 28.834,09) — 12 tickets",
  pasos: {
    reclasificar: { fecha: "2026-08-31", ref: "IVA-COMB-NO-COMPUTADO-MAY-AGO", debe: "nueva", haber: "iva" },
    recuperar: { fecha: "2026-09-30", ref: "IVA-COMB-RECUPERADO-SEP", debe: "iva", haber: "nueva" },
  } as Record<string, { fecha: string; ref: string; debe: string; haber: string }>,
};

async function cuenta(code: string): Promise<number | null> {
  const r = await ex("account.account", "search_read", [[["code", "=", code], ["company_ids", "in", [C]]]], { fields: ["id"] }) as Rec[];
  return r.length ? r[0].id as number : null;
}

async function iva_combustible(body: Rec): Promise<Rec> {
  const p = LOTE.pasos[String(body.paso || "")];
  if (!p) return { ok: false, error: "paso desconocido (reclasificar | recuperar)" };
  const dry = !!body.dry_run;
  const log: string[] = [];
  // ya cargado? (idempotente)
  const ya = await ex("account.move", "search_read", [[["ref", "=", p.ref], ["company_id", "=", C], ["state", "!=", "cancel"]]], { fields: ["name", "state", "date"] }) as Rec[];
  if (ya.length) return { ok: true, ya_existia: ya };
  const idIva = await cuenta(LOTE.cuenta_iva); if (!idIva) return { ok: false, error: "no encuentro la cuenta " + LOTE.cuenta_iva };
  let idNueva = await cuenta(LOTE.cuenta_nueva.code);
  if (!idNueva) {
    if (body.paso === "recuperar") return { ok: false, error: "la cuenta a recuperar no existe" };
    log.push("crear cuenta " + LOTE.cuenta_nueva.code + " " + LOTE.cuenta_nueva.name);
    if (!dry) idNueva = await ex("account.account", "create", [{ code: LOTE.cuenta_nueva.code, name: LOTE.cuenta_nueva.name, account_type: "asset_current", reconcile: false, company_ids: [[6, 0, [C]]] }]) as number;
  }
  const diario = await ex("account.journal", "search_read", [[["company_id", "=", C], ["type", "=", "general"], ["code", "in", ["MISC", "VARIO", "Vario"]]]], { fields: ["id", "name", "code"] }) as Rec[];
  const diarioG = diario.length ? diario : await ex("account.journal", "search_read", [[["company_id", "=", C], ["type", "=", "general"]]], { fields: ["id", "name", "code"], limit: 1 }) as Rec[];
  if (!diarioG.length) return { ok: false, error: "no hay diario de operaciones varias" };
  const cta = (k: string) => k === "iva" ? idIva : idNueva;
  const linea = (acc: number | null, debit: number, credit: number) => [0, 0, { account_id: acc, name: LOTE.detalle, debit, credit, tax_ids: [[6, 0, []]], tax_tag_ids: [[6, 0, []]] }];
  const vals = { move_type: "entry", journal_id: diarioG[0].id, date: p.fecha, ref: p.ref, company_id: C,
    line_ids: [linea(cta(p.debe), LOTE.importe, 0), linea(cta(p.haber), 0, LOTE.importe)] };
  log.push(`asiento ${p.fecha} en ${diarioG[0].name}: Debe ${p.debe === "iva" ? LOTE.cuenta_iva : LOTE.cuenta_nueva.code} / Haber ${p.haber === "iva" ? LOTE.cuenta_iva : LOTE.cuenta_nueva.code} por ${LOTE.importe}`);
  if (dry) return { ok: true, dry_run: true, log };
  const mid = await ex("account.move", "create", [vals]) as number;
  await ex("account.move", "action_post", [[mid]]);
  const m = await ex("account.move", "read", [[mid], ["name", "state", "date", "ref"]]) as Rec[];
  const ls = await ex("account.move.line", "search_read", [[["move_id", "=", mid]]], { fields: ["account_id", "debit", "credit", "tax_line_id"] }) as Rec[];
  return { ok: true, log, asiento: m[0], lineas: ls };
}

Deno.serve(async (req: Request) => {
  const h = { "Content-Type": "application/json" };
  const clave = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (!clave || req.headers.get("x-cron-key") !== clave) return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), { status: 401, headers: h });
  try {
    const body = await req.json() as Rec;
    if (body.lote === "iva_combustible") return new Response(JSON.stringify(await iva_combustible(body)), { headers: h });
    return new Response(JSON.stringify({ ok: false, error: "lote desconocido" }), { headers: h });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: h }); }
});
