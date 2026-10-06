import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ deprecated: true, message: "Función retirada por seguridad." }), { status: 410, headers: { "Content-Type": "application/json" } }));
