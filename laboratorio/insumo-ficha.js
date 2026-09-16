/* =========================================================================
   Rosaint · CORE — Ficha de insumo (materia prima / envase)
   Un único panel lateral, compartido por Stock y reposición y Proveedores:
   desde cualquier lista donde aparezca un insumo se abre esta ficha y se
   puede completar o corregir sin salir de donde estabas.
   Se monta su propio panel, por encima del que tenga la página, así se puede
   abrir la ficha de un insumo estando dentro de la ficha de un proveedor.
   Depende de REPO (reposicion.js) para los ayudantes de formato.
   ========================================================================= */

const FICHA = (() => {
  const { esc, pesos, num, uni, fecha, toast } = REPO;
  const $ = s => document.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let CTX = null;          // lo que le pasa la página anfitriona
  let CATEGORIAS = [];
  let codigoActual = null;
  let montado = false;

  const FN_PROV = window.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') + '/odoo-proveedores';

  function montar() {
    if (montado) return;
    montado = true;
    const velo = document.createElement('div');
    velo.id = 'fi-velo';
    velo.className = 'fi-velo';
    const panel = document.createElement('aside');
    panel.id = 'fi-panel';
    panel.className = 'fi-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header>
        <div>
          <h3 id="fi-nombre">—</h3>
          <div id="fi-sub" class="fi-sub">—</div>
        </div>
        <button class="fi-cerrar" id="fi-cerrar" aria-label="Cerrar">&times;</button>
      </header>
      <div class="fi-cuerpo" id="fi-cuerpo"></div>`;
    document.body.append(velo, panel);

    const css = document.createElement('style');
    css.textContent = `
      .fi-velo { position:fixed; inset:0; background:rgba(0,0,0,.3); z-index:70; display:none; }
      .fi-velo.open { display:block; }
      .fi-panel { position:fixed; inset:0 0 0 auto; width:min(560px,100%); background:var(--surface);
                  border-left:1px solid var(--border); box-shadow:var(--shadow-menu); z-index:71;
                  display:flex; flex-direction:column; transform:translateX(100%); transition:transform .18s ease; }
      .fi-panel.open { transform:none; }
      .fi-panel > header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; gap:12px; align-items:flex-start; }
      .fi-panel > header h3 { font-size:15.5px; font-weight:700; line-height:1.3; }
      .fi-sub { font-size:11.5px; color:var(--muted); margin-top:2px; }
      .fi-cerrar { margin-left:auto; background:none; border:none; font-size:20px; color:var(--muted); cursor:pointer; line-height:1; }
      .fi-cuerpo { padding:18px 20px; overflow:auto; flex:1; }
      .fi-grid { display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-bottom:6px; }
      .fi-dato { background:var(--bg); border-radius:var(--radius-sm); padding:9px 11px; }
      .fi-dato .k { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
      .fi-dato .v { font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:2px; }
      .fi-dato .s { font-size:11px; color:var(--muted); }
      .fi-h4 { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
               font-weight:600; margin:20px 0 8px; }
      .fi-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
      .fi-campo.ancho { grid-column:1 / -1; }
      .fi-campo label { display:block; font-size:11.5px; color:var(--muted); margin-bottom:5px; font-weight:600; }
      .fi-campo input, .fi-campo select, .fi-campo textarea {
        width:100%; background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm);
        padding:8px 10px; font-size:13px; color:var(--text); font-family:inherit; }
      .fi-campo .ayuda { font-size:11px; color:var(--muted); margin-top:4px; line-height:1.45; }
      .fi-acciones { display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-top:15px; }
      .fi-tabla { width:100%; border-collapse:collapse; font-size:12px; }
      .fi-tabla th { text-align:left; font-size:10px; text-transform:uppercase; color:var(--muted); padding:4px 6px; font-weight:600; }
      .fi-tabla td { padding:6px; border-top:1px solid var(--border); font-variant-numeric:tabular-nums; }
      .fi-tabla td.txt { font-variant-numeric:normal; }
      @media (max-width:760px) { .fi-grid { grid-template-columns:1fr; } }`;
    document.head.appendChild(css);

    velo.addEventListener('click', cerrar);
    $('#fi-cerrar').addEventListener('click', cerrar);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('#fi-panel').classList.contains('open')) { e.stopPropagation(); cerrar(); }
    }, true);
  }

  function configurar(ctx) {
    CTX = ctx;
    montar();
    if (!CATEGORIAS.length) {
      sb.from('categorias').select('id,nombre,aplica_a').then(({ data }) => { CATEGORIAS = data || []; });
    }
  }

  function cerrar() {
    codigoActual = null;
    $('#fi-panel').classList.remove('open');
    $('#fi-panel').setAttribute('aria-hidden', 'true');
    $('#fi-velo').classList.remove('open');
  }

  /* Hace clicable cualquier elemento que tenga data-insumo="<codigo>" dentro
     del contenedor que se le pase. Se llama después de pintar cada lista. */
  function enlazar(selector = '[data-insumo]', raiz = document) {
    $$(selector, raiz).forEach(el => {
      if (el.dataset.fiEnlazado) return;
      el.dataset.fiEnlazado = '1';
      el.style.cursor = 'pointer';
      el.addEventListener('click', ev => {
        if (ev.target.closest('button, a, input, select, textarea')) return;
        abrir(el.dataset.insumo);
      });
    });
  }

  async function fnProv(body) {
    const { data: s } = await sb.auth.getSession();
    const token = s?.session?.access_token || window.SUPABASE_KEY;
    const r = await fetch(FN_PROV, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Odoo no respondió');
    return j;
  }

  // ---- Armado de la ficha -------------------------------------------------
  function abrir(codigo) {
    if (!CTX) return console.warn('[ficha] falta FICHA.configurar()');
    const item = CTX.getItem(codigo);
    const calc = CTX.getCalculo ? CTX.getCalculo(codigo) : null;
    const ajuste = CTX.getAjuste ? CTX.getAjuste(codigo) : null;
    const provs = (CTX.getProveedores() || []).filter(p => p.activo !== false)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const real = CTX.getReal ? CTX.getReal(codigo) : null;
    if (!item && !calc) return toast('No encontré ese insumo', 'err');

    codigoActual = codigo;
    const nombre = (item?.nombre) || calc?.nombre || codigo;
    const unidad = calc?.unidad || item?.unidad || '';
    const cats = CATEGORIAS.filter(c => !c.aplica_a || ['MP', 'IN'].includes(String(c.aplica_a)));

    $('#fi-nombre').textContent = nombre;
    $('#fi-sub').textContent = [codigo, calc?.categoria, item?.estado === 'descontinuado' ? 'ARCHIVADO' : null]
      .filter(Boolean).join(' · ');

    const proveedorReal = real?.proveedor || calc?.proveedor || null;
    const provAsignado = item?.proveedor_id ? provs.find(p => p.id === item.proveedor_id) : null;
    const desalineado = proveedorReal && provAsignado &&
      (provAsignado.odoo_nombre || provAsignado.nombre) !== proveedorReal;

    $('#fi-cuerpo').innerHTML = `
      ${calc ? `<div class="fi-grid">
        <div class="fi-dato"><div class="k">Stock</div><div class="v">${num(calc.stock)} ${esc(unidad)}</div>
          <div class="s">${calc.enCamino ? num(calc.enCamino) + ' en camino' : 'nada en camino'}</div></div>
        <div class="fi-dato"><div class="k">Alcanza para</div>
          <div class="v">${calc.cobertura == null ? '—' : calc.cobertura + ' días'}</div>
          <div class="s">${esc(REPO.NIVEL_TXT[REPO.nivel(calc)] || '')}</div></div>
        <div class="fi-dato"><div class="k">Uso por mes</div><div class="v">${num(calc.mensual)} ${esc(unidad)}</div>
          <div class="s">${num(calc.diario, 3)} por día</div></div>
        <div class="fi-dato"><div class="k">Punto de pedido</div><div class="v">${num(calc.puntoPedido)} ${esc(unidad)}</div>
          <div class="s">${calc.plazo} d de entrega${calc.plazoEstimado ? '*' : ''} + ${CTX.getCfg().dias_seguridad} de seguridad</div></div>
      </div>` : ''}

      ${calc && calc.sugerido > 0 ? `<div class="fi-dato" style="background:var(--accent-tint);margin-bottom:6px">
        <div class="k">Sugerencia</div>
        <div class="v" style="color:var(--accent)">Pedir ${num(calc.sugerido)} ${esc(unidad)}</div>
        <div class="s">Cubre ${calc.diasObjetivo} días${calc.proveedor ? ' · a ' + esc(calc.proveedor) : ''}</div></div>` : ''}

      ${desalineado ? `<div class="fi-dato" style="background:rgba(184,134,11,.12);margin-bottom:6px">
        <div class="k">Ojo</div><div class="s" style="font-size:12.5px;line-height:1.5">
        La ficha dice <b>${esc(provAsignado.nombre)}</b> pero desde
        ${esc(fecha(CTX.getSnap()?.historia_desde))} se lo comprás a <b>${esc(proveedorReal)}</b>.</div></div>` : ''}

      <h4 class="fi-h4">Datos del insumo</h4>
      <div class="fi-form">
        <div class="fi-campo ancho"><label>Nombre</label>
          <input id="fi-f-nombre" value="${esc(item?.nombre || nombre)}"></div>
        <div class="fi-campo"><label>Proveedor</label>
          <select id="fi-f-prov">
            <option value="">Sin asignar</option>
            ${provs.map(p => `<option value="${p.id}" ${item?.proveedor_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}
          </select>
          ${proveedorReal ? `<div class="ayuda">Le comprás a ${esc(proveedorReal)}.</div>` : ''}</div>
        <div class="fi-campo"><label>Código del proveedor</label>
          <input id="fi-f-codprov" value="${esc(item?.codigo_proveedor || '')}" placeholder="El código con el que lo pedís">
          <div class="ayuda">El que usa el proveedor en su lista.</div></div>
        <div class="fi-campo"><label>Categoría</label>
          <select id="fi-f-cat"><option value="">Sin categoría</option>
            ${cats.map(c => `<option value="${c.id}" ${item?.categoria_id === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}
          </select></div>
        <div class="fi-campo"><label>Unidad</label>
          <select id="fi-f-unidad">
            ${['Kg', 'unidad'].map(u => `<option value="${u}" ${item?.unidad === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select></div>
        <div class="fi-campo ancho"><label>Notas</label>
          <textarea id="fi-f-notas" rows="2">${esc(item?.notas || '')}</textarea></div>
      </div>

      <h4 class="fi-h4">Cómo se repone</h4>
      <div class="fi-form">
        <div class="fi-campo"><label>Lote de compra</label>
          <input type="number" id="fi-f-lote" step="0.01" min="0" value="${ajuste?.lote_compra ?? ''}"
            placeholder="${calc?.lote != null ? num(calc.lote) + ' (del historial)' : 'sin dato'}">
          <div class="ayuda">La cantidad sugerida se redondea a un múltiplo de esto.</div></div>
        <div class="fi-campo"><label>Días a cubrir</label>
          <input type="number" id="fi-f-dias" min="1" max="365" value="${ajuste?.dias_objetivo ?? ''}"
            placeholder="${calc?.diasObjetivo ?? ''} (calculado)">
          <div class="ayuda">Pisa plazo + seguridad + ciclo para este insumo.</div></div>
        <div class="fi-campo ancho">
          <label style="display:flex;gap:8px;align-items:center;font-weight:400;cursor:pointer">
            <input type="checkbox" id="fi-f-excl" ${ajuste?.excluido ? 'checked' : ''}>
            No avisarme cuando se esté por terminar</label>
          <input id="fi-f-motivo" placeholder="Por qué se excluye" value="${esc(ajuste?.motivo_excluido || '')}"
            style="margin-top:8px;${ajuste?.excluido ? '' : 'display:none'}"></div>
      </div>

      <div class="fi-acciones">
        <button class="btn primary" id="fi-guardar">Guardar</button>
        ${item ? `<button class="btn secondary" id="fi-archivar">${item.estado === 'descontinuado' ? 'Volver a usar' : 'Archivar'}</button>` : ''}
        <span style="font-size:11.5px;color:var(--muted)">Archivar lo saca del Core; en Odoo no se toca.</span>
      </div>

      ${calc && Object.keys(calc.meses || {}).length ? `
        <h4 class="fi-h4">Consumo mes a mes</h4>
        <table class="fi-tabla"><tbody>${Object.keys(calc.meses).sort().map(m => {
          const max = Math.max(...Object.values(calc.meses));
          return `<tr><td class="txt" style="width:76px">${m}</td>
            <td><div style="background:var(--structure);opacity:.55;height:9px;border-radius:2px;width:${max ? (calc.meses[m] / max) * 100 : 0}%;min-width:2px"></div></td>
            <td style="width:92px;text-align:right">${num(calc.meses[m])} ${esc(unidad)}</td></tr>`;
        }).join('')}</tbody></table>` : ''}

      ${real?.compras?.length || calc?.compras?.length ? `
        <h4 class="fi-h4">Compras</h4>
        <table class="fi-tabla">
          <thead><tr><th>Fecha</th><th>Proveedor</th><th style="text-align:right">Cant.</th><th style="text-align:right">$ por ${esc(uni(unidad))}</th></tr></thead>
          <tbody>${(real?.compras || calc.compras).slice().reverse().slice(0, 12).map(c => `<tr>
            <td class="txt">${esc(fecha(c.fecha))}</td>
            <td class="txt" style="font-size:11.5px">${esc(c.proveedor)}</td>
            <td style="text-align:right">${num(c.cantidad)}</td>
            <td style="text-align:right">${c.moneda === 'ARS' ? pesos(c.precio) : 'US$ ' + num(c.precio)}</td>
          </tr>`).join('')}</tbody></table>` : ''}
    `;

    $('#fi-f-excl').addEventListener('change', e => {
      $('#fi-f-motivo').style.display = e.target.checked ? '' : 'none';
    });
    $('#fi-guardar').addEventListener('click', () => guardar(codigo));
    const arch = $('#fi-archivar');
    if (arch) arch.addEventListener('click', () => archivar(codigo, item.estado === 'descontinuado' ? 'vigente' : 'descontinuado'));

    $('#fi-panel').classList.add('open');
    $('#fi-panel').setAttribute('aria-hidden', 'false');
    $('#fi-velo').classList.add('open');
    $('#fi-cuerpo').scrollTop = 0;
  }

  // ---- Guardar ------------------------------------------------------------
  async function guardar(codigo) {
    const item = CTX.getItem(codigo);
    const btn = $('#fi-guardar');
    btn.disabled = true;

    const nuevoProv = $('#fi-f-prov').value ? Number($('#fi-f-prov').value) : null;
    const cambioProv = item && item.proveedor_id !== nuevoProv;
    const nombre = $('#fi-f-nombre').value.trim();
    const lote = $('#fi-f-lote').value.trim();
    const dias = $('#fi-f-dias').value.trim();

    try {
      if (!nombre) throw new Error('El nombre no puede quedar vacío');

      if (item) {
        const { error } = await sb.from('items').update({
          nombre,
          proveedor_id: nuevoProv,
          codigo_proveedor: $('#fi-f-codprov').value.trim() || null,
          categoria_id: $('#fi-f-cat').value ? Number($('#fi-f-cat').value) : null,
          unidad: $('#fi-f-unidad').value,
          notas: $('#fi-f-notas').value.trim() || null,
          actualizado_en: new Date().toISOString(),
        }).eq('codigo', codigo);
        if (error) throw new Error(error.message);
      }

      const ajuste = {
        codigo,
        lote_compra: lote === '' ? null : Number(lote),
        dias_objetivo: dias === '' ? null : Number(dias),
        excluido: $('#fi-f-excl').checked,
        motivo_excluido: $('#fi-f-excl').checked ? ($('#fi-f-motivo').value.trim() || null) : null,
        actualizado_en: new Date().toISOString(),
      };
      const { error: e2 } = await sb.from('repo_items').upsert(ajuste, { onConflict: 'codigo' });
      if (e2) throw new Error(e2.message);

      let aviso = '';
      if (cambioProv && item) {
        const { data: s } = await sb.auth.getSession();
        await sb.from('prov_cambios').insert({
          codigo_item: codigo, desde_id: item.proveedor_id, hasta_id: nuevoProv,
          motivo: 'Cambiado desde la ficha del insumo', quien: s?.session?.user?.email || null,
        });
        const p = (CTX.getProveedores() || []).find(x => x.id === nuevoProv);
        if (p?.odoo_partner_id) {
          const real = CTX.getReal ? CTX.getReal(codigo) : null;
          try {
            await fnProv({
              modo: 'proveedor_item', codigo_item: codigo, odoo_partner_id: p.odoo_partner_id,
              precio: real && real.moneda === 'ARS' ? real.ultimoPrecio : undefined,
              plazo_dias: p.plazo_entrega_dias ?? undefined,
            });
          } catch (e) { aviso = ' (en Odoo no se pudo: ' + e.message + ')'; }
        } else if (nuevoProv) {
          aviso = ' · en Odoo no se tocó: ese proveedor todavía no existe allá';
        }
      }

      await CTX.alGuardar();
      abrir(codigo);
      toast('Guardado' + aviso, aviso.includes('no se pudo') ? 'err' : '');
    } catch (e) {
      toast('No se pudo guardar: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function archivar(codigo, estado) {
    const { error } = await sb.from('items')
      .update({ estado, actualizado_en: new Date().toISOString() }).eq('codigo', codigo);
    if (error) return toast('No se pudo: ' + error.message, 'err');
    await CTX.alGuardar();
    abrir(codigo);
    toast(estado === 'descontinuado' ? 'Archivado. En Odoo no se tocó nada.' : 'Volvió a estar vigente');
  }

  return { configurar, abrir, cerrar, enlazar, get codigoActual() { return codigoActual; } };
})();
