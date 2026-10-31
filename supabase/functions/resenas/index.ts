import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// resenas v1 (31-oct-2026) — reseñas propias de rosaint.online (reemplazan a Trusty).
// PÚBLICA a propósito (la llama la web sin sesión): solo lee publicadas y escribe con un token
// de pedido de un solo uso por producto. Desplegar con --no-verify-jwt.
//   GET  ?formato=google            → feed XML de Google (product reviews 2.3): lo lee /api/reviews de
//                                     la web y sirve tal cual para Merchant Center.
//   GET  ?accion=pedido&t=TOKEN      → qué productos puede opinar ese pedido.
//   POST {accion:"opinar", t, autor, items:[{sku, path, puntaje, titulo, texto}]}
//   POST {accion:"baja", t}          → no volver a escribirle por ese pedido.
// Lo que entra queda PENDIENTE; se modera en Core (comercial/resenas.html).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://rosaint.online";
const ORIGENES = new Set([SITE, "https://www.rosaint.online", "http://localhost:8807", "http://127.0.0.1:8807"]);
type Rec = Record<string, unknown>;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ORIGENES.has(o) ? o : SITE, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
function json(req: Request, data: unknown, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });
}
async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const xml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const limpio = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

// Mismo formato que el feed de Trusty, así /api/reviews y Merchant Center no cambian de lector.
async function feedGoogle(): Promise<string> {
  const filas = await rest("resenas?estado=eq.publicada&select=id,origen,origen_id,pedido_tn,sku,producto_path,producto_nombre,puntaje,titulo,texto,autor,creada_en,publicada_en&order=creada_en.desc&limit=5000") as Rec[];
  const reviews = filas.map((r) => {
    const url = SITE + r.producto_path;
    return `<review><review_id>${xml(r.origen_id || r.id)}</review_id><reviewer><name>${xml(r.autor)}</name></reviewer>` +
      `<review_timestamp>${xml(new Date(String(r.creada_en)).toISOString())}</review_timestamp>` +
      (r.titulo ? `<title>${xml(r.titulo)}</title>` : "") + `<content>${xml(r.texto || r.titulo || "")}</content>` +
      `<review_url type="singleton">${xml(url)}</review_url><ratings><overall min="1" max="5">${r.puntaje}</overall></ratings>` +
      (r.pedido_tn ? `<transaction_id>${xml(r.pedido_tn)}</transaction_id><collection_method>post_fulfillment</collection_method>` : "") +
      `<products><product><product_ids>${r.sku ? `<mpns><mpn>${xml(r.sku)}</mpn></mpns>` : ""}<brands><brand>Rosaint</brand></brands></product_ids>` +
      `<product_name>${xml(r.producto_nombre || "")}</product_name><product_url>${xml(url)}</product_url></product></products></review>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.3/product_reviews.xsd">` +
    `<version>2.3</version><aggregator><name>Rosaint</name></aggregator><publisher><name>Rosaint</name><favicon>${SITE}/assets/favicon-32.png</favicon></publisher><reviews>${reviews.join("")}</reviews></feed>`;
}

async function pedidoPorToken(t: unknown): Promise<Rec | null> {
  if (typeof t !== "string" || !/^[0-9a-f]{48}$/.test(t)) return null;
  const filas = await rest(`resenas_pedidos?token=eq.${t}&select=pedido_tn,nombre,email,productos,baja`) as Rec[];
  return filas[0] || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const u = new URL(req.url);
    if (req.method === "GET" && u.searchParams.get("formato") === "google") {
      return new Response(await feedGoogle(), { headers: { ...cors(req), "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    if (req.method === "GET" && u.searchParams.get("accion") === "pedido") {
      const p = await pedidoPorToken(u.searchParams.get("t"));
      if (!p) return json(req, { ok: false, error: "enlace_invalido" }, 404);
      const ya = await rest(`resenas?pedido_tn=eq.${p.pedido_tn}&select=sku`) as Rec[];
      const hechas = new Set(ya.map((r) => String(r.sku)));
      const productos = (p.productos as Rec[]).map((x) => ({ sku: x.sku, nombre: x.nombre, imagen: x.imagen, ya_opino: hechas.has(String(x.sku)) }));
      return json(req, { ok: true, nombre: String(p.nombre || "").split(" ")[0], productos, baja: p.baja });
    }
    if (req.method !== "POST") return json(req, { ok: false, error: "metodo" }, 405);
    const body = await req.json().catch(() => ({})) as Rec;
    const p = await pedidoPorToken(body.t);
    if (!p) return json(req, { ok: false, error: "enlace_invalido" }, 404);

    if (body.accion === "baja") {
      await rest(`resenas_pedidos?pedido_tn=eq.${p.pedido_tn}`, { method: "PATCH", body: JSON.stringify({ baja: true }) });
      return json(req, { ok: true });
    }
    if (body.accion !== "opinar") return json(req, { ok: false, error: "accion" }, 400);
    const autor = limpio(body.autor, 60);
    if (!autor) return json(req, { ok: false, error: "falta_nombre" }, 400);
    const delPedido = new Map((p.productos as Rec[]).map((x) => [String(x.sku), x]));
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30) as Rec[];
    const filas: Rec[] = [];
    for (const it of items) {
      const sku = String(it.sku ?? ""), prod = delPedido.get(sku), puntaje = Number(it.puntaje);
      const path = String(it.path ?? "");
      if (!prod || !Number.isInteger(puntaje) || puntaje < 1 || puntaje > 5) continue;
      if (!/^\/productos\/[a-z0-9-]+\/$/.test(path)) continue;
      const prueba = Number(p.pedido_tn) < 0; // pedido de prueba de resenas-pedir: nunca se publica
      filas.push({ origen: "rosaint", pedido_tn: p.pedido_tn, sku, producto_path: path, producto_nombre: limpio(prod.nombre, 200),
        puntaje, titulo: limpio(it.titulo, 120) || null, texto: limpio(it.texto, 2000) || null, autor, email: p.email, verificada: !prueba,
        ...(prueba ? { estado: "rechazada", motivo_rechazo: "prueba", moderada_por: "prueba automática" } : {}) });
    }
    if (!filas.length) return json(req, { ok: false, error: "sin_items" }, 400);
    // Un producto por pedido: si ya opinó ese, no se pisa (unique pedido_tn, sku).
    const guardadas = await rest("resenas?on_conflict=pedido_tn,sku", { method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" }, body: JSON.stringify(filas) }) as Rec[];
    await rest(`resenas_pedidos?pedido_tn=eq.${p.pedido_tn}`, { method: "PATCH", body: JSON.stringify({ respondido_en: new Date().toISOString() }) });
    return json(req, { ok: true, guardadas: guardadas.length });
  } catch (e) {
    console.error(e);
    return json(req, { ok: false, error: "interno" }, 500);
  }
});
