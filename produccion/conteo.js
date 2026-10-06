// ====== Conteo de inventario (producto terminado + graneles) → Consolidación ======
// 1) "Empezar conteo" toma una foto del stock de Odoo (modo plan de sync-produccion) y arma las líneas.
// 2) Se imprime la planilla "a ciegas" y se carga lo contado acá (autoguardado + respaldo local).
// 3) "Sincronizar con Odoo" trae los movimientos hechos desde la foto (entregas, fabricaciones…).
//    Lo ESPERADO de cada producto = foto + movimientos que ya habían pasado cuando se contó ese producto
//    (por hora; se puede corregir a mano: "ya había salido/entrado cuando contaron").
// 4) "Finalizar" cierra el conteo como CONSOLIDACIÓN con código, inicio, fin, quién y resumen (historial).
// El ajuste en Odoo es un paso aparte, con OK.
(function () {
  'use strict';
  const FN = window.SUPABASE_URL + '/functions/v1/sync-produccion';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 2) => (n == null || n === '' ? '' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: d }));
  const fh = (t, conFecha = true) => (t ? new Date(t).toLocaleString('es-AR', conFecha ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) : '—');
  const GRUPOS = [
    { k: 'granel', t: 'Graneles', u: 'kg', ayuda: 'En kilos, con un decimal si hace falta.' },
    { k: 'terminado', t: 'Producto terminado', u: 'u', ayuda: 'En unidades (potes, baldes, botellas).' },
  ];
  const unidad = (l) => (l.grupo === 'granel' ? 'kg' : 'u');
  const grupoDe = (k) => (GRUPOS.find((g) => g.k === k) || {}).t || k;
  const S = { conteo: null, lineas: [], historial: [], verOdoo: false, filtro: '', soloFaltan: false, vista: 'contar', difFiltro: '' };
  try { if (localStorage.getItem('conteo.vista') === 'diferencias') S.vista = 'diferencias'; } catch { /* */ }
  const abierto = () => S.conteo && S.conteo.estado === 'abierto';

  function msg(t, err = false) { const m = $('msg'); m.textContent = t; m.className = 'cn-msg' + (err ? ' err' : ''); m.style.display = 'block'; clearTimeout(msg._t); msg._t = setTimeout(() => { m.style.display = 'none'; }, err ? 6000 : 3500); }
  async function usuario() { const { data } = await sb.auth.getUser(); return data?.user?.email || null; }
  async function fn(modo, body = {}) {
    const { data: s } = await sb.auth.getSession();
    const r = await fetch(FN, { method: 'POST', headers: { Authorization: 'Bearer ' + (s?.session?.access_token || window.SUPABASE_KEY), apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ modo, ...body }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || 'Error'); return j;
  }

  // ---------------- carga ----------------
  async function cargar(id) {
    const [h, c] = await Promise.all([
      sb.from('inv_conteos').select('*').order('id', { ascending: false }).limit(40),
      id ? sb.from('inv_conteos').select('*').eq('id', id).limit(1) : sb.from('inv_conteos').select('*').eq('estado', 'abierto').order('id', { ascending: false }).limit(1),
    ]);
    if (h.error) throw new Error(h.error.message);
    if (c.error) throw new Error(c.error.message);
    S.historial = h.data;
    S.conteo = c.data[0] || null;
    S.lineas = [];
    if (S.conteo) {
      const { data: l, error } = await sb.from('inv_conteo_lineas').select('*').eq('conteo_id', S.conteo.id).order('codigo').range(0, 1999);
      if (error) throw new Error(error.message);
      S.lineas = l;
    }
    pintar();
  }

  async function empezar() {
    const b = $('btn-empezar'); b.disabled = true; b.textContent = 'Leyendo el stock de Odoo…';
    try {
      await fn('plan');
      const { data: snap, error: es } = await sb.from('prod_plan_snapshot').select('creado,datos').order('id', { ascending: false }).limit(1).single();
      if (es) throw new Error(es.message);
      const lineas = [];
      for (const p of snap.datos.stock) {
        const fam = p.c.charAt(0);
        // los combos y packs son kits: Odoo informa cuántos se podrían ARMAR con sus productos, no stock real → no se cuentan
        if (snap.datos.kits && snap.datos.kits[p.c]) continue;
        const grupo = fam === '9' ? 'granel' : fam === '1' ? 'terminado' : null;
        if (!grupo) continue;
        lineas.push({ codigo: p.c, nombre: p.n, grupo, uom: p.uom, odoo_qty: Number(p.disp) });
      }
      const quien = await usuario();
      const { data: c, error: ec } = await sb.from('inv_conteos').insert({ titulo: 'Conteo de producto terminado y graneles', foto_odoo: snap.creado, creado_por: quien }).select().single();
      if (ec) throw new Error(ec.message);
      const { error: el } = await sb.from('inv_conteo_lineas').insert(lineas.map((l) => ({ ...l, conteo_id: c.id })));
      if (el) throw new Error(el.message);
      S.vista = 'contar'; await cargar(); msg(`Conteo iniciado: ${lineas.length} productos`);
    } catch (e) { msg('No se pudo empezar: ' + e.message, true); b.disabled = false; b.textContent = 'Empezar conteo'; }
  }

  // ---------------- autoguardado (respaldo local + reintento) ----------------
  const PEND = {}; const timers = {};
  const claveResp = () => 'conteo.pendiente.' + S.conteo.id;
  function respaldar() { try { if (S.conteo) localStorage.setItem(claveResp(), JSON.stringify(PEND)); } catch { /* */ } }
  function estado(t, tipo) { const e = $('estado-guardado'); if (e) { e.textContent = t; e.className = 'guardado ' + (tipo || ''); } }
  function parsear(valor) { const t = String(valor).trim(); if (t === '') return null; const v = Number(t.replace(',', '.')); return v >= 0 ? v : NaN; }
  function guardarPronto(codigo, valor, demora = 600) {
    const v = parsear(valor);
    if (Number.isNaN(v)) { estado('⚠ Número inválido en ' + codigo, 'err'); return; }
    PEND[codigo] = v; respaldar(); estado('Guardando…', 'pend');
    clearTimeout(timers[codigo]); timers[codigo] = setTimeout(() => enviar(codigo), demora);
  }
  let reintento = null;
  async function enviar(codigo) {
    if (!(codigo in PEND) || !abierto()) return;
    const v = PEND[codigo];
    const quien = await usuario(); const ahora = new Date().toISOString();
    // contado_en = cuándo se contó: define qué movimientos de Odoo ya habían pasado
    const { error } = await sb.from('inv_conteo_lineas').update({ contado: v, contado_en: v == null ? null : ahora, actualizado: ahora, actualizado_por: quien }).eq('conteo_id', S.conteo.id).eq('codigo', codigo);
    if (error) { estado('Sin conexión: quedó guardado en este equipo, reintentando…', 'err'); clearTimeout(reintento); reintento = setTimeout(() => Object.keys(PEND).forEach(enviar), 5000); return; }
    if (PEND[codigo] === v) delete PEND[codigo];
    respaldar();
    const l = S.lineas.find((x) => x.codigo === codigo); if (l) { l.contado = v; l.contado_en = v == null ? null : ahora; refrescarFila(l); }
    pintarKpis();
    if (!Object.keys(PEND).length) estado('Guardado ✓ ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), 'ok');
  }
  function refrescarFila(l) {
    const i = document.querySelector(`table.cn input.cant[data-cod="${CSS.escape(l.codigo)}"]`); if (!i) return;
    const tr = i.closest('tr'); tr.classList.toggle('contado', l.contado != null);
    const d = tr.querySelector('.difcell'); if (d) d.innerHTML = difHtml(l);
    if (document.activeElement !== i && !(l.codigo in PEND)) i.value = l.contado == null ? '' : String(l.contado);
  }
  // lo que cargan otros equipos (cada 15 s), sin pisar lo que se escribe acá
  async function traerOtros() {
    if (!abierto() || document.hidden) return;
    const { data, error } = await sb.from('inv_conteo_lineas').select('codigo,contado,contado_en,esperado,odoo_actual,movimientos,mov_override').eq('conteo_id', S.conteo.id).range(0, 1999);
    if (error) { estado('Sin conexión: reintentando…', 'err'); return; }
    let cambio = false;
    for (const r of data) {
      if (r.codigo in PEND) continue;
      const l = S.lineas.find((x) => x.codigo === r.codigo); if (!l) continue;
      const v = r.contado == null ? null : Number(r.contado);
      if (l.contado !== v || JSON.stringify(l.movimientos) !== JSON.stringify(r.movimientos) || JSON.stringify(l.mov_override) !== JSON.stringify(r.mov_override)) { Object.assign(l, r, { contado: v }); refrescarFila(l); cambio = true; }
    }
    pintarKpis();
    if (cambio && S.vista === 'diferencias') pintarDiferencias();
  }

  // ---------------- sincronizar con Odoo (movimientos desde la foto) ----------------
  let sincronizando = false;
  async function sincronizarOdoo(silencioso = false) {
    if (!abierto() || sincronizando) return;
    sincronizando = true;
    const b = $('btn-sync'); if (b) { b.disabled = true; b.textContent = 'Sincronizando…'; }
    try {
      for (const c of Object.keys(PEND)) await enviar(c);       // primero que entre lo tipeado
      const r = await fn('conteo_sync', { conteo_id: S.conteo.id });
      S.conteo.ultima_sync = r.sincronizado;
      await traerOtros();
      if (!silencioso) msg(r.productos_con_movimientos ? `Sincronizado: ${r.productos_con_movimientos} producto(s) con movimientos en Odoo desde la foto` : 'Sincronizado: sin movimientos en Odoo desde la foto');
    } catch (e) { if (!silencioso) msg('No se pudo sincronizar: ' + e.message, true); }
    finally { sincronizando = false; pintarSync(); }
  }
  function pintarSync() {
    const b = $('btn-sync'); if (b) { b.disabled = false; b.textContent = '🔄 Sincronizar con Odoo'; }
    const t = $('ult-sync'); if (t) t.textContent = S.conteo?.ultima_sync ? 'Última sincronización: ' + fh(S.conteo.ultima_sync, false) : 'Todavía no se sincronizó con Odoo';
  }

  // ---------------- cálculo de lo esperado y la diferencia ----------------
  // por defecto todo movimiento validado en Odoo cuenta como ocurrido (sale primero, se valida después); se destilda a mano
  const incluye = (l, m) => { const ov = l.mov_override || {}; return m.ref in ov ? !!ov[m.ref] : true; };
  function esperadoDe(l) {
    const movs = l.movimientos || [];
    return Math.round((Number(l.odoo_qty || 0) + movs.filter((m) => incluye(l, m)).reduce((a, m) => a + Number(m.q), 0)) * 10000) / 10000;
  }
  const dif = (l) => (l.contado == null ? null : Math.round((Number(l.contado) - esperadoDe(l)) * 1000) / 1000);
  function difHtml(l) {
    const d = dif(l); if (d == null) return '';
    return d === 0 ? '<span class="dif igual">=</span>' : `<span class="dif ${d > 0 ? 'mas' : 'menos'}">${d > 0 ? '+' : ''}${fmt(d, 3)}</span>`;
  }
  async function marcarMov(codigo, ref, valor) {
    const l = S.lineas.find((x) => x.codigo === codigo); if (!l || !abierto()) return;
    l.mov_override = { ...(l.mov_override || {}), [ref]: valor };
    const { error } = await sb.from('inv_conteo_lineas').update({ mov_override: l.mov_override, esperado: esperadoDe(l) }).eq('conteo_id', S.conteo.id).eq('codigo', codigo);
    if (error) msg('No se guardó: ' + error.message, true);
    pintarKpis(); pintarDiferencias();
  }

  // ---------------- pintar ----------------
  function pintarKpis() {
    const nd = $('n-dif'); if (nd) nd.textContent = S.lineas.filter((l) => dif(l) != null && dif(l) !== 0).length;
    const nc = $('n-cont'); if (nc) nc.textContent = S.lineas.filter((l) => l.contado != null).length + '/' + S.lineas.length;
    for (const g of GRUPOS) { const m = $('meta-' + g.k); if (m) { const xs = S.lineas.filter((l) => l.grupo === g.k); m.textContent = xs.filter((l) => l.contado != null).length + ' de ' + xs.length + ' contados'; } }
    const k = $('kpis'); if (!k) return;
    const tot = S.lineas.length, cont = S.lineas.filter((l) => l.contado != null).length;
    const difs = S.lineas.filter((l) => dif(l) != null && dif(l) !== 0);
    k.innerHTML = `
      <div class="cn-kpi clic" data-vista="contar" title="Ir a lo contado"><div class="k">Contados</div><div class="v">${cont} <span style="font-size:13px;color:var(--muted)">/ ${tot}</span></div><div class="barra"><i style="width:${tot ? (cont / tot) * 100 : 0}%"></i></div></div>
      <div class="cn-kpi clic" data-vista="diferencias" title="Ver las diferencias"><div class="k">Con diferencia ›</div><div class="v" style="color:${difs.length ? 'var(--warn)' : 'var(--ok)'}">${difs.length}</div><div class="sub">tocá para verlas</div></div>
      <div class="cn-kpi"><div class="k">${abierto() ? 'Foto de Odoo' : 'Consolidación'}</div><div class="v" style="font-size:15px">${abierto() ? fh(S.conteo.foto_odoo) : esc(S.conteo.codigo || '')}</div><div class="sub">${abierto() ? 'iniciado por ' + esc((S.conteo.creado_por || '').split('@')[0]) : 'cerrado por ' + esc((S.conteo.cerrado_por || '').split('@')[0])}</div></div>`;
  }

  function pintar() {
    if (!S.conteo) {
      $('cuerpo').innerHTML = `<div class="cn-nota">Para empezar se toma una <b>foto del stock de Odoo</b> de producto terminado y graneles. Se imprime la planilla <b>a ciegas</b>, se cuenta y se carga acá. Con <b>Sincronizar con Odoo</b> se tienen en cuenta las entregas y fabricaciones que pasen mientras se cuenta. Al terminar, <b>Finalizar</b> lo registra como consolidación. <b>El ajuste en Odoo es un paso aparte</b>, con tu OK.</div>
        <div class="cn-bloque"><div class="cn-vacio"><button class="btn primary" id="btn-empezar">Empezar conteo</button></div></div>${historialHtml()}`;
      $('btn-empezar').addEventListener('click', empezar);
      return;
    }
    const tot = S.lineas.length;
    const conDif = S.lineas.filter((l) => dif(l) != null && dif(l) !== 0).length;
    const cerrado = !abierto();
    const c = S.conteo;
    const dur = c.inicio && c.fin ? Math.round((new Date(c.fin) - new Date(c.inicio)) / 60000) : null;
    $('cuerpo').innerHTML = `
      ${cerrado ? `<div class="cn-cons"><div><div class="cn-cod">${esc(c.codigo || 'Conteo #' + c.id)}</div>
          <div class="cn-cons-txt">Consolidación ${c.estado === 'aplicado' ? 'aplicada en Odoo' : 'cerrada'} · inicio <b>${fh(c.inicio)}</b> · fin <b>${fh(c.fin)}</b>${dur != null ? ` · ${dur >= 60 ? Math.floor(dur / 60) + ' h ' : ''}${dur % 60} min` : ''} · por ${esc((c.cerrado_por || '').split('@')[0])}</div></div>
          <span class="der"><button class="btn secondary" id="btn-res">🖨️ Imprimir resumen</button>${S.historial.some((h) => h.estado === 'abierto') ? '' : '<button class="btn primary" id="btn-nuevo">Nuevo conteo</button>'}</span></div>` : ''}
      <div class="cn-top"><div class="cn-kpis" id="kpis"></div>
        ${cerrado ? '' : `<div class="cn-acc"><div class="txt">Cargá lo contado: <b>se guarda solo</b>. Sincronizá con Odoo si hubo entregas o fabricaciones mientras cuentan.</div>
          <div class="guardado ok" id="estado-guardado">Guardado ✓</div>
          <button class="btn primary" id="btn-imprimir">🖨️ Imprimir planilla</button>
          <button class="btn secondary" id="btn-sync">🔄 Sincronizar con Odoo</button><div class="txt" id="ult-sync"></div>
          <button class="btn secondary fin" id="btn-fin">✓ Finalizar conteo</button></div>`}</div>
      <div class="cn-tabs" role="tablist">
        <button class="cn-tab" role="tab" data-vista="contar" aria-selected="${S.vista === 'contar'}">${cerrado ? 'Contado' : 'Contar'} <span class="n" id="n-cont">${S.lineas.filter((l) => l.contado != null).length}/${tot}</span></button>
        <button class="cn-tab" role="tab" data-vista="diferencias" aria-selected="${S.vista === 'diferencias'}">Diferencias <span class="n" id="n-dif">${conDif}</span></button>
        <button class="cn-tab" role="tab" data-vista="historial" aria-selected="${S.vista === 'historial'}">Historial <span class="n">${S.historial.length}</span></button>
      </div>
      <div id="vista"></div>`;
    pintarKpis();
    if (S.vista === 'diferencias') pintarDiferencias(); else if (S.vista === 'historial') $('vista').innerHTML = historialHtml(); else pintarContar();
    if (cerrado) { $('btn-res').addEventListener('click', imprimirResumen); const n = $('btn-nuevo'); if (n) n.addEventListener('click', () => { S.conteo = null; S.lineas = []; pintar(); }); }
    else { $('btn-imprimir').addEventListener('click', imprimir); $('btn-sync').addEventListener('click', () => sincronizarOdoo(false)); $('btn-fin').addEventListener('click', finalizar); pintarSync(); }
  }

  function pintarContar() {
    const ro = !abierto();
    const f = S.filtro.toLowerCase();
    const visible = (l) => (!f || l.codigo.toLowerCase().includes(f) || String(l.nombre).toLowerCase().includes(f)) && (!S.soloFaltan || l.contado == null);
    const verOdoo = S.verOdoo || ro;
    $('vista').innerHTML = `
      <div class="cn-tools">
        <input class="input" type="search" id="filtro" placeholder="🔍 Buscar por código o nombre" value="${esc(S.filtro)}" autocomplete="off">
        <label><input type="checkbox" id="chk-faltan" ${S.soloFaltan ? 'checked' : ''}> Solo los ${ro ? 'no contados' : 'que faltan contar'}</label>
        ${ro ? '' : `<label><input type="checkbox" id="chk-odoo" ${S.verOdoo ? 'checked' : ''}> Mostrar lo que dice Odoo</label>`}
      </div>
      ${GRUPOS.map((g) => {
        const xs = S.lineas.filter((l) => l.grupo === g.k);
        if (!xs.length) return '';
        const vis = xs.filter(visible);
        return `<div class="cn-bloque"><header><h3>${g.t}</h3><span class="meta"><span id="meta-${g.k}">${xs.filter((l) => l.contado != null).length} de ${xs.length} contados</span> · ${esc(g.ayuda)}</span></header>
          <table class="cn"><thead><tr><th class="cod">Código</th><th>Producto</th><th class="num ${verOdoo ? '' : 'oculto'}">Esperado</th><th class="num">Contado (${g.u})</th><th class="num ${verOdoo ? '' : 'oculto'}">Diferencia</th></tr></thead><tbody>
          ${vis.map((l) => `<tr class="${l.contado != null ? 'contado' : ''}"><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td>
            <td class="num ${verOdoo ? '' : 'oculto'}">${fmt(esperadoDe(l), 3)}</td>
            <td class="num">${ro ? `<b>${l.contado == null ? '—' : fmt(l.contado, 3)}</b>` : `<input class="input cant" inputmode="decimal" data-cod="${esc(l.codigo)}" value="${l.codigo in PEND ? esc(PEND[l.codigo] == null ? '' : String(PEND[l.codigo])) : l.contado == null ? '' : esc(String(l.contado))}" aria-label="Contado ${esc(l.nombre)}">`}</td>
            <td class="num difcell ${verOdoo ? '' : 'oculto'}">${difHtml(l)}</td></tr>`).join('') || '<tr><td colspan="5" class="cn-vacio">Nada para mostrar con este filtro.</td></tr>'}
          </tbody></table></div>`;
      }).join('')}`;
    $('filtro').addEventListener('input', (e) => { S.filtro = e.target.value; const pos = e.target.selectionStart; pintarContar(); const n = $('filtro'); n.focus(); n.setSelectionRange(pos, pos); });
    $('chk-faltan').addEventListener('change', (e) => { S.soloFaltan = e.target.checked; pintarContar(); });
    if (!ro) $('chk-odoo').addEventListener('change', (e) => { S.verOdoo = e.target.checked; pintarContar(); });
    for (const i of document.querySelectorAll('table.cn input.cant')) {
      i.addEventListener('input', () => guardarPronto(i.dataset.cod, i.value));
      i.addEventListener('change', () => guardarPronto(i.dataset.cod, i.value, 0));
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const todos = [...document.querySelectorAll('table.cn input.cant')]; const sig = todos[todos.indexOf(i) + 1]; i.blur(); if (sig) sig.focus(); } });
    }
  }

  function movsHtml(l) {
    const ms = l.movimientos || [];
    if (!ms.length) return '<span class="muted">—</span>';
    const ro = !abierto();
    return ms.map((m) => `<label class="mov ${incluye(l, m) ? 'in' : ''}" title="${incluye(l, m) ? 'Se tiene en cuenta (destildá si pasó DESPUÉS de contar)' : 'No se tiene en cuenta: marcado como posterior al conteo'}">
      <input type="checkbox" ${incluye(l, m) ? 'checked' : ''} ${ro ? 'disabled' : ''} data-movcod="${esc(l.codigo)}" data-movref="${esc(m.ref)}">
      <b class="${m.q < 0 ? 'neg' : 'pos'}">${m.q > 0 ? '+' : ''}${fmt(m.q, 3)}</b> ${esc(m.ref)} <span class="muted">${fh(m.fecha, false)}${m.antes_de_contar ? '' : ' · validado después del conteo'}</span></label>`).join('');
  }

  function pintarDiferencias() {
    const contados = S.lineas.filter((l) => l.contado != null);
    const xs = contados.filter((l) => dif(l) !== 0);
    const sobra = xs.filter((l) => dif(l) > 0), falta = xs.filter((l) => dif(l) < 0);
    const iguales = contados.length - xs.length;
    const sin = S.lineas.filter((l) => l.contado == null);
    const conMov = S.lineas.filter((l) => (l.movimientos || []).length);
    const base = S.difFiltro === 'falta' ? falta : S.difFiltro === 'sobra' ? sobra : S.difFiltro === 'mov' ? conMov : xs;
    const lista = [...base].sort((a, b) => Math.abs(dif(b) || 0) - Math.abs(dif(a) || 0));
    $('vista').innerHTML = `
      <div class="cn-nota"><b>Esperado</b> = lo que decía Odoo al empezar + los movimientos de Odoo desde entonces (entregas, fabricaciones). Por defecto <b>se cuentan todos los movimientos</b> (la mercadería sale y después se valida en Odoo). <b>Destildá</b> uno solo si de verdad pasó después de contar ese producto. ${abierto() ? '<b>Sincronizá con Odoo</b> para traer los movimientos nuevos.' : ''} El ajuste en Odoo se hace aparte y con tu OK.</div>
      <div class="cn-filtros">
        <button class="chip-f ${!S.difFiltro ? 'on' : ''}" data-dif="">Con diferencia (${xs.length})</button>
        <button class="chip-f ${S.difFiltro === 'falta' ? 'on' : ''}" data-dif="falta">Hay menos (${falta.length})</button>
        <button class="chip-f ${S.difFiltro === 'sobra' ? 'on' : ''}" data-dif="sobra">Hay más (${sobra.length})</button>
        <button class="chip-f ${S.difFiltro === 'mov' ? 'on' : ''}" data-dif="mov">Con movimientos en Odoo (${conMov.length})</button>
        <span class="muted" style="font-size:12px">· ${iguales} coinciden · ${sin.length} sin contar</span>
      </div>
      <div class="cn-bloque">${lista.length ? `<table class="cn"><thead><tr><th class="cod">Código</th><th>Producto</th><th class="num">Al empezar</th><th>Movimientos en Odoo desde la foto</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead><tbody>
        ${lista.map((l) => `<tr><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}<div class="muted" style="font-size:11px">${esc(grupoDe(l.grupo))}${l.contado_en ? ' · contado ' + fh(l.contado_en, false) : ''}</div></td>
          <td class="num">${fmt(l.odoo_qty, 3)}</td><td class="movs">${movsHtml(l)}</td>
          <td class="num">${fmt(esperadoDe(l), 3)} ${unidad(l)}</td><td class="num"><b>${l.contado == null ? '—' : fmt(l.contado, 3)}</b> ${l.contado == null ? '' : unidad(l)}</td><td class="num">${difHtml(l)} ${dif(l) ? unidad(l) : ''}</td></tr>`).join('')}</tbody></table>`
        : `<div class="cn-vacio">${contados.length ? 'Sin diferencias en lo contado. ✓' : 'Todavía no se cargó nada: las diferencias aparecen a medida que se cuenta.'}</div>`}</div>
      ${sin.length ? `<div class="cn-bloque"><details><summary class="cn-sum">Sin contar (${sin.length})</summary>
        <table class="cn"><tbody>${sin.map((l) => `<tr><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td><td class="muted">${esc(grupoDe(l.grupo))}</td><td class="num muted">Esperado: ${fmt(esperadoDe(l), 3)} ${unidad(l)}</td></tr>`).join('')}</tbody></table></details></div>` : ''}`;
    for (const b of document.querySelectorAll('[data-dif]')) b.addEventListener('click', () => { S.difFiltro = b.dataset.dif; pintarDiferencias(); });
    for (const c of document.querySelectorAll('input[data-movcod]')) c.addEventListener('change', () => marcarMov(c.dataset.movcod, c.dataset.movref, c.checked));
  }

  function historialHtml() {
    if (!S.historial.length) return '';
    return `<div class="cn-bloque"><header><h3>Historial de conteos y consolidaciones</h3><span class="meta">${S.historial.length}</span></header>
      <table class="cn"><thead><tr><th>Código</th><th>Estado</th><th>Inicio</th><th>Fin</th><th class="num">Contados</th><th class="num">Con diferencia</th><th>Quién</th><th></th></tr></thead><tbody>
      ${S.historial.map((h) => `<tr class="${S.conteo && S.conteo.id === h.id ? 'actual' : ''}"><td><b>${esc(h.codigo || 'Conteo #' + h.id)}</b></td>
        <td><span class="est ${esc(h.estado)}">${h.estado === 'abierto' ? 'En curso' : h.estado === 'cerrado' ? 'Cerrado' : h.estado === 'aplicado' ? 'Aplicado en Odoo' : 'Anulado'}</span></td>
        <td>${fh(h.inicio || h.creado)}</td><td>${fh(h.fin)}</td>
        <td class="num">${h.resumen ? `${h.resumen.contados}/${h.resumen.lineas}` : '—'}</td><td class="num">${h.resumen ? h.resumen.con_diferencia : '—'}</td>
        <td class="muted">${esc(((h.cerrado_por || h.creado_por) || '').split('@')[0])}</td>
        <td><span class="acc"><button data-ver="${h.id}">Ver</button></span></td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------------- finalizar → consolidación ----------------
  async function finalizar() {
    const sin = S.lineas.filter((l) => l.contado == null).length;
    if (Object.keys(PEND).length) { msg('Esperá que termine de guardar lo último', true); return; }
    const aviso = `¿Finalizar el conteo y registrarlo como consolidación?\n\n` + (sin ? `Quedan ${sin} producto(s) SIN CONTAR: no se van a comparar ni ajustar.\n\n` : '') + `Antes de cerrar se sincroniza con Odoo una última vez. Después no se puede editar.`;
    if (!confirm(aviso)) return;
    const b = $('btn-fin'); b.disabled = true; b.textContent = 'Cerrando…';
    try {
      await sincronizarOdoo(true);
      const ahora = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const codigo = `CONS-${ahora.getFullYear()}${p(ahora.getMonth() + 1)}${p(ahora.getDate())}-${p(ahora.getHours())}${p(ahora.getMinutes())}`;
      const contadosT = S.lineas.filter((l) => l.contado_en).map((l) => new Date(l.contado_en).getTime());
      const inicio = new Date(Math.min(new Date(S.conteo.creado).getTime(), ...(contadosT.length ? contadosT : [Infinity])));
      const xs = S.lineas.filter((l) => l.contado != null && dif(l) !== 0);
      const resumen = {
        lineas: S.lineas.length, contados: S.lineas.filter((l) => l.contado != null).length, sin_contar: sin,
        con_diferencia: xs.length, hay_mas: xs.filter((l) => dif(l) > 0).length, hay_menos: xs.filter((l) => dif(l) < 0).length,
        diferencias: xs.map((l) => ({ codigo: l.codigo, nombre: l.nombre, unidad: unidad(l), esperado: esperadoDe(l), contado: Number(l.contado), diferencia: dif(l) })),
      };
      // guardar el esperado final de cada línea (queda como registro)
      for (let i = 0; i < S.lineas.length; i += 150) {
        await sb.from('inv_conteo_lineas').upsert(S.lineas.slice(i, i + 150).map((l) => ({ conteo_id: S.conteo.id, codigo: l.codigo, esperado: esperadoDe(l) })), { onConflict: 'conteo_id,codigo' });
      }
      const { error } = await sb.from('inv_conteos').update({ estado: 'cerrado', codigo, inicio: inicio.toISOString(), fin: ahora.toISOString(), cerrado_por: await usuario(), resumen }).eq('id', S.conteo.id);
      if (error) throw new Error(error.message);
      try { localStorage.removeItem(claveResp()); } catch { /* */ }
      S.vista = 'diferencias'; await cargar(S.conteo.id);
      msg(`Consolidación ${codigo} registrada`);
    } catch (e) { msg('No se pudo cerrar: ' + e.message, true); b.disabled = false; b.textContent = '✓ Finalizar conteo'; }
  }

  function irA(vista) { S.vista = vista; try { localStorage.setItem('conteo.vista', vista); } catch { /* */ } pintar(); if (vista === 'diferencias' && abierto() && (!S.conteo.ultima_sync || Date.now() - new Date(S.conteo.ultima_sync) > 60000)) sincronizarOdoo(true); }
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-vista]'); if (t) { irA(t.dataset.vista); return; }
    const v = e.target.closest('[data-ver]'); if (v) { S.vista = 'diferencias'; await cargar(Number(v.dataset.ver)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  // ---------------- impresos ----------------
  const ESTILO_IMP = `@page { size: A4; margin: 11mm; } * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; }
      header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
      header .marca { font-weight: 800; letter-spacing: .12em; font-size: 12px; } header h1 { font-size: 17px; margin: 2px 0 0; }
      header .der { text-align: right; font-size: 10.5px; color: #444; line-height: 1.6; }
      h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 4px; }
      table { width: 100%; border-collapse: collapse; } tr { page-break-inside: avoid; }
      th { text-align: left; font-size: 9px; text-transform: uppercase; color: #444; border-bottom: 1.5px solid #111; padding: 3px 5px; }
      td { border-bottom: 1px solid #bbb; padding: 5px; height: 22px; }
      .cod { font-family: Consolas, monospace; font-size: 10px; color: #555; width: 58px; }
      .num { text-align: right; width: 70px; } td.caja { width: 80px; border-left: 1px solid #999; border-right: 1px solid #999; } td.obs { width: 130px; }
      footer { margin-top: 12px; display: flex; justify-content: space-between; font-size: 10.5px; }`;
  function abrirImpreso(html) {
    const w = window.open('', '_blank');
    if (!w) return msg('El navegador bloqueó la ventana de impresión: permití ventanas emergentes para Core', true);
    w.document.open(); w.document.write(html); w.document.close();
  }
  function imprimir() {
    const verOdoo = S.verOdoo; const hoy = new Date();
    const filas = (g) => S.lineas.filter((l) => l.grupo === g.k).map((l) => `<tr><td class="cod">${esc(l.codigo)}</td><td>${esc(l.nombre)}</td>${verOdoo ? `<td class="num">${fmt(esperadoDe(l), 3)}</td>` : ''}<td class="caja"></td><td class="obs"></td></tr>`).join('');
    abrirImpreso(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Planilla de conteo ${hoy.toLocaleDateString('es-AR')}</title><style>${ESTILO_IMP}</style></head><body>
      <header><div><div class="marca">ROSAINT</div><h1>Planilla de conteo de inventario</h1><div>Producto terminado y graneles</div></div>
        <div class="der">Fecha: ${hoy.toLocaleDateString('es-AR')}<br>Contó: ____________________<br>Hora inicio: ______ fin: ______</div></header>
      ${GRUPOS.map((g) => { const f = filas(g); return f ? `<h2>${g.t} (${g.u === 'kg' ? 'kilos' : 'unidades'})</h2><table><thead><tr><th>Código</th><th>Producto</th>${verOdoo ? '<th class="num">Odoo</th>' : ''}<th>Contado</th><th>Observaciones</th></tr></thead><tbody>${f}</tbody></table>` : ''; }).join('')}
      <footer><span>Controló: ______________________</span><span>Rosaint Core · Conteo de inventario</span></footer>
      <script>window.onload = () => window.print();<\/script></body></html>`);
  }
  function imprimirResumen() {
    const c = S.conteo, r = c.resumen || {};
    const xs = (r.diferencias || []).slice().sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
    abrirImpreso(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${esc(c.codigo)}</title><style>${ESTILO_IMP}</style></head><body>
      <header><div><div class="marca">ROSAINT</div><h1>Consolidación de inventario ${esc(c.codigo)}</h1><div>Producto terminado y graneles</div></div>
        <div class="der">Inicio: ${fh(c.inicio)}<br>Fin: ${fh(c.fin)}<br>Cerró: ${esc(c.cerrado_por || '')}</div></header>
      <p>Productos: <b>${r.lineas}</b> · contados: <b>${r.contados}</b> · sin contar: <b>${r.sin_contar}</b> · con diferencia: <b>${r.con_diferencia}</b> (hay más ${r.hay_mas} · hay menos ${r.hay_menos})</p>
      <h2>Diferencias contra Odoo</h2>
      ${xs.length ? `<table><thead><tr><th>Código</th><th>Producto</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead><tbody>
      ${xs.map((d) => `<tr><td class="cod">${esc(d.codigo)}</td><td>${esc(d.nombre)}</td><td class="num">${fmt(d.esperado, 3)} ${d.unidad}</td><td class="num">${fmt(d.contado, 3)} ${d.unidad}</td><td class="num"><b>${d.diferencia > 0 ? '+' : ''}${fmt(d.diferencia, 3)} ${d.unidad}</b></td></tr>`).join('')}</tbody></table>` : '<p>Sin diferencias.</p>'}
      <footer><span>Aprobó: ______________________</span><span>Rosaint Core · Conteo de inventario</span></footer>
      <script>window.onload = () => window.print();<\/script></body></html>`);
  }

  // ---------------- arranque ----------------
  async function recuperarRespaldo() {
    if (!abierto()) return;
    let r = {}; try { r = JSON.parse(localStorage.getItem(claveResp()) || '{}'); } catch { /* */ }
    const cods = Object.keys(r).filter((c) => S.lineas.some((l) => l.codigo === c));
    if (!cods.length) return;
    for (const c of cods) { PEND[c] = r[c]; const l = S.lineas.find((x) => x.codigo === c); if (l) { l.contado = r[c]; refrescarFila(l); } }
    estado('Recuperando ' + cods.length + ' valor(es) que no se habían guardado…', 'pend');
    for (const c of cods) await enviar(c);
  }
  setInterval(traerOtros, 15000);
  setInterval(() => { if (abierto() && !document.hidden) sincronizarOdoo(true); }, 3 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) traerOtros(); });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(PEND).length) { respaldar(); e.preventDefault(); e.returnValue = ''; } });
  cargar().then(recuperarRespaldo).then(() => { if (abierto()) sincronizarOdoo(true); })
    .catch((e) => { $('cuerpo').innerHTML = `<div class="cn-bloque"><div class="cn-vacio">No se pudo cargar: ${esc(e.message)}</div></div>`; });
})();
