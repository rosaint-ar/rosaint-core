/* =========================================================================
   Rosaint · CORE — Ficha rápida del producto
   Tocar el código (o el nombre al lado) de un producto en cualquier tabla abre un panel lateral con:
   precios por lista y cómo se calculan, costo y rentabilidad, y DÓNDE APARECE (lista de precios
   pública para profesionales, cotizador), que se cambia ahí mismo y se guarda solo.
   Lo carga shell.js en las pantallas de catálogo, precios, comercial, producción, laboratorio y fichas.
   También se puede abrir a mano: FichaProducto.abrir('10212').
   ========================================================================= */
(function () {
  if (window.FichaProducto) return;
  const SECCIONES = /\/(catalogo|precios|comercial|produccion|laboratorio|fichas)\//;
  if (!SECCIONES.test(location.pathname)) return;

  // Canales que se deciden desde Core. "porDefecto" = qué vale cuando el producto no tiene fila:
  // la lista pública solo muestra lo marcado; el cotizador muestra todo lo que no esté apagado.
  const CANALES = [
    { canal: 'lista_profesional', titulo: 'Lista de precios pública', ayuda: 'La lista para profesionales que se publica y se manda a clientes.', porDefecto: false },
    { canal: 'cotizador', titulo: 'Cotizador', ayuda: 'Aparece para armar cotizaciones en Comercial.', porDefecto: true },
  ];

  const css = `
  .fp-velo{position:fixed;inset:0;background:rgba(20,16,12,.28);z-index:900;opacity:0;transition:opacity .18s}
  .fp-velo.on{opacity:1}
  .fp-panel{position:fixed;top:0;right:0;height:100%;width:min(440px,100vw);background:var(--surface);border-left:1px solid var(--border);
    z-index:901;transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(20,16,12,.12)}
  .fp-panel.on{transform:none}
  .fp-cab{padding:18px 20px 14px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start}
  .fp-cab .fp-cod{font-family:var(--font-mono);font-size:12px;color:var(--accent)}
  .fp-cab h3{margin:2px 0 4px;font-size:17px;line-height:1.25;color:var(--text)}
  .fp-cab .fp-sub{font-size:12px;color:var(--muted)}
  .fp-x{margin-left:auto;border:0;background:none;font-size:22px;line-height:1;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:8px}
  .fp-x:hover{background:var(--surface-2);color:var(--text)}
  .fp-cuerpo{overflow:auto;padding:6px 20px 24px;flex:1}
  .fp-sec{margin-top:18px}
  .fp-sec h4{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px;font-weight:700}
  .fp-tabla{width:100%;border-collapse:collapse;font-size:13px}
  .fp-tabla td{padding:6px 0;border-bottom:1px solid var(--border)}
  .fp-tabla td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .fp-nota{font-size:12px;color:var(--text-2);background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;margin-top:8px;line-height:1.45}
  .fp-canal{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer}
  .fp-canal:last-child{border-bottom:0}
  .fp-canal .t{font-size:13.5px;font-weight:600;color:var(--text)}
  .fp-canal .a{font-size:12px;color:var(--muted);margin-top:1px}
  .fp-sw{flex:none;width:38px;height:22px;border-radius:11px;background:var(--border-2);position:relative;transition:background .15s;margin-top:1px}
  .fp-sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
  .fp-canal.si .fp-sw{background:var(--ok)}
  .fp-canal.si .fp-sw::after{left:19px}
  .fp-canal.guardando{opacity:.55;pointer-events:none}
  .fp-estado{font-size:11.5px;margin-top:6px;min-height:16px;color:var(--muted)}
  .fp-estado.ok{color:var(--ok)} .fp-estado.err{color:var(--hot)}
  .fp-links{display:flex;flex-wrap:wrap;gap:8px}
  .fp-links a{font-size:12.5px;padding:7px 11px;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);text-decoration:none;background:var(--surface)}
  .fp-links a:hover{border-color:var(--accent);color:var(--accent)}
  .fp-cargando{padding:30px 0;color:var(--muted);font-size:13px}
  td.codigo.fp-click, td.fp-click-nombre{cursor:pointer}
  td.codigo.fp-click:hover{text-decoration:underline}
  td.fp-click-nombre:hover{color:var(--accent)}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ars = (n) => n == null || isNaN(n) ? '—' : '$ ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const pct = (n) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
  const raiz = (() => { const m = location.pathname.match(/^(.*\/)(catalogo|precios|comercial|produccion|laboratorio|fichas)\//); return m ? m[1] : '/'; })();

  let velo, panel, actual = null;
  function armar() {
    if (panel) return;
    velo = document.createElement('div'); velo.className = 'fp-velo'; velo.onclick = cerrar;
    panel = document.createElement('aside'); panel.className = 'fp-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Ficha del producto');
    document.body.append(velo, panel);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && actual) cerrar(); });
  }
  function cerrar() {
    actual = null; panel.classList.remove('on'); velo.classList.remove('on');
    setTimeout(() => { if (!actual) { velo.style.display = 'none'; } }, 200);
  }

  async function abrir(codigo) {
    if (!window.sb || !codigo) return;
    armar(); actual = codigo;
    velo.style.display = 'block';
    panel.innerHTML = `<div class="fp-cab"><div><div class="fp-cod">${esc(codigo)}</div><h3>Cargando…</h3></div><button class="fp-x" aria-label="Cerrar">×</button></div><div class="fp-cuerpo"><div class="fp-cargando">Buscando el producto…</div></div>`;
    panel.querySelector('.fp-x').onclick = cerrar;
    requestAnimationFrame(() => { velo.classList.add('on'); panel.classList.add('on'); });

    const [it, precios, rel, can, rent, pres] = await Promise.all([
      sb.from('items').select('codigo, nombre, tipo, estado, lineas(nombre)').eq('codigo', codigo).maybeSingle(),
      sb.from('items_lista_precio').select('precio_iva_incl, precio_publicado, desvinculado_en, listas_precios!inner(nombre, estado)').eq('codigo_vendible', codigo).is('desvinculado_en', null),
      sb.from('relaciones_precio').select('sku_origen, factor, operacion, redondeo_arriba_a, comentario').eq('sku_destino', codigo),
      sb.from('item_canales').select('canal, activo').eq('codigo_item', codigo),
      sb.from('v_precios_listas_completos').select('costo_unitario, rentab_real_l1, rentab_real_l2').eq('codigo_sku', codigo).maybeSingle(),
      sb.from('presentaciones').select('codigo_sku').eq('codigo_sku', codigo).maybeSingle(),
    ]);
    if (actual !== codigo) return;
    const item = it.data;
    if (!item) { panel.querySelector('.fp-cuerpo').innerHTML = '<div class="fp-cargando">Este código no es un producto del catálogo.</div>'; panel.querySelector('h3').textContent = codigo; return; }

    const listas = (precios.data || []).filter((p) => p.listas_precios.estado === 'vigente')
      .sort((a, b) => a.listas_precios.nombre.localeCompare(b.listas_precios.nombre, 'es', { numeric: true }));
    const estadoCanal = {}; (can.data || []).forEach((c) => { estadoCanal[c.canal] = c.activo; });
    const vendible = listas.length > 0 || !!pres.data || ['SKU', 'COMBO', 'PACK'].includes(item.tipo);
    const relTxt = (rel.data || []).map((r) => r.comentario || `${r.operacion === 'dividir' ? '÷' : '×'} ${Number(r.factor).toLocaleString('es-AR')} sobre ${r.sku_origen}${r.redondeo_arriba_a ? `, redondeado ↑ a $${r.redondeo_arriba_a}` : ''}`);

    panel.querySelector('.fp-cab').innerHTML = `<div><div class="fp-cod">${esc(item.codigo)}</div><h3>${esc(item.nombre)}</h3>
      <div class="fp-sub">${esc(item.tipo || '')}${item.lineas?.nombre ? ' · ' + esc(item.lineas.nombre) : ''} · ${esc(item.estado || '')}</div></div>
      <button class="fp-x" aria-label="Cerrar">×</button>`;
    panel.querySelector('.fp-x').onclick = cerrar;

    let h = '';
    if (vendible) {
      h += `<div class="fp-sec"><h4>Dónde aparece</h4>` + CANALES.map((c) => {
        const si = c.canal in estadoCanal ? !!estadoCanal[c.canal] : c.porDefecto;
        return `<div class="fp-canal ${si ? 'si' : ''}" data-canal="${c.canal}" role="switch" aria-checked="${si}" tabindex="0">
          <span class="fp-sw"></span><div><div class="t">${esc(c.titulo)}</div><div class="a">${esc(c.ayuda)}</div></div></div>`;
      }).join('') + `<div class="fp-estado" id="fp-estado">Odoo siempre tiene todos los productos. Los cambios se guardan solos.</div></div>`;
    }
    h += `<div class="fp-sec"><h4>Precios (con IVA)</h4>`;
    h += listas.length ? `<table class="fp-tabla">${listas.map((p) => `<tr><td>${esc(p.listas_precios.nombre)}${p.precio_publicado == null && p.precio_iva_incl != null ? ' <span style="color:var(--muted);font-size:11px">(no publicado)</span>' : ''}</td><td class="n">${ars(p.precio_publicado ?? p.precio_iva_incl)}</td></tr>`).join('')}</table>`
      : `<div class="fp-nota">No tiene precio en ninguna lista.</div>`;
    if (relTxt.length) h += `<div class="fp-nota"><b>Cómo se calcula:</b> ${relTxt.map(esc).join(' · ')}</div>`;
    else if (listas.length) h += `<div class="fp-nota">Precio cargado a mano (no está atado a otro producto).</div>`;
    h += `</div>`;
    if (rent.data) {
      h += `<div class="fp-sec"><h4>Costo y rentabilidad</h4><table class="fp-tabla">
        <tr><td>Costo unitario</td><td class="n">${ars(rent.data.costo_unitario)}</td></tr>
        <tr><td>Rentabilidad Lista 1</td><td class="n">${pct(rent.data.rentab_real_l1)}</td></tr>
        <tr><td>Rentabilidad Lista 2</td><td class="n">${pct(rent.data.rentab_real_l2)}</td></tr></table></div>`;
    }
    const links = [];
    if (pres.data) links.push(`<a href="${raiz}catalogo/presentaciones.html?editar=${encodeURIComponent(codigo)}">✎ Editar presentación</a>`);
    if (listas.length) links.push(`<a href="${raiz}precios/listas.html?sku=${encodeURIComponent(codigo)}">Listas de precios</a>`);
    if (links.length) h += `<div class="fp-sec"><h4>Ir a</h4><div class="fp-links">${links.join('')}</div></div>`;
    panel.querySelector('.fp-cuerpo').innerHTML = h;

    panel.querySelectorAll('.fp-canal').forEach((el) => {
      const cambiar = async () => {
        const canal = el.dataset.canal, nuevo = !el.classList.contains('si');
        const msg = panel.querySelector('#fp-estado');
        el.classList.add('guardando');
        const { error } = await sb.from('item_canales').upsert({ codigo_item: codigo, canal, activo: nuevo, actualizado_en: new Date().toISOString() }, { onConflict: 'codigo_item,canal' });
        el.classList.remove('guardando');
        if (error) { msg.className = 'fp-estado err'; msg.textContent = 'No se pudo guardar: ' + error.message; return; }
        el.classList.toggle('si', nuevo); el.setAttribute('aria-checked', String(nuevo));
        const t = CANALES.find((c) => c.canal === canal).titulo;
        msg.className = 'fp-estado ok'; msg.textContent = `Guardado: ${nuevo ? 'aparece en' : 'ya no aparece en'} ${t}.`;
        document.dispatchEvent(new CustomEvent('ficha-producto:cambio', { detail: { codigo, canal, activo: nuevo } }));
      };
      el.onclick = cambiar;
      el.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); cambiar(); } };
    });
  }

  // Código de un producto en la fila: la celda td.codigo (convención de todas las tablas de Core).
  const PARECE_CODIGO = /^[0-9]{4,6}(-[A-Z]{1,3})?$/;
  function codigoDeCelda(td) {
    if (!td) return null;
    if (td.dataset.ficha) return td.dataset.ficha;
    const cod = td.classList.contains('codigo') ? td : td.previousElementSibling;
    if (!cod || !cod.classList || !cod.classList.contains('codigo')) return null;
    const t = cod.textContent.trim();
    return PARECE_CODIGO.test(t) ? t : null;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('input, select, textarea, button, a, label')) return;
    const td = e.target.closest('td.codigo, td.codigo + td, [data-ficha]');
    const cod = codigoDeCelda(td);
    if (cod) { e.preventDefault(); abrir(cod); }
  });
  // Marcar visualmente lo que se puede tocar (las tablas se redibujan seguido)
  document.addEventListener('mouseover', (e) => {
    const td = e.target.closest('td.codigo, td.codigo + td');
    if (!td || td.dataset.fpVisto) return;
    td.dataset.fpVisto = '1';
    if (codigoDeCelda(td)) { td.classList.add(td.classList.contains('codigo') ? 'fp-click' : 'fp-click-nombre'); td.title = td.title || 'Ver ficha del producto'; }
  });

  window.FichaProducto = { abrir, cerrar };
})();
