import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ ok: true, msg: "sin operacion" }), { headers: { "Content-Type": "application/json" } }));
