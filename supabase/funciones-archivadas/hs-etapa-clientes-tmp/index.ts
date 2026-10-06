import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Ya cumplio su trabajo el 24/9/2026: paso a "Cliente" a los 649 contactos que en Odoo si habian comprado.
// Queda desactivada. Se puede borrar del panel de Supabase.
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: "desactivada: ya se ejecuto una sola vez, el 24/9/2026" }), { headers: { "Content-Type": "application/json" } }));
