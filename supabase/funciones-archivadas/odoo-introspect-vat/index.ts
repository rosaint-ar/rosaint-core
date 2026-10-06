import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Función de sondeo desactivada. La descarga de Libros de IVA vive en odoo-libros-iva.
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: "deshabilitada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
