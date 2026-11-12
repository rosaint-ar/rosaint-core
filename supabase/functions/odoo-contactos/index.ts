import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// ====== odoo-contactos — personas de cada empresa (contactos hijos de Odoo) ======
// Una empresa (cliente o proveedor) puede tener varias personas, cada una con su sector y sus propios
// teléfono y correo: en Odoo son res.partner con parent_id = la empresa (pestaña «Contactos y direcciones»).
// Esta función:
//   sincronizar            → copia todas las personas a la tabla odoo_contactos (cron cada hora)
//   crear {empresa_id, nombre, funcion?, email?, telefono?}
//                          → agrega una persona a una empresa (solo si empresa_id es una empresa) y la sincroniza
//   empresa {empresa_id}   → la empresa y sus personas (para mostrar)
// Escribe SOLO res.partner.create de una persona hija. Guardia de acceso del Core.
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CTX = { lang: "es_ES", allowed_company_ids: [2] };
type Rec = Record<string, unknown>;

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  let res: Response | null = null, texto = "";
  for (let intento = 0; intento < 4; intento++) {
    if (intento) await new Promise((r) => setTimeout(r, 600 * intento + Math.random() * 400));
    res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }) });
    texto = await res.text();
    if (res.ok && texto.trimStart().startsWith("{")) break;
  }
  if (!texto.trimStart().startsWith("{")) throw new Error(`Odoo no respondió bien (HTTP ${res?.status})`);
  const j = JSON.parse(texto);
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error?.message || j.error));
  return j.result;
}
let _uid: number | null = null;
async function odoo(model: string, method: string, args: unknown[], kwargs: Rec = {}) {
  if (!_uid) {
    const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
    if (!uid || typeof uid !== "number") throw new Error("No se pudo entrar a Odoo");
    _uid = uid;
  }
  return await rpc("object", "execute_kw", [ODOO_DB, _uid, ODOO_KEY, model, method, args, { ...kwargs, context: { ...((kwargs.context as Rec) || {}), ...CTX } }]);
}

// mismo criterio que odoo-sync-incremental (cliente_metricas.telefono_wa): 549 + característica + número, sin 0 ni 15
function normWa(tel: unknown): string | null {
  if (!tel) return null;
  let d = String(tel).replace(/[^0-9]/g, ""); if (!d) return null;
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length < 10) return null;
  let local = d; if (local.startsWith("9")) local = local.slice(1);
  local = local.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
  if (local.length < 10) return null;
  return "549" + local;
}
// 5492804517743 → "+54 9 280 451-7743" (como guarda Odoo los teléfonos argentinos)
function telOdoo(wa: string): string {
  const l = wa.slice(3);
  const cod = /^(11|2[0-9]{2}|3[0-9]{2})/.exec(l)?.[0] || l.slice(0, 3);
  const n = l.slice(cod.length);
  return `+54 9 ${cod} ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
}

const db = (ruta: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${ruta}`, { ...init,
  headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, "Content-Type": "application/json", ...(init.headers as Record<string, string> || {}) } });

const CAMPOS = ["id", "name", "parent_id", "function", "email", "phone", "mobile"];
function fila(p: Rec) {
  const par = p.parent_id as [number, string];
  return { partner_id: p.id, nombre: p.name, empresa_id: par[0], empresa_nombre: par[1], funcion: p.function || null,
    email: p.email ? String(p.email).trim().toLowerCase() : null, telefono: p.phone || null, movil: p.mobile || null,
    telefono_wa: normWa(p.phone), movil_wa: normWa(p.mobile), actualizado: new Date().toISOString() };
}

async function sincronizar(ids?: number[]) {
  const dom: unknown[] = [["parent_id", "!=", false], ["type", "=", "contact"], ["active", "=", true]];
  if (ids) dom.push(["id", "in", ids]);
  const ps = await odoo("res.partner", "search_read", [dom], { fields: CAMPOS, limit: 20000 }) as Rec[];
  const filas = ps.map(fila);
  for (let i = 0; i < filas.length; i += 500) {
    const r = await db("odoo_contactos?on_conflict=partner_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(filas.slice(i, i + 500)) });
    if (!r.ok) throw new Error("No se pudo guardar: " + (await r.text()).slice(0, 200));
  }
  let quitados = 0;
  if (!ids) {   // los que ya no están en Odoo (archivados, borrados o pasados a empresa) se sacan de la copia
    const vigentes = new Set(filas.map((f) => f.partner_id));
    const hay = await (await db("odoo_contactos?select=partner_id")).json() as { partner_id: number }[];
    const fuera = hay.map((x) => x.partner_id).filter((id) => !vigentes.has(id));
    if (fuera.length) { await db(`odoo_contactos?partner_id=in.(${fuera.join(",")})`, { method: "DELETE" }); quitados = fuera.length; }
  }
  return { personas: filas.length, con_whatsapp: filas.filter((f) => f.telefono_wa || f.movil_wa).length, con_email: filas.filter((f) => f.email).length, quitados };
}

async function _accesoPermitido(req: Request): Promise<string | null> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return "sistema";
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  if (SRK && a.slice(7) === SRK) return "sistema";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB", Authorization: a } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? String(u.email || u.id) : null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
  const responder = (o: Rec, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const quien = await _accesoPermitido(req);
  if (!quien) return responder({ ok: false, error: "No autorizado: iniciá sesión en Core" }, 401);
  let b: Rec = {}; try { b = await req.json(); } catch { /* */ }
  const accion = String(b.accion || "sincronizar");
  try {
    if (accion === "sincronizar") return responder({ ok: true, ...(await sincronizar()) });

    if (accion === "empresa") {
      const id = Number(b.empresa_id); if (!id) throw new Error("Falta empresa_id");
      const [emp] = await odoo("res.partner", "read", [[id], ["id", "name", "email", "phone", "mobile", "is_company", "child_ids"]]) as Rec[];
      const hijos = await odoo("res.partner", "search_read", [[["parent_id", "=", id], ["type", "=", "contact"]]], { fields: CAMPOS }) as Rec[];
      return responder({ ok: true, empresa: emp, personas: hijos.map(fila) });
    }

    if (accion === "crear") {
      const empresaId = Number(b.empresa_id);
      const nombre = String(b.nombre || "").trim().replace(/\s+/g, " ");
      const funcion = String(b.funcion || "").trim() || false;
      const email = String(b.email || "").trim().toLowerCase() || false;
      const wa = b.telefono ? normWa(b.telefono) : null;
      if (!empresaId) throw new Error("Falta la empresa");
      if (nombre.length < 2) throw new Error("Falta el nombre de la persona");
      if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email as string)) throw new Error("El correo no es válido: " + email);
      if (b.telefono && !wa) throw new Error("El teléfono no es válido: " + b.telefono);
      const [emp] = await odoo("res.partner", "read", [[empresaId], ["id", "name", "is_company", "parent_id"]]) as Rec[];
      if (!emp) throw new Error("No existe esa empresa en Odoo");
      if (!emp.is_company) throw new Error(`«${emp.name}» no está marcada como empresa en Odoo: no se le pueden colgar personas`);
      // no duplicar: si ya hay una persona de esa empresa con ese teléfono o correo, se devuelve esa
      const dom: unknown[] = [["parent_id", "=", empresaId], ["type", "=", "contact"]];
      const ya = (await odoo("res.partner", "search_read", [dom], { fields: CAMPOS }) as Rec[]).map(fila)
        .find((p) => (wa && (p.telefono_wa === wa || p.movil_wa === wa)) || (email && p.email === email));
      if (ya) { await sincronizar([ya.partner_id as number]); return responder({ ok: true, ya_existia: true, persona: ya }); }
      const id = await odoo("res.partner", "create", [{ name: nombre, parent_id: empresaId, type: "contact", function: funcion, email,
        phone: wa ? telOdoo(wa) : false, comment: `Cargada desde el Core por ${quien}` }]) as number;
      await sincronizar([id]);
      const [p] = await odoo("res.partner", "search_read", [[["id", "=", id]]], { fields: CAMPOS }) as Rec[];
      return responder({ ok: true, creada: true, persona: fila(p) });
    }
    throw new Error("Acción desconocida: " + accion);
  } catch (e) {
    return responder({ ok: false, error: String((e as Error).message || e) });
  }
});
