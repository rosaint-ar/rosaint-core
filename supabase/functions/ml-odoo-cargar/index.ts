import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// v17 (6-oct-2026): separa el cupón DEL VENDEDOR (order.coupon, baja tu precio → frena) del cupón de la PLATAFORMA
//      (payments[].coupon_amount: lo paga ML/MP, el precio de venta no cambia → se carga igual y se anota). Antes frenaba ambos.
// ═══ ml-odoo-cargar (v16) — carga ventas de Mercado Libre en Odoo, POR PACK ═══
// v16: contexto Odoo SOLO empresa 2 (VELAZQUEZ). RST Cosmetics (1) se dio de baja -> pedir [1,2] tiraba
//      "Acceso a empresas no autorizadas" y frenaba TODA la carga. v15: cancelaciones. v14: candado.
// v13: auto+bitacora. v12: localidad related. v11: FLEX. v10: date_order. CORTE 01/09. Una venta=un pack.
// Modos: listar | preview | cargar[,reemplazar_so_id][,forzar] | auto | set_marcadores | backfill_ref[,overwrite][,limpiar]

const ML_API = "https://api.mercadolibre.com";
const ML_TOKEN_URL = `${ML_API}/oauth/token`;
const SELLER = 157540060;
const DESDE = "2026-09-01";
const ODOO_URL = Deno.env.get("ODOO_URL")!, ODOO_DB = Deno.env.get("ODOO_DB")!, ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!, ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY = 2, COUNTRY_AR = 10, TAX_IVA21_VENTAS = 187, PAYMENT_ML = 41, PAYMENT_TERM_CONTADO = 1, SOURCE_ML = 15, FLEX_TAG = 20;
// FECHA DE DESPACHO (23/10/2026): las etiquetas Hoy / 1 dia / 2-3 dias (crm.tag 2, 4, 5) se
// reemplazaron por la "Fecha de entrega" nativa del pedido (sale.order.commitment_date). Odoo la
// muestra en el listado de ventas como pildora de color (Hoy, Manana, 2-3 dias, Programado,
// Atrasado) que se calcula sola con el calendario, asi que ya no hay que "mover" nada cada dia.
// Aca se escribe la fecha de despacho que impone Mercado Libre (expected_date del SLA). La unica
// etiqueta que sigue tocando este conector es FLEX (20). Listo (21) y Entrega parcial (22) no.
const ID_TYPE: Record<string, number> = { DNI: 5, CUIT: 4, CUIL: 6 };
const AFIP: Record<string, number> = { "consumidor final": 5, "iva responsable inscripto": 1, "responsable monotributo": 6, "monotributo": 6, "iva sujeto exento": 4, "sujeto exento": 4 };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function mlToken(sb: any): Promise<string> {
  const { data: auth } = await sb.from("ml_auth").select("*").eq("id", 1).single();
  if (!auth?.refresh_token) throw new Error("Falta refresh token de ML.");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: Deno.env.get("ML_APP_ID")!, client_secret: Deno.env.get("ML_SECRET")!, refresh_token: auth.refresh_token });
  const r = await fetch(ML_TOKEN_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const d = await r.json(); if (!r.ok) throw new Error("No se pudo renovar token ML: " + JSON.stringify(d));
  await sb.from("ml_auth").update({ access_token: d.access_token, refresh_token: d.refresh_token, token_expira_en: new Date(Date.now() + (d.expires_in ?? 21600) * 1000).toISOString(), actualizado_en: new Date().toISOString() }).eq("id", 1);
  return d.access_token;
}
let MLTOK = "";
async function mlGet(path: string, headers: any = {}) { const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${MLTOK}`, ...headers } }); if (!r.ok) return null; return await r.json(); }

// --- FACTURA DE ODOO -> MERCADO LIBRE ---
// Odoo NO guarda el PDF de la factura hasta que alguien la imprime o la envia: verificado el
// 07/10/2026, las facturas de ML estaban posted y con CAE pero con 0 adjuntos. Asi que:
// 1) si el PDF ya esta guardado se usa ese; 2) si no, se le pide a Odoo el PDF oficial abriendo
// una SESION WEB (el /jsonrpc no sabe hacer PDFs, y los metodos que los generan no se pueden
// llamar por RPC porque empiezan con guion bajo).
function esPDF(b: Uint8Array) { return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; }
function deBase64(t: string) { const bin = atob(t); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

// La clave de API de Odoo NO sirve para abrir una sesion web: /web/session/authenticate contesta
// "Access Denied" (probado 07/10/2026). Entonces /report/pdf no es alcanzable y el PDF hay que
// hacerlo generar a Odoo con su propio asistente Enviar e imprimir, eligiendo SOLO el metodo
// "manual" (descargar): asi arma el PDF oficial y lo deja adjunto en la factura, SIN mandar mail.
async function generarPdfEnOdoo(moveId: number): Promise<void> {
  const ctx = { active_model: "account.move", active_ids: [moveId], default_move_id: moveId };
  const wid = await exec("account.move.send.wizard", "create", [{ move_id: moveId, sending_methods: ["manual"] }], { context: ctx }) as number;
  await exec("account.move.send.wizard", "action_send_and_print", [[wid]], { context: ctx });
}

async function pdfFactura(moveId: number, permitirGenerar: boolean): Promise<{ bytes: Uint8Array; via: string; nombre: string } | null> {
  const leer = async () => (await exec("account.move", "read", [[moveId], ["name", "invoice_pdf_report_id"]], {}) as any[])[0] || {};
  let mv = await leer();
  const nombre = String(mv.name || ("factura-" + moveId)).replace(/[^A-Za-z0-9._-]+/g, "-") + ".pdf";
  let via = "el PDF que Odoo ya tenia guardado";
  if (!mv.invoice_pdf_report_id) {
    if (!permitirGenerar) return null;
    await generarPdfEnOdoo(moveId);
    mv = await leer();
    via = "PDF generado ahora por Odoo";
  }
  if (!mv.invoice_pdf_report_id) throw new Error("Odoo no dejo el PDF adjunto despues de generarlo");
  const att = (await exec("ir.attachment", "read", [[mv.invoice_pdf_report_id[0]], ["datas"]], {}) as any[])[0];
  if (!att?.datas) throw new Error("El adjunto de la factura vino vacio");
  const bytes = deBase64(String(att.datas));
  if (!esPDF(bytes)) throw new Error("El adjunto de la factura no es un PDF");
  return { bytes, via, nombre };
}

// El upload es multipart con el campo fiscal_document. El Content-Type lo pone fetch con su
// boundary: ponerlo a mano rompe el envio.
async function subirFiscal(packId: string, bytes: Uint8Array, nombre: string) {
  const fd = new FormData();
  fd.append("fiscal_document", new Blob([bytes], { type: "application/pdf" }), nombre);
  const r = await fetch(`${ML_API}/packs/${packId}/fiscal_documents`, {
    method: "POST", headers: { Authorization: `Bearer ${MLTOK}` }, body: fd,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Mercado Libre contesto ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch (_) { return {}; }
}
// Sube a Mercado Libre las facturas de las ventas recientes que todavia no la tienen cargada.
// PISO DURO: nada anterior a FACTURAS_DESDE. Decision de Diego el 07/10/2026: el historico de
// septiembre no se toca, porque ML le manda notificacion y mail al comprador por CADA factura
// que se carga, y avisar ahora de una compra de hace un mes confunde mas de lo que ayuda.
const FACTURAS_DESDE = "2026-10-01";
async function subirFacturasPendientes(sb: any, dias = 20, tope = 5) {
  const piso = [FACTURAS_DESDE, fechaAR(-dias)].sort().pop() as string;   // la mas reciente de las dos
  const sos = await exec("sale.order", "search_read", [[["source_id", "=", SOURCE_ML], ["company_id", "=", COMPANY],
    ["client_order_ref", "!=", false], ["invoice_status", "=", "invoiced"], ["date_order", ">=", piso + " 00:00:00"]],
    ["id", "name", "client_order_ref", "amount_total", "invoice_ids"]], { limit: 100, order: "id desc" }) as any[];
  const detalle: string[] = []; const fallos: string[] = [];
  const salteadas = { ya_en_ml: 0, sin_emitir: 0, varias_facturas: 0, ya_registrada: 0 };
  if (!sos.length) return { desde: piso, revisadas: 0, subidas: 0, salteadas, detalle, fallos };
  // Las que ya constan subidas en la bitacora no se vuelven a consultar en ML (ahorra llamadas).
  const refs = sos.map((x: any) => String(x.client_order_ref));
  const yaSet = new Set<string>();
  try {
    const { data } = await sb.from("ml_odoo_bitacora").select("pack_id").eq("resultado", "factura_subida").in("pack_id", refs);
    for (const r of (data || [])) yaSet.add(String(r.pack_id));
  } catch (_) { }
  let subidas = 0;
  for (const so of sos) {
    if (subidas >= tope) break;
    const pack = String(so.client_order_ref);
    if (yaSet.has(pack)) { salteadas.ya_registrada++; continue; }
    const facturas = (so.invoice_ids || []) as number[];
    if (facturas.length !== 1) { salteadas.varias_facturas++; continue; }   // se elige a mano con factura_ml
    try {
      const inv = (await exec("account.move", "read", [[facturas[0]],
        ["name", "state", "move_type", "amount_total", "l10n_ar_afip_auth_code"]], {}) as any[])[0] || {};
      if (inv.state !== "posted" || inv.move_type !== "out_invoice" || !inv.l10n_ar_afip_auth_code) { salteadas.sin_emitir++; continue; }
      if (Math.abs(Number(inv.amount_total) - Number(so.amount_total)) > 0.5) {
        fallos.push(`${so.name}: la factura no coincide con la venta`); continue;
      }
      const enML = await mlGet(`/packs/${pack}/fiscal_documents`);
      const docs = ((enML && enML.fiscal_documents) || []) as any[];
      if (docs.some((d) => String(d.file_type || "").toLowerCase().includes("pdf"))) { yaSet.add(pack); salteadas.ya_en_ml++; continue; }
      const pdf = await pdfFactura(facturas[0], true);
      if (!pdf) { fallos.push(`${so.name}: no pude obtener el PDF`); continue; }
      if (pdf.bytes.length > 1024 * 1024) { fallos.push(`${so.name}: el PDF pesa mas de 1 MB`); continue; }
      await subirFiscal(pack, pdf.bytes, pdf.nombre);
      subidas++; detalle.push(`${so.name}: ${inv.name}`);
      try {
        await sb.from("ml_odoo_bitacora").insert([{ pack_id: pack, so_name: so.name, total: Number(inv.amount_total),
          resultado: "factura_subida", detalle: `${inv.name} subida a Mercado Libre.` }]);
      } catch (_) { }
    } catch (e) { fallos.push(`${so.name}: ${String((e as Error).message || e).slice(0, 160)}`); }
  }
  // Un fallo callado deja de subir facturas sin que nadie se entere: queda en la bitacora.
  if (fallos.length) {
    try { await sb.from("ml_odoo_bitacora").insert([{ resultado: "factura_falla", detalle: fallos.join(" | ").slice(0, 480) }]); } catch (_) { }
  }
  return { desde: piso, revisadas: sos.length, subidas, salteadas, detalle, fallos };
}
// De la referencia de la venta (pack_id) al order_id que sirve de semilla. Cuando la venta es de
// un solo item el pack_id ES el order_id y /packs contesta 404: ahi se usa la referencia directo.
async function semillaDeRef(ref: string): Promise<string> {
  const pk = await mlGet(`/packs/${ref}`);
  const prim = ((pk && pk.orders) || [])[0];
  return prim && prim.id ? String(prim.id) : ref;
}

// AUDITORIA: compara renglon por renglon lo que quedo en Odoo contra lo que dice Mercado Libre.
// Es la condicion que puso Diego para animarse a confirmar las ventas solas: tiene que coincidir
// TODO y al centavo, porque de esa info sale el armado del pedido.
// En ML la venta en Odoo son SOLO renglones de producto: no hay envio ni recompensas (a diferencia
// del conector de Tienda Nube), asi que cualquier renglon de mas es una diferencia.
const CENTAVO = 0.011;   // un centavo, con margen para el redondeo binario
// El mismo documento puede estar como DNI o como CUIT (el CUIT lleva el DNI adentro).
const nucleo = (v: unknown) => { const d = soloDig(v); return d.length === 11 ? d.slice(2, 10) : d; };

async function auditarVenta(so: any) {
  const ref = String(so.client_order_ref);
  const p = await armarPack(await semillaDeRef(ref));
  const difs: string[] = [];
  const lins = await exec("sale.order.line", "search_read", [[["order_id", "=", so.id]],
    ["product_id", "product_uom_qty", "price_unit", "name", "display_type"]], { limit: 60 }) as any[];
  const reales = lins.filter((l: any) => !l.display_type);   // sin secciones ni notas
  const pids = [...new Set(reales.map((l: any) => l.product_id && l.product_id[0]).filter(Boolean))] as number[];
  const prods = pids.length ? await exec("product.product", "read", [pids, ["default_code"]], {}) as any[] : [];
  const codigoDe: Record<number, string> = {};
  for (const pr of prods) codigoDe[pr.id] = String(pr.default_code || "");
  const cod = (l: any) => (l.product_id ? codigoDe[l.product_id[0]] : "") || "";

  // cliente
  const par = (await exec("res.partner", "read", [[so.partner_id[0]], ["vat", "name"]], {}) as any[])[0] || {};
  if (nucleo(par.vat) !== nucleo(p.cliente.documento)) {
    difs.push(`documento: Odoo ${par.vat || "(vacio)"} vs ML ${p.cliente.documento || "(vacio)"}`);
  }
  // cada producto de ML tiene que estar en Odoo con la misma cantidad y el mismo precio
  for (const l of p.lineas) {
    const enOdoo = reales.filter((x: any) => cod(x) === l.sku);
    if (!enOdoo.length) { difs.push(`falta en Odoo el producto ${l.sku} (${l.titulo})`); continue; }
    const qty = enOdoo.reduce((a: number, x: any) => a + Number(x.product_uom_qty || 0), 0);
    if (Math.abs(qty - Number(l.qty)) > 0.001) difs.push(`${l.sku}: cantidad Odoo ${qty} vs ML ${l.qty}`);
    const pu = Number(enOdoo[0].price_unit || 0);
    if (Math.abs(pu - Number(l.precio)) > CENTAVO) difs.push(`${l.sku}: precio Odoo $${pu} vs ML $${l.precio}`);
  }
  // y no puede haber nada de mas
  for (const x of reales) {
    if (!p.lineas.some((l: any) => l.sku === cod(x))) difs.push(`en Odoo sobra el renglon ${cod(x) || x.name}`);
  }
  // el total, al centavo
  const tOdoo = Number(so.amount_total || 0), tML = Number(p.total || 0);
  if (Math.abs(tOdoo - tML) > CENTAVO) difs.push(`TOTAL: Odoo $${tOdoo} vs ML $${tML} (difieren $${(tOdoo - tML).toFixed(2)})`);
  // lo que el propio armado ya marca como para revisar
  if (p.cupon > 0) difs.push(`cupon del vendedor $${p.cupon}`);
  for (const l of p.lineas) if (!l.product_id) difs.push(`SKU sin producto en Odoo: ${l.sku}`);
  return { so: so.name, pack_id: ref, difs, total_odoo: tOdoo, total_ml: tML, renglones: p.lineas.length };
}
// Confirma borradores de ML que pasen la auditoria EN EL MOMENTO. Si algo no coincide al centavo
// con Mercado Libre, esa venta no se toca y queda anotado el motivo. Condicion de Diego
// (13/10/2026): de esta info sale el armado del pedido, asi que o esta perfecta o no se confirma.
// hacer=false solo ensaya.
async function confirmarPendientes(sb: any, dias: number, tope: number, hacer: boolean, soFiltro?: string) {
  const desde = fechaAR(-dias);
  const dom: unknown[] = [["source_id", "=", SOURCE_ML], ["company_id", "=", COMPANY],
    ["client_order_ref", "!=", false], ["state", "=", "draft"]];
  if (soFiltro) dom.push(["name", "=", soFiltro]);
  else dom.push(["date_order", ">=", desde + " 00:00:00"]);
  const sos = await exec("sale.order", "search_read", [dom,
    ["id", "name", "client_order_ref", "amount_total", "partner_id", "state"]], { limit: tope, order: "id asc" }) as any[];
  const confirmadas: any[] = []; const frenadas: any[] = []; const errores: string[] = [];
  for (const so of sos) {
    try {
      const r = await auditarVenta(so);
      if (r.difs.length) { frenadas.push({ so: r.so, motivos: r.difs }); continue; }
      if (!hacer) { confirmadas.push({ so: r.so, total: r.total_odoo, ensayo: true }); continue; }
      await exec("sale.order", "action_confirm", [[so.id]], {});
      const ya = (await exec("sale.order", "read", [[so.id], ["name", "state"]], {}) as any[])[0] || {};
      confirmadas.push({ so: ya.name, total: r.total_odoo, estado: ya.state });
      try {
        await sb.from("ml_odoo_bitacora").insert([{ pack_id: r.pack_id, so_name: ya.name, total: r.total_odoo,
          resultado: "confirmada", detalle: `Confirmada sola: la auditoria contra Mercado Libre dio 0 diferencias (${r.renglones} renglones).` }]);
      } catch (_) { }
    } catch (e) { errores.push(`${so.name}: ${String((e as Error).message || e).slice(0, 200)}`); }
  }
  // Lo frenado y lo que falla tienen que quedar anotados: si no, una venta que no cuadra
  // desaparece del radar y nadie se entera.
  if (hacer && (frenadas.length || errores.length)) {
    try {
      await sb.from("ml_odoo_bitacora").insert([{ resultado: "confirmar_frenada",
        detalle: [...frenadas.map((x: any) => `${x.so}: ${x.motivos.join("; ")}`), ...errores].join(" | ").slice(0, 480) }]);
    } catch (_) { }
  }
  return { revisadas: sos.length, confirmadas: confirmadas.length, frenadas: frenadas.length, errores, detalle: confirmadas, no_confirmadas: frenadas };
}
let _uid: number | null = null;
async function odooCall(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }) });
  const j = await r.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error)); return j.result;
}
async function odooAuth() { if (_uid) return _uid; _uid = await odooCall("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number; if (!_uid) throw new Error("Auth Odoo fallida"); return _uid; }
async function exec(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await odooAuth(); kwargs.context = { allowed_company_ids: [COMPANY], lang: "es_ES", ...((kwargs.context as any) || {}) };
  return await odooCall("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}

const soloDig = (s: string) => String(s || "").replace(/\D/g, "");
const titleCase = (s: string) => String(s || "").trim().split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
function fmtVat(tipo: string, num: string): string[] { const n = soloDig(num); if (!n) return []; if (tipo === "DNI") { return [n.replace(/\B(?=(\d{3})+(?!\d))/g, "."), n]; } if (tipo === "CUIT" || tipo === "CUIL") { const c = n.length === 11 ? `${n.slice(0,2)}-${n.slice(2,10)}-${n.slice(10)}` : n; return [c, n]; } return [n]; }
let _prodCache: Record<string, number> | null = null;
async function productoPorSku(skus: string[]): Promise<Record<string, number>> { if (!_prodCache) { const res = await exec("product.product", "search_read", [[["default_code", "!=", false]], ["id", "default_code"]], { limit: 5000 }) as any[]; _prodCache = {}; for (const p of res) _prodCache[String(p.default_code)] = p.id; } const out: Record<string, number> = {}; for (const s of skus) out[s] = _prodCache[s]; return out; }
async function buscarPartner(tipo: string, num: string): Promise<number | null> { const vats = fmtVat(tipo, num); if (!vats.length) return null; const dom: unknown[] = []; vats.forEach((v, i) => { if (i > 0) dom.unshift("|"); dom.push(["vat", "=", v]); }); const ids = await exec("res.partner", "search", [dom], { limit: 1 }) as number[]; return ids[0] || null; }
function mapAfip(desc: string): number { return AFIP[(desc || "").toLowerCase().trim()] ?? 5; }
function stateId(code: string, states: Record<string, number>): number | false { const c = String(code || "").replace(/^AR-/, ""); return states[c] || false; }
let _states: Record<string, number> | null = null;
async function estadosAR(): Promise<Record<string, number>> { if (_states) return _states; const res = await exec("res.country.state", "search_read", [[["country_id", "=", COUNTRY_AR]], ["id", "code"]], { limit: 60 }) as any[]; _states = {}; for (const s of res) _states[String(s.code)] = s.id; return _states; }
function fechaOdoo(iso: string): string | false { if (!iso) return false; const d = new Date(iso); if (isNaN(d.getTime())) return false; return d.toISOString().slice(0, 19).replace("T", " "); }
// Fecha en Argentina (UTC-3, sin horario de verano) como yyyy-mm-dd. Identico a ml-despacho:
// las dos piezas leen el MISMO dato (expected_date del SLA) y lo comparan igual, asi la etiqueta
// nunca puede contradecir a la tarjeta "A despachar hoy". Ver rosaint-ml-despacho.
function fechaAR(offsetDias = 0): string {
  return new Date(Date.now() - 3 * 3600 * 1000 + offsetDias * 86400000).toISOString().slice(0, 10);
}
// Traduce el SLA de ML a la fecha de despacho del pedido. Devuelve null si ML todavia no la da.
// "odoo" va en UTC (asi guarda Odoo los datetime): el SLA viene con offset -03:00, asi que el dia
// argentino se conserva. "dia" es el yyyy-mm-dd argentino y "dias" cuanto falta desde hoy (AR).
function etiquetaDe(sla: string): { odoo: string; dia: string; nombre: string; dias: number } | null {
  const s = String(sla || "").trim();
  const exp = s.slice(0, 10);
  if (!exp) return null;
  const t = Date.parse(s.length > 10 ? s : exp + "T12:00:00-03:00");
  // exp ya viene en hora argentina (ML lo manda con offset -03:00), asi que comparar las dos
  // fechas como medianoche UTC da la diferencia de dias limpia, sin lio de zonas.
  const a = Date.parse(exp + "T00:00:00Z"), b = Date.parse(fechaAR(0) + "T00:00:00Z");
  if (isNaN(a) || isNaN(b) || isNaN(t)) return null;
  const dias = Math.round((a - b) / 86400000);
  const nombre = dias < 0 ? "atrasada" : dias === 0 ? "hoy" : dias === 1 ? "manana" : dias <= 3 ? "2-3 dias" : "programada";
  return { odoo: new Date(t).toISOString().slice(0, 19).replace("T", " "), dia: exp, nombre, dias };
}
// Lo que se escribe en el pedido: FLEX (agregar o sacar) y la fecha de despacho si ML ya la dio.
function tagsDe(p: any): unknown[] { return [p.flex ? [4, FLEX_TAG] : [3, FLEX_TAG]]; }
function valsDespacho(p: any): Record<string, unknown> {
  const v: Record<string, unknown> = { tag_ids: tagsDe(p) };
  if (p.etiqueta) v.commitment_date = p.etiqueta.odoo;
  return v;
}

async function armarPack(seedId: string) {
  const seed = await mlGet(`/orders/${seedId}`); if (!seed) throw new Error(`Orden/pack ML ${seedId} no encontrado`);
  const packId = String(seed.pack_id || seed.id); let ordenes = [seed];
  if (seed.pack_id) { const pk = await mlGet(`/packs/${packId}`); const otras = ((pk?.orders) || []).map((o: any) => String(o.id)).filter((id: string) => id !== String(seed.id)); for (const id of otras) { const o = await mlGet(`/orders/${id}`); if (o) ordenes.push(o); } }
  const primary = ordenes[0];
  let flex = false, full = false, sla = "";
  const sid = primary.shipping?.id;
  if (sid) {
    try {
      const sh = await mlGet(`/shipments/${sid}`, { "x-format-new": "true" });
      const lt = sh?.logistic?.type || sh?.logistic_type || "";
      flex = lt === "self_service";
      full = lt === "fulfillment";   // lo despacha ML desde su deposito: no hay nada que preparar aca
    } catch (_) { }
    // La fecha de despacho sale del SLA del envio (expected_date). El lead_time viene con nulos:
    // esa leccion ya la pago ml-despacho. En Full no se pide: no hay nada que despachar desde aca.
    if (!full) { try { const sl = await mlGet(`/shipments/${sid}/sla`); sla = String(sl?.expected_date || ""); } catch (_) { } }
  }
  const etiqueta = etiquetaDe(sla);
  const bi = await mlGet(`/orders/${primary.id}/billing_info`, { "x-version": "2" }); const b = bi?.buyer?.billing_info || {}; const ident = b.identification || {};
  const tipoDoc = String(ident.type || "DNI").toUpperCase();
  const nombre = [b.name, b.last_name].filter(Boolean).join(" ").trim() || (primary.buyer?.nickname ?? "Consumidor Final ML");
  const addr = b.address || {}; const cond = b.taxes?.taxpayer_type?.description || "Consumidor Final";
  const items: any[] = [];
  for (const o of ordenes) for (const it of (o.order_items || [])) items.push({ sku: String(it.item?.seller_sku || "").trim(), titulo: it.item?.title || "", qty: it.quantity || 0, precio: it.unit_price || 0 });
  const skuMap = await productoPorSku(items.map((i) => i.sku).filter(Boolean));
  const lineas = items.map((i) => ({ ...i, product_id: skuMap[i.sku] || null }));
  const total = ordenes.reduce((a, o) => a + (o.total_amount || 0), 0);
  const suma_lineas = items.reduce((a, i) => a + i.precio * i.qty, 0);
  // cupón del vendedor: baja el precio que cobrás (frena la carga). Cupón de ML/MP: lo paga la plataforma al comprador.
  const cupon_vendedor = ordenes.reduce((a, o) => a + (o.coupon?.amount || 0), 0);
  const cupon_plataforma = ordenes.reduce((a, o) => a + (o.payments || []).reduce((x: number, p: any) => x + (p.coupon_amount || 0), 0), 0);
  // si el total de la orden no coincide con la suma de los productos, algo cambió el precio: se trata como cupón propio
  const cupon = cupon_vendedor + (Math.abs(total - suma_lineas) > 0.5 ? Math.abs(total - suma_lineas) : 0);
  return { pack_id: packId, order_ids: ordenes.map((o) => String(o.id)), fecha: primary.date_created, total, cupon, cupon_plataforma, suma_lineas, flex, full, sla, etiqueta,
    cliente: { nombre, tipo_doc: tipoDoc, documento: soloDig(ident.number || ""), condicion_afip: cond, localidad: titleCase(addr.city_name || ""), provincia_code: addr.state?.code || "", provincia_nombre: addr.state?.name || "", cp: addr.zip_code || "" }, lineas };
}
async function yaCargada(packId: string): Promise<number | null> { const ids = await exec("sale.order", "search", [[["client_order_ref", "=", String(packId)], ["company_id", "=", COMPANY]]], { limit: 1 }) as number[]; return ids[0] || null; }
async function partnerDe(p: any): Promise<number> {
  const partnerId = await buscarPartner(p.cliente.tipo_doc, p.cliente.documento);
  if (partnerId) {
    try { const cur = await exec("res.partner", "read", [[partnerId], ["city"]], {}) as any[]; const c = cur[0]?.city; if (c && c !== titleCase(c)) await exec("res.partner", "write", [[partnerId], { city: titleCase(c) }]); } catch (_) { }
    return partnerId;
  }
  const states = await estadosAR(); const [vatFmt] = fmtVat(p.cliente.tipo_doc, p.cliente.documento);
  return await exec("res.partner", "create", [{ name: p.cliente.nombre, company_type: "person", customer_rank: 1, vat: vatFmt || false, l10n_latam_identification_type_id: ID_TYPE[p.cliente.tipo_doc] || 5, l10n_ar_afip_responsibility_type_id: mapAfip(p.cliente.condicion_afip), country_id: COUNTRY_AR, state_id: stateId(p.cliente.provincia_code, states), city: p.cliente.localidad || false, zip: p.cliente.cp || false }], {}) as number;
}
async function crearBorrador(p: any, reSo: number | null) {
  const partnerId = await partnerDe(p);
  const linesAdd = p.lineas.map((l: any) => [0, 0, { product_id: l.product_id, product_uom_qty: l.qty, price_unit: l.precio, tax_id: [[6, 0, [TAX_IVA21_VENTAS]]] }]);
  const vals: any = { partner_id: partnerId, company_id: COMPANY, client_order_ref: p.pack_id, date_order: fechaOdoo(p.fecha), payment_term_id: PAYMENT_TERM_CONTADO, x_studio_mtodo_de_pago_2: PAYMENT_ML, source_id: SOURCE_ML };
  let soId: number;
  if (reSo) { await exec("sale.order", "write", [[reSo], { ...vals, order_line: [[5, 0, 0], ...linesAdd] }]); soId = reSo; }
  else { soId = await exec("sale.order", "create", [{ ...vals, order_line: linesAdd }], {}) as number; }
  // FLEX y la fecha de despacho van en un write APARTE, DESPUES del create. Metidas en los valores
  // del create no quedan: comprobado el 07/10/2026 con las etiquetas (S01335/37/38/39), y el mismo
  // comando por write si las escribe.
  try { await exec("sale.order", "write", [[soId], valsDespacho(p)]); } catch (_) { }
  const so = await exec("sale.order", "read", [[soId], ["name", "amount_total"]], {}) as any[];
  return { so_id: soId, so_name: so[0]?.name, total_odoo: so[0]?.amount_total, total_coincide: Math.abs((so[0]?.amount_total || 0) - (p.total || 0)) < 0.5, partner_id: partnerId };
}
async function packsPendientes(): Promise<Array<{ pack_id: string; order_id: string; fecha: string }>> {
  const orders: any[] = [];
  for (let p = 0; p < 4; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=paid&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length - 1].date_created || "") < DESDE) break; }
  const packMap: Record<string, { order_id: string; fecha: string }> = {};
  for (const o of orders) { if ((o.date_created || "") < DESDE) continue; const pid = String(o.pack_id || o.id); if (!packMap[pid] || (o.date_created || "") < packMap[pid].fecha) packMap[pid] = { order_id: String(o.id), fecha: o.date_created }; }
  const pids = Object.keys(packMap); if (!pids.length) return [];
  const existing = await exec("sale.order", "search_read", [[["client_order_ref", "in", pids], ["company_id", "=", COMPANY]], ["client_order_ref"]], {}) as any[];
  const setC = new Set(existing.map((e) => String(e.client_order_ref)));
  return pids.filter((pid) => !setC.has(pid)).map((pid) => ({ pack_id: pid, order_id: packMap[pid].order_id, fecha: packMap[pid].fecha })).sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
}
// De la referencia de la venta (el pack_id) a la fecha de despacho, sin rearmar el pack entero.
// Cuando la venta es de un solo item el pack_id ES el order_id y /packs contesta 404: se usa directo.
async function slaDeRef(ref: string): Promise<{ sla: string; full: boolean }> {
  const oid = await semillaDeRef(ref);
  const o = await mlGet(`/orders/${oid}`);
  const sid = o && o.shipping && o.shipping.id;
  if (!sid) return { sla: "", full: false };
  const sh = await mlGet(`/shipments/${sid}`, { "x-format-new": "true" });
  const lt = (sh && (sh.logistic?.type || sh.logistic_type)) || "";
  if (lt === "fulfillment") return { sla: "", full: true };   // lo despacha ML, no hay nada que preparar
  const sl = await mlGet(`/shipments/${sid}/sla`);
  return { sla: String((sl && sl.expected_date) || ""), full: false };
}

// REPASO DE FECHAS DE DESPACHO. Al cargarse la venta a los SEGUNDOS de la compra, Mercado Libre
// todavia puede no tener la fecha de despacho (lo vimos el 07/10/2026), asi que hay que volver a
// buscarla. Ya NO hace falta "mover" nada con el calendario: la pildora de Odoo pasa sola de
// "2-3 dias" a "Manana" y a "Hoy". Lo que si se revisa es si ML corrio la fecha.
// Candidatos: ventas de ML sin entregar ni cancelar de los ultimos 45 dias. Para no gastar
// llamadas, la que ya tiene fecha de hoy o anterior no se vuelve a consultar (ya es urgente).
async function repararEtiquetas(dias = 45, tope = 12) {
  const desde = fechaAR(-dias);
  const sos = await exec("sale.order", "search_read", [[["source_id", "=", SOURCE_ML], ["company_id", "=", COMPANY],
    ["state", "!=", "cancel"], ["client_order_ref", "!=", false], ["date_order", ">=", desde + " 00:00:00"]],
    ["id", "name", "client_order_ref", "tag_ids", "delivery_status", "commitment_date"]], { limit: 100, order: "id desc" }) as any[];
  const detalle: string[] = []; const fallos: string[] = [];
  let etiquetadas = 0, revisadas = 0, enHoy = 0;
  const mananaUTC = fechaAR(1) + " 03:00:00";   // medianoche de manana en Argentina, en UTC
  for (const so of sos) {
    if (etiquetadas >= tope) break;
    if (so.delivery_status === "full") continue;   // ya se entrego: no hay nada que preparar
    const puesta = so.commitment_date ? String(so.commitment_date) : "";
    if (puesta && puesta < mananaUTC) { enHoy++; continue; }   // ya es de hoy o atrasada: no se consulta
    revisadas++;
    try {
      const { sla, full } = await slaDeRef(String(so.client_order_ref));
      if (full) continue;
      const et = etiquetaDe(sla);
      if (!et || (puesta && puesta.slice(0, 13) === et.odoo.slice(0, 13))) continue;   // ML todavia no da fecha, o ya esta la correcta
      const tags = Array.isArray(so.tag_ids) ? so.tag_ids as number[] : [];
      await exec("sale.order", "write", [[so.id], valsDespacho({ flex: tags.includes(FLEX_TAG), etiqueta: et })]);
      etiquetadas++;
      detalle.push(`${so.name}: ${puesta ? "ML corrio la fecha a " : "despacho "}${et.dia} (${et.nombre})`);
    } catch (e) { fallos.push(`${so.name}: ${String((e as Error).message || e).slice(0, 140)}`); }
  }
  return { revisadas, etiquetadas, en_hoy: enHoy, detalle, fallos };
}
async function packsCancelados(): Promise<string[]> {
  const orders: any[] = [];
  for (let p = 0; p < 3; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=cancelled&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length - 1].date_created || "") < DESDE) break; }
  const packs = new Set<string>();
  for (const o of orders) { if ((o.date_created || "") < DESDE) continue; packs.add(String(o.pack_id || o.id)); }
  return [...packs];
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

_servirConGuardia(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({})) as any; const modo = body.modo || "listar"; MLTOK = await mlToken(sb);

    // Recalcula y escribe SOLO la fecha de despacho (y FLEX) de una venta ya cargada (no toca nada mas).
    // Se niega si la fecha de despacho ya paso: una venta vieja ya despachada no tiene que
    // aparecer como "Hoy". Con forzar:true se escribe igual.
    // SUBIR LA FACTURA DE ODOO A LA VENTA EXACTA DE MERCADO LIBRE.
    // POST /packs/{pack_id}/fiscal_documents - multipart, campo fiscal_document, PDF de hasta 1 MB,
    // UNO por pack (si ya hay, ML contesta 409). El enlace a la venta exacta es el pack_id, que el
    // conector ya guarda en client_order_ref desde que carga la venta.
    // OJO: al cargar la factura, MERCADO LIBRE LE MANDA AL COMPRADOR UNA NOTIFICACION Y UN MAIL.
    // Por eso sin confirmar:true esto solo ENSAYA (resuelve la factura, consigue el PDF, mira ML).
    // Corre el lote a pedido (para ponerse al dia). dias y tope configurables; el piso duro
    // FACTURAS_DESDE manda igual, asi que nunca toca ventas anteriores.
    // Estado de las facturas para la pantalla del Core (Canales -> ML -> Facturas). SOLO LECTURA.
    // Las que ya constan subidas en la bitacora no se consultan en ML; del resto se consultan
    // hasta 12 por vez (cada una es una llamada a ML) y las demas quedan sin_revisar.
    // Audita los borradores de ML contra Mercado Libre, SIN TOCAR NADA. Es el paso previo a
    // confirmar ventas solas: primero hay que ver que coincida todo, al centavo.
    // Confirma borradores de ML, pero SOLO los que pasan la auditoria en el momento: si algo no
    // coincide al centavo con Mercado Libre, esa venta no se toca y se dice por que. Condicion que
    // puso Diego (13/10/2026): de esta info sale el armado del pedido, asi que o esta perfecta o no
    // se confirma. Sin confirmar:true solo ensaya y no escribe nada.
    if (modo === "confirmar_ventas") {
      const r = await confirmarPendientes(sb, Number(body.dias ?? 20), Number(body.tope ?? 20),
        body.confirmar === true, body.so ? String(body.so) : undefined);
      return new Response(JSON.stringify({ ok: true, ensayo: body.confirmar !== true, ...r }), { headers: cors });
    }

    if (modo === "auditar") {
      const dias = Number(body.dias ?? 20);
      const desde = fechaAR(-dias);
      const dom: unknown[] = [["source_id", "=", SOURCE_ML], ["company_id", "=", COMPANY], ["client_order_ref", "!=", false]];
      if (body.so) dom.push(["name", "=", String(body.so)]);
      else { dom.push(["state", "=", "draft"]); dom.push(["date_order", ">=", desde + " 00:00:00"]); }
      const sos = await exec("sale.order", "search_read", [dom,
        ["id", "name", "client_order_ref", "amount_total", "partner_id", "state"]], { limit: Number(body.tope ?? 20), order: "id desc" }) as any[];
      const iguales: any[] = []; const con_difs: any[] = []; const errores: string[] = [];
      for (const so of sos) {
        try {
          const r = await auditarVenta(so);
          if (r.difs.length) con_difs.push(r); else iguales.push({ so: r.so, total: r.total_odoo, renglones: r.renglones });
        } catch (e) { errores.push(`${so.name}: ${String((e as Error).message || e).slice(0, 160)}`); }
      }
      return new Response(JSON.stringify({ ok: true, desde, revisadas: sos.length,
        coinciden: iguales.length, con_diferencias: con_difs.length, errores, difs: con_difs, iguales }), { headers: cors });
    }

    if (modo === "facturas_estado") {
      const dias = Number(body.dias ?? 20);
      const piso = [FACTURAS_DESDE, fechaAR(-dias)].sort().pop() as string;
      const sos = await exec("sale.order", "search_read", [[["source_id", "=", SOURCE_ML], ["company_id", "=", COMPANY],
        ["client_order_ref", "!=", false], ["date_order", ">=", piso + " 00:00:00"]],
        ["name", "client_order_ref", "date_order", "amount_total", "invoice_ids", "partner_id"]],
        { limit: 120, order: "id desc" }) as any[];
      const ids = sos.flatMap((x: any) => (x.invoice_ids || []) as number[]);
      const invs = ids.length ? await exec("account.move", "read", [ids,
        ["name", "state", "move_type", "amount_total", "l10n_ar_afip_auth_code"]], {}) as any[] : [];
      const porId: Record<number, any> = {}; for (const v of invs) porId[v.id] = v;
      const refs = sos.map((x: any) => String(x.client_order_ref));
      const yaSet = new Set<string>();
      try {
        const { data } = await sb.from("ml_odoo_bitacora").select("pack_id").eq("resultado", "factura_subida").in("pack_id", refs);
        for (const r of (data || [])) yaSet.add(String(r.pack_id));
      } catch (_) { }
      let consultas = 0; const ventas: any[] = [];
      for (const so of sos) {
        const pack = String(so.client_order_ref);
        const fs = (so.invoice_ids || []) as number[];
        const inv = fs.length === 1 ? porId[fs[0]] : null;
        let estado = "sin_facturar"; let motivo = "";
        if (fs.length > 1) { estado = "varias"; motivo = fs.length + " facturas: hay que elegir a mano"; }
        else if (!inv || inv.move_type !== "out_invoice") { estado = "sin_facturar"; }
        else if (inv.state !== "posted") { estado = "sin_facturar"; motivo = "la factura esta en " + inv.state; }
        else if (!inv.l10n_ar_afip_auth_code) { estado = "sin_cae"; motivo = "sin CAE de ARCA"; }
        else if (Math.abs(Number(inv.amount_total) - Number(so.amount_total)) > 0.5) { estado = "no_cuadra"; motivo = "la factura no coincide con la venta"; }
        else if (yaSet.has(pack)) { estado = "subida"; }
        else if (consultas < 12) {
          consultas++;
          const enML = await mlGet(`/packs/${pack}/fiscal_documents`);
          const docs = ((enML && enML.fiscal_documents) || []) as any[];
          estado = docs.some((d) => String(d.file_type || "").toLowerCase().includes("pdf")) ? "en_ml" : "pendiente";
        } else { estado = "sin_revisar"; }
        ventas.push({ so: so.name, pack_id: pack, fecha: so.date_order,
          cliente: Array.isArray(so.partner_id) ? so.partner_id[1] : "", total: Number(so.amount_total),
          factura: inv ? inv.name : null, cae: inv ? inv.l10n_ar_afip_auth_code : null, estado, motivo });
      }
      return new Response(JSON.stringify({ ok: true, desde: piso, ventas }), { headers: cors });
    }

    if (modo === "facturas_pendientes") {
      // Toma el MISMO candado que el auto: si no, las dos corridas se pisan y una venta se sube dos veces.
      const viejoF = new Date(Date.now() - 180000).toISOString();
      const { data: gotF } = await sb.from("ml_odoo_lock").update({ running: true, since: new Date().toISOString() })
        .eq("id", 1).or(`running.eq.false,since.lt.${viejoF}`).select();
      if (!gotF || !gotF.length) return new Response(JSON.stringify({ ok: true, skip: "hay otra corrida en curso" }), { headers: cors });
      try {
        const r = await subirFacturasPendientes(sb, Number(body.dias ?? 20), Number(body.tope ?? 5));
        return new Response(JSON.stringify({ ok: true, ...r }), { headers: cors });
      } finally { try { await sb.from("ml_odoo_lock").update({ running: false, since: new Date().toISOString() }).eq("id", 1); } catch (_) { } }
    }

    if (modo === "factura_ml") {
      const packPedido = String(body.pack_id || "").trim();
      const soPedida = String(body.so || "").trim();
      if (!packPedido && !soPedida) return new Response(JSON.stringify({ ok: false, error: "Falta pack_id o so" }), { headers: cors });
      const dom: unknown[] = packPedido ? [["client_order_ref", "=", packPedido]] : [["name", "=", soPedida]];
      const sos = await exec("sale.order", "search_read", [[...dom, ["company_id", "=", COMPANY]],
        ["id", "name", "client_order_ref", "state", "amount_total", "invoice_ids"]], { limit: 3 }) as any[];
      if (!sos.length) return new Response(JSON.stringify({ ok: false, error: "No encontre la venta en Odoo" }), { headers: cors });
      if (sos.length > 1) return new Response(JSON.stringify({ ok: false, error: "Hay mas de una venta con esa referencia: " + sos.map((x: any) => x.name).join(", ") }), { headers: cors });
      const so = sos[0];
      const packId = String(so.client_order_ref || "").trim();
      const facturas = (so.invoice_ids || []) as number[];
      if (!packId) return new Response(JSON.stringify({ ok: false, error: `${so.name} no tiene la referencia de Mercado Libre` }), { headers: cors });
      if (!facturas.length) return new Response(JSON.stringify({ ok: false, error: `${so.name} todavia no esta facturada`, so: so.name, pack_id: packId }), { headers: cors });
      if (facturas.length > 1) return new Response(JSON.stringify({ ok: false, error: `${so.name} tiene ${facturas.length} facturas: hay que elegir cual a mano`, facturas }), { headers: cors });
      const inv = (await exec("account.move", "read", [[facturas[0]],
        ["name", "state", "move_type", "amount_total", "invoice_date", "l10n_ar_afip_auth_code"]], {}) as any[])[0] || {};
      // Frenos: una sola factura de cliente, emitida, con CAE de ARCA y por el mismo importe que la venta.
      if (inv.state !== "posted") return new Response(JSON.stringify({ ok: false, error: `La factura ${inv.name} esta en "${inv.state}", no emitida`, so: so.name }), { headers: cors });
      if (inv.move_type !== "out_invoice") return new Response(JSON.stringify({ ok: false, error: `${inv.name} no es una factura de cliente (${inv.move_type})` }), { headers: cors });
      if (!inv.l10n_ar_afip_auth_code) return new Response(JSON.stringify({ ok: false, error: `${inv.name} no tiene CAE de ARCA` }), { headers: cors });
      if (Math.abs(Number(inv.amount_total) - Number(so.amount_total)) > 0.5) {
        return new Response(JSON.stringify({ ok: false, error: `Los totales no coinciden: factura $${inv.amount_total} vs venta $${so.amount_total}`, so: so.name, factura: inv.name }), { headers: cors });
      }
      const enML = await mlGet(`/packs/${packId}/fiscal_documents`);
      const docs = ((enML && enML.fiscal_documents) || []) as any[];
      const yaHayPdf = docs.some((d) => String(d.file_type || "").toLowerCase().includes("pdf"));
      // En el ensayo no se genera nada: solo se mira si el PDF ya esta. Generarlo deja el adjunto
      // en la factura y la marca como enviada en Odoo, asi que se hace al confirmar (o con generar:true).
      const pdf = await pdfFactura(facturas[0], body.confirmar === true || body.generar === true);
      const kb = pdf ? Math.round(pdf.bytes.length / 1024) : 0;
      const info: any = { so: so.name, pack_id: packId, factura: inv.name, fecha: inv.invoice_date,
        cae: inv.l10n_ar_afip_auth_code, total: inv.amount_total, pdf_kb: kb, pdf_via: pdf ? pdf.via : "todavia no hay PDF: hay que generarlo",
        ya_en_ml: docs.map((d) => ({ id: d.id, tipo: d.file_type, archivo: d.filename, fecha: d.date })) };
      if (pdf && pdf.bytes.length > 1024 * 1024) return new Response(JSON.stringify({ ok: false, error: `El PDF pesa ${kb} kB y Mercado Libre acepta hasta 1024 kB`, ...info }), { headers: cors });
      if (yaHayPdf) return new Response(JSON.stringify({ ok: true, ya_subida: true, msg: "Esa venta ya tiene la factura cargada en Mercado Libre", ...info }), { headers: cors });
      if (body.generar === true && body.confirmar !== true) {
        return new Response(JSON.stringify({ ok: true, solo_pdf: true, msg: "PDF listo en Odoo; no se subio a Mercado Libre", ...info }), { headers: cors });
      }
      if (!body.confirmar) {
        return new Response(JSON.stringify({ ok: true, ensayo: true, pdf_listo: !!pdf, ...info,
          aviso: "Al confirmar, Mercado Libre le manda al comprador una notificacion y un mail." }), { headers: cors });
      }
      if (!pdf) return new Response(JSON.stringify({ ok: false, error: "No pude obtener el PDF de la factura", ...info }), { headers: cors });
      const res = await subirFiscal(packId, pdf.bytes, pdf.nombre);
      try {
        await sb.from("ml_odoo_bitacora").insert([{ pack_id: packId, so_name: so.name, total: Number(inv.amount_total),
          resultado: "factura_subida", detalle: `${inv.name} (CAE ${inv.l10n_ar_afip_auth_code}, ${kb} kB) subida a Mercado Libre. ${pdf.via}.` }]);
      } catch (_) { }
      return new Response(JSON.stringify({ ok: true, subida: true, ids: (res && res.ids) || null, ...info }), { headers: cors });
    }

    if (modo === "etiquetar" || modo === "fecha_despacho") {
      const seed = String(body.order_id || "");
      if (!seed) return new Response(JSON.stringify({ ok: false, error: "Falta order_id" }), { headers: cors });
      const p = await armarPack(seed);
      const soId = await yaCargada(p.pack_id);
      if (!soId) return new Response(JSON.stringify({ ok: false, error: "Ese pack no esta cargado en Odoo", pack_id: p.pack_id }), { headers: cors });
      const cur = (await exec("sale.order", "read", [[soId], ["name", "state", "tag_ids", "delivery_status", "commitment_date"]], {}) as any[])[0] || {};
      if (cur.state === "cancel") return new Response(JSON.stringify({ ok: false, error: `${cur.name} esta cancelada`, so_id: soId }), { headers: cors });
      // Si ya se entrego no hay nada que preparar. (Visto con datos reales el 06/10: S01324/S01328/
      // S01329 estaban entregadas y su fecha de despacho era HOY.)
      if (!body.forzar && cur.delivery_status === "full") {
        return new Response(JSON.stringify({ ok: false, error: `${cur.name} ya esta entregada: no se le pone fecha (forzar:true para hacerlo igual)`,
          so: cur.name, so_id: soId, entrega: cur.delivery_status, fecha_antes: cur.commitment_date }), { headers: cors });
      }
      const dias = p.etiqueta ? p.etiqueta.dias : null;
      if (dias === null) {
        return new Response(JSON.stringify({ ok: false, error: "Mercado Libre todavia no da fecha de despacho",
          so: cur.name, so_id: soId, sla: p.sla, fecha_antes: cur.commitment_date }), { headers: cors });
      }
      await exec("sale.order", "write", [[soId], valsDespacho(p)]);
      const post = (await exec("sale.order", "read", [[soId], ["tag_ids", "commitment_date"]], {}) as any[])[0] || {};
      return new Response(JSON.stringify({ ok: true, so: cur.name, so_id: soId, pack_id: p.pack_id, sla: p.sla, dias,
        despacho: p.etiqueta, flex: p.flex, fecha_antes: cur.commitment_date, fecha_despues: post.commitment_date, etiquetas_despues: post.tag_ids }), { headers: cors });
    }

    if (modo === "set_marcadores") { const soId = Number(body.so_id); if (!soId) return new Response(JSON.stringify({ ok: false, error: "Falta so_id" }), { headers: cors }); await exec("sale.order", "write", [[soId], { source_id: SOURCE_ML, x_studio_mtodo_de_pago_2: PAYMENT_ML, payment_term_id: PAYMENT_TERM_CONTADO }]); const so = await exec("sale.order", "read", [[soId], ["name", "x_studio_origen"]], {}) as any[]; return new Response(JSON.stringify({ ok: true, so: so[0] }), { headers: cors }); }

    if (modo === "backfill_ref") {
      const pares = (body.pares || []) as Array<{ so_id: number; ref?: string }>;
      if (body.limpiar) { let limpiadas = 0; const errs: string[] = []; for (const pr of pares) { try { await exec("sale.order", "write", [[pr.so_id], { client_order_ref: false }]); limpiadas++; } catch (e) { errs.push(`${pr.so_id}: ${(e as Error).message}`); } } return new Response(JSON.stringify({ ok: true, limpiadas, errores: errs.slice(0, 20) }), { headers: cors }); }
      let escritas = 0, saltadas = 0; const errores: string[] = []; for (const pr of pares) { try { const cur = await exec("sale.order", "read", [[pr.so_id], ["client_order_ref"]], {}) as any[]; if (cur[0]?.client_order_ref && !body.overwrite) { saltadas++; continue; } await exec("sale.order", "write", [[pr.so_id], { client_order_ref: String(pr.ref) }]); escritas++; } catch (e) { errores.push(`${pr.so_id}: ${(e as Error).message}`); } } return new Response(JSON.stringify({ ok: true, escritas, saltadas, errores: errores.slice(0, 20) }), { headers: cors });
    }

    if (modo === "auto") {
      const cutoff = new Date(Date.now() - 120000).toISOString();
      const { data: got } = await sb.from("ml_odoo_lock").update({ running: true, since: new Date().toISOString() }).eq("id", 1).or(`running.eq.false,since.lt.${cutoff}`).select();
      if (!got || !got.length) return new Response(JSON.stringify({ ok: true, skip: "auto ya en ejecucion" }), { headers: cors });
      try {
        const pend = await packsPendientes();
        let cargadas = 0, revisar = 0, errores = 0, saltadas = 0, canceladas = 0; const bitac: any[] = []; const detalle: any[] = [];
        for (const it of pend) {
          try {
            if (await yaCargada(it.pack_id)) { saltadas++; continue; }
            const p = await armarPack(it.order_id);
            const faltan = p.lineas.filter((l: any) => !l.product_id);
            if (faltan.length) { revisar++; bitac.push({ pack_id: p.pack_id, cliente: p.cliente.nombre, total: p.total, resultado: "revisar", detalle: "SKU sin producto: " + faltan.map((f: any) => f.sku).join(",") }); }
            else if (p.cupon > 0) { revisar++; bitac.push({ pack_id: p.pack_id, cliente: p.cliente.nombre, total: p.total, resultado: "revisar", detalle: "cupón $" + p.cupon }); }
            else { const r = await crearBorrador(p, null); cargadas++; bitac.push({ pack_id: p.pack_id, so_name: r.so_name, cliente: p.cliente.nombre, total: p.total, resultado: "cargada", detalle: [r.total_coincide ? "" : "total no coincide", p.cupon_plataforma > 0 ? "cupón de ML/MP $" + p.cupon_plataforma + " (no afecta el precio)" : "", p.etiqueta ? "despacho " + p.etiqueta.dia + " (" + p.etiqueta.nombre + ")" : "sin fecha de despacho todavía: la pone el repaso"].filter(Boolean).join(" · ") }); detalle.push({ so_name: r.so_name, cliente: p.cliente.nombre, total: r.total_odoo }); }
          } catch (e) { errores++; bitac.push({ pack_id: it.order_id, resultado: "error", detalle: String((e as Error).message || e).slice(0, 250) }); }
        }
        // ── sweep de cancelaciones ──
        try {
          const cpacks = await packsCancelados();
          if (cpacks.length) {
            const sos = await exec("sale.order", "search_read", [[["client_order_ref", "in", cpacks], ["company_id", "=", COMPANY], ["state", "!=", "cancel"]], ["id", "name", "delivery_status", "client_order_ref"]], {}) as any[];
            for (const so of sos) {
              try {
                if (so.delivery_status === "full" || so.delivery_status === "partial") { revisar++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "revisar", detalle: "cancelada en ML pero tiene entrega — revisar/devolver a mano" }); }
                else { await exec("sale.order", "action_cancel", [[so.id]], {}); canceladas++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "cancelada", detalle: "cancelada en ML" }); }
              } catch (e) { errores++; bitac.push({ pack_id: so.client_order_ref, so_name: so.name, resultado: "error", detalle: "cancelar: " + String((e as Error).message || e).slice(0, 150) }); }
            }
          }
        } catch (_) { }
        // Confirma las que pasen la auditoria. Va ANTES de las facturas: la factura se arma sobre
        // la venta confirmada.
        let confirmar: any = { revisadas: 0, confirmadas: 0, frenadas: 0, errores: [], detalle: [] };
        try { confirmar = await confirmarPendientes(sb, 20, 5, true); } catch (_) { }
        if (confirmar.confirmadas) bitac.push({ resultado: "confirmada", detalle: "confirmadas solas: " + confirmar.detalle.map((x: any) => x.so).join(", ") });
        let facturas: any = { revisadas: 0, subidas: 0, detalle: [], fallos: [] };
        try { facturas = await subirFacturasPendientes(sb); } catch (_) { }
        if (facturas.subidas) bitac.push({ resultado: "etiquetada", detalle: "facturas subidas a ML: " + facturas.detalle.join(" · ") });
        let repaso: any = { revisadas: 0, etiquetadas: 0, detalle: [] };
        try {
          repaso = await repararEtiquetas();
          if (repaso.etiquetadas) bitac.push({ resultado: "etiquetada", detalle: "fechas de despacho puestas al repasar: " + repaso.detalle.join(" · ") });
          if (repaso.fallos && repaso.fallos.length) bitac.push({ resultado: "etiqueta_falla", detalle: repaso.fallos.join(" | ").slice(0, 480) });
        } catch (_) { }
        if (bitac.length) { try { await sb.from("ml_odoo_bitacora").insert(bitac); } catch (_) { } }
        return new Response(JSON.stringify({ ok: true, pendientes: pend.length, cargadas, canceladas, revisar, saltadas, errores, etiquetadas: repaso.etiquetadas, repaso, confirmadas: confirmar.confirmadas, confirmar, facturas_subidas: facturas.subidas, facturas, detalle }), { headers: cors });
      } finally { try { await sb.from("ml_odoo_lock").update({ running: false, since: new Date().toISOString() }).eq("id", 1); } catch (_) { } }
    }

    if (modo === "listar") {
      const orders: any[] = [];
      for (let p = 0; p < 4; p++) { const d = await mlGet(`/orders/search?seller=${SELLER}&order.status=paid&sort=date_desc&limit=50&offset=${p * 50}`); const res = (d?.results || []); for (const o of res) orders.push(o); if (res.length < 50) break; if (res.length && (res[res.length-1].date_created || "") < DESDE) break; }
      const packs: Record<string, any> = {};
      for (const o of orders) { if ((o.date_created || "") < DESDE) continue; const pid = String(o.pack_id || o.id); if (!packs[pid]) packs[pid] = { pack_id: pid, fecha: o.date_created, total: 0, items: 0, comprador: o.buyer?.nickname || "", order_id: String(o.id) }; packs[pid].total += o.total_amount || 0; packs[pid].items += (o.order_items || []).length; if ((o.date_created || "") < packs[pid].fecha) { packs[pid].fecha = o.date_created; packs[pid].order_id = String(o.id); } }
      const packIds = Object.keys(packs);
      const cargadas = packIds.length ? await exec("sale.order", "search_read", [[["client_order_ref", "in", packIds], ["company_id", "=", COMPANY]], ["client_order_ref", "name"]], {}) as any[] : [];
      const setC: Record<string, string> = {}; for (const c of cargadas) setC[String(c.client_order_ref)] = c.name;
      const lista = Object.values(packs).map((p: any) => ({ ...p, ya_cargada: !!setC[p.pack_id], so_name: setC[p.pack_id] || null })).sort((a: any, b: any) => (a.fecha || "").localeCompare(b.fecha || ""));
      return new Response(JSON.stringify({ ok: true, corte: DESDE, cantidad: lista.length, pendientes: lista.filter((x:any)=>!x.ya_cargada).length, packs: lista }), { headers: cors });
    }

    const seedId = String(body.pack_id || body.order_id || "");
    if (!seedId) return new Response(JSON.stringify({ ok: false, error: "Falta pack_id u order_id" }), { headers: cors });

    if (modo === "preview") {
      const p = await armarPack(seedId); const partnerId = await buscarPartner(p.cliente.tipo_doc, p.cliente.documento); const warnings: string[] = [];
      if ((p.fecha || "") < DESDE) warnings.push(`Compra anterior al corte (${DESDE}).`);
      for (const l of p.lineas) if (!l.product_id) warnings.push(`SKU sin producto en Odoo: ${l.sku || "(vacío)"} — ${l.titulo}`);
      if (p.cupon > 0) warnings.push(`Compra con cupón del vendedor $${p.cupon} — revisar el precio.`);
      if (p.cupon_plataforma > 0) warnings.push(`Cupón de ML/MP $${p.cupon_plataforma}: lo paga la plataforma, el precio de venta no cambia.`);
      const soId = await yaCargada(p.pack_id);
      return new Response(JSON.stringify({ ok: true, ...p, cliente_existe: !!partnerId, partner_id: partnerId, ya_cargada: !!soId, so_id: soId, warnings }), { headers: cors });
    }

    if (modo === "cargar") {
      const p = await armarPack(seedId);
      if ((p.fecha || "") < DESDE && !body.forzar) return new Response(JSON.stringify({ ok: false, error: `Compra anterior al corte ${DESDE}. forzar:true para cargar igual.`, fecha: p.fecha }), { headers: cors });
      const reSo = body.reemplazar_so_id ? Number(body.reemplazar_so_id) : null;
      if (!reSo) { const yaId = await yaCargada(p.pack_id); if (yaId) return new Response(JSON.stringify({ ok: true, ya_cargada: true, so_id: yaId, pack_id: p.pack_id, msg: "El pack ya estaba cargado" }), { headers: cors }); }
      const faltan = p.lineas.filter((l: any) => !l.product_id);
      if (faltan.length) return new Response(JSON.stringify({ ok: false, error: "Hay SKU sin producto en Odoo", faltan }), { headers: cors });
      if (p.cupon > 0 && !body.forzar) return new Response(JSON.stringify({ ok: false, error: `Compra con cupón $${p.cupon}. forzar:true para cargar.`, cupon: p.cupon }), { headers: cors });
      const r = await crearBorrador(p, reSo);
      return new Response(JSON.stringify({ ok: true, [reSo ? "reemplazada" : "creada"]: true, ...r, pack_id: p.pack_id, fecha: fechaOdoo(p.fecha), flex: p.flex, localidad: p.cliente.localidad, renglones: p.lineas.length, total_ml: p.total, cliente: p.cliente.nombre }), { headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: "modo invalido" }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
