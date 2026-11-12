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
// UN SOLO CALLBACK POR APP: la app 35324 también tiene la promoción «Rosaint · Rutinas complementarias
// 5%» (motor PHP en rosaint.online, rosaint-rutinas-v38.php). Tienda Nube llama a UNA sola URL, así que
// esta función le reenvía cada bolsa de Rosaint al motor de rutinas (en paralelo) y junta sus comandos con
// los nuestros. La URL con su clave vive en el secreto RUTINAS_CALLBACK_URL (nunca en el código).
const RUTINAS = Deno.env.get("RUTINAS_CALLBACK_URL") || "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
type Rec = Record<string, any>;

// La configuración (tiendas, reglas, bolsas de prueba) se lee del archivo público tn-publico/tn-descuentos-v2.json
// que publica tn-envios (accion publicar_descuentos) cada vez que cambia algo: lo sirve la CDN cerca de
// sa-east-1, mucho más rápido que ir a la base en us-west-2. Si el archivo falla, se lee la base
// (función SQL tn_descuentos_datos). Si lo guardado tiene más de 15 s se responde con eso igual y se refresca por
// detrás (hasta 5 min); solo la primera vez se espera.
const ARCHIVO = `${SB_URL}/storage/v1/object/public/tn-publico/tn-descuentos-v2.json`;
let cache: { leido: number; tiendas: Rec[]; reglas: Rec[]; prueba: Set<string>; cp: [number, number, string][] } | null = null;

// ZONA (12/11/2026). Tienda Nube manda solo el código postal. CPA (S2000ABC): la letra ES la provincia
// (ISO 3166-2:AR); CP de 4 dígitos: tabla cp_provincias publicada en rangos [desde, hasta, letra].
// Misma lógica en tn-envios (simulador) y en la bolsa de rosaint.online (live.js shippingBonusQuote).
const LETRAS = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]$/;
export function cpPartes(cp: unknown) { const m = String(cp ?? "").toUpperCase().replace(/\s/g, "").match(/^([A-Z])?(\d{4})/); return m ? { cp: m[2], letra: m[1] && LETRAS.test(m[1]) ? m[1] : "" } : null; }
export function provinciaDe(cp: unknown, rangos: [number, number, string][]) {
  const x = cpPartes(cp); if (!x) return null; if (x.letra) return x.letra;
  const n = Number(x.cp); let a = 0, b = rangos.length - 1;
  while (a <= b) { const m = (a + b) >> 1, r = rangos[m]; if (n < r[0]) b = m - 1; else if (n > r[1]) a = m + 1; else return r[2]; }
  return null;
}
export function cpEnLista(lista: unknown, cp: string) {
  for (const parte of String(lista ?? "").replace(/\s*-\s*/g, "-").split(/[,;\s]+/)) {
    const m = parte.match(/^(\d{4})(?:-(\d{4}))?$/); if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]), n = Number(cp);
    if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
  }
  return false;
}
// todas = siempre; incluir = CP en la lista o provincia marcada; excluir = ni CP en la lista ni provincia marcada.
// Sin CP, o con provincias en juego y CP desconocido: la regla con zona NO vale (no se da donde no corresponde).
export function zonaOk(r: Rec, cp: unknown, rangos: [number, number, string][]) {
  const modo = r.zona_modo || "todas"; if (modo === "todas") return true;
  const x = cpPartes(cp); if (!x) return false;
  const enCps = cpEnLista(r.zona_cps, x.cp), provs: string[] = r.zona_provincias || [];
  if (modo === "incluir") { if (enCps) return true; const p = provinciaDe(cp, rangos); return !!p && provs.includes(p); }
  if (enCps) return false; if (!provs.length) return true;
  const p = provinciaDe(cp, rangos); return !!p && !provs.includes(p);
}
let refrescando: Promise<void> | null = null;
function refrescar() {
  refrescando ??= fetch(ARCHIVO)
    .then((x) => { if (!x.ok) throw new Error("archivo " + x.status); return x.json(); })
    .catch(() => fetch(`${SB_URL}/rest/v1/rpc/tn_descuentos_datos`, { method: "POST", headers: H, body: "{}" }).then((x) => x.json()))
    .then((j: Rec) => { cache = { leido: Date.now(), tiendas: j.tiendas || [], reglas: j.reglas || [], prueba: new Set(j.prueba || []), cp: j.cp || [] }; })
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
// a llamar cuando la clienta elige el envío y manda shipping.cost vacío. Sin costo (precio null)
// aplican las de MONTO FIJO y las de % que tengan «envío de referencia» (se calcula sobre ese monto);
// cuando el envío llega, el % se calcula sobre el real. Las que filtran por correo o por
// domicilio/sucursal quedan para el simulador. Envío explícitamente en 0 (gratis) => nada.
function evaluarReglas(reglas: Rec[], carrito: Rec, opcion: Rec, hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) {
  const sinCosto = opcion.precio == null;
  if (!sinCosto && !(opcion.precio > 0)) return null;
  const vale = reglas.filter((r) => {
    if (sinCosto && r.descuento_tipo !== "monto" && !(Number(r.referencia_envio) > 0)) return false;
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
    if (!zonaOk(r, carrito.cp, carrito.rangos || [])) return false;
    return true;
  });
  let mejor: Rec | null = null;
  for (const r of vale) {
    const base = sinCosto ? Number(r.referencia_envio) : opcion.precio;
    let d = r.descuento_tipo === "porcentaje" ? base * Number(r.descuento_valor) / 100 : Number(r.descuento_valor);
    if (r.tope != null) d = Math.min(d, Number(r.tope));
    d = Math.round(d * 100) / 100;
    if (!sinCosto) d = Math.min(d, opcion.precio);
    if (!mejor || d > mejor.descuento || (d === mejor.descuento && r.prioridad < mejor.prioridad)) mejor = { regla: r.nombre, texto: r.texto, descuento: d, prioridad: r.prioridad, estimado: sinCosto && r.descuento_tipo === "porcentaje" };
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

// Pide al motor de rutinas sus comandos para esta bolsa (solo Rosaint). Corta a los 600 ms: si no llega,
// se responde igual con lo nuestro (Tienda Nube corta a los 800 ms y dejaría la bolsa sin cambios).
async function comandosRutinas(raw: string, store: number): Promise<{ cmds: Rec[]; estado: string }> {
  if (store !== 385079 || !RUTINAS) return { cmds: [], estado: RUTINAS ? '' : 'rutinas sin configurar' };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 600);
  try {
    const r = await fetch(RUTINAS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw, signal: ctl.signal });
    if (r.status === 204) return { cmds: [], estado: 'rutinas 204' };
    if (!r.ok) return { cmds: [], estado: 'rutinas ' + r.status };
    const j = await r.json(); return { cmds: Array.isArray(j?.commands) ? j.commands : [], estado: 'rutinas ' + (j?.commands?.length || 0) + ' cmd' };
  } catch (e) { return { cmds: [], estado: 'rutinas error ' + String((e as Error).name || e) }; }
  finally { clearTimeout(t); }
}

// Nuestros comandos (bonificación de envío). Devuelve también la fila del registro.
async function comandosEnvio(b: Rec, store: number, cart: number, t0: number): Promise<{ cmds: Rec[]; log: Rec }> {
  const d = await datos();
  const tienda = d.tiendas.find((x) => Number(x.store_id) === store);
  // Tienda que no conocemos o apagada: no tocamos nada.
  if (!tienda || !tienda.habilitada || !tienda.promotion_id) return { cmds: [], log: { store_id: store || null, cart_id: cart || null, respuesta: 'tienda no habilitada' } };
  if (b.execution_tier && b.execution_tier !== 'cross_items') return { cmds: [], log: { store_id: store, cart_id: cart, respuesta: 'tier ' + b.execution_tier } };
  const prueba = d.prueba.has(`${store}|${cart}`);
  const reglas = d.reglas.filter((r) => Number(r.store_id) === store && (r.activa || prueba));
  const porCat: Record<string, number> = {};
  let unidades = 0;
  for (const p of b.products || []) {
    const q = Number(p.quantity) || 0; unidades += q;
    for (const c of p.categories || []) porCat[c.id] = (porCat[c.id] || 0) + q;
  }
  const subtotal = Number(b.totals?.subtotal ?? 0);
  const envio = b.shipping?.cost == null || b.shipping.cost === '' ? null : Number(b.shipping.cost);
  const tiene = (b.promotions || []).some((p: Rec) => p.id === tienda.promotion_id);
  // CUIDAR EL MARGEN (pedido de Diego 1/11): la bonificación no se suma a otros descuentos, salvo las
  // reglas marcadas «acumula». totals.total_discount trae también NUESTRA bonificación anterior, por
  // eso solo se usa cuando la nuestra no está; la rutina se reconoce por sus pares de productos.
  const variantes = new Set((b.products || []).map((p: Rec) => Number(p.variant_id)));
  const otros = (b.coupons || []).length ? 'cupón'
    : (b.products || []).some((p: Rec) => Number(p.compare_at_price) > Number(p.price)) ? 'producto en oferta'
    : (tienda.excluir_pares || []).some((par: number[]) => par.every((v) => variantes.has(Number(v)))) ? 'rutina'
    : (!tiene && Number(b.totals?.total_discount || 0) > 0) ? 'otro descuento' : '';
  const aplicables = otros ? reglas.filter((r) => r.acumula) : reglas;
  const mejor = evaluarReglas(aplicables, { unidades, unidades_por_categoria: porCat, subtotal, cp: b.shipping?.postalcode ?? null, rangos: d.cp }, { precio: envio, medio: '?', entrega: '?' });
  const base = { store_id: store, cart_id: cart, envio, cp: b.shipping?.postalcode ?? null, unidades, subtotal, prueba, payload: prueba ? b : null };
  if (mejor && mejor.descuento > 0) return { log: { ...base, respuesta: 'descuento', descuento: mejor.descuento, regla: mejor.regla + (mejor.estimado ? ' · sobre envío de referencia' : '') },
    cmds: [{ command: 'create_or_update_discount', specs: { promotion_id: tienda.promotion_id, currency: b.currency || 'ARS',
      display_text: { 'es-ar': mejor.texto, es: mejor.texto }, discount_specs: { type: 'fixed', amount: mejor.descuento.toFixed(2) } } }] };
  const porque = otros && reglas.length ? ` (no acumula: ${otros})` : '';
  if (tiene) return { log: { ...base, respuesta: 'quitar' + porque }, cmds: [{ command: 'remove_discount', specs: { scope: 'cart', promotion_ids: [tienda.promotion_id] } }] };
  return { log: { ...base, respuesta: 'sin descuento' + porque }, cmds: [] };
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  if (req.method !== 'POST') return new Response('ok');
  const raw = await req.text();
  let b: Rec;
  try { b = JSON.parse(raw); } catch { return sinCambios(); }
  const store = Number(b.store_id), cart = Number(b.cart_id);
  // Tienda Nube consulta por separado cada nivel: «line_item» (rutinas, descuento por producto) y
  // «cross_items» (nuestra bonificación, sobre la bolsa). Cada uno va solo a quien le corresponde, así el
  // de rutinas no espera a la base y el nuestro no espera a rosaint.online. Sin nivel => los dos.
  // La URL registrada lleva ?forceFunctionRegion=sa-east-1 (al lado de Tienda Nube y de rosaint.online).
  const tier = String(b.execution_tier || '');
  const pRutinas = tier === 'cross_items' ? Promise.resolve({ cmds: [] as Rec[], estado: '' }) : comandosRutinas(raw, store);
  let nuestros: { cmds: Rec[]; log: Rec };
  if (tier === 'line_item') nuestros = { cmds: [], log: { store_id: store || null, cart_id: cart || null, respuesta: 'tier line_item' } };
  else {
    try { nuestros = await comandosEnvio(b, store, cart, t0); }
    catch (e) { nuestros = { cmds: [], log: { store_id: store || null, cart_id: cart || null, respuesta: 'error: ' + String((e as Error).message || e).slice(0, 300) } }; }
  }
  const rut = await pRutinas;
  const commands = [...rut.cmds, ...nuestros.cmds];
  // cart_id 0 = latido del cron «tn-descuentos-latido» (mantiene caliente la conexión con rutinas): no se registra.
  if (cart === 0) return json({ latido: true, rutinas: rut.estado, ms: Date.now() - t0 });
  registrar({ ...nuestros.log, respuesta: [nuestros.log.respuesta, rut.estado].filter(Boolean).join(' · '), ms: Date.now() - t0 });
  return commands.length ? json({ commands }) : sinCambios();
});
