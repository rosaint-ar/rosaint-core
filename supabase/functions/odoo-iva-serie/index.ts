import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-iva-serie - posicion de IVA por mes (debito ventas vs credito compras)
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2;
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function ex(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }

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

_servirConGuardia(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const meses = Math.min(24, Math.max(3, (body.meses as number) || 12));
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [C] };
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (meses - 1), 1));
    const desde = start.toISOString().slice(0, 10);
    // Consulta (solo lectura): comprobantes de compra de un mes con su IVA, para cruzar contra el libro de ARCA
    if (body.comprobantes_compra) {
      const mes = String(body.comprobantes_compra); const [y, mm] = mes.split("-").map(Number);
      const hasta = new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 10);
      const movs = await ex(uid, "account.move", "search_read", [[["company_id", "=", C], ["state", "=", "posted"], ["move_type", "in", ["in_invoice", "in_refund"]], ["date", ">=", mes + "-01"], ["date", "<", hasta]]],
        { fields: ["name", "move_type", "date", "invoice_date", "partner_id", "l10n_latam_document_type_id", "l10n_latam_document_number", "journal_id", "amount_tax", "amount_total", "currency_id", "l10n_latam_use_documents"], limit: 2000, context: ctx }) as Rec[];
      const pids = [...new Set(movs.map((m) => (m.partner_id as unknown[])?.[0]).filter(Boolean))] as number[];
      const ps = pids.length ? await ex(uid, "res.partner", "read", [pids], { fields: ["vat"], context: ctx }) as Rec[] : [];
      const vat: Record<number, string> = {}; for (const p of ps) vat[p.id as number] = String(p.vat || "");
      return new Response(JSON.stringify({ ok: true, comprobantes: movs.map((m) => ({ ...m, cuit: vat[(m.partner_id as unknown[])?.[0] as number] || "" })) }), { headers: cors });
    }
    // Solo IVA (auditoría 6-oct-2026). Antes se sumaba TODA línea de impuesto en valor absoluto: entraban las
    // percepciones de Ingresos Brutos como si fueran crédito de IVA y las notas de crédito sumaban en vez de restar.
    // Ahora: cada línea con su signo, y clasificada por el grupo de impuesto de Odoo (l10n_ar):
    //   - IVA por alícuota (grupo con código de IVA de AFIP) → débito (ventas) / crédito (compras)
    //   - percepción de IVA (pago a cuenta, también se descuenta del saldo) → aparte
    //   - lo demás (IIBB, municipales, etc.) → no es IVA, solo se informa
    async function lineas(moveTypes: string[]) {
      return await ex(uid, "account.move.line", "search_read", [[
        ["tax_line_id", "!=", false],
        ["parent_state", "=", "posted"],
        ["company_id", "=", C],
        ["date", ">=", desde],
        ["move_id.move_type", "in", moveTypes],
      ]], { fields: ["date", "balance", "tax_line_id"], limit: 20000, context: ctx }) as Rec[];
    }
    const lv = await lineas(["out_invoice", "out_refund"]);
    const lc = await lineas(["in_invoice", "in_refund"]);
    const taxIds = [...new Set([...lv, ...lc].map((l) => (l.tax_line_id as unknown[])?.[0]).filter(Boolean))] as number[];
    const taxes = taxIds.length ? await ex(uid, "account.tax", "read", [taxIds], { fields: ["name", "tax_group_id"], context: ctx }) as Rec[] : [];
    const grupoIds = [...new Set(taxes.map((t) => (t.tax_group_id as unknown[])?.[0]).filter(Boolean))] as number[];
    let grupos: Rec[] = [];
    try { grupos = grupoIds.length ? await ex(uid, "account.tax.group", "read", [grupoIds], { fields: ["name", "l10n_ar_vat_afip_code", "l10n_ar_tribute_afip_code"], context: ctx }) as Rec[] : []; }
    catch { grupos = grupoIds.length ? await ex(uid, "account.tax.group", "read", [grupoIds], { fields: ["name"], context: ctx }) as Rec[] : []; }
    const grupoDe: Record<number, Rec> = {}; for (const g of grupos) grupoDe[g.id as number] = g;
    const claseDe: Record<number, string> = {};
    const nombreDe: Record<number, string> = {};
    for (const t of taxes) {
      const g = grupoDe[(t.tax_group_id as unknown[])?.[0] as number] || {};
      const nom = String(t.name || "") + " " + String(g.name || "");
      nombreDe[t.id as number] = String(t.name || "");
      if (g.l10n_ar_vat_afip_code || (!("l10n_ar_vat_afip_code" in g) && /^IVA\s*\d/i.test(String(t.name)))) claseDe[t.id as number] = "iva";
      else if (/percep[a-z]*\s.*\biva\b|\biva\b.*percep/i.test(nom) || String(g.l10n_ar_tribute_afip_code || "") === "06") claseDe[t.id as number] = "percepcion_iva";
      else claseDe[t.id as number] = "otro";
    }
    const acum = (ls: Rec[], signo: number) => {
      const m: Record<string, Record<string, number>> = {}; const det: Record<string, Record<string, number>> = {};
      for (const l of ls) {
        const k = String(l.date || "").slice(0, 7); if (!k) continue;
        const id = (l.tax_line_id as unknown[])?.[0] as number; const cl = claseDe[id] || "otro";
        const v = signo * Number(l.balance || 0);
        (m[k] ||= {})[cl] = ((m[k] ||= {})[cl] || 0) + v;
        (det[k] ||= {})[nombreDe[id] || String(id)] = ((det[k] ||= {})[nombreDe[id] || String(id)] || 0) + v;
      }
      return { m, det };
    };
    const V = acum(lv, -1);   // ventas: el IVA va al haber (balance negativo) → débito positivo; NC lo resta
    const Cc = acum(lc, 1);   // compras: el IVA va al debe (positivo) → crédito positivo; NC lo resta
    const r2 = (x: number) => Math.round((x || 0) * 100) / 100;
    const out = [] as Rec[];
    for (let i = 0; i < meses; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const k = d.toISOString().slice(0, 7);
      const dv = r2(V.m[k]?.iva), cv = r2(Cc.m[k]?.iva), pv = r2(Cc.m[k]?.percepcion_iva);
      out.push({ mes: k, debito: dv, credito: r2(cv + pv), credito_alicuotas: cv, percepciones_iva: pv,
        otros_impuestos_compras: r2(Cc.m[k]?.otro), saldo: r2(dv - cv - pv),
        ...(body.detalle ? { detalle_ventas: V.det[k] || {}, detalle_compras: Cc.det[k] || {} } : {}) });
    }
    return new Response(JSON.stringify({ ok: true, desde, meses: out }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
