// ====== Conteo de inventario (producto terminado + graneles) ======
// 1) "Empezar conteo" toma una foto del stock de Odoo (modo plan de sync-produccion) y arma las líneas.
// 2) Se imprime la planilla "a ciegas" (sin lo que dice Odoo) y se carga lo contado acá (se guarda solo).
// 3) Se ven las diferencias. El ajuste en Odoo es un paso aparte, con OK: aplica la DIFERENCIA contra
//    la foto (no el número absoluto), para no pisar entregas/fabricaciones que pasen en el medio.
(function () {
  'use strict';
  const FN = window.SUPABASE_URL + '/functions/v1/sync-produccion';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 2) => (n == null || n === '' ? '' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: d }));
  const GRUPOS = [
    { k: 'granel', t: 'Graneles', u: 'kg', ayuda: 'En kilos, con un decimal si hace falta.' },
    { k: 'terminado', t: 'Producto terminado', u: 'u', ayuda: 'En unidades (potes, baldes, botellas).' },
    { k: 'revisar', t: 'Revisar', u: 'u', ayuda: 'Combos con stock propio en Odoo: no deberían tenerlo (se arman con sus productos). Contá si hay alguno armado.' },
  ];
  const S = { conteo: null, lineas: [], verOdoo: false, filtro: '', soloFaltan: false };

  function msg(t, err = false) { const m = $('msg'); m.textContent = t; m.className = 'cn-msg' + (err ? ' err' : ''); m.style.display = 'block'; clearTimeout(msg._t); msg._t = setTimeout(() => { m.style.display = 'none'; }, err ? 6000 : 3000); }
  async function usuario() { const { data } = await sb.auth.getUser(); return data?.user?.email || null; }

  async function cargar() {
    const { data: c, error } = await sb.from('inv_conteos').select('*').eq('estado', 'abierto').order('id', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    S.conteo = c[0] || null;
    S.lineas = [];
    if (S.conteo) {
      const { data: l, error: e2 } = await sb.from('inv_conteo_lineas').select('*').eq('conteo_id', S.conteo.id).order('codigo').range(0, 1999);
      if (e2) throw new Error(e2.message);
      S.lineas = l;
    }
    pintar();
  }

  async function empezar() {
    const b = $('btn-empezar'); b.disabled = true; b.textContent = 'Leyendo el stock de Odoo…';
    try {
      const { data: s } = await sb.auth.getSession();
      const r = await fetch(FN, { method: 'POST', headers: { Authorization: 'Bearer ' + (s?.session?.access_token || window.SUPABASE_KEY), apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ modo: 'plan' }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || 'No se pudo leer Odoo');
      const { data: snap, error: es } = await sb.from('prod_plan_snapshot').select('creado,datos').order('id', { ascending: false }).limit(1).single();
      if (es) throw new Error(es.message);
      const lineas = [];
      for (const p of snap.datos.stock) {
        const fam = p.c.charAt(0);
        const grupo = fam === '9' ? 'granel' : fam === '1' ? 'terminado' : (fam === '6' && Number(p.disp) !== 0) ? 'revisar' : null;
        if (!grupo) continue;
        lineas.push({ codigo: p.c, nombre: p.n, grupo, uom: p.uom, odoo_qty: Number(p.disp) });
      }
      const quien = await usuario();
      const { data: c, error: ec } = await sb.from('inv_conteos').insert({ titulo: 'Conteo de producto terminado y graneles', foto_odoo: snap.creado, creado_por: quien }).select().single();
      if (ec) throw new Error(ec.message);
      const { error: el } = await sb.from('inv_conteo_lineas').insert(lineas.map((l) => ({ ...l, conteo_id: c.id })));
      if (el) throw new Error(el.message);
      await cargar(); msg(`Conteo iniciado: ${lineas.length} productos`);
    } catch (e) { msg('No se pudo empezar: ' + e.message, true); b.disabled = false; b.textContent = 'Empezar conteo'; }
  }

  async function guardar(codigo, valor, input) {
    const v = valor === '' ? null : Number(String(valor).replace(',', '.'));
    if (v != null && !(v >= 0)) { msg('La cantidad tiene que ser un número de 0 en adelante', true); return; }
    const quien = await usuario();
    const { error } = await sb.from('inv_conteo_lineas').update({ contado: v, actualizado: new Date().toISOString(), actualizado_por: quien }).eq('conteo_id', S.conteo.id).eq('codigo', codigo);
    if (error) { msg('No se guardó: ' + error.message, true); return; }
    const l = S.lineas.find((x) => x.codigo === codigo); if (l) l.contado = v;
    const tr = input.closest('tr'); tr.classList.toggle('contado', v != null);
    tr.querySelector('.difcell').innerHTML = difHtml(l);
    pintarKpis();
  }

  const dif = (l) => (l.contado == null ? null : Math.round((Number(l.contado) - Number(l.odoo_qty || 0)) * 1000) / 1000);
  function difHtml(l) {
    const d = dif(l); if (d == null) return '';
    return d === 0 ? '<span class="dif igual">=</span>' : `<span class="dif ${d > 0 ? 'mas' : 'menos'}">${d > 0 ? '+' : ''}${fmt(d, 3)}</span>`;
  }

  function pintarKpis() {
    const tot = S.lineas.length, cont = S.lineas.filter((l) => l.contado != null).length;
    const difs = S.lineas.filter((l) => dif(l) != null && dif(l) !== 0);
    $('kpis').innerHTML = `
      <div class="cn-kpi"><div class="k">Contados</div><div class="v">${cont} <span style="font-size:13px;color:var(--muted)">/ ${tot}</span></div><div class="barra"><i style="width:${tot ? (cont / tot) * 100 : 0}%"></i></div></div>
      <div class="cn-kpi"><div class="k">Con diferencia</div><div class="v" style="color:${difs.length ? 'var(--warn)' : 'var(--ok)'}">${difs.length}</div><div class="sub">contra la foto de Odoo</div></div>
      <div class="cn-kpi"><div class="k">Foto de Odoo</div><div class="v" style="font-size:16px">${S.conteo.foto_odoo ? new Date(S.conteo.foto_odoo).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</div><div class="sub">iniciado por ${esc((S.conteo.creado_por || '').split('@')[0])}</div></div>`;
  }

  function pintar() {
    if (!S.conteo) {
      $('cuerpo').innerHTML = `<div class="cn-nota">Para empezar se toma una <b>foto del stock de Odoo</b> de producto terminado y graneles. Después se imprime la planilla <b>a ciegas</b> (sin lo que dice Odoo), se cuenta, y se carga acá lo contado. Las diferencias se ven al final. <b>El ajuste en Odoo es un paso aparte</b>: no se toca nada hasta que lo apruebes.</div>
        <div class="cn-bloque"><div class="cn-vacio"><button class="btn primary" id="btn-empezar">Empezar conteo</button></div></div>`;
      $('btn-empezar').addEventListener('click', empezar);
      return;
    }
    const f = S.filtro.toLowerCase();
    const visible = (l) => (!f || l.codigo.toLowerCase().includes(f) || String(l.nombre).toLowerCase().includes(f)) && (!S.soloFaltan || l.contado == null);
    $('cuerpo').innerHTML = `
      <div class="cn-top"><div class="cn-kpis" id="kpis"></div>
        <div class="cn-acc"><div class="txt">Imprimí la planilla para contar y cargá acá lo contado (se guarda solo al salir de cada casilla).</div>
          <button class="btn primary" id="btn-imprimir">🖨️ Imprimir planilla</button>
          <button class="btn secondary" id="btn-dif">Ver diferencias</button></div></div>
      <div class="cn-tools">
        <input class="inp" id="filtro" placeholder="Buscar por código o nombre" value="${esc(S.filtro)}">
        <label><input type="checkbox" id="chk-faltan" ${S.soloFaltan ? 'checked' : ''}> Solo los que faltan contar</label>
        <label><input type="checkbox" id="chk-odoo" ${S.verOdoo ? 'checked' : ''}> Mostrar lo que dice Odoo</label>
      </div>
      ${GRUPOS.map((g) => {
        const xs = S.lineas.filter((l) => l.grupo === g.k);
        if (!xs.length) return '';
        const vis = xs.filter(visible);
        return `<div class="cn-bloque"><header><h3>${g.t}</h3><span class="meta">${xs.filter((l) => l.contado != null).length} de ${xs.length} contados · ${esc(g.ayuda)}</span></header>
          <table class="cn"><thead><tr><th class="cod">Código</th><th>Producto</th><th class="num ${S.verOdoo ? '' : 'oculto'}">Odoo</th><th class="num">Contado (${g.u})</th><th class="num ${S.verOdoo ? '' : 'oculto'}">Diferencia</th></tr></thead><tbody>
          ${vis.map((l) => `<tr class="${l.contado != null ? 'contado' : ''}"><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td>
            <td class="num ${S.verOdoo ? '' : 'oculto'}">${fmt(l.odoo_qty, 3)}</td>
            <td class="num"><input class="inp" inputmode="decimal" data-cod="${esc(l.codigo)}" value="${l.contado == null ? '' : esc(String(l.contado))}" aria-label="Contado ${esc(l.nombre)}"></td>
            <td class="num difcell ${S.verOdoo ? '' : 'oculto'}">${difHtml(l)}</td></tr>`).join('') || '<tr><td colspan="5" class="cn-vacio">Nada para mostrar con este filtro.</td></tr>'}
          </tbody></table></div>`;
      }).join('')}
      <div class="cn-bloque" id="bloque-dif" hidden></div>`;
    pintarKpis();
    $('filtro').addEventListener('input', (e) => { S.filtro = e.target.value; const pos = e.target.selectionStart; pintar(); const n = $('filtro'); n.focus(); n.setSelectionRange(pos, pos); });
    $('chk-faltan').addEventListener('change', (e) => { S.soloFaltan = e.target.checked; pintar(); });
    $('chk-odoo').addEventListener('change', (e) => { S.verOdoo = e.target.checked; pintar(); });
    $('btn-imprimir').addEventListener('click', imprimir);
    $('btn-dif').addEventListener('click', verDiferencias);
    for (const i of document.querySelectorAll('table.cn input')) {
      i.addEventListener('change', () => guardar(i.dataset.cod, i.value.trim(), i));
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const todos = [...document.querySelectorAll('table.cn input')]; const sig = todos[todos.indexOf(i) + 1]; i.blur(); if (sig) sig.focus(); } });
    }
  }

  function verDiferencias() {
    const xs = S.lineas.filter((l) => dif(l) != null && dif(l) !== 0).sort((a, b) => Math.abs(dif(b)) - Math.abs(dif(a)));
    const sin = S.lineas.filter((l) => l.contado == null).length;
    const b = $('bloque-dif'); b.hidden = false;
    b.innerHTML = `<header><h3>Diferencias contra Odoo</h3><span class="meta">${xs.length} producto${xs.length === 1 ? '' : 's'}${sin ? ` · faltan contar ${sin} (no se comparan)` : ''} · el ajuste en Odoo se hace aparte, con tu OK</span></header>
      ${xs.length ? `<table class="cn"><thead><tr><th class="cod">Código</th><th>Producto</th><th class="num">Odoo</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead><tbody>
      ${xs.map((l) => `<tr><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td><td class="num">${fmt(l.odoo_qty, 3)}</td><td class="num">${fmt(l.contado, 3)}</td><td class="num">${difHtml(l)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="cn-vacio">Sin diferencias en lo contado.</div>'}`;
    b.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function imprimir() {
    const verOdoo = S.verOdoo;
    const hoy = new Date();
    const filas = (g) => S.lineas.filter((l) => l.grupo === g.k).map((l) => `<tr><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td>${verOdoo ? `<td class="num">${fmt(l.odoo_qty, 3)}</td>` : ''}<td class="caja"></td><td class="obs"></td></tr>`).join('');
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Planilla de conteo ${hoy.toLocaleDateString('es-AR')}</title><style>
      @page { size: A4; margin: 11mm; } * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; }
      header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
      header .marca { font-weight: 800; letter-spacing: .12em; font-size: 12px; } header h1 { font-size: 17px; margin: 2px 0 0; }
      header .der { text-align: right; font-size: 10.5px; color: #444; line-height: 1.6; }
      h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 4px; }
      table { width: 100%; border-collapse: collapse; } tr { page-break-inside: avoid; }
      th { text-align: left; font-size: 9px; text-transform: uppercase; color: #444; border-bottom: 1.5px solid #111; padding: 3px 5px; }
      td { border-bottom: 1px solid #bbb; padding: 5px; height: 22px; }
      .cod { font-family: Consolas, monospace; font-size: 10px; color: #555; width: 58px; }
      .num { text-align: right; width: 60px; } td.caja { width: 80px; border-left: 1px solid #999; border-right: 1px solid #999; } td.obs { width: 130px; }
      footer { margin-top: 12px; display: flex; justify-content: space-between; font-size: 10.5px; }
    </style></head><body>
      <header><div><div class="marca">ROSAINT</div><h1>Planilla de conteo de inventario</h1><div>Producto terminado y graneles</div></div>
        <div class="der">Fecha: ${hoy.toLocaleDateString('es-AR')}<br>Contó: ____________________<br>Hora inicio: ______ fin: ______</div></header>
      ${GRUPOS.map((g) => { const f = filas(g); return f ? `<h2>${g.t} (${g.u === 'kg' ? 'kilos' : 'unidades'})</h2><table><thead><tr><th>Código</th><th>Producto</th>${verOdoo ? '<th class="num">Odoo</th>' : ''}<th>Contado</th><th>Observaciones</th></tr></thead><tbody>${f}</tbody></table>` : ''; }).join('')}
      <footer><span>Controló: ______________________</span><span>Rosaint Core · Conteo de inventario</span></footer>
      <script>window.onload = () => window.print();<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) return msg('El navegador bloqueó la ventana de impresión: permití ventanas emergentes para Core', true);
    w.document.open(); w.document.write(html); w.document.close();
  }

  cargar().catch((e) => { $('cuerpo').innerHTML = `<div class="cn-bloque"><div class="cn-vacio">No se pudo cargar: ${esc(e.message)}</div></div>`; });
})();
