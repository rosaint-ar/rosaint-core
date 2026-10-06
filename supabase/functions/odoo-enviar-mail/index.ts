import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// odoo-enviar-mail v3 (JSON-RPC) - manda mail con adjuntos desde Odoo + diagnostico de encoding
const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const FROM_DEFAULT = "contacto@rosaint.com.ar";
type Rec = Record<string, unknown>;
async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }) });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}
async function authenticate(): Promise<number> { const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]); if (!uid || typeof uid !== "number") throw new Error("Auth fallida"); return uid; }
async function execKw(uid: number, model: string, method: string, args: unknown[], kwargs: Rec = {}) { return await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]); }

// ===== Control de acceso (auditoría 6-oct-2026) =====
// Entra solo: un usuario con sesión de Core, un proceso automático con la clave interna (header
// x-cron-key = secreto CONTROL_CRON_KEY) o el propio servidor (service role). La clave pública que
// está en las páginas NO alcanza: antes dejaba entrar a cualquiera.
async function _accesoPermitido(req: Request): Promise<boolean> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return true;
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
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json; charset=utf-8" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json() as Rec;
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "(sin asunto)");
    const bodyHtml = String(body.body_html || "");
    const from = String(body.from || FROM_DEFAULT);
    const cc = body.cc ? String(body.cc) : null;
    const diag = body.diag === true;
    const adj = (body.attachments as Array<{ filename: string; base64: string; mimetype?: string }>) || [];
    if (!to) return new Response(JSON.stringify({ ok: false, error: "falta destinatario (to)" }), { headers: cors });
    const uid = await authenticate();
    const usr = await execKw(uid, "res.users", "read", [[uid], ["partner_id"]]) as Rec[];
    const authorPid = Array.isArray(usr[0]?.partner_id) ? (usr[0].partner_id as unknown[])[0] as number : false;
    const attIds: number[] = [];
    for (const a of adj) {
      const id = await execKw(uid, "ir.attachment", "create", [{ name: a.filename, datas: a.base64, type: "binary", mimetype: a.mimetype || "application/octet-stream" }]) as number;
      attIds.push(id);
    }
    const vals: Rec = { subject, body_html: bodyHtml, email_from: from, email_to: to, author_id: authorPid };
    if (cc) vals.email_cc = cc;
    if (attIds.length) vals.attachment_ids = [[6, 0, attIds]];
    const mailId = await execKw(uid, "mail.mail", "create", [vals]) as number;
    // leer como quedo guardado (diagnostico de encoding)
    const stored = await execKw(uid, "mail.mail", "read", [[mailId], ["subject", "body_html"]]) as Rec[];
    // diagnóstico: el mail de prueba se cancela enseguida (antes quedaba en la cola de Odoo y el cron lo mandaba)
    if (diag) { try { await execKw(uid, "mail.mail", "write", [[mailId], { state: "cancel" }]); } catch (_) { /* */ } return new Response(JSON.stringify({ ok: true, diag: true, mail_id: mailId, subject_guardado: stored[0]?.subject, body_guardado: String(stored[0]?.body_html || "").slice(0, 200) }), { headers: cors }); }
    try { await execKw(uid, "mail.mail", "send", [[mailId]]); } catch (e) { /* */ }
    const est = await execKw(uid, "mail.mail", "read", [[mailId], ["state", "failure_reason"]]) as Rec[];
    return new Response(JSON.stringify({ ok: est[0]?.state === "sent", mail_id: mailId, estado: est[0]?.state, motivo_falla: est[0]?.failure_reason || null, adjuntos: attIds.length, subject_guardado: stored[0]?.subject }), { headers: cors });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { headers: cors, status: 200 }); }
});
