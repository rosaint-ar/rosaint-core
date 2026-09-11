/* =========================================================================
   Rosaint · CORE — Fichas técnicas
   Utilidades compartidas: textos, avisos y la lista de dudas/inconsistencias
   (fichas_pendientes) con sus acciones. La usan index.html y ver.html.
   ========================================================================= */

const FX = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const ESTADOS = {
    por_revisar:  { label: 'Por revisar',  ayuda: 'Necesitan una decisión' },
    por_corregir: { label: 'Por corregir', ayuda: 'Ya se sabe qué hacer, falta hacerlo' },
    hecho:        { label: 'Hecho',        ayuda: 'Resuelto, queda como registro' },
    descartado:   { label: 'Descartado',   ayuda: 'No aplicaba' },
  };
  const FUENTES = {
    formula: 'Tenía razón la fórmula',
    web: 'Tenía razón la web',
    decision_laboratorio: 'Decisión del laboratorio',
    otro: 'Otra fuente',
  };
  const ESTADO_FICHA = { borrador: 'Borrador', en_revision: 'En revisión', aprobada: 'Aprobada' };
  const GRAVEDAD = { alta: 0, media: 1, baja: 2 };

  let NOMBRES = {};    // codigo_granel -> nombre legible
  let GRANELES = [];   // [{codigo, nombre}] para elegir producto al anotar

  const setNombres = m => { NOMBRES = { ...NOMBRES, ...m }; };
  const setGraneles = l => { GRANELES = l.slice().sort((a, b) => a.codigo.localeCompare(b.codigo)); };
  const nombre = c => (c && NOMBRES[c]) || '';

  function toast(msg, tipo = '') {
    let t = document.getElementById('fx-toast');
    if (!t) { t = document.createElement('div'); t.id = 'fx-toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show ' + tipo;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast ' + tipo; }, tipo === 'err' ? 5000 : 2800);
  }

  async function usuario() {
    try { const { data } = await sb.auth.getSession(); return data?.session?.user?.email || null; }
    catch { return null; }
  }

  const fecha = ts => ts ? new Date(ts).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const quien = q => q === 'claude' ? 'Claude' : q;

  const ordenar = (a, b) =>
    (GRAVEDAD[a.gravedad] ?? 3) - (GRAVEDAD[b.gravedad] ?? 3)
    || (a.titulo || '').localeCompare(b.titulo || '', 'es')
    || (a.codigo_granel || '').localeCompare(b.codigo_granel || '');

  // ---- Una duda / inconsistencia ------------------------------------------------
  function htmlPendiente(p, { conProducto = true } = {}) {
    const cerrado = p.estado === 'hecho' || p.estado === 'descartado';
    let prod = '';
    if (conProducto) {
      prod = p.codigo_granel
        ? `<a class="fx-prod" href="ver.html?c=${encodeURIComponent(p.codigo_granel)}">${esc(p.codigo_granel)}${nombre(p.codigo_granel) ? ' · ' + esc(nombre(p.codigo_granel)) : ''}</a>`
        : `<span class="fx-prod gral">Varios productos</span>`;
    }

    let btns;
    if (p.estado === 'por_revisar') {
      btns = `<button class="btn primary fx-chico" data-accion="resolver" data-id="${p.id}">Resolver</button>
              <button class="btn ghost fx-chico" data-accion="editar" data-id="${p.id}">Editar</button>`;
    } else if (p.estado === 'por_corregir') {
      btns = `<button class="btn primary fx-chico" data-accion="corregido" data-id="${p.id}">Marcar corregido</button>
              <button class="btn ghost fx-chico" data-accion="editar" data-id="${p.id}">Editar</button>`;
    } else {
      btns = `<button class="btn ghost fx-chico" data-accion="reabrir" data-id="${p.id}">Reabrir</button>`;
    }

    const meta = cerrado
      ? `${p.estado === 'descartado' ? 'Descartado' : 'Cerrado'} ${fecha(p.resuelta_en)}${p.resuelta_por ? ' · ' + esc(quien(p.resuelta_por)) : ''}`
      : `Anotado ${fecha(p.detectada_en)}${p.creado_por ? ' · ' + esc(quien(p.creado_por)) : ''}`;

    return `<article class="fx-pend ${cerrado ? 'cerrado' : ''}">
      <span class="sev ${esc(p.gravedad || '')}" title="Importancia: ${esc(p.gravedad || 'sin definir')}"></span>
      <div class="fx-pend-cuerpo">
        <div class="fx-pend-tit"><span>${esc(p.titulo)}</span>${prod}</div>
        ${p.detalle ? `<div class="fx-pend-det">${esc(p.detalle)}</div>` : ''}
        ${p.accion && !cerrado ? `<div class="fx-pend-acc"><b>Qué hacer:</b> ${esc(p.accion)}</div>` : ''}
        ${p.resolucion ? `<div class="fx-pend-res"><b>${p.estado === 'descartado' ? 'Descartado' : 'Se decidió'}:</b> ${esc(p.resolucion)}${p.fuente_correcta ? ` <span class="fx-muted">· ${esc(FUENTES[p.fuente_correcta] || p.fuente_correcta)}</span>` : ''}</div>` : ''}
        <div class="fx-pend-meta">${meta}</div>
      </div>
      <div class="fx-pend-btns">${btns}</div>
    </article>`;
  }

  // ---- Modal ---------------------------------------------------------------------
  function abrir(html) {
    let bg = document.getElementById('fx-modal');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'fx-modal'; bg.className = 'modal-bg';
      bg.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(bg);
      bg.addEventListener('click', e => { if (e.target === bg) cerrar(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && bg.classList.contains('show')) cerrar(); });
    }
    const box = bg.querySelector('.modal-box');
    box.innerHTML = html;
    bg.classList.add('show');
    const primero = box.querySelector('textarea, input:not([type=radio]), select');
    if (primero) setTimeout(() => primero.focus(), 40);
    box.querySelectorAll('[data-m="cancelar"]').forEach(b => b.addEventListener('click', cerrar));
    return box;
  }
  function cerrar() { document.getElementById('fx-modal')?.classList.remove('show'); }

  async function actualizar(id, cambios) {
    const { error } = await sb.from('fichas_pendientes').update(cambios).eq('id', id);
    if (error) { toast('No se pudo guardar: ' + error.message, 'err'); return false; }
    return true;
  }

  const opcionesProducto = sel =>
    `<option value="">Varios productos / todo el catálogo</option>` +
    GRANELES.map(g => `<option value="${esc(g.codigo)}"${g.codigo === sel ? ' selected' : ''}>${esc(g.codigo)} · ${esc(g.nombre)}</option>`).join('');

  // Anotar una duda nueva o editar una existente
  function abrirEditor(p, alCambiar) {
    const nuevo = !p?.id;
    p = p || {};
    const box = abrir(`
      <h3>${nuevo ? 'Anotar una duda' : 'Editar'}</h3>
      <div class="sub">${nuevo ? 'Queda en la lista para revisarla cuando puedas.' : 'Cambiá lo que haga falta.'}</div>
      <label for="fp-prod">Producto</label>
      <select id="fp-prod">${opcionesProducto(p.codigo_granel)}</select>
      <label for="fp-tit">Qué pasa *</label>
      <input id="fp-tit" value="${esc(p.titulo || '')}" placeholder="Ej: ¿el gel reductor lleva mentol?">
      <label for="fp-det">Detalle</label>
      <textarea id="fp-det" rows="3" placeholder="Qué dice cada fuente, dónde lo viste…">${esc(p.detalle || '')}</textarea>
      <label for="fp-acc">Qué hay que hacer</label>
      <textarea id="fp-acc" rows="2" placeholder="Opcional">${esc(p.accion || '')}</textarea>
      <div class="field-grid">
        <div>
          <label for="fp-grav">Importancia</label>
          <select id="fp-grav">
            <option value="alta"${p.gravedad === 'alta' ? ' selected' : ''}>Alta: puede declarar algo falso</option>
            <option value="media"${!p.gravedad || p.gravedad === 'media' ? ' selected' : ''}>Media</option>
            <option value="baja"${p.gravedad === 'baja' ? ' selected' : ''}>Baja: detalle de forma</option>
          </select>
        </div>
        <div>
          <label for="fp-est">Estado</label>
          <select id="fp-est">
            ${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}"${(p.estado || 'por_revisar') === k ? ' selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-actions">
        ${nuevo ? '' : '<button class="btn ghost" data-m="borrar" style="color:var(--hot)">Borrar</button>'}
        <span class="spacer"></span>
        <button class="btn ghost" data-m="cancelar">Cancelar</button>
        <button class="btn primary" data-m="guardar">${nuevo ? 'Anotar' : 'Guardar'}</button>
      </div>`);

    box.querySelector('[data-m="guardar"]').addEventListener('click', async ev => {
      const titulo = box.querySelector('#fp-tit').value.trim();
      if (!titulo) { toast('Escribí qué pasa: es lo que se ve en la lista.', 'err'); box.querySelector('#fp-tit').focus(); return; }
      const estado = box.querySelector('#fp-est').value;
      const datos = {
        codigo_granel: box.querySelector('#fp-prod').value || null,
        titulo,
        detalle: box.querySelector('#fp-det').value.trim() || null,
        accion: box.querySelector('#fp-acc').value.trim() || null,
        gravedad: box.querySelector('#fp-grav').value,
        estado,
      };
      const cerrado = estado === 'hecho' || estado === 'descartado';
      const email = await usuario();
      if (cerrado && !p.resuelta_en) Object.assign(datos, { resuelta_en: new Date().toISOString(), resuelta_por: email });
      if (!cerrado) Object.assign(datos, { resuelta_en: null, resuelta_por: null });

      ev.currentTarget.disabled = true;
      let error;
      if (nuevo) ({ error } = await sb.from('fichas_pendientes').insert({ ...datos, tipo: 'duda', creado_por: email }));
      else ({ error } = await sb.from('fichas_pendientes').update(datos).eq('id', p.id));
      if (error) { ev.currentTarget.disabled = false; toast('No se pudo guardar: ' + error.message, 'err'); return; }
      cerrar();
      toast(nuevo ? 'Duda anotada' : 'Guardado', 'ok');
      alCambiar && alCambiar();
    });

    box.querySelector('[data-m="borrar"]')?.addEventListener('click', async () => {
      if (!confirm('¿Borrar esta anotación? No se puede deshacer. Si ya se resolvió, mejor marcala como hecha y queda el registro.')) return;
      const { error } = await sb.from('fichas_pendientes').delete().eq('id', p.id);
      if (error) { toast('No se pudo borrar: ' + error.message, 'err'); return; }
      cerrar(); toast('Borrado'); alCambiar && alCambiar();
    });
  }

  // Resolver una duda: qué se decidió y si queda algo por corregir
  function abrirResolver(p, alCambiar) {
    const box = abrir(`
      <h3>Resolver</h3>
      <div class="sub">${esc(p.titulo)}${p.codigo_granel ? ` · ${esc(p.codigo_granel)} ${esc(nombre(p.codigo_granel))}` : ''}</div>
      ${p.detalle ? `<div class="fx-modal-det">${esc(p.detalle)}</div>` : ''}
      <label for="fr-res">¿Qué se decidió? *</label>
      <textarea id="fr-res" rows="3" placeholder="Ej: lleva Ethylhexylglycerin; la fórmula del Core estaba vieja.">${esc(p.resolucion || '')}</textarea>
      <label for="fr-fuente">¿Quién tenía razón?</label>
      <select id="fr-fuente">
        <option value="">No aplica</option>
        ${Object.entries(FUENTES).map(([k, v]) => `<option value="${k}"${p.fuente_correcta === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <label>¿Y ahora?</label>
      <div class="fx-radio">
        <label><input type="radio" name="fr-sig" value="por_corregir" checked>
          <span>Queda algo por corregir<small>Pasa a «Por corregir» con la tarea de abajo.</small></span></label>
        <label><input type="radio" name="fr-sig" value="hecho">
          <span>Ya está, no hay nada más que hacer<small>Pasa a «Hecho».</small></span></label>
      </div>
      <div id="fr-acc-wrap">
        <label for="fr-acc">Qué hay que corregir *</label>
        <textarea id="fr-acc" rows="2" placeholder="Ej: cambiar el INCI publicado en la tienda.">${esc(p.accion || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-m="descartar">No aplicaba</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-m="cancelar">Cancelar</button>
        <button class="btn primary" data-m="guardar">Guardar</button>
      </div>`);

    const wrap = box.querySelector('#fr-acc-wrap');
    box.querySelectorAll('input[name="fr-sig"]').forEach(r =>
      r.addEventListener('change', () => { wrap.hidden = box.querySelector('input[name="fr-sig"]:checked').value !== 'por_corregir'; }));

    box.querySelector('[data-m="guardar"]').addEventListener('click', async ev => {
      const resolucion = box.querySelector('#fr-res').value.trim();
      const sig = box.querySelector('input[name="fr-sig"]:checked').value;
      const accion = box.querySelector('#fr-acc').value.trim();
      if (!resolucion) { toast('Contá qué se decidió: es lo que queda de registro.', 'err'); return; }
      if (sig === 'por_corregir' && !accion) { toast('Contá qué hay que corregir.', 'err'); return; }
      ev.currentTarget.disabled = true;
      const ok = await actualizar(p.id, {
        resolucion,
        fuente_correcta: box.querySelector('#fr-fuente').value || null,
        estado: sig,
        accion: sig === 'por_corregir' ? accion : p.accion,
        resuelta_por: await usuario(),
        resuelta_en: new Date().toISOString(),
      });
      if (!ok) { ev.currentTarget.disabled = false; return; }
      cerrar();
      toast(sig === 'hecho' ? 'Resuelto' : 'Pasó a «Por corregir»', 'ok');
      alCambiar && alCambiar();
    });

    box.querySelector('[data-m="descartar"]').addEventListener('click', async () => {
      const resolucion = box.querySelector('#fr-res').value.trim() || 'No aplicaba.';
      const ok = await actualizar(p.id, { estado: 'descartado', resolucion, resuelta_por: await usuario(), resuelta_en: new Date().toISOString() });
      if (!ok) return;
      cerrar(); toast('Descartado'); alCambiar && alCambiar();
    });
  }

  // Engancha los botones de una lista de pendientes (una sola vez por contenedor)
  function conectar(contenedor, buscar, alCambiar) {
    contenedor.addEventListener('click', async e => {
      const b = e.target.closest('[data-accion]');
      if (!b) return;
      const p = buscar(Number(b.dataset.id));
      if (!p) return;
      const accion = b.dataset.accion;
      if (accion === 'resolver') return abrirResolver(p, alCambiar);
      if (accion === 'editar') return abrirEditor(p, alCambiar);
      b.disabled = true;
      let ok = false;
      if (accion === 'corregido') {
        ok = await actualizar(p.id, {
          estado: 'hecho',
          resolucion: p.resolucion || 'Corregido.',
          resuelta_por: await usuario(),
          resuelta_en: new Date().toISOString(),
        });
        if (ok) toast('Marcado como corregido', 'ok');
      } else if (accion === 'reabrir') {
        ok = await actualizar(p.id, { estado: p.accion ? 'por_corregir' : 'por_revisar', resuelta_en: null, resuelta_por: null });
        if (ok) toast('Reabierto');
      }
      if (ok) alCambiar && alCambiar(); else b.disabled = false;
    });
  }

  return {
    esc, norm, toast, usuario, fecha, ordenar,
    ESTADOS, FUENTES, ESTADO_FICHA,
    setNombres, setGraneles, nombre,
    htmlPendiente, abrir, cerrar, abrirEditor, conectar,
  };
})();
