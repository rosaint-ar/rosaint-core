import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retirada. Era un diagnostico temporal del login de Odoo (14-sep-2026), ya resuelto.
// Se puede borrar del proyecto sin consecuencias: no la usa nadie.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: false, error: "Funcion de diagnostico retirada" }), {
    headers: { "Content-Type": "application/json" },
    status: 410,
  })
);
