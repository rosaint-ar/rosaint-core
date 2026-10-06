// Rosaint · Fichas — importador del contenido publicado en la tienda online.
// Lee el sitio publico (no necesita token de Tienda Nube), parsea las secciones
// que el theme marca con data-tab / data-faq y las deja en _import_tienda.
// Se puede volver a correr cada vez que se editen los textos de la tienda.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; RosaintFichas/1.0)' };
const SITIO = 'https://www.rosaint.online';

const txt = (s: string) =>
  s.replace(/<br\s*\/?>/gi, '\n')
   .replace(/<[^>]+>/g, '')
   .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
   .replace(/&#39;|&rsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
   .replace(/[ \t]+/g, ' ').trim();

function parsear(html: string) {
  const m = html.match(/<div class="product-description user-content">([\s\S]*?)<\/div>\s*<div class="js-nubesdk-slot"/)
         || html.match(/<div class="product-description user-content">([\s\S]*?)<\/div>\s*<\/div>/);
  if (!m) return null;
  const body = m[1];
  const product_id = (html.match(/data-store="product-description-(\d+)"/) || [])[1] ?? null;
  const secciones: Record<string, unknown> = {};
  const faq: { p: string; r: string }[] = [];
  for (const p of body.split(/(?=<h3[^>]*data-(?:tab|faq-title)[^>]*>)/i)) {
    const ft = p.match(/<h3[^>]*data-faq-title[^>]*>([\s\S]*?)<\/h3>/i);
    if (ft) {
      for (const q of p.matchAll(/<h4[^>]*data-faq[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h4|$)/gi))
        faq.push({ p: txt(q[1]), r: txt(q[2]) });
      continue;
    }
    const t = p.match(/<h3[^>]*data-tab[^>]*>([\s\S]*?)<\/h3>/i);
    if (!t) continue;
    const cuerpo = p.replace(/<h3[\s\S]*?<\/h3>/i, '');
    const items = [...cuerpo.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => txt(x[1])).filter(Boolean);
    secciones[txt(t[1])] = items.length
      ? items
      : ([...cuerpo.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((x) => txt(x[1])).filter(Boolean).join('\n\n') || txt(cuerpo));
  }
  return { product_id, secciones, faq };
}

Deno.serve(async () => {
  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const sm = await (await fetch(`${SITIO}/sitemap.xml`, { headers: UA })).text();
    const urls = [...sm.matchAll(/<loc>(https:\/\/rosaint\.online\/productos\/[^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((u) => u.replace(/\/$/, '').split('/').pop() !== 'productos');

    // Una ficha por producto: agrupamos las presentaciones (500g, 1kg, 4kg...) del mismo handle.
    const grupos: Record<string, string[]> = {};
    for (const u of urls) {
      const h = u.replace(/\/$/, '').split('/').pop()!;
      const base = h.replace(/-(\d+(?:[.,]\d+)?)(g|kg|cc|ml|lts?|l)$/, '');
      (grupos[base] ??= []).push(u);
    }

    const filas = [];
    const errores: string[] = [];
    for (const [handle, us] of Object.entries(grupos)) {
      const html = await (await fetch(us[0], { headers: UA })).text();
      const d = parsear(html);
      if (!d) { errores.push(handle); continue; }
      filas.push({ handle, product_id: d.product_id, url: us[0], presentaciones: us.length,
                   secciones: d.secciones, faq: d.faq, importado_en: new Date().toISOString() });
    }

    const { error } = await sb.from('_import_tienda').upsert(filas, { onConflict: 'handle' });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, urls: urls.length, productos: filas.length, errores }, null, 1),
      { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500,
      headers: { 'Content-Type': 'application/json' } });
  }
});
