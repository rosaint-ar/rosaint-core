import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: "deshabilitada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
