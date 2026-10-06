import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// tn-buscar-clientes - SOLO LECTURA. Recibe una lista de mails y devuelve el nombre y el documento
// que tiene Tienda Nube para cada uno. Sirve para recuperar los nombres de los contactos que entraron
// por el checkout sin nombre. No escribe en ningun lado.
// Body: { emails: ["...", "..."] }

const STORE = 385079;
const TN_API = "https://api.tiendanube.com/v1";
const UA = "Rosaint Odoo (rosaint.ar@gmail.com)";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };


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
  const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as any;
    const buscados = new Set((body.emails || []).map((e: string) => String(e).trim().toLowerCase()).filter(Boolean));
    if (!buscados.size) return ok({ ok: false, error: "Falta la lista de emails" });

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await sb.schema("mcp").from("stores").select("access_token").eq("store_id", STORE).single();
    const tok = data?.access_token;
    if (!tok) return ok({ ok: false, error: "No hay token de Tienda Nube" });

    const mapa: Record<string, { nombre: string; doc: string | null }> = {};
    let revisados = 0;
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`${TN_API}/${STORE}/customers?per_page=200&page=${page}&fields=id,name,email,identification`,
        { headers: { Authentication: `bearer ${tok}`, "User-Agent": UA, "Content-Type": "application/json" } });
      if (!r.ok) break;
      const lote = await r.json();
      if (!Array.isArray(lote) || !lote.length) break;
      revisados += lote.length;
      for (const c of lote) {
        const mail = String(c.email || "").trim().toLowerCase();
        const nombre = String(c.name || "").trim();
        if (!mail || !nombre || !buscados.has(mail)) continue;
        const doc = String(c.identification || "").replace(/\D/g, "") || null;
        // si el mismo mail aparece mas de una vez, gana el nombre mas completo
        if (!mapa[mail] || nombre.length > mapa[mail].nombre.length) mapa[mail] = { nombre, doc };
      }
      if (lote.length < 200) break;
    }

    const encontrados = Object.keys(mapa);
    const faltan = [...buscados].filter((m) => !mapa[m as string]);
    return ok({ ok: true, pedidos: buscados.size, clientes_revisados: revisados,
      encontrados: encontrados.length, sin_encontrar: faltan.length, mapa, faltan });
  } catch (e) { return ok({ ok: false, error: String((e as Error).message || e) }); }
});
