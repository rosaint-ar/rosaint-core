import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Función de diagnóstico DESACTIVADA (6-oct-2026). Se usó para relevamientos de solo lectura durante la auditoría
// de Producción. No hace nada; queda solo para no perder el lugar (el proyecto está en el tope de funciones).
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: "desactivada" }), { headers: { "Content-Type": "application/json" } }));
