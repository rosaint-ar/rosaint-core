import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-percepciones v2 (JSON-RPC) - SOLO LECTURA: percepciones por comprobante y regimen, para cruzar con AFIP IMP_PER_RET
// v2 (13-oct-2026): body {periodo, modo:"iibb"} devuelve las percepciones de IIBB sufridas (cuentas 1.1.4.02.*)
//   por comprobante y jurisdicción (código SIFERE 901-924), con fecha del comprobante, tipo, letra, PV y número:
//   lo que el contador necesita para cargarlas en SIFERE y para cruzarlas contra lo que importa SIRCAR.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
type Rec = Record<string, unknown>;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
const m2oName = (v: unknown) => Array.isArray(v) ? (v as unknown[])[1] as string : null;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
function monthRange(periodo: string) { const [y, m] = periodo.split("-").map(Number); const desde = `${y}-${String(m).padStart(2, "0")}-01`; const ld = new Date(y, m, 0).getDate(); return { desde, hasta: `${y}-${String(m).padStart(2, "0")}-${String(ld).padStart(2, "0")}` }; }
function esGrupoIVAReal(g: string) { const n = (g || "").toUpperCase(); return /^VAT \d/.test(n) || /^IVA \d/.test(n); }
// Mapea el nombre del impuesto de Odoo al codigo de regimen de AFIP
function regimenDe(nombre: string): string {
  const n = (nombre || "").toLowerCase();
  if (/2408/.test(n)) return "493";      // Percepcion IVA General RG 2408/08
  if (/5319/.test(n)) return "976";      // Percepcion IVA Especial RG 5319/23
  if (/iibb|ingresos brutos/.test(n)) return "iibb";
  if (/ganancia|profit|earnings/.test(n)) return "ganancias";
  if (/percepci.n del iva|vat perception/.test(n)) return "iva_otro";
  return "otros";
}

// ===== Percepciones de IIBB por jurisdicción =====
// Código de jurisdicción de Convenio Multilateral (el mismo que usa SIFERE y la CM03).
const JUR: [RegExp, string, string][] = [
  [/caba|capital|ciudad/i, "901", "CABA"], [/buenos aires/i, "902", "Buenos Aires"], [/catamarca/i, "903", "Catamarca"],
  [/c.rdoba/i, "904", "Córdoba"], [/corrientes/i, "905", "Corrientes"], [/chaco/i, "906", "Chaco"], [/chubut/i, "907", "Chubut"],
  [/entre r.os/i, "908", "Entre Ríos"], [/formosa/i, "909", "Formosa"], [/jujuy/i, "910", "Jujuy"], [/la pampa/i, "911", "La Pampa"],
  [/la rioja/i, "912", "La Rioja"], [/mendoza/i, "913", "Mendoza"], [/misiones/i, "914", "Misiones"], [/neuqu.n/i, "915", "Neuquén"],
  [/r.o negro/i, "916", "Río Negro"], [/salta/i, "917", "Salta"], [/san juan/i, "918", "San Juan"], [/san luis/i, "919", "San Luis"],
  [/santa cruz/i, "920", "Santa Cruz"], [/santa fe/i, "921", "Santa Fe"], [/santiago/i, "922", "Santiago del Estero"],
  [/tierra del fuego/i, "923", "Tierra del Fuego"], [/tucum.n/i, "924", "Tucumán"],
];
// Tipo de comprobante en castellano (Odoo devuelve el nombre en inglés según el idioma del usuario API)
const TIPO_CBTE: Record<string, string> = {
  "1": "Factura", "2": "Nota de débito", "3": "Nota de crédito", "6": "Factura", "7": "Nota de débito", "8": "Nota de crédito",
  "11": "Factura", "12": "Nota de débito", "13": "Nota de crédito", "51": "Factura", "52": "Nota de débito", "53": "Nota de crédito",
  "81": "Tique factura", "82": "Tique factura", "83": "Tique", "201": "Factura de crédito MiPyME", "203": "Nota de crédito MiPyME",
};
function jurDe(cuenta: string): { codigo: string; nombre: string } {
  const n = cuenta.replace(/^[\d.]+\s+/, "");
  for (const [re, codigo, nombre] of JUR) if (re.test(n)) return { codigo, nombre };
  return { codigo: "", nombre: n };
}
async function percepIibb(uid: number, periodo: string, desde: string, hasta: string): Promise<Rec> {
  // el período es el de la FECHA DEL COMPROBANTE (fecha de la percepción); si no tiene, la contable
  const dom = [["company_id", "=", COMPANY_ID], ["parent_state", "=", "posted"], ["account_id.code", "=like", "1.1.4.02%"],
    "|", "&", ["move_id.invoice_date", ">=", desde], ["move_id.invoice_date", "<=", hasta],
    "&", "&", ["move_id.invoice_date", "=", false], ["date", ">=", desde], ["date", "<=", hasta]];
  const ls = await execKw(uid, "account.move.line", "search_read", [dom], { fields: ["move_id", "account_id", "balance", "partner_id", "date"] }) as Rec[];
  const movIds = [...new Set(ls.map(l => m2oId(l.move_id)).filter((x): x is number => x !== null))];
  const movs: Record<number, Rec> = {};
  if (movIds.length) for (const m of await execKw(uid, "account.move", "read", [movIds, ["name", "move_type", "invoice_date", "date", "l10n_latam_document_number", "l10n_latam_document_type_id", "partner_id"]]) as Rec[]) movs[m.id as number] = m;
  const tipoIds = [...new Set(Object.values(movs).map(m => m2oId(m.l10n_latam_document_type_id)).filter((x): x is number => x !== null))];
  const tipos: Record<number, Rec> = {};
  if (tipoIds.length) for (const t of await execKw(uid, "l10n_latam.document.type", "read", [tipoIds, ["code", "name", "l10n_ar_letter", "internal_type"]]) as Rec[]) tipos[t.id as number] = t;
  const pids = [...new Set(Object.values(movs).map(m => m2oId(m.partner_id)).filter((x): x is number => x !== null))];
  let cuits: Record<number, string> = {};
  if (pids.length) cuits = Object.fromEntries((await execKw(uid, "res.partner", "read", [pids, ["vat"]]) as Rec[]).map(p => [p.id as number, String((p.vat as string) || "").replace(/\D/g, "")]));
  // una fila por comprobante y jurisdicción (un comprobante puede tener dos regímenes de la misma provincia)
  const filas: Record<string, Rec> = {};
  for (const l of ls) {
    const mid = m2oId(l.move_id); if (mid === null) continue;
    const m = movs[mid] || {}; const j = jurDe(m2oName(l.account_id) || "");
    const t = tipos[m2oId(m.l10n_latam_document_type_id) as number] || {};
    const nro = String(m.l10n_latam_document_number || ""); const [pv, numero] = nro.includes("-") ? nro.split("-") : ["", nro];
    const k = mid + "|" + j.codigo + "|" + j.nombre;
    const f = filas[k] ||= { jur_codigo: j.codigo, jurisdiccion: j.nombre, comprobante: m.name, numero_completo: nro, pv, numero,
      tipo_codigo: String(t.code || "").padStart(3, "0"), tipo: TIPO_CBTE[String(t.code || "")] || String(t.name || ""), letra: t.l10n_ar_letter || "", es_nc: m.move_type === "in_refund",
      fecha: m.invoice_date || l.date, agente: m2oName(m.partner_id) || m2oName(l.partner_id) || "", cuit: cuits[m2oId(m.partner_id) as number] || "", importe: 0 };
    f.importe = (f.importe as number) + ((l.balance as number) || 0);
  }
  const lineas = Object.values(filas).map(f => ({ ...f, importe: Math.round((f.importe as number) * 100) / 100 }))
    .filter(f => f.importe !== 0)
    .sort((a, b) => String(a.jur_codigo).localeCompare(String(b.jur_codigo)) || String(a.fecha).localeCompare(String(b.fecha)));
  return { ok: true, periodo, desde, hasta, cantidad: lineas.length, lineas };
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

_servirConGuardia(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    const periodo = (body.periodo as string) || "";
    if (!periodo) return new Response(JSON.stringify({ ok: false, error: "falta periodo" }), { headers: cors });
    const uid = await authenticate();
    const { desde, hasta } = monthRange(periodo);
    if (body.modo === "iibb") return new Response(JSON.stringify(await percepIibb(uid, periodo, desde, hasta)), { headers: cors });
    const moves = await execKw(uid, "account.move", "search_read", [[["move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", COMPANY_ID], ["state", "=", "posted"], ["date", ">=", desde], ["date", "<=", hasta]]], { fields: ["id", "move_type", "l10n_latam_document_number", "partner_id"] }) as Rec[];
    const moveIds = moves.map(m => m.id as number);
    const pids = [...new Set(moves.map(m => m2oId(m.partner_id)).filter((x): x is number => x !== null))];
    let pmap: Record<number, string> = {};
    if (pids.length) { const ps = await execKw(uid, "res.partner", "read", [pids, ["vat"]]) as Rec[]; pmap = Object.fromEntries(ps.map(p => [p.id as number, String((p.vat as string) || "").replace(/\D/g, "")])); }
    // lineas de impuesto
    let taxByMove: Record<number, Record<string, number>> = {};
    if (moveIds.length) {
      const tl = await execKw(uid, "account.move.line", "search_read", [[["move_id", "in", moveIds], ["display_type", "=", "tax"]]], { fields: ["move_id", "balance", "tax_line_id", "tax_group_id"] }) as Rec[];
      for (const l of tl) {
        const mid = m2oId(l.move_id); if (mid === null) continue;
        const gname = m2oName(l.tax_group_id) || "";
        if (esGrupoIVAReal(gname)) continue; // es IVA propio, no percepcion
        const tname = m2oName(l.tax_line_id) || gname;
        const reg = regimenDe(tname);
        const bal = Math.abs((l.balance as number) || 0);
        (taxByMove[mid] = taxByMove[mid] || {})[reg] = (taxByMove[mid]?.[reg] || 0) + bal;
      }
    }
    const facturas = moves.map(m => {
      const id = m.id as number; const pid = m2oId(m.partner_id);
      const esNC = m.move_type === "in_refund"; const signo = esNC ? -1 : 1;
      const por = taxByMove[id] || {};
      const porFirmado: Record<string, number> = {}; let tot = 0;
      for (const k of Object.keys(por)) { porFirmado[k] = Math.round(por[k] * signo * 100) / 100; tot += por[k]; }
      return { comprobante: m.l10n_latam_document_number, cuit: pid !== null ? (pmap[pid] || "") : "", proveedor: m2oName(m.partner_id), es_nc: esNC, por_regimen: porFirmado, total_percep: Math.round(tot * signo * 100) / 100 };
    }).filter(f => Object.keys(f.por_regimen).length > 0);
    return new Response(JSON.stringify({ ok: true, periodo, desde, hasta, cantidad: facturas.length, facturas }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
