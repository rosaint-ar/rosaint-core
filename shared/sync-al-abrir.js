// Sincronizar al abrir (27-oct-2026).
// Las pantallas que leen una foto guardada de Odoo / Tienda Nube / Mercado Libre se mantienen al día solas:
// al abrirlas, si la última sincronización tiene más de `maxMin` minutos (o no hay ninguna), se corre en
// segundo plano. Mientras tanto se ve lo último guardado. El botón queda para forzarla a mano.
// Solo para sincronizaciones de LECTURA (las que escriben en Odoo/TN/ML nunca se corren solas).
//
//   syncAlAbrir({
//     ultimo: async () => fechaISO | null,   // cuándo fue la última sincronización
//     maxMin: 30,                            // cuánto tiempo se considera al día
//     correr: async () => { ... },           // la misma función que llama el botón
//   });
// Devuelve true si sincronizó. Nunca tira error: si falla, la pantalla sigue con lo guardado.
(function () {
  const corriendo = new Set();
  window.syncAlAbrir = async function ({ ultimo, maxMin, correr, clave }) {
    const k = clave || String(correr);
    if (corriendo.has(k)) return false;   // una sola vez a la vez por pantalla
    try {
      const ts = await ultimo();
      const edadMin = ts ? (Date.now() - new Date(ts).getTime()) / 60000 : Infinity;
      if (edadMin < maxMin) return false;
      corriendo.add(k);
      await correr();
      return true;
    } catch (e) {
      console.warn('[syncAlAbrir]', e && e.message ? e.message : e);
      return false;
    } finally {
      corriendo.delete(k);
    }
  };
})();
