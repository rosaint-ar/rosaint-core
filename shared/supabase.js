/* =========================================================================
   Rosaint · CORE — cliente Supabase compartido
   Cada página carga @supabase/supabase-js desde CDN y luego este archivo.
   Después queda `window.sb` disponible en toda la página.
   ========================================================================= */

window.SUPABASE_URL = 'https://jayhjhifrfcdecofwgbf.supabase.co';
window.SUPABASE_KEY = 'sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB';

// URL de la edge function principal (proxy a Odoo)
window.ODOO_FN_URL = window.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') + '/odoo-explorar';

if (typeof supabase !== 'undefined') {
  window.sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
} else {
  console.warn('[shared/supabase] Cargá @supabase/supabase-js ANTES de este archivo.');
}

/* Las funciones del servidor exigen la sesión del usuario: la clave pública de la página no alcanza
   (auditoría 6-oct-2026). Toda llamada a una función se manda con el token de la sesión, aunque la
   pantalla haya puesto la clave pública, así no hay que tocar cada pantalla. */
(function () {
  const esFuncion = (u) => /\/functions\/v1\/|\.functions\.supabase\.co\//.test(u);
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (window.sb && esFuncion(url)) {
      try {
        const { data } = await window.sb.auth.getSession();
        const token = data && data.session && data.session.access_token;
        if (token) {
          const h = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
          h.set('Authorization', 'Bearer ' + token);
          if (!h.has('apikey')) h.set('apikey', window.SUPABASE_KEY);
          init = Object.assign({}, init, { headers: h });
        }
      } catch (e) { /* sin sesión: va como estaba y el servidor responde "No autorizado" */ }
    }
    return fetchOriginal(input, init);
  };
})();
