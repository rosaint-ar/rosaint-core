// tn-descuentos — callback de la API de descuentos de Tienda Nube (app 35324).
// Tienda Nube lo llama en cada cambio de la bolsa de una tienda que tenga nuestra promoción, con
// productos, categorías, cantidades, código postal y costo del envío. Respondemos con el descuento
// del envío según public.tn_envio_reglas; Tienda Nube lo cobra en el checkout con cualquier medio de pago.
//
// SEPARADO POR TIENDA (la app está instalada en Rosaint y Augusta): cada llamada trae store_id y solo
// se usan las reglas y la promoción de ESA tienda (public.tn_descuentos_tiendas). Tienda que no está
// habilitada => 204 (sin cambios), así nunca se pisa una con otra.
// Bolsas de prueba de Core (public.tn_carritos_prueba): ahí se aplican también las reglas en borrador.
//
// Abierta a propósito (la llama Tienda Nube, sin sesión de Core): no escribe nada en la tienda, solo
// devuelve el descuento a quien pregunta. Tienda Nube corta a los 800 ms: todo en memoria y el
// registro se guarda después de responder.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
type Rec = Record<string, any>;

// Una sola consulta (función SQL tn_descuentos_datos). La URL registrada en Tienda Nube lleva
// ?forceFunctionRegion=us-west-2 para correr al lado de la base. Si lo guardado tiene más de 15 s
// se responde con eso igual y se refresca por detrás (hasta 5 min); solo la primera vez se espera.
let cache: { leido: number; tiendas: Rec[]; reglas: Rec[]; prueba: Set<string> } | null = null;
let refrescando: Promise<void> | null = null;
function refrescar() {
  refrescando ??= fetch(`${SB_URL}/rest/v1/rpc/tn_descuentos_datos`, { method: "POST", headers: H, body: "{}" })
    .then((x) => x.json())
    .then((j: Rec) => { cache = { leido: Date.now(), tiendas: j.tiendas || [], reglas: j.reglas || [], prueba: new Set(j.prueba || []) }; })
    .finally(() => { refrescando = null; });
  return refrescando;
}
async function datos() {
  const edad = cache ? Date.now() - cache.leido : Infinity;
  if (edad > 300_000) await refrescar();
  else if (edad > 15_000) { const p = refrescar().catch(() => {}); (globalThis as any).EdgeRuntime?.waitUntil?.(p); }
  return cache!;
}

// Misma lógica que tn-envios (simulador), con una diferencia medida el 1/11/2026: Tienda Nube NO vuelve
// a llamar cuando la clienta elige el envío y manda shipping.cost vacío. Sin costo (precio null) solo
// aplican las reglas de MONTO FIJO; las de porcentaje y las que filtran por correo o por
// domicilio/sucursal quedan para el simulador. Envío explícitamente en 0 (gratis) => nada.
function evaluarReglas(reglas: Rec[], carrito: Rec, opcion: Rec, hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) {
  const sinCosto = opcion.precio == null;
  if (!sinCosto && !(opcion.precio > 0)) return null;
  const vale = reglas.filter((r) => {
    if (sinCosto && r.descuento_tipo !== "monto") return false;
    if (r.desde && hoy < r.desde) return false;
    if (r.hasta && hoy > r.hasta) return false;
    if (r.medio !== "todos" && r.medio !== opcion.medio) return false;
    if (r.entrega !== "todas" && r.entrega !== opcion.entrega) return false;
    if (r.min_monto != null && carrito.subtotal < Number(r.min_monto)) return false;
    if (r.max_monto != null && carrito.subtotal > Number(r.max_monto)) return false;
    const u = r.categoria_ids?.length
      ? r.categoria_ids.reduce((s: number, c: number) => s + (carrito.unidades_por_categoria[c] || 0), 0)
      : carrito.unidades;
    if (r.min_unidades != null && u < r.min_unidades) return false;
    return true;
  });
  let mejor: Rec | null = null;
  for (const r of vale) {
    let d = r.descuento_tipo === "porcentaje" ? opcion.precio * Number(r.descuento_valor) / 100 : Number(r.descuento_valor);
    if (r.tope != null) d = Math.min(d, Number(r.tope));
    d = Math.round(d * 100) / 100;
    if (!sinCosto) d = Math.min(d, opcion.precio);
    if (!mejor || d > mejor.descuento || (d === mejor.descuento && r.prioridad < mejor.prioridad)) mejor = { regla: r.nombre, texto: r.texto, descuento: d, prioridad: r.prioridad };
  }
  return mejor;
}

function registrar(fila: Rec) {
  const p = fetch(`${SB_URL}/rest/v1/tn_descuentos_log`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(fila) }).catch(() => {});
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const sinCambios = () => new Response(null, { status: 204 });

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  if (req.method !== "POST") return new Response("ok");
  let b: Rec;
  try { b = await req.json(); } catch { return sinCambios(); }
  const store = Number(b.store_id), cart = Number(b.cart_id);
  try {
    const d = await datos();
    const tienda = d.tiendas.find((x) => Number(x.store_id) === store);
    // Tienda que no conocemos o apagada: no tocamos nada.
    if (!tienda || !tienda.habilitada || !tienda.promotion_id) { registrar({ store_id: store || null, cart_id: cart || null, respuesta: "tienda no habilitada", ms: Date.now() - t0 }); return sinCambios(); }
    if (b.execution_tier && b.execution_tier !== "cross_items") return sinCambios();
    const prueba = d.prueba.has(`${store}|${cart}`);
    const reglas = d.reglas.filter((r) => Number(r.store_id) === store && (r.activa || prueba));
    const porCat: Record<string, number> = {};
    let unidades = 0;
    for (const p of b.products || []) {
      const q = Number(p.quantity) || 0; unidades += q;
      for (const c of p.categories || []) porCat[c.id] = (porCat[c.id] || 0) + q;
    }
    const subtotal = Number(b.totals?.subtotal ?? 0);
    const envio = b.shipping?.cost == null || b.shipping.cost === "" ? null : Number(b.shipping.cost);
    const mejor = evaluarReglas(reglas, { unidades, unidades_por_categoria: porCat, subtotal }, { precio: envio, medio: "?", entrega: "?" });
    const tiene = (b.promotions || []).some((p: Rec) => p.id === tienda.promotion_id);
    const base = { store_id: store, cart_id: cart, envio, cp: b.shipping?.postalcode ?? null, unidades, subtotal, prueba, payload: prueba ? b : null };
    if (mejor && mejor.descuento > 0) {
      const monto = mejor.descuento.toFixed(2);
      registrar({ ...base, respuesta: "descuento", descuento: mejor.descuento, regla: mejor.regla, ms: Date.now() - t0 });
      return json({ commands: [{ command: "create_or_update_discount", specs: {
        promotion_id: tienda.promotion_id, currency: b.currency || "ARS",
        display_text: { "es-ar": mejor.texto, es: mejor.texto }, discount_specs: { type: "fixed", amount: monto },
      } }] });
    }
    if (tiene) {
      registrar({ ...base, respuesta: "quitar", ms: Date.now() - t0 });
      return json({ commands: [{ command: "remove_discount", specs: { scope: "cart", promotion_ids: [tienda.promotion_id] } }] });
    }
    registrar({ ...base, respuesta: "sin descuento", ms: Date.now() - t0 });
    return sinCambios();
  } catch (e) {
    registrar({ store_id: store || null, cart_id: cart || null, respuesta: "error: " + String((e as Error).message || e).slice(0, 300), ms: Date.now() - t0 });
    return sinCambios();
  }
});
