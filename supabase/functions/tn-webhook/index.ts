import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// tn-webhook - recibe los avisos de Tienda Nube y dispara la carga a Odoo.
// Contesta 200 al toque (Tienda Nube reintenta si tarda) y sigue trabajando en segundo plano.
// No decide nada por si mismo: solo despierta al modo auto, que es el que mira que hay pendiente.

const AUTO = "https://jayhjhifrfcdecofwgbf.supabase.co/functions/v1/tn-odoo-cargar";

Deno.serve(async (req: Request) => {
  let evento = "";
  try {
    const body = await req.json().catch(() => ({})) as any;
    evento = String(body?.event || "");
  } catch (_) { /* si el cuerpo viene raro igual contestamos 200 */ }

  if (/^order\//.test(evento)) {
    const disparar = fetch(AUTO, {
      method: "POST",
      // tn-odoo-cargar exige credencial (auditoría 6-oct): va con la del servidor
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ modo: "auto" }),
    }).catch(() => { /* el cron de respaldo lo levanta igual */ });
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(disparar); } catch (_) { /* ignorar */ }
  }

  return new Response(JSON.stringify({ ok: true, evento }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
