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
