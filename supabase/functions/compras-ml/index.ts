import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// ═══ compras-ml v1 (10-nov-2026) — Compras de Rosaint EN Mercado Libre ⇄ ARCA ⇄ Odoo ═══
// La factura de una compra en ML no se puede bajar por API como comprador: la fuente es ARCA (Mis Comprobantes
// Recibidos, que sube la pantalla). Esta función da todo lo demás y carga en Odoo.
// Modos:
//   datos {mes}       → compras de ML como comprador (INCLUYE canceladas: generan FA + NC), facturas de proveedor de
//                       Odoo de la ventana, mapa CUIT→vendedor aprendido, decisiones guardadas e historial de cuentas por CUIT.
//   aprender {cuit, seller_id, nickname, razon_social}
//   decidir {clave, categoria, nota}
//   cargar {comp, categoria, detalle, pago:{fecha}|null, dry_run} → factura/NC de proveedor en Odoo: proveedor por CUIT
//                       (alta si falta), verificada al centavo contra ARCA, pago por Mercado Pago, NC conciliada con su FA.
// Trampa: l10n_latam_document_number NO sirve como filtro en Odoo (lo ignora y devuelve todo): duplicados por `name`.

const ML_API = "https://api.mercadolibre.com";
const BUYER = 157540060;
const ODOO_URL = Deno.env.get("ODOO_URL")!, ODOO_DB = Deno.env.get("ODOO_DB")!, ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!, ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2, J_COMPRAS = 33, J_MP = 42, PML_MP_OUT = 22, COUNTRY_AR = 10, ID_CUIT = 4;
const TAX = { iva21: 188, iva105: 186, iva27: 190, noAplica: 178, noGravado: 180 };
const TAX_IVA = new Set([188, 186, 190]);
// Criterio de Diego (10-nov-2026) = como se vienen cargando:
const CATS: Record<string, { code: string; account: number; label: string }> = {
  comercial: { code: "GC10", account: 918, label: "Gastos comerciales varios (cajas, cintas, film, bolsas)" },
  libreria:  { code: "GA04", account: 786, label: "Artículos de librería (papel, tintas, etiquetas)" },
  personal:  { code: "GN01", account: 934, label: "Gastos varios no operativos (personal)" },
  equipos:   { code: "GA05", account: 946, label: "Equipos de computación" },
};
const DOC: Record<string, { id: number; nc: boolean; letra: string; pref: string }> = {
  "1": { id: 1, nc: false, letra: "A", pref: "FA-A" }, "3": { id: 3, nc: true, letra: "A", pref: "NC-A" },
  "6": { id: 6, nc: false, letra: "B", pref: "FA-B" }, "8": { id: 8, nc: true, letra: "B", pref: "NC-B" },
  "11": { id: 11, nc: false, letra: "C", pref: "FA-C" }, "13": { id: 13, nc: true, letra: "C", pref: "NC-C" },
};
type Rec = Record<string, any>;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };

// ── Odoo ────────────────────────────────────────────────────────────────────
async function rpc(service: string, method: string, args: unknown[]): Promise<any> {
  let texto = "", st = 0;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 600 * i + Math.random() * 400));
    const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }) });
    st = res.status; texto = await res.text();
    if (res.ok && texto.trimStart().startsWith("{")) break;
  }
  if (!texto.trimStart().startsWith("{")) throw new Error(`Odoo no respondió bien (HTTP ${st})`);
  const j = JSON.parse(texto);
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let UID = 0;
async function ex(model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  if (!UID) UID = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  const ctx = { lang: "es_ES", allowed_company_ids: [C], ...(kwargs.context || {}) };
  return await rpc("object", "execute_kw", [ODOO_DB, UID, ODOO_KEY, model, method, args, { ...kwargs, context: ctx }]);
}
async function leerTodo(model: string, domain: unknown[], fields: string[], order = "id") {
  const out: Rec[] = [];
  for (let off = 0; ; off += 500) { const r = await ex(model, "search_read", [domain], { fields, limit: 500, offset: off, order }) as Rec[]; out.push(...r); if (r.length < 500) break; }
  return out;
}
const m2o = (v: any) => Array.isArray(v) ? v[0] : null;
const digitos = (s: any) => String(s || "").replace(/\D/g, "");
const cuitFmt = (d: string) => d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : d;

// ── Mercado Libre ───────────────────────────────────────────────────────────
async function mlToken(sb: any): Promise<string> {
  const { data: auth } = await sb.from("ml_auth").select("*").eq("id", 1).single();
  if (!auth?.refresh_token) throw new Error("Falta refresh token de ML.");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: Deno.env.get("ML_APP_ID")!, client_secret: Deno.env.get("ML_SECRET")!, refresh_token: auth.refresh_token });
  const r = await fetch(`${ML_API}/oauth/token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const d = await r.json(); if (!r.ok) throw new Error("No se pudo renovar token ML: " + JSON.stringify(d));
  await sb.from("ml_auth").update({ access_token: d.access_token, refresh_token: d.refresh_token, token_expira_en: new Date(Date.now() + (d.expires_in ?? 21600) * 1000).toISOString(), actualizado_en: new Date().toISOString() }).eq("id", 1);
  return d.access_token;
}

async function comprasML(sb: any, desde: string, hasta: string) {
  const tok = await mlToken(sb);
  const out: Rec[] = [];
  for (let off = 0; off < 2000; off += 50) {
    const q = `/orders/search?buyer=${BUYER}&order.date_created.from=${desde}T00:00:00.000-03:00&order.date_created.to=${hasta}T23:59:59.000-03:00&sort=date_asc&limit=50&offset=${off}`;
    let j: Rec | null = null;
    for (let i = 0; i < 3 && !j; i++) { const r = await fetch(ML_API + q, { headers: { Authorization: "Bearer " + tok } }); if (r.ok) j = await r.json(); else await new Promise((s) => setTimeout(s, 700 * (i + 1))); }
    if (!j) throw new Error("Mercado Libre no respondió la lista de compras");
    for (const o of j.results || []) {
      const pagos = (o.payments || []).filter((p: Rec) => p.status === "approved");
      out.push({
        id: String(o.id), pack: String(o.pack_id || o.id), fecha: String(o.date_created).slice(0, 10), status: o.status,
        seller_id: o.seller?.id, seller: o.seller?.nickname || "", total: o.total_amount,
        pagado: r2(pagos.reduce((s: number, p: Rec) => s + (p.total_paid_amount || 0), 0)),
        fecha_pago: (pagos[0]?.date_approved || o.date_created || "").slice(0, 10),
        items: (o.order_items || []).map((i: Rec) => ({ titulo: i.item?.title, cant: i.quantity, precio: i.unit_price, item_id: i.item?.id })),
      });
    }
    if (off + 50 >= (j.paging?.total || 0)) break;
  }
  return out;
}

// ── modos ───────────────────────────────────────────────────────────────────
async function datos(sb: any, body: Rec) {
  const mes = String(body.mes || "");
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error("Falta el mes (YYYY-MM)");
  const [y, m] = mes.split("-").map(Number);
  const ini = new Date(Date.UTC(y, m - 1, 1)), fin = new Date(Date.UTC(y, m, 0));
  const [compras, vend, dec] = await Promise.all([
    comprasML(sb, iso(addDays(ini, -50)), iso(addDays(fin, 10))),
    sb.from("compras_ml_vendedores").select("*"),
    sb.from("compras_ml_decisiones").select("*"),
  ]);
  // facturas de proveedor de la ventana
  const moves = await leerTodo("account.move", [["move_type", "in", ["in_invoice", "in_refund"]], ["state", "!=", "cancel"], ["company_id", "=", C],
    ["invoice_date", ">=", iso(addDays(ini, -60))], ["invoice_date", "<=", iso(addDays(fin, 60))]],
    ["name", "move_type", "state", "partner_id", "invoice_date", "date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "invoice_payments_widget"], "invoice_date asc, id asc");
  const ids = moves.map((x) => x.id);
  const lineas: Rec[] = [];
  for (let i = 0; i < ids.length; i += 300) lineas.push(...await leerTodo("account.move.line", [["move_id", "in", ids.slice(i, i + 300)], ["display_type", "in", ["product", "tax"]]], ["move_id", "display_type", "account_id", "product_id", "tax_line_id", "balance"]));
  const pids = [...new Set(moves.map((x) => m2o(x.partner_id)).filter(Boolean))];
  const partners = pids.length ? await ex("res.partner", "read", [pids], { fields: ["vat"] }) as Rec[] : [];
  const vat: Record<number, string> = Object.fromEntries(partners.map((p) => [p.id, digitos(p.vat)]));
  const porMove: Record<number, Rec[]> = {};
  for (const l of lineas) (porMove[m2o(l.move_id)] ||= []).push(l);
  const odoo = moves.map((x) => {
    const ls = porMove[x.id] || [];
    return {
      id: x.id, name: x.name, nc: x.move_type === "in_refund", state: x.state, cuit: vat[m2o(x.partner_id)] || "", proveedor: x.partner_id?.[1] || "",
      fecha: x.invoice_date, fecha_contable: x.date, total: x.amount_total, iva: x.amount_tax, residual: x.amount_residual, pago: x.payment_state,
      pagos: (x.invoice_payments_widget?.content || []).map((p: Rec) => p.journal_name),
      cuentas: [...new Set(ls.filter((l) => l.display_type === "product").map((l) => l.account_id?.[1]))],
      productos: [...new Set(ls.filter((l) => l.display_type === "product").map((l) => l.product_id?.[1]).filter(Boolean))],
      percepciones: r2(ls.filter((l) => l.display_type === "tax" && l.tax_line_id && !TAX_IVA.has(m2o(l.tax_line_id))).reduce((s, l) => s + Math.abs(l.balance), 0)),
    };
  });
  // órdenes de compra de la ventana: lo que va por Compras (envases y materias primas, con trazabilidad) se factura
  // DESDE la OC; la herramienta no tiene que crear otra factura por afuera.
  const ocs = await leerTodo("purchase.order", [["company_id", "=", C], ["state", "in", ["purchase", "done", "sent", "to approve"]],
    ["date_order", ">=", iso(addDays(ini, -60)) + " 00:00:00"], ["date_order", "<=", iso(addDays(fin, 15)) + " 23:59:59"]],
    ["name", "partner_id", "date_order", "amount_total", "state", "invoice_status", "invoice_ids"]);
  const ocPids = [...new Set(ocs.map((o) => m2o(o.partner_id)).filter((p) => p && !vat[p]))];
  if (ocPids.length) for (const p of await ex("res.partner", "read", [ocPids], { fields: ["vat"] }) as Rec[]) vat[p.id] = digitos(p.vat);
  const facturaDe: Record<number, string> = Object.fromEntries(moves.map((x) => [x.id, x.name]));
  const compras_odoo = ocs.map((o) => ({ name: o.name, cuit: vat[m2o(o.partner_id)] || "", proveedor: o.partner_id?.[1] || "", fecha: String(o.date_order).slice(0, 10),
    total: o.amount_total, estado: o.state, facturacion: o.invoice_status, facturas: (o.invoice_ids || []).map((i: number) => facturaDe[i] || ("id " + i)) }));
  // historial de cuentas por CUIT (12 meses): cómo se cargó antes a cada proveedor
  const hl = await leerTodo("account.move.line", [["move_id.move_type", "=", "in_invoice"], ["move_id.state", "=", "posted"], ["display_type", "=", "product"],
    ["company_id", "=", C], ["date", ">=", iso(addDays(ini, -365))]], ["partner_id", "account_id", "product_id"]);
  const hp = [...new Set(hl.map((l) => m2o(l.partner_id)).filter((p) => p && !vat[p]))];
  if (hp.length) for (const p of await ex("res.partner", "read", [hp], { fields: ["vat"] }) as Rec[]) vat[p.id] = digitos(p.vat);
  const cuenta: Record<string, Record<string, number>> = {};
  for (const l of hl) {
    const c = vat[m2o(l.partner_id)]; if (!c) continue;
    const k = (l.account_id?.[1] || "") + "||" + (l.product_id?.[1] || "");
    (cuenta[c] ||= {})[k] = (cuenta[c][k] || 0) + 1;
  }
  const historial: Rec = {};
  for (const [c, ks] of Object.entries(cuenta)) {
    const [k, n] = Object.entries(ks).sort((a, b) => b[1] - a[1])[0];
    const [cta, prod] = k.split("||");
    historial[c] = { cuenta: cta, producto: prod, veces: n, total: Object.values(ks).reduce((a, b) => a + b, 0) };
  }
  return { ok: true, mes, compras, odoo, compras_odoo, historial, vendedores: vend.data || [], decisiones: dec.data || [], categorias: CATS };
}

async function cargar(sb: any, body: Rec) {
  const c = body.comp || {}; const dry = !!body.dry_run;
  const doc = DOC[String(c.cod)];
  if (!doc) return { ok: false, error: `Tipo de comprobante ${c.cod} no soportado acá (solo facturas y NC A, B y C)` };
  if (body.categoria === "envases") return { ok: false, error: "Los envases van con pedido de compra (es mercadería que entra al depósito): cargalos desde Compras de Odoo." };
  const cat = CATS[String(body.categoria)];
  if (!cat) return { ok: false, error: "Elegí la categoría" };
  const cuit = digitos(c.cuit);
  if (cuit.length !== 11) return { ok: false, error: "CUIT inválido" };
  const numero = `${String(c.pv).padStart(5, "0")}-${String(c.num).padStart(8, "0")}`;
  const nombre = `${doc.pref} ${numero}`;
  const total = r2(Math.abs(+c.total || 0)), iva = r2(Math.abs(+c.iva || 0)), neto = r2(Math.abs(+c.neto || 0)), nograv = r2(Math.abs(+c.nograv || 0)), otros = r2(Math.abs(+c.otros || 0));
  if (!total) return { ok: false, error: "Total en cero" };
  if (doc.letra === "A" && Math.abs(r2(neto + nograv + iva + otros) - total) > 0.01) return { ok: false, error: `Los importes de ARCA no cierran: neto ${neto} + no grav. ${nograv} + IVA ${iva} + otros ${otros} ≠ total ${total}` };
  if (doc.letra !== "A" && otros) return { ok: false, error: `Factura ${doc.letra} con "otros tributos" por $${otros}: cargala a mano.` };
  const detalle = String(body.detalle || cat.label).slice(0, 250);
  const importePago = body.pago?.importe != null ? r2(Math.min(+body.pago.importe, total)) : total;

  // proveedor
  const ya = await ex("res.partner", "search_read", [[["vat", "in", [cuitFmt(cuit), cuit]]]], { fields: ["id", "name"], context: { active_test: false }, limit: 1 }) as Rec[];
  let partner: number | null = ya.length ? ya[0].id : null;
  // Duplicados (pedido de Diego 10-nov): mismo número (cualquier proveedor, por si el contacto está duplicado),
  // y cualquier BORRADOR del proveedor o por el mismo importe (un borrador puede no tener número todavía).
  const mismoNumero = await ex("account.move", "search_read", [[["name", "=", nombre], ["move_type", "=", doc.nc ? "in_refund" : "in_invoice"], ["state", "!=", "cancel"]]], { fields: ["id", "name", "state", "amount_total", "partner_id"] }) as Rec[];
  const delProveedor = mismoNumero.filter((m) => !partner || m2o(m.partner_id) === partner);
  if (delProveedor.length) return delProveedor[0].state === "draft"
    ? { ok: false, error: `Ya hay un BORRADOR de ${nombre} en Odoo (id ${delProveedor[0].id}): revisalo y validalo ahí, no se crea otro.` }
    : { ok: true, ya_cargada: true, move: delProveedor[0] };
  if (mismoNumero.length) return { ok: false, error: `${nombre} ya está cargado con OTRO proveedor (${mismoNumero[0].partner_id?.[1]}): revisá el contacto antes de cargarlo.` };
  const borr = await ex("account.move", "search_read", [[["move_type", "in", ["in_invoice", "in_refund"]], ["state", "=", "draft"], ["company_id", "=", C],
    "|", ["partner_id", "=", partner || 0], ["amount_total", "=", total]]], { fields: ["id", "name", "partner_id", "amount_total"] }) as Rec[];
  if (borr.length) return { ok: false, error: `Hay un BORRADOR en Odoo que puede ser este comprobante (id ${borr[0].id}, ${borr[0].partner_id?.[1] || "sin proveedor"}, ${borr[0].amount_total}): resolvelo antes para no duplicar.` };
  // ¿va por Compras? (envases / materias primas con trazabilidad): una OC del proveedor por el mismo importe (±$1)
  if (partner && !doc.nc) {
    const oc = await ex("purchase.order", "search_read", [[["partner_id", "=", partner], ["state", "in", ["purchase", "done", "sent", "to approve"]],
      ["amount_total", ">=", total - 1], ["amount_total", "<=", total + 1],
      ["date_order", ">=", iso(addDays(new Date(c.fecha + "T12:00:00Z"), -60)) + " 00:00:00"], ["date_order", "<=", iso(addDays(new Date(c.fecha + "T12:00:00Z"), 15)) + " 23:59:59"]]],
      { fields: ["name", "invoice_status", "invoice_ids"], order: "date_order desc", limit: 1 }) as Rec[];
    if (oc.length) return oc[0].invoice_status === "invoiced"
      ? { ok: false, error: `Esta compra está en Compras (${oc[0].name}) y la OC ya tiene factura: revisá el número en Odoo antes de cargar otra.` }
      : { ok: false, error: `Esta compra está en Compras (${oc[0].name}): generá la factura DESDE la orden de compra para no duplicar ni perder la trazabilidad.` };
  }
  const parecidas = partner ? await ex("account.move", "search_read", [[["partner_id", "=", partner], ["move_type", "=", doc.nc ? "in_refund" : "in_invoice"], ["state", "=", "posted"], ["amount_total", "=", total]]], { fields: ["name", "invoice_date"] }) as Rec[] : [];
  // impuestos del renglón
  let taxIva: number | null = null;
  if (doc.letra === "A" && iva) {
    const r = neto ? iva / neto : 0;
    taxIva = Math.abs(r - 0.21) < 0.002 ? TAX.iva21 : Math.abs(r - 0.105) < 0.002 ? TAX.iva105 : Math.abs(r - 0.27) < 0.002 ? TAX.iva27 : null;
    if (!taxIva) return { ok: false, error: `El IVA ($${iva}) no corresponde a una sola alícuota sobre el neto ($${neto}): tiene varias alícuotas, cargala a mano.` };
  }
  // percepciones: ARCA solo da el total; se copia el desglose de una factura del MISMO proveedor con la misma percepción
  let perc: { tax: number; importe: number }[] = [];
  if (otros) {
    if (!partner) return { ok: false, error: `Trae percepciones por $${otros} que ARCA no detalla por jurisdicción y el proveedor no tiene facturas previas: cargala con "Percepciones (cargar)", que lee el PDF.` };
    const prev = await ex("account.move", "search_read", [[["partner_id", "=", partner], ["move_type", "in", ["in_invoice", "in_refund"]], ["state", "=", "posted"]]], { fields: ["id", "name"], order: "invoice_date desc", limit: 40 }) as Rec[];
    for (const p of prev) {
      const tl = await ex("account.move.line", "search_read", [[["move_id", "=", p.id], ["display_type", "=", "tax"]]], { fields: ["tax_line_id", "balance"] }) as Rec[];
      const pl = tl.filter((l) => l.tax_line_id && !TAX_IVA.has(m2o(l.tax_line_id)));
      if (pl.length && Math.abs(r2(pl.reduce((s, l) => s + Math.abs(l.balance), 0)) - otros) <= 0.005) { perc = pl.map((l) => ({ tax: m2o(l.tax_line_id), importe: r2(Math.abs(l.balance)) })); break; }
    }
    if (!perc.length) return { ok: false, error: `Trae percepciones por $${otros} que ARCA no detalla por jurisdicción: cargala con "Percepciones (cargar)", que lee el PDF.` };
  }
  const prod = await ex("product.product", "search_read", [[["default_code", "=", cat.code]]], { fields: ["id"], context: { active_test: false } }) as Rec[];
  if (prod.length !== 1) return { ok: false, error: "No encuentro el producto " + cat.code };
  const lineas: Rec[] = doc.letra === "A"
    ? [{ product_id: prod[0].id, account_id: cat.account, name: detalle, quantity: 1, price_unit: neto, tax_ids: [[6, 0, [...(taxIva ? [taxIva] : [TAX.noGravado]), ...perc.map((p) => p.tax)]]] },
       ...(nograv ? [{ product_id: prod[0].id, account_id: cat.account, name: detalle + " (no gravado)", quantity: 1, price_unit: nograv, tax_ids: [[6, 0, [TAX.noGravado]]] }] : [])]
    : [{ product_id: prod[0].id, account_id: cat.account, name: detalle, quantity: 1, price_unit: total, tax_ids: [[6, 0, [TAX.noAplica]]] }];
  const plan = { comprobante: nombre, proveedor: partner ? ya[0].name : `ALTA: ${c.denom} (${cuitFmt(cuit)})`, cuenta: cat.label, total, iva, percepciones: perc,
    pago: !doc.nc && body.pago?.fecha && importePago > 0 ? `Mercado Pago ${body.pago.fecha} $${importePago}${importePago < total ? ` (quedan $${r2(total - importePago)} abiertos: se devolvió sin NC)` : ""}` : doc.nc ? "NC: se concilia con su factura" : "sin pago (anulada por NC)",
    aviso: parecidas.length ? `Ojo: ya hay ${parecidas.map((p) => `${p.name} del ${p.invoice_date}`).join(", ")} del mismo proveedor por el mismo importe (puede ser una compra repetida; verificá que sea otro comprobante).` : null };
  if (dry) return { ok: true, dry_run: true, plan };

  if (!partner) partner = await ex("res.partner", "create", [{ name: String(c.denom || cuitFmt(cuit)).trim(), vat: cuitFmt(cuit), is_company: /^3/.test(cuit), country_id: COUNTRY_AR,
    l10n_latam_identification_type_id: ID_CUIT, l10n_ar_afip_responsibility_type_id: doc.letra === "C" ? 6 : 1, supplier_rank: 1 }]) as number;
  const id = await ex("account.move", "create", [{ move_type: doc.nc ? "in_refund" : "in_invoice", partner_id: partner, journal_id: J_COMPRAS,
    l10n_latam_document_type_id: doc.id, l10n_latam_document_number: numero, invoice_date: c.fecha, date: c.fecha, company_id: C,
    invoice_line_ids: lineas.map((l) => [0, 0, l]) }]) as number;
  const sg = doc.nc ? -1 : 1; // en la NC los impuestos van al haber y el proveedor al debe
  const leer = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  let ls = await leer();
  if (perc.length) {
    const cmds: unknown[] = [];
    for (const p of perc) {
      const l = ls.find((x) => m2o(x.tax_line_id) === p.tax);
      if (!l) return { ok: false, error: "Odoo no generó la línea de la percepción " + p.tax + "; quedó en BORRADOR", id };
      cmds.push([1, l.id, { balance: sg * p.importe, amount_currency: sg * p.importe }]);
    }
    const tt = ls.find((x) => x.display_type === "payment_term");
    cmds.push([1, tt.id, { balance: -sg * total, amount_currency: -sg * total }]);
    await ex("account.move", "write", [[id], { line_ids: cmds }]);
    ls = await leer();
  }
  const sumTax = (pred: (t: number) => boolean) => r2(Math.abs(ls.filter((l) => l.tax_line_id && pred(m2o(l.tax_line_id))).reduce((s, l) => s + l.balance, 0)));
  const chk = {
    total: r2(Math.abs(ls.filter((l) => l.display_type === "payment_term").reduce((s, l) => s + l.balance, 0))),
    iva: sumTax((t) => TAX_IVA.has(t)), percepciones: sumTax((t) => !TAX_IVA.has(t)),
    debe: r2(ls.reduce((s, l) => s + l.debit, 0)), haber: r2(ls.reduce((s, l) => s + l.credit, 0)),
  };
  if (chk.total !== total || chk.iva !== iva || chk.percepciones !== otros || chk.debe !== chk.haber)
    return { ok: false, error: `No cerró al centavo contra ARCA (Odoo total ${chk.total} / IVA ${chk.iva} / perc ${chk.percepciones}): quedó en BORRADOR para revisar`, id, chk };
  await ex("account.move", "action_post", [[id]]);
  const ctx = { active_model: "account.move", active_ids: [id] };
  const nm = (await ex("account.move", "read", [[id], ["name"]]) as Rec[])[0].name;
  let pago: Rec | null = null;
  if (!doc.nc && body.pago?.fecha && importePago > 0) {
    // se paga lo que realmente salió de Mercado Pago; si es menos que la factura (devolución sin NC), el resto queda abierto a la vista
    const wid = await ex("account.payment.register", "create", [{ journal_id: J_MP, payment_method_line_id: PML_MP_OUT, payment_date: body.pago.fecha, amount: importePago, communication: nm,
      ...(importePago < total ? { payment_difference_handling: "open" } : {}) }], { context: ctx }) as number;
    await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
    pago = { diario: "Mercado Pago", fecha: body.pago.fecha, importe: importePago, queda_abierto: r2(total - importePago) };
  }
  if (doc.nc) {
    // NC de una compra cancelada: se concilia con la factura abierta del mismo proveedor por el mismo importe
    const fa = await ex("account.move", "search_read", [[["partner_id", "=", partner], ["move_type", "=", "in_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]], ["amount_residual", "=", total]]], { fields: ["id", "name"], order: "invoice_date asc", limit: 1 }) as Rec[];
    const lp = (await ex("account.move.line", "search_read", [[["move_id", "=", id], ["display_type", "=", "payment_term"], ["reconciled", "=", false]]], { fields: ["id"] }) as Rec[])[0];
    if (fa.length && lp) { await ex("account.move", "js_assign_outstanding_line", [[fa[0].id], lp.id]); pago = { concilia_con: fa[0].name }; }
  }
  const fin = (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_residual", "payment_state", "partner_id"]]) as Rec[])[0];
  await sb.from("compras_ml_decisiones").upsert({ clave: `${cuit}|${nombre}`, categoria: body.categoria, nota: body.nota || null, odoo_move_id: id, odoo_move_name: fin.name, actualizado_en: new Date().toISOString() });
  return { ok: true, comprobante: fin, chk, pago };
}

// ── guardia de acceso de Core (sesión, service role, x-cron-key o clave de conector) ──
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
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
    return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), { status: 401, headers: cors });
  };
  return (Deno.serve as any)(...args);
}

_servirConGuardia(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as Rec;
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const modo = String(body.modo || "datos");
    let out: Rec;
    if (modo === "datos") out = await datos(sb, body);
    else if (modo === "cargar") out = await cargar(sb, body);
    else if (modo === "aprender") {
      const cuit = digitos(body.cuit);
      if (cuit.length !== 11 || !body.seller_id) throw new Error("Falta CUIT o vendedor");
      const { error } = await sb.from("compras_ml_vendedores").upsert({ cuit, seller_id: body.seller_id, nickname: body.nickname || null, razon_social: body.razon_social || null, actualizado_en: new Date().toISOString() });
      if (error) throw new Error(error.message);
      out = { ok: true };
    } else if (modo === "decidir") {
      if (!body.clave) throw new Error("Falta la clave del comprobante");
      const { error } = await sb.from("compras_ml_decisiones").upsert({ clave: body.clave, categoria: body.categoria || null, nota: body.nota || null, actualizado_en: new Date().toISOString() });
      if (error) throw new Error(error.message);
      out = { ok: true };
    } else throw new Error("Modo desconocido: " + modo);
    return new Response(JSON.stringify(out), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 });
  }
});
