import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// RETIRADA. Fue una puerta generica de lectura a Odoo, usada dos veces en
// sept-2026 para disenar Stock y reposicion y Proveedores. Se desactiva al
// terminar cada analisis para no dejar abierto un acceso a todo el catalogo,
// las compras y los costos. Lo que los modulos necesitan lo sirven
// `odoo-reposicion` y `odoo-proveedores`, que devuelven solo eso.
Deno.serve(() =>
  new Response(
    JSON.stringify({ ok: false, error: "Funcion retirada. Usar odoo-reposicion u odoo-proveedores." }),
    { headers: { "Content-Type": "application/json" }, status: 410 },
  )
);
