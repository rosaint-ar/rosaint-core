// ====== Portal profesional (módulo del Core) — SOLO LECTURA ======
// Vive dentro de odoo-metricas (tope de funciones del plan). Se entra con body.modo = "portal_metricas".
// Lee lo que Odoo registra del portal rosaint.odoo.com (website id 1, empresa VELAZQUEZ):
//   website.track    páginas y productos vistos (con sesión → contacto; sin sesión → visitante anónimo)
//   res.users        clientes con acceso (share = true) y su último ingreso (login_date)
//   res.users.log    cada ingreso, con fecha y hora
//   sale.order       pedidos que entran POR el portal (website_id); el borrador es el carrito abierto
// El equipo de Rosaint (usuarios internos, share = false, también los dados de baja) NO cuenta.
// Devuelve los datos crudos del período; la pantalla arma indicadores, embudo y tablas.
type Rec = Record<string, unknown>;
type Ex = (model: string, method: string, args: unknown[], kw?: Rec) => Promise<Rec[]>;
const C = 2;
const m2oId = (v: unknown) => Array.isArray(v) ? (v as unknown[])[0] as number : null;
const m2oName = (v: unknown) => Array.isArray(v) ? String((v as unknown[])[1]) : "";

// "AAAA-MM-DD" en hora argentina → texto UTC de Odoo ("AAAA-MM-DD HH:MM:SS")
const utc = (dia: string, sumarDias = 0) => {
  const d = new Date(dia + "T03:00:00Z"); d.setUTCDate(d.getUTCDate() + sumarDias);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

export async function portal(body: Rec, ex: Ex, ctx: Rec): Promise<Rec> {
  if (body.modo !== "portal_metricas") return { ok: false, error: "modo desconocido" };
  const desde = String(body.desde || "").slice(0, 10), hasta = String(body.hasta || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return { ok: false, error: "Faltan desde/hasta (AAAA-MM-DD)" };
  const ini = utc(desde), fin = utc(hasta, 1);
  const sr = (model: string, dom: unknown[], fields: string[], kw: Rec = {}) => ex(model, "search_read", [dom], { fields, ...kw });
  // (ex pisa el context: los dados de baja se piden por dominio, no con active_test)
  const todos = ["active", "in", [true, false]];

  // Quiénes son del equipo: usuarios internos (también los dados de baja) + las cuentas de prueba que manda
  // el Core (portal_excluidos: en Rosaint el equipo prueba el portal con usuarios de cliente)
  const [internos, clientes] = await Promise.all([
    sr("res.users", [["share", "=", false], todos], ["partner_id"]),
    sr("res.users", [["share", "=", true], todos], ["name", "login", "partner_id", "login_date", "create_date", "active"]),
  ]);
  const excluir = (Array.isArray(body.excluir) ? body.excluir : []).map(Number).filter(Boolean);
  const pInternos = [...new Set([...internos.map((u) => m2oId(u.partner_id)), ...excluir].filter(Boolean))] as number[];
  const equipo = new Set(pInternos);
  const uidCliente = new Set(clientes.filter((u) => !equipo.has(m2oId(u.partner_id) as number)).map((u) => u.id as number));

  const [tracks, logins, pedidos] = await Promise.all([
    sr("website.track", [["visit_datetime", ">=", ini], ["visit_datetime", "<", fin], ["visitor_id.partner_id", "not in", pInternos]],
      ["url", "page_id", "product_id", "visitor_id", "visit_datetime"], { order: "visit_datetime asc", limit: 50000 }),
    sr("res.users.log", [["create_date", ">=", ini], ["create_date", "<", fin]], ["create_uid", "create_date"], { limit: 20000 }),
    sr("sale.order", [["website_id", "!=", false], ["company_id", "=", C], ["date_order", ">=", ini], ["date_order", "<", fin], ["state", "!=", "cancel"],
      ["partner_id", "not in", pInternos], ["partner_id.commercial_partner_id", "not in", pInternos]],
      ["name", "partner_id", "state", "amount_total", "amount_untaxed", "date_order"], { order: "date_order asc", limit: 5000 }),
  ]);

  // Visitante → contacto (sin contacto = visitante sin cuenta)
  const visIds = [...new Set(tracks.map((t) => m2oId(t.visitor_id)).filter(Boolean))] as number[];
  const visitantes = visIds.length ? await ex("website.visitor", "read", [visIds], { fields: ["partner_id"] }) : [];
  const partnerDe: Record<number, number | null> = {};
  for (const v of visitantes) partnerDe[v.id as number] = m2oId(v.partner_id);

  // Cada contacto llevado a su cuenta (commercial_partner_id): así se cruza con Clientes y con WhatsApp
  const pids = [...new Set([...clientes.map((u) => m2oId(u.partner_id)), ...Object.values(partnerDe), ...pedidos.map((o) => m2oId(o.partner_id))].filter(Boolean))] as number[];
  const cuentas: Record<number, number> = {};
  for (let i = 0; i < pids.length; i += 500) {
    for (const p of await ex("res.partner", "read", [pids.slice(i, i + 500)], { fields: ["commercial_partner_id"] })) cuentas[p.id as number] = m2oId(p.commercial_partner_id) ?? (p.id as number);
  }

  // Renglones de los pedidos (sin envío) para saber qué se compra por el portal
  const oIds = pedidos.map((o) => o.id as number);
  const lineas = oIds.length ? await sr("sale.order.line", [["order_id", "in", oIds], ["is_delivery", "=", false], ["display_type", "=", false]],
    ["order_id", "product_id", "product_uom_qty", "price_subtotal"]) : [];

  return {
    ok: true, desde, hasta, generado: new Date().toISOString(),
    internos: pInternos.length, cuentas,
    clientes: clientes.filter((u) => uidCliente.has(u.id as number)).map((u) => ({ uid: u.id, partner_id: m2oId(u.partner_id), nombre: m2oName(u.partner_id) || u.name, login: u.login,
      ultimo_ingreso: u.login_date || null, alta: u.create_date || null, activo: !!u.active })),
    ingresos: logins.filter((l) => uidCliente.has(m2oId(l.create_uid) as number)).map((l) => ({ uid: m2oId(l.create_uid), ts: l.create_date })),
    vistas: tracks.map((t) => ({ ts: t.visit_datetime, visitante: m2oId(t.visitor_id), partner_id: partnerDe[m2oId(t.visitor_id) as number] ?? null,
      url: t.url || null, pagina: m2oName(t.page_id) || null, producto_id: m2oId(t.product_id), producto: m2oName(t.product_id) || null })),
    pedidos: pedidos.map((o) => ({ id: o.id, nombre: o.name, partner_id: m2oId(o.partner_id), cliente: m2oName(o.partner_id), estado: o.state,
      total: o.amount_total, neto: o.amount_untaxed, fecha: o.date_order })),
    lineas: lineas.map((l) => ({ pedido_id: m2oId(l.order_id), producto_id: m2oId(l.product_id), producto: m2oName(l.product_id),
      cantidad: l.product_uom_qty, neto: l.price_subtotal })),
  };
}
