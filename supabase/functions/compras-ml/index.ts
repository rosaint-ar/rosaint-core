import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// Padrón de ARCA (A5, con el certificado de Rosaint): se reusa la consulta del portal de altas, sin tocarla.
import { consultarArca } from "../portal-alta/arca.ts";
// PDF de los cargos de ML (streams Flate)
import { inflateSync, inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";
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
const C = 2, J_COMPRAS = 33, J_MP = 42, PML_MP_OUT = 22, PML_MP_IN = 21, COUNTRY_AR = 10, ID_CUIT = 4;
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

// ── Contactos con el formato de Diego (10-nov-2026) ─────────────────────────
// · Empresas: tipo oración (cada palabra con mayúscula, conectores en minúscula, acentos) y la sociedad abreviada
//   con puntos: "La Casa del Envase Plástico S.A.", "Papelera Todoplastic S.R.L.".
// · Personas: "Nombre Segundo-nombre Apellido" y, si sirve para identificarla, la marca entre paréntesis:
//   "José Levy (Pura Química)". El padrón separa apellido y nombre: no se adivina el orden.
// · Siempre el domicilio FISCAL del padrón: calle, localidad, código postal y provincia.
const MINUS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "con", "para", "por", "a"]);
const ACENTOS: Record<string, string> = {
  maria: "María", jose: "José", rodriguez: "Rodríguez", gonzalez: "González", martinez: "Martínez", lopez: "López", gomez: "Gómez",
  fernandez: "Fernández", perez: "Pérez", sanchez: "Sánchez", ramirez: "Ramírez", diaz: "Díaz", alvarez: "Álvarez", gimenez: "Giménez",
  jimenez: "Jiménez", benitez: "Benítez", hernandez: "Hernández", dominguez: "Domínguez", nuñez: "Núñez", nunez: "Núñez", suarez: "Suárez",
  vazquez: "Vázquez", velazquez: "Velázquez", gutierrez: "Gutiérrez", juarez: "Juárez", mendez: "Méndez", ruiz: "Ruiz", garcia: "García",
  belen: "Belén", ines: "Inés", ramon: "Ramón", martin: "Martín", julian: "Julián", sebastian: "Sebastián", lucia: "Lucía", sofia: "Sofía",
  angel: "Ángel", andres: "Andrés", ruben: "Rubén", german: "Germán", hector: "Héctor", oscar: "Óscar", victor: "Víctor", raul: "Raúl",
  joaquin: "Joaquín", agustin: "Agustín", nicolas: "Nicolás", tomas: "Tomás", matias: "Matías", ivan: "Iván", cesar: "César", adrian: "Adrián",
  quimica: "Química", quimicos: "Químicos", drogueria: "Droguería", electronica: "Electrónica", plastico: "Plástico", plasticos: "Plásticos",
  informatico: "Informático", informatica: "Informática", organizacion: "Organización", distribucion: "Distribución", logistica: "Logística",
  tecnologia: "Tecnología", comercializacion: "Comercialización", produccion: "Producción", argentina: "Argentina", union: "Unión",
  farmacia: "Farmacia", farmaceutica: "Farmacéutica", cosmetica: "Cosmética", industria: "Industria", fabrica: "Fábrica", grafica: "Gráfica",
  aguila: "Águila", electrica: "Eléctrica", optica: "Óptica", economica: "Económica", tecnica: "Técnica", medica: "Médica",
  damian: "Damián", fabian: "Fabián", junin: "Junín", peron: "Perón", lanus: "Lanús", catan: "Catán", dominico: "Domínico", velez: "Vélez",
  dean: "Deán", cordoba: "Córdoba", tucuman: "Tucumán", neuquen: "Neuquén", constitucion: "Constitución", belgrano: "Belgrano", rios: "Ríos",
  sarmiento: "Sarmiento", moron: "Morón", ituzaingo: "Ituzaingó",
  // marcas con mayúsculas propias
  eyg: "EyG",
};
const SOCIEDAD: [RegExp, string][] = [
  [/\bSOCIEDAD ANONIMA COMERCIAL E INDUSTRIAL\b/g, "S.A.C.I."], [/\bSOCIEDAD ANONIMA\b/g, "S.A."],
  [/\bSOCIEDAD DE RESPONSABILIDAD LIMITADA\b/g, "S.R.L."], [/\bSOCIEDAD POR ACCIONES SIMPLIFICADA\b/g, "S.A.S."],
  [/\bS\.?\s?R\.?\s?L\.?(?=\s|$)/g, "S.R.L."], [/\bS\.?\s?A\.?\s?S\.?(?=\s|$)/g, "S.A.S."], [/\bS\.?\s?A\.?\s?C\.?\s?I\.?(?=\s|$)/g, "S.A.C.I."],
  [/\bS\.?\s?A\.?(?=\s|$)/g, "S.A."], [/\bS\.?\s?C\.?(?=\s|$)/g, "S.C."],
];
function palabra(w: string, i: number): string {
  if (/^[A-Z]\.([A-Z]\.)+$/.test(w)) return w;                       // S.A., S.R.L.
  const l = w.toLowerCase();
  if (i > 0 && MINUS.has(l)) return l;
  if (/^[^aeiouáéíóú]{2,4}$/i.test(w) && /[A-Z]/.test(w)) return w.toUpperCase(); // siglas sin vocales (YPF)
  if (ACENTOS[l]) return ACENTOS[l];
  return l.split("-").map((p) => p ? p[0].toUpperCase() + p.slice(1) : p).join("-");
}
export function tipoOracion(s: string): string {
  let t = String(s || "").toUpperCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
  for (const [re, rep] of SOCIEDAD) t = t.replace(re, rep);
  return t.split(" ").map((w, i) => palabra(w, i)).join(" ");
}
function nombreProlijo(p: Rec, marca?: string): string {
  const marcaTxt = marca ? ` (${String(marca).trim()})` : "";
  if (p.apellido && !p.razon) return `${tipoOracion(p.nombre)} ${tipoOracion(p.apellido)}`.trim() + marcaTxt;
  return tipoOracion(p.razon || p.nombre_completo || "");
}
let ESTADOS: Rec[] | null = null;
const sinAcento = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
async function provinciaId(nombre: string): Promise<number | null> {
  if (!ESTADOS) ESTADOS = await ex("res.country.state", "search_read", [[["country_id", "=", COUNTRY_AR]]], { fields: ["id", "name"] }) as Rec[];
  const n = sinAcento(nombre);
  if (/CAPITAL FEDERAL|CIUDAD AUTONOMA/.test(n)) return (ESTADOS.find((e) => /CIUDAD AUTONOMA/.test(sinAcento(e.name))) || {}).id ?? null;
  return (ESTADOS.find((e) => sinAcento(e.name) === n) || ESTADOS.find((e) => sinAcento(e.name).startsWith(n)) || {}).id ?? null;
}
// Calle del padrón ("SANTA FE AV. 2830 Piso:1 Dpto:A") → "Av. Santa Fe 2830 Piso 1 Dpto. A"
function domicilioProlijo(dir: string): string {
  let t = tipoOracion(String(dir || "").replace(/\s+(PISO|DPTO|DEPTO|OF|OFICINA|LOCAL):\s*/gi, " $1 "));
  const av = t.match(/^(.*?)\s+(Av\.?|Avda\.?|Avenida)\s+(\d.*)$/i);
  if (av) t = `Av. ${av[1]} ${av[3]}`;
  return t.replace(/\bDpto\s+(\w+)/i, (_, d) => `Dpto. ${d.toUpperCase()}`).replace(/\bDepto\s+(\w+)/i, (_, d) => `Dpto. ${d.toUpperCase()}`).replace(/\s+/g, " ").trim();
}
const RESP_PADRON: Record<string, number> = { RI: 1, MONO: 6, EXENTO: 4 };
async function datosPadron(cuit: string): Promise<Rec> {
  const p = await consultarArca(cuit);
  if (!p?.ok || !p.existe) return { ok: false, error: p?.error || "ARCA no devolvió datos de " + cuit };
  const esCaba = /CAPITAL FEDERAL|CIUDAD AUTONOMA/.test(sinAcento(p.provincia || ""));
  return { ok: true, p, state_id: p.provincia ? await provinciaId(p.provincia) : null,
    street: p.domicilio ? domicilioProlijo(p.domicilio) : null,
    // en CABA el padrón no trae localidad: se usa "Capital Federal", como ya figura en los contactos
    city: p.localidad ? tipoOracion(p.localidad) : esCaba ? "Capital Federal" : null, zip: p.cp || null,
    resp: RESP_PADRON[p.iva] || null };
}

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
      // lo que salió de Mercado Pago: todos los pagos acreditados (incluye la percepción que cobra ML) menos lo devuelto
      const cobrados = (o.payments || []).filter((p: Rec) => ["approved", "refunded", "partially_refunded", "charged_back"].includes(p.status));
      out.push({
        id: String(o.id), pack: String(o.pack_id || o.id), fecha: String(o.date_created).slice(0, 10), status: o.status,
        seller_id: o.seller?.id, seller: o.seller?.nickname || "", total: o.total_amount,
        pagado: r2(cobrados.reduce((s: number, p: Rec) => s + (p.total_paid_amount || 0), 0)),
        devuelto: r2(cobrados.reduce((s: number, p: Rec) => s + (p.transaction_amount_refunded || 0), 0)),
        envio_en_pago: r2(cobrados.reduce((s: number, p: Rec) => s + (p.shipping_cost || 0), 0)),
        envio: 0, shipment: o.shipping?.id ? String(o.shipping.id) : null,
        fecha_pago: (cobrados[0]?.date_approved || o.date_created || "").slice(0, 10),
        items: (o.order_items || []).map((i: Rec) => ({ titulo: i.item?.title, cant: i.quantity, precio: i.unit_price, item_id: i.item?.id })),
      });
    }
    if (off + 50 >= (j.paging?.total || 0)) break;
  }
  // Envío que pagó el comprador y NO viene dentro del pago de la orden (verificado 10-nov: Mavima factura
  // ítems + envío; el envío se cobra aparte). Un envío es por pack: se cuenta UNA vez, en la primera orden.
  const porEnvio = new Map<string, Rec[]>();
  for (const o of out) if (o.shipment && o.status === "paid") { if (!porEnvio.has(o.shipment)) porEnvio.set(o.shipment, []); porEnvio.get(o.shipment)!.push(o); }
  const ids = [...porEnvio.keys()];
  for (let i = 0; i < ids.length; i += 6) {
    await Promise.all(ids.slice(i, i + 6).map(async (sid) => {
      try {
        const r = await fetch(`${ML_API}/shipments/${sid}`, { headers: { Authorization: "Bearer " + tok, "x-format-new": "true" } });
        if (!r.ok) return;
        const s = await r.json();
        const costo = +(s.lead_time?.cost ?? s.shipping_option?.cost ?? 0) || 0;
        const ords = porEnvio.get(sid)!;
        const yaEnPagos = ords.reduce((a, o) => a + o.envio_en_pago, 0);
        ords[0].envio = r2(Math.max(0, costo - yaEnPagos));
      } catch { /* sin dato de envío: se informa como diferencia */ }
    }));
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
  // como siempre: el pago va por el TOTAL de la factura, por Mercado Pago, con la MISMA fecha de la factura
  const importePago = total;
  const fechaPago = c.fecha;

  // proveedor
  const ya = await ex("res.partner", "search_read", [[["vat", "in", [cuitFmt(cuit), cuit]]]], { fields: ["id", "name"], context: { active_test: false }, limit: 1 }) as Rec[];
  let partner: number | null = ya.length ? ya[0].id : null;
  // Duplicados (pedido de Diego 10-nov): mismo número (cualquier proveedor, por si el contacto está duplicado),
  // y cualquier BORRADOR del proveedor o por el mismo importe (un borrador puede no tener número todavía).
  const mismoNumero = await ex("account.move", "search_read", [[["name", "=", nombre], ["move_type", "=", doc.nc ? "in_refund" : "in_invoice"], ["state", "!=", "cancel"]]], { fields: ["id", "name", "state", "amount_total", "partner_id", "create_date"] }) as Rec[];
  const delProveedor = mismoNumero.filter((m) => !partner || m2o(m.partner_id) === partner);
  // Un borrador del MISMO comprobante (proveedor + número), creado en las últimas 6 h y por el mismo importe (±$0,05)
  // es un intento anterior de esta carga que frenó por un control: se RETOMA en vez de crear otro.
  let retomar: number | null = null;
  if (delProveedor.length && delProveedor[0].state === "draft") {
    const b = delProveedor[0];
    const reciente = Date.now() - new Date(String(b.create_date).replace(" ", "T") + "Z").getTime() < 6 * 3600e3;
    if (reciente && Math.abs(b.amount_total - total) <= 0.05) retomar = b.id;
    else return { ok: false, error: `Ya hay un BORRADOR de ${nombre} en Odoo (id ${b.id}): revisalo y validalo ahí, no se crea otro.` };
  } else if (delProveedor.length) return { ok: true, ya_cargada: true, move: delProveedor[0] };
  if (mismoNumero.length && !retomar) return { ok: false, error: `${nombre} ya está cargado con OTRO proveedor (${mismoNumero[0].partner_id?.[1]}): revisá el contacto antes de cargarlo.` };
  const borr = await ex("account.move", "search_read", [[["move_type", "in", ["in_invoice", "in_refund"]], ["state", "=", "draft"], ["company_id", "=", C], ["id", "!=", retomar || 0],
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
  // Igual que como se cargaron siempre (verificado 10-nov sobre 15 facturas de compras de ML): UN renglón, cantidad 1,
  // la descripción que pone Odoo para el producto ([GN01] Gastos varios no operativos, [INS_EXP] Insumos de oficina…),
  // A al neto con su IVA; B y C por el total con "IVA No Aplica". Sin referencia ni nota.
  const lineas: Rec[] = doc.letra === "A"
    ? [{ product_id: prod[0].id, account_id: cat.account, quantity: 1, price_unit: neto, tax_ids: [[6, 0, [...(taxIva ? [taxIva] : [TAX.noGravado]), ...perc.map((p) => p.tax)]]] },
       ...(nograv ? [{ product_id: prod[0].id, account_id: cat.account, quantity: 1, price_unit: nograv, tax_ids: [[6, 0, [TAX.noGravado]]] }] : [])]
    : [{ product_id: prod[0].id, account_id: cat.account, quantity: 1, price_unit: total, tax_ids: [[6, 0, [TAX.noAplica]]] }];
  // NC de una compra cancelada: se crea como REVERSIÓN de la factura que anula (misma forma que el lote compras_b)
  let faAnulada: Rec | null = null;
  let ncPendiente = "";
  if (doc.nc) {
    const fa = partner ? await ex("account.move", "search_read", [[["partner_id", "=", partner], ["move_type", "=", "in_invoice"], ["state", "=", "posted"],
      ["payment_state", "=", "not_paid"], ["amount_total", "=", total]]], { fields: ["id", "name"], order: "invoice_date asc, id asc", limit: 1 }) as Rec[] : [];
    if (fa.length) faAnulada = fa[0];
    else if (dry && body.fa_en_lote) ncPendiente = String(body.fa_en_lote); // ensayo de un lote: la factura que anula se carga antes en el mismo lote
    else return { ok: false, error: `No encuentro la factura abierta de ${total} que anula esta NC: cargá primero esa factura (sin pago).` };
  }
  const plan: Rec = { comprobante: nombre, proveedor: partner ? ya[0].name : `ALTA: ${c.denom} (${cuitFmt(cuit)})`, cuenta: cat.label, total, iva, percepciones: perc,
    pago: !doc.nc && body.pago ? `Mercado Pago ${fechaPago} $${importePago}` : doc.nc ? `NC: reversión de ${faAnulada?.name || ncPendiente + " (se carga antes en este lote)"}, se concilian entre sí` : "sin pago (anulada por NC)",
    aviso: parecidas.length ? `Ojo: ya hay ${parecidas.map((p) => `${p.name} del ${p.invoice_date}`).join(", ")} del mismo proveedor por el mismo importe (puede ser una compra repetida; verificá que sea otro comprobante).` : null };
  // proveedor nuevo: el ensayo ya trae del padrón el nombre con el formato de Diego y el domicilio fiscal
  let alta: Rec | null = null;
  if (!partner) {
    alta = await datosPadron(cuit);
    if (!alta.ok) return { ok: false, error: `No pude consultar el padrón de ARCA para dar de alta a ${c.denom} (${alta.error}). Reintentá en un rato: el proveedor se crea con su domicilio fiscal.` };
    const persona = !!(alta.p.apellido && !alta.p.razon);
    plan.proveedor = `ALTA: ${nombreProlijo(alta.p, body.marca)} (${cuitFmt(cuit)})`;
    plan.alta = { nombre: nombreProlijo(alta.p, body.marca), persona, domicilio: [alta.street, alta.city, alta.zip, alta.p.provincia ? tipoOracion(alta.p.provincia) : null].filter(Boolean).join(" · ") };
  }
  if (dry) return { ok: true, dry_run: true, plan };

  // proveedor nuevo: como los de siempre (empresa, CUIT, responsabilidad según la letra), con el formato de Diego
  // y el domicilio FISCAL del padrón de ARCA. Sin padrón no se da de alta a medias.
  if (!partner && alta) {
    const d = alta;
    partner = await ex("res.partner", "create", [{ name: nombreProlijo(d.p, body.marca), vat: cuitFmt(cuit), is_company: true, country_id: COUNTRY_AR,
      street: d.street || false, city: d.city || false, zip: d.zip || false, state_id: d.state_id || false,
      l10n_latam_identification_type_id: ID_CUIT, l10n_ar_afip_responsibility_type_id: d.p.iva === "MONO" ? 6 : d.p.iva === "EXENTO" ? 4 : doc.letra === "C" ? 6 : 1, supplier_rank: 1 }]) as number;
  }
  const id: number = retomar ?? await ex("account.move", "create", [{ move_type: doc.nc ? "in_refund" : "in_invoice", partner_id: partner, journal_id: J_COMPRAS,
    l10n_latam_document_type_id: doc.id, l10n_latam_document_number: numero, invoice_date: c.fecha, date: c.fecha, company_id: C,
    ...(faAnulada ? { reversed_entry_id: faAnulada.id } : {}),
    invoice_line_ids: lineas.map((l) => [0, 0, l]) }]) as number;
  const sg = doc.nc ? -1 : 1; // en la NC los impuestos van al haber y el proveedor al debe
  const leer = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  let ls = await leer();
  // Ajustes para que quede IGUAL al comprobante (como se hace a mano en Odoo, editando el impuesto):
  //  · percepciones: el importe exacto de cada jurisdicción;
  //  · IVA: si el vendedor redondeó distinto (hasta $0,05), el IVA del comprobante.
  const cmds: unknown[] = [];
  for (const p of perc) {
    const l = ls.find((x) => m2o(x.tax_line_id) === p.tax);
    if (!l) return { ok: false, error: "Odoo no generó la línea de la percepción " + p.tax + "; quedó en BORRADOR", id };
    cmds.push([1, l.id, { balance: sg * p.importe, amount_currency: sg * p.importe }]);
  }
  const lIva = ls.filter((x) => x.tax_line_id && TAX_IVA.has(m2o(x.tax_line_id)));
  const ivaOdoo = r2(Math.abs(lIva.reduce((s, l) => s + l.balance, 0)));
  let ajusteIva = 0;
  if (iva && lIva.length === 1 && ivaOdoo !== iva) {
    ajusteIva = r2(iva - ivaOdoo);
    if (Math.abs(ajusteIva) > 0.05) return { ok: false, error: `El IVA de Odoo (${ivaOdoo}) difiere en ${ajusteIva} del comprobante (${iva}): más que un redondeo, quedó en BORRADOR`, id };
    cmds.push([1, lIva[0].id, { balance: sg * iva, amount_currency: sg * iva }]);
  }
  if (cmds.length) {
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
  if (!doc.nc && body.pago) {
    const wid = await ex("account.payment.register", "create", [{ journal_id: J_MP, payment_method_line_id: PML_MP_OUT, payment_date: fechaPago, amount: importePago, communication: nm }], { context: ctx }) as number;
    await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
    pago = { diario: "Mercado Pago", fecha: fechaPago, importe: importePago };
  }
  if (doc.nc && faAnulada) {
    // la NC (reversión) se concilia con la factura que anula: las dos quedan saldadas, sin movimiento de plata
    const lp = (await ex("account.move.line", "search_read", [[["move_id", "=", id], ["display_type", "=", "payment_term"], ["reconciled", "=", false]]], { fields: ["id"] }) as Rec[])[0];
    if (lp) await ex("account.move", "js_assign_outstanding_line", [[faAnulada.id], lp.id]);
    const st = (await ex("account.move", "read", [[faAnulada.id], ["payment_state", "amount_residual"]]) as Rec[])[0];
    pago = { concilia_con: faAnulada.name, estado_factura: st.payment_state, saldo_factura: st.amount_residual };
    if (st.amount_residual !== 0) return { ok: false, error: `La NC quedó cargada pero no saldó ${faAnulada.name} (saldo ${st.amount_residual}): revisalo en Odoo.`, id };
  }
  const fin = (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_residual", "payment_state", "partner_id"]]) as Rec[])[0];
  await sb.from("compras_ml_decisiones").upsert({ clave: `${cuit}|${nombre}`, categoria: body.categoria, nota: body.nota || null, odoo_move_id: id, odoo_move_name: fin.name, actualizado_en: new Date().toISOString() });
  return { ok: true, comprobante: fin, chk, pago, ajuste_iva: ajusteIva || undefined, retomado: retomar ? true : undefined };
}

// ═══ CARGOS de Mercado Libre (comisiones, publicidad, envíos, Mercado Pago, suscripción) ═══════════════
// Fuente: la lista de ARCA del mes (la sube la pantalla) + el PDF de cada comprobante, que SÍ se baja por la API de
// facturación de ML (/billing/integration). Se arma igual que como se cargaron de marzo a octubre de 2026:
//  · un renglón por concepto (Comisiones GC01, Publicidad GC06, Medios de pago GC03, Envíos GC04, Flex GC11,
//    Suscripción GC08), NETO de sus bonificaciones; IVA 21% en todos; las percepciones por jurisdicción en el 1.º;
//  · FA-B (suscripción): por el total con "IVA No Aplica";
//  · pago por Mercado Pago el MISMO día de la factura por el total (criterio de Diego: hay cargos que se debitan en
//    cada venta y el resto va con tarjeta; se simplifica pagando el día de la factura);
//  · NC: se salda por Mercado Pago (reintegro de ML) el MISMO día de la NC, por su total. La factura de su
//    "Doc. Ref" queda anotada en la referencia, pero NO se toca (Diego 10-nov: nada de lo ya presentado a la
//    contadora puede cambiar; las NC suelen referir a facturas de meses anteriores).
const CONCEPTOS: { re: RegExp; no?: RegExp; code: string | null; cuenta?: string; label: string; bonif?: boolean }[] = [
  { re: /BONIF.*(HERRAMIENTAS ADS|PUBLICIDAD|PRODUCT ADS)/, code: "GC06", label: "Bonificación publicidad (Ads)", bonif: true },
  { re: /(HERRAMIENTAS ADS|PUBLICIDAD|PRODUCT ADS)/, code: "GC06", label: "Publicidad (Ads)" },
  { re: /BONIF.*MERCADO PAGO/, code: "GC03", label: "Bonificación plataforma Mercado Pago", bonif: true },
  { re: /(ADELANTO DE DINERO|INTERES)/, code: null, cuenta: "5.5.1.01.010", label: "Cargo por adelanto de dinero / intereses" },
  { re: /MERCADO PAGO/, code: "GC03", label: "Plataforma Mercado Pago" },
  { re: /BONIF.*FLEX/, code: "GC11", label: "Bonificación Flex", bonif: true },
  { re: /BONIF.*ENVIO/, code: "GC04", label: "Bonificación envíos", bonif: true },
  { re: /BONIF.*PLATAFORMA/, code: "GC01", label: "Bonificación plataforma ML", bonif: true },
  { re: /SUSCRIPCION/, code: "GC08", label: "Suscripción" },
  { re: /ENVIO/, code: "GC04", label: "Envíos" },
  { re: /(REPUTACION|PLATAFORMA.*MERCADO LIBRE)/, code: "GC01", label: "Comisiones (plataforma ML)" },
];
const ORDEN_CODE = ["GC01", "GC06", "GC03", "GC04", "GC11", "GC08", null];
// percepciones del PDF → impuesto de Odoo (el orden importa: CABA comercio electrónico antes que CABA general)
const PERCEP: [RegExp, number][] = [
  [/5319/, 199], [/2408/, 195], [/GANANCIAS/, 152], [/COMERCIO ELECTRONICO/, 198], [/TUCUMAN.*174/, 202], [/TUCUMAN/, 138],
  [/(CABA|CIUDAD AUTONOMA)/, 124], [/(ARBA|BUENOS AIRES)/, 125], [/NEUQUEN/, 143], [/CORRIENTES/, 128], [/CATAMARCA/, 126],
  [/LA PAMPA/, 144], [/CORDOBA/, 127], [/ENTRE RIOS/, 129], [/JUJUY/, 130], [/MENDOZA/, 131], [/LA RIOJA/, 132], [/SALTA/, 133],
  [/SAN JUAN/, 134], [/SAN LUIS/, 135], [/SANTA FE/, 136], [/SANTIAGO/, 137], [/CHACO/, 139], [/CHUBUT/, 140], [/FORMOSA/, 141],
  [/MISIONES/, 142], [/RIO NEGRO/, 145], [/SANTA CRUZ/, 146], [/TIERRA DEL FUEGO/, 147],
];
const IVA_TASA: Record<string, number> = { "21": TAX.iva21, "10,5": TAX.iva105, "10,50": TAX.iva105, "27": TAX.iva27 };
const mayus = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const aNum = (s: string) => +String(s).replace(/\./g, "").replace(",", ".");

// PDF → renglones de texto (streams con o sin Flate; <hex>Tj y (texto)Tj agrupados por altura)
function textoPDF(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  const lineas: { x: number; y: number; t: string }[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const ini = m.index + m[0].length;
    const fin = s.indexOf("endstream", ini);
    if (fin < 0) break;
    const dict = s.slice(Math.max(0, m.index - 400), m.index);
    let data: Buffer = buf.subarray(ini, fin);
    if (/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) {
      try { data = inflateSync(data); } catch { try { data = inflateRawSync(data.subarray(2)); } catch { continue; } }
    }
    const t = data.toString("latin1");
    if (!/Tj|TJ/.test(t)) continue;
    let x = 0, y = 0;
    for (const bt of t.matchAll(/BT([\s\S]*?)ET/g)) {
      const ops = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td|(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|<([0-9A-Fa-f\s]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
      for (const op of bt[1].matchAll(ops)) {
        if (op[1] !== undefined) { x = +op[1]; y = +op[2]; }
        else if (op[3] !== undefined) { x = +op[3]; y = +op[4]; }
        else if (op[5] !== undefined) {
          const h = op[5].replace(/\s/g, ""); let str = "";
          for (let i = 0; i < h.length; i += 2) str += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
          lineas.push({ x, y, t: str });
        } else if (op[6] !== undefined) lineas.push({ x, y, t: op[6].replace(/\\([()\\])/g, "$1") });
      }
    }
  }
  const porY = new Map<number, typeof lineas>();
  for (const l of lineas) { const k = Math.round(l.y); if (!porY.has(k)) porY.set(k, []); porY.get(k)!.push(l); }
  return [...porY].sort((a, b) => b[0] - a[0])
    .map(([, ls]) => ls.sort((a, b) => a.x - b.x).map((l) => l.t).join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Lee un comprobante de ML: conceptos, percepciones, IVA, totales, Doc. Ref. Valida que todo sume al centavo.
function leerComprobanteML(lineas: string[]): Rec {
  const out: Rec = { conceptos: [], perc: [], iva: [], problemas: [] };
  let fase = 0;
  for (const l of lineas) {
    const u = mayus(l);
    if (!out.cuit_emisor) { const c = u.match(/CUIT:\s*(\d{2}-\d{8}-\d)/); if (c) out.cuit_emisor = digitos(c[1]); }
    if (!out.fecha) { const f = u.match(/FECHA DE EMISION:.*?(\d{2})\.(\d{2})\.(\d{4})/); if (f) out.fecha = `${f[3]}-${f[2]}-${f[1]}`; }
    if (!out.numero) { const n = u.match(/^(\d{4,5})-(\d{8})$/); if (n) out.numero = `${n[1].padStart(5, "0")}-${n[2]}`; }
    if (!out.letra && /^[ABC]$/.test(u)) out.letra = u;
    if (!out.clase && /^ORIGINAL/.test(u)) out.clase = /NOTA DE CREDITO/.test(u) ? "NC" : /NOTA DE DEBITO/.test(u) ? "ND" : /FACTURA/.test(u) ? "FA" : null;
    const dr = u.match(/DOC\. ?REF:\s*(\d{4,5})([ABC])(\d{8})/);
    if (dr) out.doc_ref = { letra: dr[2], numero: `${dr[1].padStart(5, "0")}-${dr[3]}`, texto: `${dr[1]}${dr[2]}${dr[3]}` };
    const mm = u.match(/(\d{1,3}(?:\.\d{3})*,\d{2})$/);
    if (!mm) continue;
    const imp = aNum(mm[1]);
    if (/^SUBTOTAL/.test(u)) { out.subtotal = imp; fase = 1; }
    else if (/^TOTAL:/.test(u)) out.total = imp;
    else if (/^I\.?V\.?A\.? INSC/.test(u)) {
      const t = (u.match(/INSC\.?\s*([\d,]+?)(?:,0+)?%/) || [])[1] || "";
      const tax = IVA_TASA[t] ?? IVA_TASA[t.replace(/,0+$/, "")];
      if (!tax) out.problemas.push(`IVA con alícuota desconocida (${t}%)`);
      out.iva.push({ tax, importe: imp });
    } else if (/PERCEP/.test(u)) {
      const p = PERCEP.find(([re]) => re.test(u));
      if (!p) out.problemas.push(`Percepción que no reconozco: "${l.slice(0, 80)}"`);
      out.perc.push({ tax: p ? p[1] : null, importe: imp, texto: l.slice(0, 80) });
    } else if (fase === 0) {
      const c = CONCEPTOS.find((k) => k.re.test(u));
      if (!c) out.problemas.push(`Concepto que no reconozco: "${l.slice(0, 80)}"`);
      out.conceptos.push({ code: c?.code ?? null, cuenta: c?.cuenta, label: c?.label || l.slice(0, 60), bonif: !!c?.bonif, importe: imp, desconocido: !c });
    }
  }
  const nc = out.clase === "NC";
  // FA: los conceptos de bonificación RESTAN; NC: todo es a favor (positivo dentro de la NC)
  const sumaC = r2(out.conceptos.reduce((s: number, c: Rec) => s + (nc ? c.importe : (c.bonif ? -c.importe : c.importe)), 0));
  out.percepciones = r2(out.perc.reduce((s: number, p: Rec) => s + p.importe, 0));
  out.iva_total = r2(out.iva.reduce((s: number, p: Rec) => s + p.importe, 0));
  if (out.subtotal === undefined || out.total === undefined) out.problemas.push("No encontré el subtotal o el total en el PDF");
  else {
    if (sumaC !== r2(out.subtotal)) out.problemas.push(`Los conceptos suman ${sumaC} y el subtotal dice ${out.subtotal}`);
    if (r2(out.subtotal + out.percepciones + out.iva_total) !== r2(out.total)) out.problemas.push(`Subtotal ${out.subtotal} + percepciones ${out.percepciones} + IVA ${out.iva_total} ≠ total ${out.total}`);
  }
  if (out.iva.length > 1) out.problemas.push("Tiene más de una alícuota de IVA: cargalo a mano");
  if (out.iva.length === 1 && Math.abs(out.subtotal * 0.21 - out.iva_total) > 1 && out.iva[0].tax === TAX.iva21) out.problemas.push(`El IVA ${out.iva_total} no es el 21% del subtotal ${out.subtotal}`);
  // renglones agrupados por producto, neto de bonificaciones
  const porCode = new Map<string, Rec>();
  for (const c of out.conceptos) {
    const k = String(c.code ?? c.cuenta);
    if (!porCode.has(k)) porCode.set(k, { code: c.code, cuenta: c.cuenta, label: c.code ? null : c.label, importe: 0, detalle: [] });
    const g = porCode.get(k)!;
    g.importe = r2(g.importe + (nc ? c.importe : (c.bonif ? -c.importe : c.importe)));
    g.detalle.push(`${c.bonif && !nc ? "−" : ""}${c.label} ${c.importe}`);
  }
  out.lineas = [...porCode.values()].sort((a, b) => ORDEN_CODE.indexOf(a.code) - ORDEN_CODE.indexOf(b.code));
  if (out.lineas.some((l: Rec) => l.importe <= 0)) out.problemas.push("Un concepto queda en cero o negativo después de las bonificaciones: cargalo a mano");
  // perc agrupadas por impuesto
  const pt = new Map<number, number>();
  for (const p of out.perc) if (p.tax) pt.set(p.tax, r2((pt.get(p.tax) || 0) + p.importe));
  out.perc_odoo = [...pt].map(([tax, importe]) => ({ tax, importe }));
  return out;
}

// La API de facturación de ML permite 5 consultas por MINUTO: se espera lo justo y, si no alcanza el tiempo de la
// función, se corta con este aviso. Todo lo leído queda en compras_ml_cargos_docs y la próxima pasada sigue de ahí.
const LIMITE_ML = "Mercado Libre permite solo 5 consultas por minuto a su facturación: esperá un minuto y tocá «Revisar» de nuevo (lo ya leído queda guardado)";
class LimiteML extends Error {}
let T0 = Date.now();
async function mlFetch(tok: string, path: string, raw = false): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(ML_API + path, { headers: { Authorization: "Bearer " + tok } });
    if (r.ok) return raw ? new Uint8Array(await r.arrayBuffer()) : await r.json();
    if (r.status === 429) {
      if (Date.now() - T0 > 95e3) throw new LimiteML(LIMITE_ML); // no llega antes del corte de 150 s
      await new Promise((s) => setTimeout(s, 13e3));               // 1 consulta nueva cada 12 s
      continue;
    }
    if (r.status < 500) return null; // 4xx: no existe / no aplica
    await new Promise((s) => setTimeout(s, 800 * (i + 1)));
  }
  throw new LimiteML(LIMITE_ML);
}
// Comprobantes de facturación de ML de los períodos que tocan el mes (el ciclo va del 30 al 29): primero lo guardado;
// a ML solo se le pregunta si falta alguno de `refs`, y cada lista se pide como mucho una vez por hora.
async function docsFacturacion(sb: any, mes: string, refs: string[]): Promise<Rec[]> {
  const [y, m] = mes.split("-").map(Number);
  const claves = [`${mes}-01`, `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`];
  const leer = async () => ((await sb.from("compras_ml_cargos_docs").select("*").in("periodo", claves)).data || []) as Rec[];
  let docs = await leer();
  const faltan = () => refs.filter((r) => !docs.some((d) => d.ref === r));
  if (!faltan().length) return docs.filter((d) => !d.ref.startsWith("__"));
  const tok = await mlToken(sb);
  for (const key of claves) for (const [g, t] of [["ML", "BILL"], ["ML", "CREDIT_NOTE"], ["MP", "BILL"], ["MP", "CREDIT_NOTE"]]) {
    if (!faltan().length) break;
    const marca = `__lista|${key}|${g}|${t}`;
    const ya = docs.find((d) => d.ref === marca);
    if (ya && Date.now() - new Date(ya.leido_en).getTime() < 3600e3) continue;
    const j = await mlFetch(tok, `/billing/integration/periods/key/${key}/documents?group=${g}&document_type=${t}&limit=50`);
    const filas: Rec[] = [{ ref: marca, periodo: key, grupo: g, tipo: t, leido_en: new Date().toISOString() }];
    for (const d of j?.results || []) for (const f of d.files || []) if (f.file_id && f.reference_number)
      filas.push({ ref: String(f.reference_number), grupo: g, tipo: t, periodo: key, file_id: String(f.file_id), monto: d.amount });
    await sb.from("compras_ml_cargos_docs").upsert(filas);
    docs = await leer();
  }
  return docs.filter((d) => !d.ref.startsWith("__"));
}
// texto del PDF: guardado, o se baja una vez y se guarda (un comprobante fiscal no cambia)
async function leerDocML(sb: any, d: Rec): Promise<Rec> {
  let texto: string[] | null = Array.isArray(d.texto) ? d.texto : null;
  if (!texto) {
    const pdf = await mlFetch(await mlToken(sb), `/billing/integration/legal_document/${d.file_id}`, true);
    if (!pdf) return { problemas: ["Mercado Libre no entregó el PDF"] };
    texto = textoPDF(pdf);
    await sb.from("compras_ml_cargos_docs").update({ texto, leido_en: new Date().toISOString() }).eq("ref", d.ref);
  }
  return leerComprobanteML(texto);
}
const refARCA = (c: Rec) => `${String(c.pv).padStart(4, "0")}${DOC[String(c.cod)]?.letra || "?"}${String(c.num).padStart(8, "0")}`;

let PRODS: Record<string, Rec> | null = null;
async function productosCargos() {
  if (PRODS) return PRODS;
  const p = await ex("product.product", "search_read", [[["default_code", "in", ["GC01", "GC03", "GC04", "GC06", "GC08", "GC11"]]]], { fields: ["id", "default_code", "property_account_expense_id"], context: { active_test: false } }) as Rec[];
  PRODS = Object.fromEntries(p.map((x) => [x.default_code, { id: x.id, account: m2o(x.property_account_expense_id) }]));
  return PRODS;
}
const CUENTAS: Record<string, number> = {};
async function cuentaId(code: string) {
  if (!CUENTAS[code]) CUENTAS[code] = ((await ex("account.account", "search_read", [[["code", "=", code], ["company_ids", "in", [C]]]], { fields: ["id"] }) as Rec[])[0] || {}).id;
  return CUENTAS[code];
}
const lineaPagar = async (moveId: number) => (await ex("account.move.line", "search_read", [[["move_id", "=", moveId], ["account_id.account_type", "=", "liability_payable"]]], { fields: ["id", "amount_residual", "reconciled", "matched_debit_ids", "matched_credit_ids"] }) as Rec[])[0];

// Arma lo que tiene que quedar en Odoo para un comprobante de cargos (sin escribir nada)
async function specCargo(sb: any, comp: Rec, docsML: Rec[] | null, limite: string | null = null): Promise<Rec> {
  const doc = DOC[String(comp.cod)];
  const cuit = digitos(comp.cuit);
  const numero = `${String(comp.pv).padStart(5, "0")}-${String(comp.num).padStart(8, "0")}`;
  const base: Rec = { cuit, numero, nombre: doc ? `${doc.pref} ${numero}` : `Cód. ${comp.cod} ${numero}`, fecha: comp.fecha, total: r2(Math.abs(+comp.total || 0)), problemas: [] };
  if (!doc) { base.problemas.push(`Tipo de comprobante ${comp.cod} (nota de débito u otro): cargalo a mano`); return base; }
  base.doc = doc;
  const arca = { neto: r2(Math.abs(+comp.neto || 0)), iva: r2(Math.abs(+comp.iva || 0)), otros: r2(Math.abs(+comp.otros || 0)), total: base.total };
  if (doc.letra !== "A") {
    // B (la suscripción): sin IVA discriminado ni percepciones; como siempre: GC08 por el total, IVA No Aplica
    if (arca.otros) base.problemas.push("Factura B con otros tributos: cargala a mano");
    if (cuit !== "30703088534" || doc.nc) base.problemas.push("Comprobante B que no es la suscripción de Mercado Libre: cargalo a mano");
    return { ...base, letra: doc.letra, lineas: [{ code: "GC08", importe: base.total, detalle: ["Suscripción"] }], perc_odoo: [], iva: 0, iva_tax: TAX.noAplica, fuente: "ARCA" };
  }
  let docs = docsML;
  if (!docs) {
    try { docs = await docsFacturacion(sb, String(comp.fecha).slice(0, 7), [refARCA(comp)]); }
    catch (e) { if (e instanceof LimiteML) { base.problemas.push(e.message); return base; } throw e; }
  }
  const d = docs.find((x) => x.ref === refARCA(comp));
  if (!d) { base.problemas.push(limite || `No está en la facturación de Mercado Libre (${refARCA(comp)}): cargala a mano`); return base; }
  let pdf: Rec;
  try { pdf = await leerDocML(sb, d); }
  catch (e) { if (e instanceof LimiteML) { base.problemas.push(e.message); return base; } throw e; }
  const pr = [...(pdf.problemas || [])];
  // contra ARCA, al centavo
  if (pdf.numero && pdf.numero !== numero) pr.push(`El PDF es ${pdf.numero}, no ${numero}`);
  if (pdf.cuit_emisor && pdf.cuit_emisor !== cuit) pr.push(`El PDF lo emite ${pdf.cuit_emisor}, ARCA dice ${cuit}`);
  if ((pdf.clase === "NC") !== doc.nc) pr.push(`El PDF es ${pdf.clase} y ARCA dice ${doc.pref}`);
  if (pdf.fecha && pdf.fecha !== comp.fecha) pr.push(`Fecha del PDF ${pdf.fecha} ≠ ARCA ${comp.fecha}`);
  for (const [k, a, b] of [["total", arca.total, pdf.total], ["IVA", arca.iva, pdf.iva_total], ["neto", arca.neto, pdf.subtotal], ["percepciones", arca.otros, pdf.percepciones]] as [string, number, number][])
    if (r2(a) !== r2(b ?? NaN)) pr.push(`${k}: ARCA ${a} ≠ PDF ${b}`);
  if (doc.nc && !pdf.doc_ref) pr.push("La NC no trae Doc. Ref: cargala a mano");
  return { ...base, letra: "A", lineas: pdf.lineas, perc_odoo: pdf.perc_odoo, perc_pdf: pdf.perc, iva: pdf.iva_total, iva_tax: pdf.iva[0]?.tax,
    doc_ref: pdf.doc_ref ? { ...pdf.doc_ref, nombre: `FA-${pdf.doc_ref.letra} ${pdf.doc_ref.numero}` } : null,
    concepto: pdf.conceptos.map((c: Rec) => c.label).join(" + "), problemas: pr, fuente: "PDF de ML" };
}

// Lo que hay hoy en Odoo para ese número (cualquier letra: la suscripción quedó como FA-A) y en qué difiere
async function enOdooCargo(spec: Rec): Promise<Rec | null> {
  const ps = await ex("res.partner", "search_read", [[["vat", "in", [cuitFmt(spec.cuit), spec.cuit]]]], { fields: ["id", "name"], context: { active_test: false } }) as Rec[];
  spec.partner = ps[0] ? { id: ps[0].id, name: ps[0].name } : null;
  const ms = await ex("account.move", "search_read", [[["name", "=like", "% " + spec.numero], ["move_type", "in", ["in_invoice", "in_refund"]], ["state", "!=", "cancel"], ["company_id", "=", C]]],
    { fields: ["id", "name", "state", "partner_id", "amount_total", "amount_tax", "amount_residual", "payment_state", "invoice_date", "reversed_entry_id", "invoice_payments_widget"] }) as Rec[];
  const m = ms.find((x) => !spec.partner || m2o(x.partner_id) === spec.partner.id) || ms[0];
  if (!m) return null;
  const ls = await ex("account.move.line", "search_read", [[["move_id", "=", m.id], ["display_type", "in", ["product", "tax"]]]], { fields: ["display_type", "product_id", "account_id", "tax_line_id", "balance"] }) as Rec[];
  const prods = await productosCargos();
  const codeDe = Object.fromEntries(Object.entries(prods).map(([k, v]) => [v.id, k]));
  const lin: Record<string, number> = {};
  for (const l of ls.filter((x) => x.display_type === "product")) { const k = codeDe[m2o(l.product_id)] ?? (l.account_id?.[1] || "?").split(" ")[0]; lin[k] = r2((lin[k] || 0) + Math.abs(l.balance)); }
  const perc: Record<number, number> = {}; let iva = 0;
  for (const l of ls.filter((x) => x.display_type === "tax")) { const t = m2o(l.tax_line_id); if (TAX_IVA.has(t)) iva = r2(iva + Math.abs(l.balance)); else perc[t] = r2((perc[t] || 0) + Math.abs(l.balance)); }
  const dif: string[] = [];
  if (spec.doc && m.name !== spec.nombre) dif.push(`está como ${m.name} y es ${spec.nombre}`);
  if (m2o(m.partner_id) !== spec.partner?.id) dif.push(`proveedor ${m.partner_id?.[1]}`);
  if (r2(m.amount_total) !== spec.total) dif.push(`total Odoo ${m.amount_total} ≠ ${spec.total}`);
  if (spec.lineas) {
    const quiere: Record<string, number> = {};
    for (const l of spec.lineas) { const k = l.code ?? l.cuenta; quiere[k] = r2((quiere[k] || 0) + l.importe); }
    for (const k of new Set([...Object.keys(quiere), ...Object.keys(lin)])) if (r2(quiere[k] || 0) !== r2(lin[k] || 0)) dif.push(`${k}: Odoo ${lin[k] || 0} → ${quiere[k] || 0}`);
    if (r2(iva) !== r2(spec.iva || 0)) dif.push(`IVA Odoo ${iva} → ${spec.iva || 0}`);
    const qp: Record<number, number> = Object.fromEntries((spec.perc_odoo || []).map((p: Rec) => [p.tax, p.importe]));
    for (const t of new Set([...Object.keys(qp), ...Object.keys(perc)].map(Number))) if (r2(qp[t] || 0) !== r2(perc[t] || 0)) dif.push(`percepción ${t}: Odoo ${perc[t] || 0} → ${qp[t] || 0}`);
  }
  const pagos = (m.invoice_payments_widget?.content || []).map((p: Rec) => `${p.journal_name} ${p.date} ${p.amount}`);
  if (m.state === "posted" && spec.doc && !spec.doc.nc && m.payment_state === "not_paid") dif.push("sin pago");
  if (m.state === "posted" && spec.doc?.nc && m.amount_residual !== 0) dif.push("NC sin conciliar con su factura");
  return { id: m.id, name: m.name, state: m.state, total: m.amount_total, pago: m.payment_state, pagos, diferencias: dif };
}

// Ajusta los impuestos al comprobante (percepciones exactas, IVA si difiere ≤ $0,05) y verifica al centavo
async function ajustarYVerificar(id: number, sg: number, perc: Rec[], iva: number, total: number): Promise<Rec> {
  const leer = async () => await ex("account.move.line", "search_read", [[["move_id", "=", id]]], { fields: ["display_type", "tax_line_id", "balance", "debit", "credit"] }) as Rec[];
  let ls = await leer();
  const cmds: unknown[] = [];
  for (const p of perc) {
    const l = ls.find((x) => m2o(x.tax_line_id) === p.tax);
    if (!l) return { ok: false, error: `Odoo no generó la línea de la percepción ${p.tax}; quedó en BORRADOR`, id };
    cmds.push([1, l.id, { balance: sg * p.importe, amount_currency: sg * p.importe }]);
  }
  const lIva = ls.filter((x) => x.tax_line_id && TAX_IVA.has(m2o(x.tax_line_id)));
  const ivaOdoo = r2(Math.abs(lIva.reduce((s, l) => s + l.balance, 0)));
  if (iva && lIva.length === 1 && ivaOdoo !== iva) {
    if (Math.abs(iva - ivaOdoo) > 0.05) return { ok: false, error: `El IVA de Odoo (${ivaOdoo}) difiere del comprobante (${iva}) más que un redondeo: quedó en BORRADOR`, id };
    cmds.push([1, lIva[0].id, { balance: sg * iva, amount_currency: sg * iva }]);
  }
  if (cmds.length) {
    const tt = ls.find((x) => x.display_type === "payment_term");
    cmds.push([1, tt.id, { balance: -sg * total, amount_currency: -sg * total }]);
    await ex("account.move", "write", [[id], { line_ids: cmds }]);
    ls = await leer();
  }
  const sumTax = (pred: (t: number) => boolean) => r2(Math.abs(ls.filter((l) => l.tax_line_id && pred(m2o(l.tax_line_id))).reduce((s, l) => s + l.balance, 0)));
  const chk = { total: r2(Math.abs(ls.filter((l) => l.display_type === "payment_term").reduce((s, l) => s + l.balance, 0))),
    iva: sumTax((t) => TAX_IVA.has(t)), percepciones: sumTax((t) => !TAX_IVA.has(t)),
    debe: r2(ls.reduce((s, l) => s + l.debit, 0)), haber: r2(ls.reduce((s, l) => s + l.credit, 0)) };
  const percTot = r2(perc.reduce((s, p) => s + p.importe, 0));
  if (chk.total !== total || chk.iva !== r2(iva) || chk.percepciones !== percTot || chk.debe !== chk.haber)
    return { ok: false, error: `No cerró al centavo (Odoo total ${chk.total} / IVA ${chk.iva} / perc ${chk.percepciones}): quedó en BORRADOR para revisar`, id, chk };
  return { ok: true, chk };
}

async function lineasOdoo(spec: Rec): Promise<Rec[]> {
  const prods = await productosCargos();
  const out: Rec[] = [];
  for (let i = 0; i < spec.lineas.length; i++) {
    const l = spec.lineas[i];
    const taxes = [spec.iva_tax || TAX.noAplica, ...(i === 0 ? spec.perc_odoo.map((p: Rec) => p.tax) : [])];
    if (l.code) { if (!prods[l.code]) throw new Error("No encuentro el producto " + l.code); out.push({ product_id: prods[l.code].id, account_id: prods[l.code].account, quantity: 1, price_unit: l.importe, tax_ids: [[6, 0, taxes]] }); }
    else out.push({ name: l.label || "Cargo financiero Mercado Pago", account_id: await cuentaId(l.cuenta), quantity: 1, price_unit: l.importe, tax_ids: [[6, 0, taxes]] });
  }
  return out;
}

// cargos {mes, arca:[comprobantes de ARCA de ML y MELI LOG]} → estado de cada uno (no escribe)
async function cargos(sb: any, body: Rec) {
  const mes = String(body.mes || "");
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error("Falta el mes (YYYY-MM)");
  const arcaA = ((body.arca || []) as Rec[]).filter((c) => DOC[String(c.cod)]?.letra === "A").map(refARCA);
  let docs: Rec[], limite: string | null = null;
  try { docs = await docsFacturacion(sb, mes, arcaA); }
  catch (e) { if (!(e instanceof LimiteML)) throw e; limite = e.message; docs = await docsFacturacion(sb, mes, []); }
  const filas: Rec[] = [];
  // de a uno: ML corta (429) si se le piden varios PDF juntos
  const specs: Rec[] = [];
  for (const comp of (body.arca || []) as Rec[]) specs.push(await specCargo(sb, comp, docs, limite));
  for (const [i, comp] of ((body.arca || []) as Rec[]).entries()) {
    const spec = specs[i];
    const odoo = await enOdooCargo(spec);
    let nc: Rec | null = null;
    if (spec.doc?.nc && spec.doc_ref && !spec.problemas.length) {
      const fa = await ex("account.move", "search_read", [[["name", "=", spec.doc_ref.nombre], ["move_type", "=", "in_invoice"], ["state", "=", "posted"], ["company_id", "=", C]]], { fields: ["id", "name", "invoice_date"] }) as Rec[];
      nc = fa.length ? { factura: fa[0].name, fecha: fa[0].invoice_date } : { error: `su factura ${spec.doc_ref.nombre} no está en Odoo` };
      if (!fa.length) spec.problemas.push(`La NC refiere a ${spec.doc_ref.nombre}, que no está en Odoo: cargá esa factura primero`);
    }
    const estado = spec.problemas.length ? "revisar" : !odoo ? "falta" : odoo.diferencias.length ? "difiere" : "ok";
    filas.push({ comp: { cuit: comp.cuit, cod: comp.cod, pv: comp.pv, num: comp.num, fecha: comp.fecha, total: comp.total }, nombre: spec.nombre, fuente: spec.fuente,
      lineas: spec.lineas, perc: spec.perc_odoo, iva: spec.iva, total: spec.total, doc_ref: spec.doc_ref?.nombre || null, nc, problemas: spec.problemas, odoo, estado });
  }
  // lo que está en la facturación de ML del mes y no vino en ARCA (para no perder nada)
  const enArca = new Set(((body.arca || []) as Rec[]).map(refARCA));
  const sinArca = docs.filter((d) => !enArca.has(d.ref) && d.periodo === `${mes}-01`).map((d) => ({ ref: d.ref, grupo: d.grupo, tipo: d.tipo, monto: d.monto }));
  return { ok: true, mes, filas, sin_arca: sinArca, aviso: limite };
}

// cargos_cargar {comp, dry_run} → crea el comprobante, o lo CORRIGE si ya está y difiere (mismo total)
async function cargosCargar(sb: any, body: Rec) {
  const dry = !!body.dry_run;
  const spec = await specCargo(sb, body.comp || {}, null);
  if (spec.problemas.length) return { ok: false, error: spec.problemas.join(" · ") };
  const actual = await enOdooCargo(spec);
  if (!spec.partner) return { ok: false, error: `No encuentro el proveedor con CUIT ${cuitFmt(spec.cuit)} en Odoo` };
  if (actual && !actual.diferencias.length) return { ok: true, ya_cargada: true, move: actual };
  const doc = spec.doc;
  const sg = doc.nc ? -1 : 1;
  let fa: Rec | null = null;
  if (doc.nc) {
    fa = (await ex("account.move", "search_read", [[["name", "=", spec.doc_ref.nombre], ["partner_id", "=", spec.partner.id], ["move_type", "=", "in_invoice"], ["state", "=", "posted"]]], { fields: ["id", "name"] }) as Rec[])[0] || null;
    if (!fa) return { ok: false, error: `La NC refiere a ${spec.doc_ref.nombre}, que no está en Odoo: cargá esa factura primero` };
  }
  const plan: Rec = { comprobante: spec.nombre, proveedor: spec.partner.name, fuente: spec.fuente, total: spec.total, iva: spec.iva,
    renglones: spec.lineas.map((l: Rec) => ({ producto: l.code || l.cuenta, importe: l.importe, de: l.detalle })), percepciones: spec.perc_odoo,
    accion: actual ? `CORREGIR ${actual.name}: ${actual.diferencias.join(" · ")}` : "crear" };
  if (actual && r2(actual.total) !== spec.total) return { ok: false, error: `${actual.name} está en Odoo por ${actual.total} y el comprobante es por ${spec.total}: revisalo a mano` };
  if (!actual) {
    const borr = await ex("account.move", "search_read", [[["move_type", "in", ["in_invoice", "in_refund"]], ["state", "=", "draft"], ["company_id", "=", C], ["partner_id", "=", spec.partner.id]]], { fields: ["id", "amount_total"] }) as Rec[];
    if (borr.length) return { ok: false, error: `Hay ${borr.length} borrador(es) de ${spec.partner.name} en Odoo (id ${borr.map((b) => b.id).join(", ")}): resolvelos antes para no duplicar` };
  }
  if (doc.nc && !actual) plan.pago = `reintegro por Mercado Pago ${spec.fecha} ${spec.total} (refiere a ${fa!.name}, que NO se toca)`;
  else if (!doc.nc && !actual) plan.pago = `Mercado Pago ${spec.fecha} ${spec.total}`;
  if (dry) return { ok: true, dry_run: true, plan };

  const lineas = await lineasOdoo(spec);
  let id: number;
  let contra: number[] = [];
  if (actual) {
    // corregir: se desconcilia (se recuerda con qué), se pasa a borrador, se rearma y se vuelve a conciliar igual
    id = actual.id;
    if (actual.state === "posted") {
      const lp = await lineaPagar(id);
      const ids = doc.nc ? lp.matched_credit_ids : lp.matched_debit_ids;
      if ((ids as number[]).length) {
        const parc = await ex("account.partial.reconcile", "read", [ids, [doc.nc ? "credit_move_id" : "debit_move_id"]]) as Rec[];
        contra = parc.map((p) => m2o(p[doc.nc ? "credit_move_id" : "debit_move_id"]) as number);
        await ex("account.move.line", "remove_move_reconcile", [[lp.id]]);
      }
      await ex("account.move", "button_draft", [[id]]);
    }
    const viejas = await ex("account.move.line", "search_read", [[["move_id", "=", id], ["display_type", "=", "product"]]], { fields: ["id"] }) as Rec[];
    // el nombre de un comprobante ya validado una vez NO se recalcula al cambiar el tipo: se escribe ("FA-A …" → "FA-B …")
    await ex("account.move", "write", [[id], { l10n_latam_document_type_id: doc.id, ...(actual.name !== spec.nombre ? { name: spec.nombre } : {}), invoice_line_ids:[...viejas.map((l) => [2, l.id]), ...lineas.map((l) => [0, 0, l])] }]);
  } else {
    id = await ex("account.move", "create", [{ move_type: doc.nc ? "in_refund" : "in_invoice", partner_id: spec.partner.id, journal_id: J_COMPRAS,
      l10n_latam_document_type_id: doc.id, l10n_latam_document_number: spec.numero, invoice_date: spec.fecha, date: spec.fecha, company_id: C,
      ...(doc.nc ? { ref: `${spec.concepto} · Doc. Ref: ${spec.doc_ref.texto}` } : {}),
      invoice_line_ids: lineas.map((l) => [0, 0, l]) }]) as number;
  }
  const v = await ajustarYVerificar(id, sg, spec.perc_odoo, spec.iva, spec.total);
  if (!v.ok) return v;
  await ex("account.move", "action_post", [[id]]);
  const nm = (await ex("account.move", "read", [[id], ["name"]]) as Rec[])[0].name;
  let pago: Rec | null = null;
  if (contra.length) {
    const lp = await lineaPagar(id);
    await ex("account.move.line", "reconcile", [[lp.id, ...contra]]);
    pago = { reconciliada_de_nuevo: contra.length };
  } else {
    // factura: pago por MP; NC: reintegro por MP (entra plata) — los dos el día del comprobante y por el total
    const ctx = { active_model: "account.move", active_ids: [id] };
    const wid = await ex("account.payment.register", "create", [{ journal_id: J_MP, payment_method_line_id: doc.nc ? PML_MP_IN : PML_MP_OUT, payment_date: spec.fecha, amount: spec.total, communication: nm }], { context: ctx }) as number;
    await ex("account.payment.register", "action_create_payments", [[wid]], { context: ctx });
    pago = { diario: "Mercado Pago", fecha: spec.fecha, importe: spec.total, tipo: doc.nc ? "reintegro" : "pago" };
  }
  const fin = (await ex("account.move", "read", [[id], ["name", "state", "amount_total", "amount_residual", "payment_state"]]) as Rec[])[0];
  if (fin.amount_residual !== 0) return { ok: false, error: `${fin.name} quedó publicada pero con saldo ${fin.amount_residual}: revisala en Odoo`, id };
  await sb.from("compras_ml_decisiones").upsert({ clave: `${spec.cuit}|${fin.name}`, categoria: "cargo_ml", nota: plan.accion, odoo_move_id: id, odoo_move_name: fin.name, actualizado_en: new Date().toISOString() });
  return { ok: true, comprobante: fin, chk: v.chk, pago, accion: plan.accion };
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
    T0 = Date.now();
    const body = await req.json() as Rec;
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const modo = String(body.modo || "datos");
    let out: Rec;
    if (modo === "datos") out = await datos(sb, body);
    else if (modo === "cargar") out = await cargar(sb, body);
    else if (modo === "cargos") out = await cargos(sb, body);
    else if (modo === "cargos_cargar") out = await cargosCargar(sb, body);
    else if (modo === "padron") {
      // propuesta (NO escribe): nombre con el formato de Diego + domicilio fiscal, contra lo que hay hoy en Odoo
      const marcas: Rec = body.marcas || {};
      const filas: Rec[] = [];
      for (const raw of (body.cuits || []) as string[]) {
        const cuit = digitos(raw);
        const campos = ["id", "name", "vat", "street", "city", "zip", "state_id", "is_company", "l10n_ar_afip_responsibility_type_id"];
        let actual = (await ex("res.partner", "search_read", [[["vat", "in", [cuitFmt(cuit), cuit]]]], { fields: campos, context: { active_test: false } }) as Rec[]);
        const d = await datosPadron(cuit);
        if (!actual.length && d.ok) {
          // CUIT mal escrito en Odoo (ej. "20-206184729-"): se busca por apellido / primera palabra y se comparan los DÍGITOS
          const clave = String(d.p.apellido || d.p.razon || "").split(" ")[0];
          if (clave.length >= 3) actual = ((await ex("res.partner", "search_read", [[["name", "ilike", clave]]], { fields: campos, context: { active_test: false }, limit: 80 })) as Rec[])
            .filter((a) => digitos(a.vat) === cuit);
        }
        filas.push({ cuit, partners: actual.map((a) => ({ id: a.id, name: a.name, vat: a.vat, street: a.street, city: a.city, zip: a.zip, provincia: a.state_id?.[1] || null, resp: a.l10n_ar_afip_responsibility_type_id?.[1] || null })),
          padron: d.ok ? { tipo: d.p.tipo, apellido: d.p.apellido, nombre: d.p.nombre, razon: d.p.razon, iva: d.p.iva, domicilio: d.p.domicilio, localidad: d.p.localidad, cp: d.p.cp, provincia: d.p.provincia } : { error: d.error },
          propuesta: d.ok ? { name: nombreProlijo(d.p, marcas[cuit]), vat: cuitFmt(cuit), street: d.street, city: d.city, zip: d.zip, state_id: d.state_id, l10n_ar_afip_responsibility_type_id: d.resp } : null });
      }
      out = { ok: true, filas };
    } else if (modo === "prolijar") {
      // aplica los cambios aprobados: solo nombre y domicilio del contacto (no toca facturas ni nada más)
      const hechos: Rec[] = [];
      for (const ch of (body.cambios || []) as Rec[]) {
        const vals: Rec = {};
        for (const k of ["name", "street", "city", "zip", "state_id", "vat", "l10n_ar_afip_responsibility_type_id"]) if (ch[k] !== undefined && ch[k] !== null && ch[k] !== "") vals[k] = ch[k];
        if (!ch.partner_id || !Object.keys(vals).length) continue;
        vals.country_id = COUNTRY_AR;
        await ex("res.partner", "write", [[ch.partner_id], vals]);
        hechos.push((await ex("res.partner", "read", [[ch.partner_id], ["id", "name", "vat", "street", "city", "zip", "state_id", "l10n_ar_afip_responsibility_type_id"]]) as Rec[])[0]);
      }
      out = { ok: true, hechos };
    }
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
