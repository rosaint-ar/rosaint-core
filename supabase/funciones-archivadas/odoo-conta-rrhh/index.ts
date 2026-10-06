import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-conta-rrhh v2 - crea jornadas + empleados + contratos en company 2
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const C = 2;
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json(); if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error)); return j.result;
}
async function auth(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function ex(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }
function attendances(hIni: number, hFin: number) {
  const dias = ["Lunes","Martes","Miércoles","Jueves","Viernes"]; const out: unknown[] = [];
  for (let d = 0; d < 5; d++) {
    if (hFin <= 12) { out.push([0,0,{ name: dias[d], dayofweek: String(d), hour_from: hIni, hour_to: hFin, day_period: "morning" }]); }
    else { out.push([0,0,{ name: dias[d]+" mañana", dayofweek: String(d), hour_from: hIni, hour_to: 12, day_period: "morning" }]); out.push([0,0,{ name: dias[d]+" tarde", dayofweek: String(d), hour_from: 12, hour_to: hFin, day_period: "afternoon" }]); }
  }
  return out;
}
const JORNADAS = [
  { key: "j30", name: "Rosaint 30 hs (L-V 8 a 14)", ini: 8, fin: 14 },
  { key: "j25", name: "Rosaint 25 hs (L-V 9 a 14)", ini: 9, fin: 14 },
  { key: "j20", name: "Rosaint 20 hs (L-V 8 a 12)", ini: 8, fin: 12 },
];
const EMPLEADOS = [
  { nombre: "Sebastian Ríos",  puesto: "Operario de Producción", jornada: "j30", tipo: "monthly", sueldo: 1000000, hora: 0 },
  { nombre: "Lucía Oviedo",    puesto: "Administrativa",         jornada: "j25", tipo: "monthly", sueldo: 700000,  hora: 0 },
  { nombre: "Daiana Gutiérrez", puesto: "Operaria de Producción", jornada: "j20", tipo: "hourly",  sueldo: 0,       hora: 6000 },
];
Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
    if (body.batch !== "crear") return new Response(JSON.stringify({ ok: false, error: "batch?" }), { headers: cors });
    const dry = body.dry_run !== false;
    const fecha = (body.date_start as string) || "2026-01-01";
    const uid = await auth();
    const ctx = { lang: "es_ES", allowed_company_ids: [C] };
    const pasos: string[] = [];
    const calId: Rec = {};
    for (const j of JORNADAS) {
      const f = await ex(uid, "resource.calendar", "search_read", [[["name", "=", j.name]]], { fields: ["id"], context: ctx }) as Rec[];
      if (f.length) { calId[j.key] = f[0].id; pasos.push(`jornada '${j.name}' ya existía`); continue; }
      if (dry) { calId[j.key] = "(nueva)"; pasos.push(`crear jornada '${j.name}'`); continue; }
      calId[j.key] = await ex(uid, "resource.calendar", "create", [{ name: j.name, tz: "America/Buenos_Aires", company_id: C, attendance_ids: attendances(j.ini, j.fin) }], { context: ctx });
      pasos.push(`jornada '${j.name}' creada (id ${calId[j.key]})`);
    }
    const resultado: Rec[] = [];
    for (const e of EMPLEADOS) {
      const yaEmp = await ex(uid, "hr.employee", "search_read", [[["name", "=", e.nombre], ["company_id", "=", C]]], { fields: ["id"], context: ctx }) as Rec[];
      if (dry) { resultado.push({ empleado: e.nombre, puesto: e.puesto, jornada: JORNADAS.find(j=>j.key===e.jornada)?.name, contrato: e.tipo === "monthly" ? `FIJO $${e.sueldo.toLocaleString("es-AR")}` : `POR HORA $${e.hora.toLocaleString("es-AR")}/h`, ya_existe_en_c2: yaEmp.length > 0 }); continue; }
      if (yaEmp.length) { resultado.push({ empleado: e.nombre, estado: "ya existe en company 2, no se duplica", id: yaEmp[0].id }); continue; }
      const empId = await ex(uid, "hr.employee", "create", [{ name: e.nombre, company_id: C, job_title: e.puesto, resource_calendar_id: calId[e.jornada] }], { context: ctx }) as number;
      const cvals: Rec = { name: "Contrato " + e.nombre, employee_id: empId, company_id: C, resource_calendar_id: calId[e.jornada], wage_type: e.tipo, wage: e.sueldo, date_start: fecha, state: "open" };
      if (e.tipo === "hourly") cvals.hourly_wage = e.hora;
      let contId: unknown, cerr: string | null = null;
      try { contId = await ex(uid, "hr.contract", "create", [cvals], { context: ctx }); } catch (er) { cerr = String((er as Error).message).slice(0, 160); }
      // verificar
      let ver: unknown = null;
      if (contId) { const r = await ex(uid, "hr.contract", "read", [[contId], ["name", "state", "wage", "wage_type", "hourly_wage", "resource_calendar_id"]]) as Rec[]; ver = r[0]; }
      resultado.push({ empleado: e.nombre, empleado_id: empId, contrato_id: contId || null, contrato_error: cerr, verif: ver });
    }
    return new Response(JSON.stringify({ ok: true, dry_run: dry, fecha_inicio_contratos: fecha, pasos, resultado }, null, 2), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
