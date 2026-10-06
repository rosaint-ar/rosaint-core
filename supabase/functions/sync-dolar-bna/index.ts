// Sync cotización dólar oficial venta (BNA)
// Fuente: dolarapi.com — CORS-friendly, sin API key, refleja el BNA.
// Se programa via pg_cron: L-V 10:00, 12:00 y 15:00 ART.
// También callable desde el módulo Precios (botón "Sincronizar ahora").
//
// v3: además de guardar en Supabase, carga la cotización en Odoo
// (res.currency.rate) para la company 2 = VELAZQUEZ DIEGO MARTIN.
// Odoo no trae proveedor de cotización para Argentina, por eso se escribe acá.
// Solo toca la fecha del día: nunca modifica cotizaciones históricas.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const ODOO_URL = Deno.env.get('ODOO_URL');
const ODOO_DB = Deno.env.get('ODOO_DB');
const ODOO_LOGIN = Deno.env.get('ODOO_LOGIN');
const ODOO_KEY = Deno.env.get('ODOO_KEY');
const ODOO_COMPANY = 2; // VELAZQUEZ DIEGO MARTIN

async function odooRpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
  });
  const j = await r.json();
  if (j.error) throw new Error('Odoo: ' + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}

// Carga la cotización del día en Odoo. Devuelve qué hizo, sin tirar la función abajo si falla.
async function cargarEnOdoo(fecha: string, venta: number) {
  if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_KEY) return { ok: false, error: 'faltan credenciales de Odoo' };

  const uid = await odooRpc('common', 'authenticate', [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
  if (!uid || typeof uid !== 'number') return { ok: false, error: 'auth Odoo fallida' };

  const ctx = { allowed_company_ids: [ODOO_COMPANY], lang: 'es_ES' };
  const kw = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
    odooRpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_KEY, model, method, args, { ...kwargs, context: { ...ctx, ...((kwargs.context as Record<string, unknown>) || {}) } }]);

  const usd = await kw('res.currency', 'search', [[['name', '=', 'USD']]], { limit: 1 }) as number[];
  if (!usd.length) return { ok: false, error: 'no existe la moneda USD en Odoo' };

  // rate = cuántos USD equivalen a 1 peso (así lo guarda Odoo); el inverso es la cotización visible.
  const rate = 1 / venta;
  const dom = [['currency_id', '=', usd[0]], ['company_id', '=', ODOO_COMPANY], ['name', '=', fecha]];
  const existente = await kw('res.currency.rate', 'search_read', [dom], { fields: ['id', 'rate', 'inverse_company_rate'], limit: 1 }) as Record<string, unknown>[];

  let accion: string, id: number, anterior: number | null = null;
  if (existente.length) {
    id = existente[0].id as number;
    anterior = Number(existente[0].inverse_company_rate);
    if (Math.abs(anterior - venta) < 0.005) return { ok: true, accion: 'sin cambios', id, cotizacion: anterior };
    await kw('res.currency.rate', 'write', [[id], { rate }]);
    accion = 'actualizada';
  } else {
    id = await kw('res.currency.rate', 'create', [{ currency_id: usd[0], company_id: ODOO_COMPANY, name: fecha, rate }]) as number;
    accion = 'creada';
  }

  const verif = await kw('res.currency.rate', 'read', [[id]], { fields: ['name', 'inverse_company_rate'] }) as Record<string, unknown>[];
  return { ok: true, accion, id, fecha, anterior, cotizacion: Number(verif[0].inverse_company_rate) };
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/oficial', {
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`dolarapi HTTP ${r.status}`);
    const d = await r.json();

    const venta = Number(d?.venta);
    if (!isFinite(venta) || venta <= 0) throw new Error(`venta inválida: ${d?.venta}`);

    // Fecha del ahora en zona ART (UTC-3)
    const ahora = new Date();
    const artOffset = -3 * 60 * 60 * 1000;
    const fecha = new Date(ahora.getTime() + artOffset).toISOString().slice(0, 10);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error } = await supabase.from('cotizaciones_dolar').upsert({
      fecha,
      venta_oficial: venta,
      fuente: 'BNA-auto',
      url_origen: 'https://dolarapi.com/v1/dolares/oficial',
    }, { onConflict: 'fecha' });

    if (error) throw new Error(`Supabase upsert: ${error.message}`);

    // Odoo va aparte: si falla, el guardado en Supabase ya quedó hecho y se reporta el error.
    let odoo: Record<string, unknown>;
    try {
      odoo = await cargarEnOdoo(fecha, venta) as Record<string, unknown>;
    } catch (e) {
      odoo = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    return new Response(JSON.stringify({
      ok: true,
      fecha,
      venta,
      compra: Number(d?.compra) || null,
      fuente_api: d?.nombre || null,
      timestamp_api: d?.fechaActualizacion || null,
      odoo,
      sincronizado_en: new Date().toISOString(),
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
