import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Desactivada. Se uso el 2/10/2026 para crear y ubicar el campo "Nombre de fantasia" en la ficha de contacto de Odoo.
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: "desactivada" }), { headers: { "Content-Type": "application/json" } }));
