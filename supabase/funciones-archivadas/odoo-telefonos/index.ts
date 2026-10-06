import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// odoo-telefonos (v3) - le da formato a los telefonos que NO tienen ninguno.
// NO agrega ni saca el 9, NO cambia ningun digito: solo agrega el espaciado (+54 [9] area resto-####).
// Ensayo por defecto. Para escribir hace falta confirmar:true Y el secreto TN_PROXY_SECRET.
//
// POR QUE SOLO LOS QUE NO TIENEN FORMATO:
// 230 (Moreno, Bs.As.) y 2302 (General Pico, La Pampa) son los dos codigos de area validos, y mirando
// solo el prefijo no hay forma de saber cual es. Odoo lo resuelve con una libreria que conoce el numero
// entero. Por eso un numero que Odoo YA formateo no se toca nunca: seria romper algo que esta bien.
// En los que no tienen formato el riesgo es solo estetico: los digitos quedan iguales.

const ODOO_URL = Deno.env.get("ODOO_URL")!, ODOO_DB = Deno.env.get("ODOO_DB")!, ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!, ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SECRET = Deno.env.get("TN_PROXY_SECRET") || "";
const COUNTRY_AR = 10;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret", "Content-Type": "application/json" };

// Los 38 codigos de area argentinos de TRES digitos. Todo lo demas (salvo el 11) se toma de cuatro.
const AREA3 = new Set(("220,221,223,230,236,237,249,260,261,263,264,266,280,291,294,297,298,299," +
  "336,341,342,343,345,348,351,353,358,362,364,370,376,379,380,381,383,385,387,388").split(","));
const soloDig = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const yaFormateado = (s: string) => /\d[ -]\d/.test(s);   // ya tiene espacio o guion entre digitos

function telOdoo(raw: unknown): string | null {
  let d = soloDig(raw);
  if (!d) return null;
  if (d.startsWith("54")) d = d.slice(2);
  let nueve = "";
  if (d.length === 11 && d.startsWith("9")) { nueve = "9 "; d = d.slice(1); }
  if (d.length !== 10) return null;                        // largo raro: no se toca
  if (!/^[123]/.test(d)) return null;                      // 0800/0810/0600 y similares: no son geograficos
  const largo = d.startsWith("11") ? 2 : (AREA3.has(d.slice(0, 3)) ? 3 : 4);
  const area = d.slice(0, largo), resto = d.slice(largo);
  return `+54 ${nueve}${area} ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}

let _uid: number | null = null;
async function odooCall(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }) });
  const j = await r.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error)); return j.result;
}
async function auth() { if (_uid) return _uid; _uid = await odooCall("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]) as number; if (!_uid) throw new Error("Auth Odoo fallida"); return _uid; }
async function exec(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await auth(); kwargs.context = { allowed_company_ids: [1, 2], lang: "es_ES", ...((kwargs.context as any) || {}) };
  return await odooCall("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as any;
    const campo = body.campo === "mobile" ? "mobile" : "phone";
    const limite = Math.min(Number(body.limite) || 250, 400);

    if (body.confirmar === true) {
      if (!SECRET) return ok({ ok: false, error: "Escritura bloqueada: falta TN_PROXY_SECRET." });
      if (req.headers.get("x-proxy-secret") !== SECRET) return ok({ ok: false, error: "No autorizado para escribir." });
    }

    const fichas = await exec("res.partner", "search_read",
      [[[campo, "!=", false], ["country_id", "=", COUNTRY_AR]], ["id", "name", campo]],
      { limit: 6000 }) as any[];

    const cambios: any[] = []; const raros: any[] = []; let intactos = 0;
    for (const f of fichas) {
      const actual = String(f[campo] || "").trim();
      if (yaFormateado(actual)) { intactos++; continue; }   // Odoo ya lo escribio: no se toca
      const nuevo = telOdoo(actual);
      if (nuevo === null) { raros.push({ id: f.id, nombre: f.name, valor: actual }); continue; }
      if (nuevo !== actual) cambios.push({ id: f.id, nombre: f.name, antes: actual, despues: nuevo });
    }

    if (body.confirmar !== true) {
      return ok({ ok: true, ensayo: true, campo, revisadas: fichas.length,
        ya_formateados_no_se_tocan: intactos, a_formatear: cambios.length, no_se_pueden: raros.length,
        ejemplos: cambios.slice(0, 20), raros: raros.slice(0, 20) });
    }

    const lote = cambios.slice(0, limite);
    let escritas = 0; const errores: string[] = [];
    for (const c of lote) {
      try { await exec("res.partner", "write", [[c.id], { [campo]: c.despues }]); escritas++; }
      catch (e) { errores.push(`${c.id} ${c.nombre}: ${(e as Error).message}`.slice(0, 200)); }
    }
    return ok({ ok: true, campo, escritas, quedan: Math.max(0, cambios.length - lote.length),
      intactos, no_se_pueden: raros.length, errores: errores.slice(0, 10) });
  } catch (e) { return ok({ ok: false, error: String((e as Error).message || e) }); }
});
