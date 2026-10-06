import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ================================================================
// odoo-proveedores — el puente bilateral de la ficha de proveedor.
//   terminos      : solo las condiciones de pago (liviano, sin escribir)
//   sincronizar   : trae de Odoo los partners y sus datos -> `proveedores`
//   guardar       : escribe en Odoo lo que se editó en el Core
//   crear         : da de alta en Odoo un proveedor que sólo estaba en el Core
//   proveedor_item: fija quién provee una materia prima (product.supplierinfo)
//   supplierinfo  : lee lo que Odoo tiene cargado por producto
// Odoo manda en la identidad (CUIT, contacto, condición de pago); el Core
// manda en lo suyo (plazo de entrega, cómo se pide, notas) y no se pisa.
// ================================================================
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COMPANY_ID = 2;
const CTX = { allowed_company_ids: [COMPANY_ID], company_id: COMPANY_ID, lang: "es_ES" };

type Row = Record<string, unknown>;
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? (v[0] as number) ?? null : null);
const m2oName = (v: unknown): string | null => (Array.isArray(v) ? String(v[1] ?? "") : null);
const txt = (v: unknown): string | null => {
  if (v === false || v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

async function jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  _uid = uid as number;
  return _uid;
}
async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await auth();
  const ctx = { ...CTX, ...((kwargs.context as Record<string, unknown>) || {}) };
  return await jsonrpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: ctx }]);
}

const CAMPOS_PARTNER = ["id", "name", "vat", "email", "phone", "mobile", "street", "street2", "city",
  "state_id", "comment", "active", "property_supplier_payment_term_id", "supplier_rank"];

function direccionDe(p: Row): string | null {
  const partes = [txt(p.street), txt(p.street2), txt(p.city), m2oName(p.state_id)].filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}

async function terminosPago(): Promise<Row[]> {
  return await call("account.payment.term", "search_read", [[]],
    { fields: ["id", "name"], context: { active_test: false } }) as Row[];
}

/** Trae de Odoo todos los que alguna vez facturaron o figuran como proveedor de algo. */
async function partnersProveedores(): Promise<Row[]> {
  const pos = await call("purchase.order", "search_read",
    [[["company_id", "=", COMPANY_ID]]], { fields: ["partner_id"] }) as Row[];
  const si = await call("product.supplierinfo", "search_read", [[]], { fields: ["partner_id"] }) as Row[];
  const ids = [...new Set([
    ...pos.map(p => m2oId(p.partner_id)),
    ...si.map(s => m2oId(s.partner_id)),
  ].filter((x): x is number => x != null))];
  if (!ids.length) return [];
  return await call("res.partner", "read", [ids], { fields: CAMPOS_PARTNER, context: { active_test: false } }) as Row[];
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/\b(s\.?r\.?l\.?|s\.?a\.?s?)\b/g, "").replace(/[^a-z0-9]/g, "");

async function modoSincronizar(sb: ReturnType<typeof createClient>) {
  const partners = await partnersProveedores();
  const terminos = await terminosPago();

  const { data: actuales } = await sb.from("proveedores").select("id,nombre,odoo_partner_id");
  const porOdoo = new Map<number, Row>();
  const porNombre = new Map<string, Row>();
  for (const p of actuales || []) {
    if (p.odoo_partner_id) porOdoo.set(p.odoo_partner_id as number, p as Row);
    porNombre.set(norm(String(p.nombre)), p as Row);
  }

  let creados = 0, actualizados = 0, vinculados = 0;
  for (const p of partners) {
    const pid = p.id as number;
    const nombre = String(p.name ?? "").trim();
    const espejo = {
      odoo_partner_id: pid,
      odoo_nombre: nombre,
      cuit: txt(p.vat),
      email: txt(p.email),
      telefono: txt(p.phone) ?? txt(p.mobile),
      direccion: direccionDe(p),
      condicion_pago_id: m2oId(p.property_supplier_payment_term_id),
      condicion_pago: m2oName(p.property_supplier_payment_term_id),
      sincronizado_en: new Date().toISOString(),
      actualizado_en: new Date().toISOString(),
    };

    const fila = porOdoo.get(pid) ?? porNombre.get(norm(nombre));
    if (fila && !fila.odoo_partner_id) vinculados++;
    if (fila) {
      await sb.from("proveedores").update(espejo).eq("id", fila.id as number);
      actualizados++;
    } else {
      await sb.from("proveedores").insert({ nombre, ...espejo });
      creados++;
    }
  }
  return { ok: true, partners: partners.length, creados, actualizados, vinculados, terminos };
}

/** Escribe en Odoo lo que se editó en la ficha del Core. */
async function modoGuardar(sb: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const proveedorId = Number(body.proveedor_id);
  const campos = (body.campos || {}) as Record<string, unknown>;
  if (!proveedorId) throw new Error("Falta proveedor_id");

  const { data: prov, error } = await sb.from("proveedores").select("*").eq("id", proveedorId).single();
  if (error || !prov) throw new Error("No existe el proveedor " + proveedorId);

  const aOdoo: Record<string, unknown> = {};
  if ("nombre" in campos && txt(campos.nombre)) aOdoo.name = txt(campos.nombre);
  if ("cuit" in campos) aOdoo.vat = txt(campos.cuit) ?? false;
  if ("email" in campos) aOdoo.email = txt(campos.email) ?? false;
  if ("telefono" in campos) aOdoo.phone = txt(campos.telefono) ?? false;
  if ("direccion" in campos) aOdoo.street = txt(campos.direccion) ?? false;
  if ("condicion_pago_id" in campos) {
    const v = campos.condicion_pago_id;
    aOdoo.property_supplier_payment_term_id = v ? Number(v) : false;
  }

  let odooOk = false;
  let odooMsg: string | null = null;
  if (prov.odoo_partner_id && Object.keys(aOdoo).length) {
    await call("res.partner", "write", [[prov.odoo_partner_id], aOdoo]);
    odooOk = true;
  } else if (!prov.odoo_partner_id && Object.keys(aOdoo).length) {
    odooMsg = "Guardado solo en el Core: este proveedor todavía no existe en Odoo.";
  }

  let condicionNombre: string | null | undefined = undefined;
  if ("condicion_pago_id" in campos) {
    const id = campos.condicion_pago_id ? Number(campos.condicion_pago_id) : null;
    if (id) {
      const t = await call("account.payment.term", "read", [[id]], { fields: ["name"] }) as Row[];
      condicionNombre = t.length ? String(t[0].name) : null;
    } else condicionNombre = null;
  }

  const aCore: Record<string, unknown> = { ...campos, actualizado_en: new Date().toISOString() };
  if (condicionNombre !== undefined) aCore.condicion_pago = condicionNombre;
  const { error: e2 } = await sb.from("proveedores").update(aCore).eq("id", proveedorId);
  if (e2) throw new Error("No se pudo guardar en el Core: " + e2.message);

  return { ok: true, escrito_en_odoo: odooOk, aviso: odooMsg };
}

/** Da de alta en Odoo un proveedor que sólo existía en el Core. */
async function modoCrear(sb: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const proveedorId = Number(body.proveedor_id);
  const { data: prov, error } = await sb.from("proveedores").select("*").eq("id", proveedorId).single();
  if (error || !prov) throw new Error("No existe el proveedor " + proveedorId);
  if (prov.odoo_partner_id) return { ok: true, ya_existia: true, odoo_partner_id: prov.odoo_partner_id };

  const nombre = txt(body.nombre_odoo) ?? String(prov.nombre);
  const previos = await call("res.partner", "search_read", [[["name", "=ilike", nombre]]],
    { fields: ["id", "name"], limit: 1, context: { active_test: false } }) as Row[];
  let pid: number;
  if (previos.length) {
    pid = previos[0].id as number;
  } else {
    pid = await call("res.partner", "create", [{
      name: nombre,
      is_company: true,
      supplier_rank: 1,
      vat: txt(prov.cuit) ?? false,
      email: txt(prov.email) ?? false,
      phone: txt(prov.telefono) ?? false,
      street: txt(prov.direccion) ?? false,
      company_id: false,
    }]) as number;
  }
  await sb.from("proveedores").update({
    odoo_partner_id: pid, odoo_nombre: nombre,
    sincronizado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
  }).eq("id", proveedorId);
  return { ok: true, odoo_partner_id: pid, reutilizado: previos.length > 0 };
}

/** Fija en Odoo quién provee una materia prima (product.supplierinfo). */
async function modoProveedorItem(body: Record<string, unknown>) {
  const codigo = txt(body.codigo_item);
  const partnerId = Number(body.odoo_partner_id);
  if (!codigo) throw new Error("Falta codigo_item");
  if (!partnerId) throw new Error("Falta odoo_partner_id");

  const prods = await call("product.product", "search_read", [[["default_code", "=", codigo]]],
    { fields: ["id", "name", "product_tmpl_id"], limit: 1, context: { active_test: false } }) as Row[];
  if (!prods.length) throw new Error("No existe en Odoo el producto " + codigo);
  const tmpl = m2oId(prods[0].product_tmpl_id)!;

  const existentes = await call("product.supplierinfo", "search_read",
    [[["product_tmpl_id", "=", tmpl]]], { fields: ["id", "partner_id", "sequence", "price", "delay", "min_qty"] }) as Row[];

  const vals: Record<string, unknown> = { sequence: 1 };
  if (body.precio != null) vals.price = Number(body.precio);
  if (body.plazo_dias != null) vals.delay = Number(body.plazo_dias);
  if (body.minimo != null) vals.min_qty = Number(body.minimo);

  const mio = existentes.find(s => m2oId(s.partner_id) === partnerId);
  let accion: string;
  if (mio) {
    await call("product.supplierinfo", "write", [[mio.id], vals]);
    accion = "actualizado";
  } else {
    await call("product.supplierinfo", "create", [{
      partner_id: partnerId, product_tmpl_id: tmpl, company_id: COMPANY_ID, ...vals,
    }]);
    accion = "creado";
  }
  const otros = existentes.filter(s => m2oId(s.partner_id) !== partnerId).map(s => s.id as number);
  if (otros.length) await call("product.supplierinfo", "write", [otros, { sequence: 10 }]);

  return { ok: true, accion, producto: prods[0].name, alternativas: otros.length };
}

/** Lee de Odoo los proveedores cargados por producto, para mostrar y comparar. */
async function modoSupplierinfo() {
  const si = await call("product.supplierinfo", "search_read", [[]],
    { fields: ["id", "partner_id", "product_tmpl_id", "min_qty", "price", "delay", "sequence"] }) as Row[];
  const tmplIds = [...new Set(si.map(s => m2oId(s.product_tmpl_id)).filter((x): x is number => x != null))];
  const mapa: Record<number, string> = {};
  for (let i = 0; i < tmplIds.length; i += 200) {
    const r = await call("product.product", "search_read", [[["product_tmpl_id", "in", tmplIds.slice(i, i + 200)]]],
      { fields: ["default_code", "product_tmpl_id"], context: { active_test: false } }) as Row[];
    for (const p of r) {
      const t = m2oId(p.product_tmpl_id);
      const c = txt(p.default_code);
      if (t && c && !mapa[t]) mapa[t] = c;
    }
  }
  return {
    ok: true,
    filas: si.map(s => ({
      id: s.id, codigo: mapa[m2oId(s.product_tmpl_id) ?? -1] ?? null,
      odoo_partner_id: m2oId(s.partner_id), proveedor: m2oName(s.partner_id),
      precio: Number(s.price ?? 0), plazo: Number(s.delay ?? 0),
      minimo: Number(s.min_qty ?? 0), orden: Number(s.sequence ?? 0),
    })).filter(f => f.codigo),
  };
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
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as Record<string, unknown>;
    const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const modo = String(body.modo ?? "terminos");
    let r: unknown;
    if (modo === "terminos") r = { ok: true, terminos: await terminosPago() };
    else if (modo === "sincronizar") r = await modoSincronizar(sb);
    else if (modo === "guardar") r = await modoGuardar(sb, body);
    else if (modo === "crear") r = await modoCrear(sb, body);
    else if (modo === "proveedor_item") r = await modoProveedorItem(body);
    else if (modo === "supplierinfo") r = await modoSupplierinfo();
    else throw new Error("modo inválido: " + modo);
    return new Response(JSON.stringify(r), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), { headers: cors });
  }
});
