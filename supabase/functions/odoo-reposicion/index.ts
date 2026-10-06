import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ================================================================
// odoo-reposicion — releva de Odoo todo lo que hace falta para
// calcular la reposicion de materias primas y envases.
// SOLO LECTURA sobre Odoo. Guarda una foto en repo_snapshot.
// El calculo (punto de pedido, cantidad sugerida) lo hace la
// pantalla, con los parametros de repo_config / repo_proveedores.
// ================================================================
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const COMPANY_ID = 2;
// RM materias primas, BM envases, SP semielaborados, BM graneles, FP fraccionamiento
const CATEGORIAS = [7, 23, 5, 4, 14];
// Lo que se repone comprando: materias primas y envases.
const CATEGORIAS_COMPRA = [7, 23];
// Historial de precios y lotes: solo lo ya comprometido o recibido.
const ESTADOS_HISTORIA = ["purchase", "done"];
// Un pedido "abierto" es todo lo que ya se puso en marcha y todavia no llego:
// desde el presupuesto pedido hasta la orden confirmada sin recibir.
const ESTADOS_ABIERTOS = ["draft", "sent", "to approve", "purchase"];
const CTX = { allowed_company_ids: [COMPANY_ID], company_id: COMPANY_ID, lang: "es_ES" };

type Row = Record<string, unknown>;
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? (v[0] as number) ?? null : null);
const m2oName = (v: unknown): string => (Array.isArray(v) ? String(v[1] ?? "") : "");
const soloFecha = (v: unknown): string | null => (v ? String(v).split(" ")[0] : null);

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

// Odoo devuelve el mes como "marzo 2026" (lang es_ES). Lo pasamos a 2026-03.
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function mesISO(txt: string): string {
  const p = String(txt).trim().split(/\s+/);
  const i = MESES.indexOf((p[0] || "").toLowerCase());
  if (i < 0 || !p[1]) return String(txt);
  return p[1] + "-" + String(i + 1).padStart(2, "0");
}

// Como se llama cada estado en la pantalla.
const ESTADO_TXT: Record<string, string> = {
  draft: "presupuesto",
  sent: "presupuesto enviado",
  "to approve": "esperando aprobación",
  purchase: "confirmado",
  done: "cerrado",
};

async function relevar() {
  const t0 = Date.now();

  // --- 1. Maestro de productos (stock y costo incluidos) ---
  const prods = await call("product.product", "search_read", [[["categ_id", "in", CATEGORIAS]]], {
    fields: ["id", "default_code", "name", "categ_id", "qty_available", "free_qty", "virtual_available",
      "standard_price", "uom_id", "active"],
    context: { active_test: false },
  }) as Row[];

  const productos = prods.map((p) => ({
    id: p.id as number,
    codigo: String(p.default_code ?? "").trim(),
    nombre: String(p.name ?? ""),
    categoria: m2oName(p.categ_id),
    categoria_id: m2oId(p.categ_id),
    unidad: m2oName(p.uom_id),
    stock: Number(p.qty_available ?? 0),
    libre: Number(p.free_qty ?? 0),
    previsto: Number(p.virtual_available ?? 0),
    costo: Number(p.standard_price ?? 0),
    activo: Boolean(p.active),
    se_compra: CATEGORIAS_COMPRA.includes(m2oId(p.categ_id) ?? -1),
  }));

  // --- 2. Consumo real: lo que las ordenes de fabricacion se comieron, por mes ---
  const domConsumo = [["state", "=", "done"], ["company_id", "=", COMPANY_ID], ["raw_material_production_id", "!=", false]];
  const grupos = await call("stock.move", "read_group",
    [domConsumo, ["product_qty"], ["product_id", "date:month"]], { lazy: false }) as Row[];
  const consumo: Record<number, Record<string, number>> = {};
  for (const g of grupos) {
    const pid = m2oId(g.product_id);
    if (pid == null) continue;
    const mes = mesISO(String(g["date:month"] ?? ""));
    consumo[pid] = consumo[pid] || {};
    consumo[pid][mes] = (consumo[pid][mes] ?? 0) + Number(g.product_qty ?? 0);
  }

  // Primer movimiento con fecha: marca desde cuando hay historia real
  const primero = await call("stock.move", "search_read", [[["state", "=", "done"], ["company_id", "=", COMPANY_ID]]],
    { fields: ["date"], limit: 1, order: "date asc" }) as Row[];
  const desde = primero.length ? soloFecha(primero[0].date) : null;

  // --- 3. Compras: quien vende cada cosa, en que lotes y a que precio ---
  // Se traen tambien los presupuestos y las ordenes sin recibir, para poder avisar
  // que algo YA esta pedido y no volver a comprarlo.
  const todosEstados = [...new Set([...ESTADOS_HISTORIA, ...ESTADOS_ABIERTOS])];
  const ordenes = await call("purchase.order", "search_read",
    [[["state", "in", todosEstados], ["company_id", "=", COMPANY_ID]]],
    { fields: ["id", "name", "partner_id", "date_order", "date_approve", "date_planned", "currency_id", "state"], order: "date_order asc" }) as Row[];
  const ordenById = new Map<number, Row>();
  for (const o of ordenes) ordenById.set(o.id as number, o);

  const ids = ordenes.map((o) => o.id as number);
  const lineasRaw: Row[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await call("purchase.order.line", "search_read",
      [[["order_id", "in", ids.slice(i, i + 50)], ["display_type", "=", false]]],
      { fields: ["id", "order_id", "product_id", "product_qty", "qty_received", "price_unit", "price_subtotal", "date_planned"] }) as Row[];
    lineasRaw.push(...r);
  }

  const compras: Row[] = [];
  const pedidos: Row[] = [];
  for (const l of lineasRaw) {
    const o = ordenById.get(m2oId(l.order_id) ?? -1);
    if (!o) continue;
    const estado = String(o.state ?? "");
    const pedida = Number(l.product_qty ?? 0);
    const recibida = Number(l.qty_received ?? 0);
    const base = {
      oc: String(o.name ?? ""),
      fecha: soloFecha(o.date_approve) ?? soloFecha(o.date_order),
      proveedor: m2oName(o.partner_id),
      producto_id: m2oId(l.product_id),
      cantidad: pedida,
      recibida,
      precio: Number(l.price_unit ?? 0),
      subtotal: Number(l.price_subtotal ?? 0),
      moneda: m2oName(o.currency_id),
      estado,
      estado_txt: ESTADO_TXT[estado] ?? estado,
    };

    if (ESTADOS_HISTORIA.includes(estado)) {
      compras.push({
        ...base,
        // Los liquidos se reciben con merma (piden 10 kg, entran 9,53). Recien por
        // debajo del 95% lo tomamos como mercaderia que todavia no llego.
        pendiente: recibida < pedida * 0.95 ? Number((pedida - recibida).toFixed(3)) : 0,
      });
    }

    // Pedido abierto: presupuesto todavia sin confirmar, o confirmado que no llego.
    const falta = Number((pedida - recibida).toFixed(3));
    const abierto = estado !== "purchase"
      ? ESTADOS_ABIERTOS.includes(estado)
      : recibida < pedida * 0.95;
    if (abierto && falta > 0) {
      pedidos.push({
        ...base,
        falta,
        // Confirmado = ya cuenta como mercaderia en camino para Odoo.
        // Presupuesto = todavia es una intencion, no suma al stock previsto.
        comprometido: estado === "purchase",
        fecha_pedido: soloFecha(o.date_order),
        fecha_prevista: soloFecha(l.date_planned) ?? soloFecha(o.date_planned),
      });
    }
  }

  const datos = {
    generado_en: new Date().toISOString(),
    historia_desde: desde,
    productos,
    consumo,
    compras,
    pedidos,
  };
  return { datos, duracion_ms: Date.now() - t0 };
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
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* sin body = relevar */ }
    const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // modo "ultimo": devuelve la foto guardada sin pegarle a Odoo
    if (body.modo === "ultimo") {
      const { data } = await sb.from("repo_snapshot").select("generado_en,datos").order("generado_en", { ascending: false }).limit(1);
      if (!data || !data.length) {
        return new Response(JSON.stringify({ ok: false, error: "Todavia no hay ninguna foto guardada" }), { headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, cache: true, generado_en: data[0].generado_en, datos: data[0].datos }), { headers: cors });
    }

    const { datos, duracion_ms } = await relevar();
    await sb.from("repo_snapshot").insert({ datos, duracion_ms });
    // Dejamos las ultimas 30 fotos nada mas
    const { data: viejas } = await sb.from("repo_snapshot").select("id").order("generado_en", { ascending: false }).range(30, 999);
    if (viejas && viejas.length) await sb.from("repo_snapshot").delete().in("id", viejas.map((v) => v.id));

    return new Response(JSON.stringify({ ok: true, cache: false, generado_en: datos.generado_en, duracion_ms, datos }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), { headers: cors });
  }
});
