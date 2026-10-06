// ═══════════════════════════════════════════════════════════════════════════
//  Edge Function: ml-costos-sync
//
//  Verifica los costos de Mercado Libre contra la API oficial y actualiza las
//  tablas de Core. Todo queda registrado en ml_costos_sync (qué se miró, qué
//  decía antes, qué dice ahora).
//
//  QUÉ PUEDE VERIFICAR SOLO (vía API):
//    · comisión % por categoría        → /sites/MLA/listing_prices
//    · cortes de precio del cargo fijo → barrido binario sobre fixed_fee
//    · cargo fijo MÍNIMO de cada franja (= tramo hasta 0,3 kg / Flex / retiro)
//    · umbral de envío gratis          → precio donde fixed_fee pasa a 0
//    · envío por peso DESDE $33.000    → /users/{id}/shipping_options/free
//
//  QUÉ NO PUEDE (queda marcado para revisar a mano):
//    · el cargo fijo por PESO. listing_prices ignora el parámetro dimensions y
//      siempre devuelve el mínimo del tramo. La escala por peso solo está
//      publicada en la Ayuda: mercadolibre.com.ar/ayuda/cambios-costos-venta_42400
//    · el envío por debajo de $33.000: ahí el envío gratis es opcional y la API
//      no lo cotiza (devuelve costo 0). Ese tramo se carga de la Ayuda 40538.
//    · el costo de las cuotas. Para gold_pro la API informa el add-on de la
//      publicación Premium (13,4%), que no es el 8,90% de "3 cuotas al mismo
//      precio". Se confirma contra ventas reales o la Ayuda 870.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Tramos de peso de la tabla oficial (kg) con su piso, para poder muestrear el medio.
const TRAMOS_PESO: Array<[number, number]> = [
  [0, 0.3], [0.3, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 3],
  [3, 4], [4, 5], [5, 8], [8, 10], [10, 13], [13, 15],
];
// Franjas de precio del envío gratis. Bajo $33.000 la API no cotiza: no se verifica.
const FRANJAS_ENVIO = [
  { desde: 33000, hasta: 49999, muestra: 40000, verificable: true },
  { desde: 50000, hasta: null,  muestra: 60000, verificable: true },
];

async function token(sb: any): Promise<string> {
  const { data: auth } = await sb.from("ml_auth").select("*").eq("id", 1).single();
  if (!auth?.refresh_token) throw new Error("Falta el refresh token de ML. Reconectá la cuenta.");
  const vence = auth.token_expira_en ? new Date(auth.token_expira_en).getTime() : 0;
  if (auth.access_token && vence > Date.now() + 5 * 60 * 1000) return auth.access_token;

  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: Deno.env.get("ML_APP_ID")!,
      client_secret: Deno.env.get("ML_SECRET")!,
      refresh_token: auth.refresh_token,
    }).toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("No se pudo renovar el token: " + JSON.stringify(d));
  await sb.from("ml_auth").update({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    token_expira_en: new Date(Date.now() + (d.expires_in ?? 21600) * 1000).toISOString(),
    actualizado_en: new Date().toISOString(),
  }).eq("id", 1);
  return d.access_token;
}

const get = async (tk: string, path: string, q: Record<string, string> = {}) => {
  const url = `${ML_API}${path}?` + new URLSearchParams(q).toString();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
};

async function tarifa(tk: string, precio: number, categoria: string, tipo: string) {
  const r = await get(tk, "/sites/MLA/listing_prices", {
    price: String(precio), category_id: categoria, listing_type_id: tipo,
  });
  const d = r.data?.sale_fee_details;
  return d ? { fijo: Number(d.fixed_fee ?? 0), pct: Number(d.percentage_fee ?? 0),
              addon: Number(d.financing_add_on_fee ?? 0) } : null;
}

// Precio exacto donde cambia el cargo fijo, entre `lo` y `hi`.
async function corte(tk: string, lo: number, hi: number, categoria: string, tipo: string) {
  const base = await tarifa(tk, lo, categoria, tipo);
  if (!base) return null;
  let a = lo, b = hi;
  while (b - a > 1) {
    const m = Math.floor((a + b) / 2);
    const t = await tarifa(tk, m, categoria, tipo);
    if (t && t.fijo === base.fijo) a = m; else b = m;
  }
  return b;
}

// Caja cuyo peso volumétrico (lado³/6000) queda por debajo del físico, para que
// el tramo lo defina el peso real y no el volumen.
function ladoCaja(pesoKg: number): number {
  return Math.max(5, Math.floor(Math.cbrt(pesoKg * 6000)) - 1);
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
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const categoria: string = body.categoria || "MLA392701";
    const aplicar: boolean = body.aplicar !== false;
    const tk = await token(sb);

    const hallazgos: any[] = [];
    const registrar = (concepto: string, ant: unknown, nue: unknown, detalle = "", origen = "api") => {
      const a = ant === null || ant === undefined ? null : String(ant);
      const n = nue === null || nue === undefined ? null : String(nue);
      hallazgos.push({ origen, concepto, valor_anterior: a, valor_nuevo: n, coincide: a === n, detalle });
    };

    // ─── 1) Comisión por vender ───
    const t50 = await tarifa(tk, 50000, categoria, "gold_special");
    const { data: pComision } = await sb.from("ml_parametros")
      .select("valor").eq("clave", "comision_estandar_pct").single();
    if (t50) {
      registrar("Comisión por vender (%)", pComision?.valor, t50.pct, `categoría ${categoria}, publicación clásica`);
      if (aplicar && Number(pComision?.valor) !== t50.pct) {
        await sb.from("ml_parametros").update({ valor: t50.pct, actualizado_en: new Date().toISOString() })
          .eq("clave", "comision_estandar_pct");
      }
    }

    // ─── 2) Cortes de precio y cargo fijo mínimo de cada franja ───
    const c1 = await corte(tk, 5000, 20000, categoria, "gold_special");
    const c2 = await corte(tk, 16000, 30000, categoria, "gold_special");
    const c3 = await corte(tk, 25000, 40000, categoria, "gold_special");
    const { data: cuGuardado } = await sb.from("ml_costo_unidad")
      .select("id, precio_desde, precio_hasta, cargo").eq("vigente", true).eq("peso_hasta_kg", 0.3)
      .order("precio_desde");
    const cortesGuardados = (cuGuardado || [])
      .map((r: any) => Number(r.precio_desde)).filter((n: number) => n > 0)
      .concat(Number((await sb.from("ml_parametros").select("valor")
        .eq("clave", "umbral_envio_gratis").single()).data?.valor ?? 0))
      .sort((a: number, b: number) => a - b);
    registrar("Cortes de precio del cargo fijo", cortesGuardados.join(" / "), [c1, c2, c3].join(" / "),
              "detectado por barrido binario sobre fixed_fee");

    for (const f of [{ p: 10000, desde: 0 }, { p: 20000, desde: 15000 }, { p: 28000, desde: 24000 }]) {
      const t = await tarifa(tk, f.p, categoria, "gold_special");
      const guardado = (cuGuardado || []).find((r: any) => Number(r.precio_desde) === f.desde);
      if (t) {
        registrar(`Cargo fijo mínimo franja desde $${f.desde}`, guardado?.cargo, t.fijo,
                  "tramo hasta 0,3 kg — también es el valor de Flex y retiro en domicilio");
        if (aplicar && guardado && Number(guardado.cargo) !== t.fijo) {
          await sb.from("ml_costo_unidad")
            .update({ cargo: t.fijo, actualizado_en: new Date().toISOString(), fuente: "API listing_prices" })
            .eq("id", guardado.id);
        }
      }
    }

    // ─── 3) Umbral de envío gratis ───
    const { data: pUmbral } = await sb.from("ml_parametros")
      .select("valor").eq("clave", "umbral_envio_gratis").single();
    registrar("Umbral de envío gratis", pUmbral?.valor, c3, "precio donde el cargo fijo pasa a $0");
    if (aplicar && c3 && Number(pUmbral?.valor) !== c3) {
      await sb.from("ml_parametros").update({ valor: c3, actualizado_en: new Date().toISOString() })
        .eq("clave", "umbral_envio_gratis");
    }

    // ─── 4) Envío gratis por peso, desde $33.000 ───
    const { data: userMe } = await get(tk, "/users/me", { attributes: "id" });
    const uid = userMe?.id;
    let okCount = 0, cambios = 0, sinDato = 0;
    if (uid) {
      const { data: envGuardado } = await sb.from("ml_costo_envio").select("*").eq("vigente", true);
      for (const fr of FRANJAS_ENVIO) {
        for (const [piso, tope] of TRAMOS_PESO) {
          const medio = (piso + tope) / 2;                 // punto medio del tramo
          const lado = ladoCaja(medio);
          const r = await get(tk, `/users/${uid}/shipping_options/free`, {
            dimensions: `${lado}x${lado}x${lado},${Math.round(medio * 1000)}`,
            item_price: String(fr.muestra),
            listing_type_id: "gold_special",
            condition: "new",
            logistic_type: "drop_off",
            verbose: "true",
          });
          const cob = r.data?.coverage?.all_country;
          const costo = cob?.list_cost;
          // Chequeo de sanidad: que ML haya facturado el peso que quisimos probar.
          const facturado = cob?.billable_weight ? Number(cob.billable_weight) / 1000 : null;
          if (costo == null || costo === 0 || (facturado != null && facturado > tope)) { sinDato++; continue; }
          const g = (envGuardado || []).find((x: any) =>
            Number(x.precio_desde) === fr.desde && Number(x.peso_hasta_kg) === tope);
          if (g && Number(g.costo) !== Number(costo)) {
            cambios++;
            registrar(`Envío · hasta ${tope} kg · desde $${fr.desde}`, g.costo, costo, "shipping_options/free");
            if (aplicar) {
              await sb.from("ml_costo_envio")
                .update({ costo, actualizado_en: new Date().toISOString(), fuente: "API shipping_options" })
                .eq("id", g.id);
            }
          } else if (g) { okCount++; }
        }
      }
    }
    registrar("Envíos verificados", `${okCount + cambios} tramos`,
              `${cambios} con cambio`, `${sinDato} sin dato de la API · tramos hasta 15 kg, desde $33.000`);

    // ─── 5) Lo que la API no puede confirmar ───
    registrar("Cargo fijo por peso", "cargado de la Ayuda oficial", "revisar a mano",
              "listing_prices ignora el peso: solo devuelve el mínimo del tramo. " +
              "Ver mercadolibre.com.ar/ayuda/cambios-costos-venta_42400", "manual");
    registrar("Envío por debajo de $33.000", "cargado de la Ayuda oficial", "revisar a mano",
              "ahí el envío gratis es opcional y la API no lo cotiza. " +
              "Ver mercadolibre.com.ar/ayuda/40538", "manual");
    const { data: cuotas } = await sb.from("ml_costo_cuotas")
      .select("costo_pct").eq("cuotas_cantidad", 3).eq("vigente", true).maybeSingle();
    registrar("Costo de 3 cuotas (%)", cuotas?.costo_pct, "revisar a mano",
              "la API informa el add-on de Premium, no el de '3 cuotas al mismo precio'. " +
              "Ver mercadolibre.com.ar/ayuda/Costos-para-vender-productos_870", "manual");

    if (hallazgos.length) await sb.from("ml_costos_sync").insert(hallazgos);

    const conCambio = hallazgos.filter((h) => !h.coincide && h.origen === "api");
    return json({
      ok: true,
      corrido_en: new Date().toISOString(),
      aplicado: aplicar,
      resumen: {
        verificados: hallazgos.filter((h) => h.origen === "api").length,
        con_cambio: conCambio.length,
        a_revisar_a_mano: hallazgos.filter((h) => h.origen === "manual").length,
      },
      cambios: conCambio,
      hallazgos,
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
