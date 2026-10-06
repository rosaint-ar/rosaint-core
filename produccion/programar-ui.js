// ====== Programar el día — pantalla ======
// Carga la foto de Odoo (prod_plan_snapshot) + lo que se configura en Core, corre el motor
// (programador.js) y muestra el resultado. Las acciones que tocan Odoo (etiquetar, postergar)
// pasan por la edge sync-produccion con la sesión del usuario.
(function () {
  'use strict';
  const FN = window.SUPABASE_URL + '/functions/v1/sync-produccion';
  const P = window.PROGRAMADOR;
  const S = { snap: null, snapCreado: null, cfg: null, parciales: [], clientes: [], postergados: [], pres: [], subg: [], plan: null };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 1) => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: d });
  const fCorta = (f) => f ? String(f).slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '—';
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function proximoHabil(d = new Date()) { const x = new Date(d); x.setHours(12, 0, 0, 0); do x.setDate(x.getDate() + 1); while (x.getDay() === 0 || x.getDay() === 6); return x; }
  const CLASE = { hoy: 'hoy', '1d': 'd1', tanda: 'tanda', '23d': 'd23', parcial: 'parcial', sin: 'sin', anticipo: 'anticipo', stock: 'stock' };
  const pill = (p) => `<span class="prio ${CLASE[p] || 'sin'}">${esc(P.ETIQUETA[p] || p)}</span>`;

  function msg(texto, err = false) {
    const m = $('msg'); m.textContent = texto; m.className = 'pg-msg' + (err ? ' err' : ''); m.style.display = 'block';
    clearTimeout(msg._t); msg._t = setTimeout(() => { m.style.display = 'none'; }, err ? 7000 : 3500);
  }
  async function fn(modo, body = {}) {
    const { data: s } = await sb.auth.getSession();
    const token = s?.session?.access_token || window.SUPABASE_KEY;
    const r = await fetch(FN, { method: 'POST', headers: { Authorization: 'Bearer ' + token, apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ modo, ...body }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Error');
    return j;
  }

  // ---------------- carga ----------------
  async function cargarSnap() {
    const { data, error } = await sb.from('prod_plan_snapshot').select('id,creado,datos').order('id', { ascending: false }).limit(1);
    if (error) throw new Error('foto: ' + error.message);
    if (!data.length) return false;
    S.snap = data[0].datos; S.snapCreado = new Date(data[0].creado);
    return true;
  }
  async function cargarConfig() {
    const [cfg, par, cli, pos] = await Promise.all([
      sb.from('prod_plan_config').select('*').eq('id', 1).single(),
      sb.from('prod_plan_parciales').select('*'),
      sb.from('prod_plan_clientes').select('*'),
      sb.from('prod_plan_postergados').select('*').order('hasta'),
    ]);
    for (const r of [cfg, par, cli, pos]) if (r.error) throw new Error(r.error.message);
    S.cfg = cfg.data; S.parciales = par.data; S.clientes = cli.data; S.postergados = pos.data;
  }
  async function cargarRecetas() {
    const [pr, fo, fc] = await Promise.all([
      sb.from('presentaciones').select('codigo_sku,codigo_granel,tamanio_kg'),
      sb.from('formulas').select('id,codigo_granel').eq('estado', 'vigente'),
      sb.from('formula_componentes').select('formula_id,codigo_componente,composicion_pct').like('codigo_componente', '9%'),
    ]);
    for (const r of [pr, fo, fc]) if (r.error) throw new Error(r.error.message);
    S.pres = pr.data.map((p) => ({ c: p.codigo_sku, g: p.codigo_granel, kg: p.tamanio_kg }));
    const gDe = {}; for (const f of fo.data) gDe[f.id] = f.codigo_granel;
    S.subg = fc.data.filter((x) => gDe[x.formula_id]).map((x) => ({ g: gDe[x.formula_id], c: x.codigo_componente, pct: x.composicion_pct }));
  }

  async function actualizarOdoo() {
    const b = $('btn-actualizar'); b.disabled = true; b.textContent = 'Leyendo Odoo…';
    try { await fn('plan'); await cargarSnap(); calcular(); msg('Datos de Odoo actualizados'); }
    catch (e) { msg('No se pudo actualizar: ' + e.message, true); }
    finally { b.disabled = false; b.textContent = 'Actualizar desde Odoo'; }
  }

  function calcular() {
    S.plan = P.programar({ snap: S.snap, cfg: S.cfg, parciales: S.parciales, clientes: S.clientes, postergados: S.postergados, pres: S.pres, subg: S.subg, hoy: new Date() });
    pintar();
  }

  // ---------------- helpers de datos ----------------
  const nombreDe = (c) => (S.snap.stock.find((s) => s.c === c) || {}).n || c;
  const pedidoDe = (id) => S.snap.pedidos.find((p) => p.id === id);
  function prioDePedido(p) {
    if (p.ml) return 'hoy';
    const inv = {}; for (const [k, id] of Object.entries(S.snap.prioridad || {})) inv[id] = k;
    const ks = (p.tag_ids || []).map((id) => inv[id]).filter(Boolean);
    if (ks.includes('parcial')) return 'parcial';
    return ks.sort((a, b) => P.RANGO[a] - P.RANGO[b])[0] || 'sin';
  }
  const esPresupuesto = (p) => (p.estado === 'draft' || p.estado === 'sent') && !p.ml;
  const postergadoActivo = (so, sku) => S.postergados.find((x) => Number(x.so_id) === Number(so) && x.sku === sku && x.hasta > isoLocal(new Date()));

  // ---------------- pintar ----------------
  function pintar() {
    const pl = S.plan;
    // encabezado
    const mins = Math.round((Date.now() - S.snapCreado) / 60000);
    const c = $('cuando');
    c.textContent = `Datos de Odoo de las ${S.snapCreado.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} (${mins < 1 ? 'recién' : mins < 60 ? 'hace ' + mins + ' min' : 'hace ' + Math.round(mins / 60) + ' h'})`;
    c.classList.toggle('viejo', mins > 30);
    const barra = (v, cap) => { const pct = cap ? v / cap : 0; return `<div class="barra ${pct > 1 ? 'pasada' : pct >= 0.95 ? 'llena' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div>`; };
    const confirmados = S.snap.pedidos.filter((p) => !esPresupuesto(p));
    $('kpis').innerHTML = `
      <div class="pg-kpi"><div class="k">Fraccionar hoy</div><div class="v">${fmt(pl.carga.u, 0)} <small>/ ${fmt(pl.carga.cap_u, 0)} u</small></div>${barra(pl.carga.u, pl.carga.cap_u)}</div>
      <div class="pg-kpi"><div class="k">Elaborar hoy</div><div class="v">${fmt(pl.carga.kg, 0)} <small>/ ${fmt(pl.carga.cap_kg, 0)} kg</small></div>${barra(pl.carga.kg, pl.carga.cap_kg)}</div>
      <div class="pg-kpi"><div class="k">Pedidos abiertos</div><div class="v">${confirmados.length}</div><div class="sub">${pl.a_confirmar.length} presupuestos a confirmar</div></div>
      <div class="pg-kpi"><div class="k">Avisos</div><div class="v" style="color:${pl.alertas.length ? 'var(--warn)' : 'var(--ok)'}">${pl.alertas.length}</div><div class="sub">${pl.postergados.length} cosas postergadas a mano</div></div>`;
    $('n-pedidos').textContent = confirmados.length;
    $('n-post').textContent = pl.postergados.length;
    pintarHoy(); pintarPedidos(); pintarPostergados(); pintarClientes(); pintarAjustes();
  }

  function accPost(so, sku, numero, etiqueta) {
    return `<span class="acc"><button data-acc="post1" data-so="${so}" data-sku="${esc(sku)}" data-num="${esc(numero || '')}" title="Sale de hoy y vuelve el próximo día hábil">+1 día</button><button data-acc="posthasta" data-so="${so}" data-sku="${esc(sku)}" data-num="${esc(numero || '')}" data-et="${esc(etiqueta || '')}">Hasta…</button></span>`;
  }
  function accEtiquetas(so) {
    return `<span class="acc">${['hoy', '1d', '23d', 'parcial'].map((k) => `<button data-acc="etiq" data-so="${so}" data-prio="${k}">${esc(P.ETIQUETA[k])}</button>`).join('')}</span>`;
  }

  function pintarHoy() {
    const pl = S.plan;
    const ico = { sin_etiqueta: '🏷️', sugerir_parcial: '🔄', ml_borrador: '🟡', parcial_sin_ritmo: '🔄', parcial_vencido: '⏰', sin_ficha: '❓', mo_vieja: '🗂️', excede: '⚠️' };
    const alertas = pl.alertas.length ? `
      <div class="pg-bloque"><header><h3>Avisos</h3><span class="meta">${pl.alertas.length}</span></header>
      ${pl.alertas.map((a) => `<div class="alerta"><span class="ico">${ico[a.tipo] || '•'}</span><span class="txt">${esc(a.texto)}</span>
        ${(a.tipo === 'sin_etiqueta' || a.tipo === 'sugerir_parcial') && a.so_id ? accEtiquetas(a.so_id) : ''}
        ${a.tipo === 'parcial_sin_ritmo' ? `<span class="acc"><button data-acc="irpedido" data-so="${a.so_id}">Cargar ritmo</button></span>` : ''}</div>`).join('')}
      </div>` : '';

    const prep = pl.preparar.length ? `
      <div class="pg-bloque"><header><h3>Preparar hoy para mañana</h3><span class="meta">Necesitan reposar o mezclar de un día para el otro</span></header>
      <table class="pg-tabla"><tbody>${pl.preparar.map((x) => `<tr><td class="cod">${esc(x.c)}</td><td><b>${esc(x.nombre)}</b></td><td class="num"><b>${fmt(x.kg)} kg</b></td><td class="muted">lote de ${fmt(x.lote)} kg</td></tr>`).join('')}</tbody></table></div>` : '';

    const elab = `
      <div class="pg-bloque"><header><h3>Elaborar</h3><span class="meta">${fmt(pl.carga.kg, 0)} kg · tope ${fmt(pl.carga.cap_kg, 0)} kg</span></header>
      ${pl.elaborar.length ? `<table class="pg-tabla"><thead><tr><th>Granel</th><th></th><th class="num">Cantidad</th><th>Lote habitual</th><th>Para</th></tr></thead><tbody>
        ${pl.elaborar.map((e) => `<tr><td class="cod">${esc(e.c)}</td><td><b>${esc(e.nombre)}</b></td><td class="num"><b>${fmt(e.kg)} kg</b></td>
          <td class="muted">${fmt(e.lote)} kg${e.kg > e.lote ? ` (${fmt(e.kg / e.lote, 1)} lotes)` : ''}</td>
          <td class="muted">${e.para.map((c) => esc(nombreDe(c))).join(' · ')}</td></tr>`).join('')}
      </tbody></table>` : '<div class="pg-vacio">No hace falta elaborar granel hoy: alcanza con lo que hay.</div>'}</div>`;

    const fracc = `
      <div class="pg-bloque"><header><h3>Fraccionar</h3><span class="meta">${fmt(pl.carga.u, 0)} unidades · tope ${fmt(pl.carga.cap_u, 0)}</span>
        <span class="der"><button class="btn secondary" data-acc="copiar">Copiar lista</button><button class="btn secondary" data-acc="imprimir">Imprimir</button></span></header>
      ${pl.fraccionar.length ? pl.fraccionar.map((f) => `
        <div class="fila">
          <div>${pill(f.prio)}</div>
          <div class="cod">${esc(f.c)}</div>
          <div><div class="nom">${esc(f.nombre)}</div>
            <div class="motivos">${f.motivos.map((m) => `<div class="motivo">${m.prio !== f.prio ? pill(m.prio) : ''}
              ${m.numero ? `<span><b>${esc(m.numero)}</b> ${esc(m.cliente)}</span>` : '<span>Para stock</span>'}
              <b>${fmt(m.q, 0)} u</b>${m.kit ? `<span class="nota">(va en ${esc(m.kit)})</span>` : ''}
              ${m.nota ? `<span class="nota">· ${esc(m.nota)}</span>` : ''}
              ${accPost(m.so_id || 0, f.c, m.numero, m.numero ? `${m.numero} · ${f.nombre}` : `${f.nombre} para stock`)}</div>`).join('')}</div></div>
          <div class="cant">${fmt(f.q, 0)}<small>${f.kg ? fmt(f.kg) + ' kg' : 'u'}</small></div>
        </div>`).join('') : '<div class="pg-vacio">Nada para fraccionar hoy.</div>'}</div>`;

    // lo que se entrega con producto ya hecho, agrupado por pedido
    const porPed = {};
    for (const d of pl.de_stock) (porPed[d.numero] = porPed[d.numero] || { numero: d.numero, cliente: d.cliente, prio: d.prio, items: [] }).items.push(d);
    const deStock = Object.keys(porPed).length ? `
      <div class="pg-bloque"><header><h3>Se puede entregar con lo que ya está hecho</h3><span class="meta">Producto terminado en stock, no hay que fabricarlo</span></header>
      <table class="pg-tabla"><tbody>${Object.values(porPed).map((p) => `<tr><td>${pill(p.prio)}</td><td><b>${esc(p.numero)}</b> ${esc(p.cliente)}</td>
        <td class="muted">${p.items.map((i) => `${esc(i.nombre)} × <b>${fmt(i.q, 0)}</b>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>` : '';

    const noEntra = pl.postergado.filter((x) => !x.manual);
    const noEntraHtml = noEntra.length ? `
      <div class="pg-bloque"><header><h3>No entra hoy</h3><span class="meta">Queda para los próximos días</span></header>
      <table class="pg-tabla"><tbody>${noEntra.map((x) => `<tr><td>${pill(x.prio)}</td><td><b>${esc(x.numero || '')}</b> ${esc(x.cliente || '')}</td>
        <td>${esc(x.nombre)}</td><td class="num"><b>${fmt(x.q, 0)}</b></td><td class="muted">${esc(x.motivo)}</td></tr>`).join('')}</tbody></table></div>` : '';

    $('tab-hoy').innerHTML = `
      <div class="pg-nota">Orden de la fila: <b>Mercado Libre y 🟥 Hoy</b> → <b>🟧 1 día</b> → <b>la entrega que le toca</b> a clientes que se entregan de a partes → <b>🟨 2-3 días</b> → <b>🔄 cuota de los parciales</b> → <b>sin etiqueta</b> → <b>próximas entregas</b> → <b>stock</b> con el lugar que sobra. Lo urgente entra siempre, aunque pase el tope.</div>
      ${alertas}${prep}${elab}${fracc}${deStock}${noEntraHtml}`;
  }

  function pintarPedidos() {
    const pl = S.plan;
    const hoyDe = {}, masDe = {};
    for (const f of pl.fraccionar) for (const m of f.motivos) if (m.so_id) hoyDe[m.so_id] = (hoyDe[m.so_id] || 0) + m.q;
    for (const d of pl.de_stock) hoyDe[d.so_id] = (hoyDe[d.so_id] || 0) + d.q;
    for (const d of [...pl.mas_adelante, ...pl.postergado]) if (d.so_id) masDe[d.so_id] = (masDe[d.so_id] || 0) + d.q;
    const pats = pl.aprendido.patrones;
    const conf = S.snap.pedidos.filter((p) => !esPresupuesto(p))
      .map((p) => ({ ...p, prio: prioDePedido(p) }))
      .sort((a, b) => P.RANGO[a.prio] - P.RANGO[b.prio] || String(a.fecha).localeCompare(String(b.fecha)));

    const filas = conf.map((p) => {
      const pz = postergadoActivo(p.id, '*');
      const pt = pats[p.partner_id];
      const par = S.parciales.find((x) => Number(x.so_id) === p.id) || {};
      const opciones = [['', 'Sin etiqueta'], ['hoy', P.ETIQUETA.hoy], ['1d', P.ETIQUETA['1d']], ['23d', P.ETIQUETA['23d']], ['parcial', P.ETIQUETA.parcial]];
      const actual = prioDePedido({ ...p, ml: false });
      return `<div class="ped" id="ped-${p.id}">
        <div class="cab"><span class="num">${esc(p.numero)}</span><span class="cli">${esc(p.cliente)}</span>
          <span class="fecha">del ${fCorta(p.fecha)}${p.ml ? ' · 🟡 Mercado Libre' : p.tn ? ' · Tienda Nube' : ''}${p.estado === 'draft' ? ' · en borrador' : ''}</span>
          ${pz ? `<span class="prio sin">Postergado hasta el ${fCorta(pz.hasta)}</span>` : pill(p.prio)}
          <span class="der">
            ${p.ml ? '<span class="muted" style="font-size:12px">ML va siempre como Hoy</span>' : `<select class="sel" data-acc="etiqsel" data-so="${p.id}">${opciones.map(([k, t]) => `<option value="${k}" ${k === (actual === 'sin' ? '' : actual) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`}
            ${pz ? `<span class="acc"><button data-acc="volver" data-so="${p.id}" data-sku="*">Volver a programar</button></span>` : accPost(p.id, '*', p.numero, `${p.numero} · pedido entero`)}
          </span></div>
        <div class="detalle">${p.lineas.map((l) => `${esc(l.n)}: <b>${fmt(l.pend, 0)}</b> pend.${l.entregado ? ` (entregado ${fmt(l.entregado, 0)} de ${fmt(l.pedido, 0)})` : ''}`).join(' · ')}</div>
        <div class="detalle">Hoy: <b>${fmt(hoyDe[p.id] || 0, 0)} u</b> · Más adelante: <b>${fmt(masDe[p.id] || 0, 0)} u</b>
          ${pt ? ` · <span title="${pt.aprendido ? 'Aprendido del historial de entregas' : 'Cargado a mano'}">Se entrega de a partes: ~${pt.entregas_por_pedido} entregas, cada ~${pt.dias_entre} días${Object.keys(pt.tandas).length ? ' · ' + Object.entries(pt.tandas).map(([c, q]) => `${esc(nombreDe(c))} de a ${fmt(q, 0)}`).join(', ') : ''}</span>` : ''}</div>
        ${actual === 'parcial' ? `<div class="ritmo"><span class="muted">Ritmo de este pedido:</span>
          <label>termina el <input type="date" class="inp" data-ritmo="fecha" data-so="${p.id}" value="${esc(par.fecha_limite || '')}"></label>
          <label>o <input type="number" min="0" step="1" class="inp corto" data-ritmo="sem" data-so="${p.id}" value="${esc(par.unidades_semana || '')}"> u por semana</label>
          <span class="acc"><button data-acc="guardarritmo" data-so="${p.id}" data-num="${esc(p.numero)}">Guardar</button>${par.so_id ? `<button data-acc="borrarritmo" data-so="${p.id}">Quitar</button>` : ''}</span>
          ${!par.so_id && pt ? '<span class="muted">(sin cargar: usa el patrón del cliente)</span>' : ''}</div>` : ''}
      </div>`;
    }).join('');

    const viejo = (f) => (Date.now() - new Date(f + 'T12:00:00')) / 864e5 > 45;
    const pres = pl.a_confirmar.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    $('tab-pedidos').innerHTML = `
      <div class="pg-nota">Acá se cambia la <b>etiqueta</b> (se guarda en Odoo), se <b>posterga</b> un pedido entero (también mueve la fecha prevista de la entrega en Odoo) y se carga el <b>ritmo</b> de los pedidos 🔄 de entrega parcial.</div>
      <div class="pg-bloque"><header><h3>Pedidos confirmados</h3><span class="meta">${conf.length}</span></header>${filas || '<div class="pg-vacio">No hay pedidos abiertos.</div>'}</div>
      <div class="pg-bloque"><header><h3>Presupuestos a confirmar</h3><span class="meta">Se ven, no se programan hasta que se confirman en Odoo</span></header>
        ${pres.length ? `<table class="pg-tabla"><thead><tr><th>Pedido</th><th>Cliente</th><th>Fecha</th><th class="num">Monto</th><th>Productos</th></tr></thead><tbody>
        ${pres.map((p) => `<tr class="${viejo(p.fecha) ? 'dim' : ''}"><td class="cod">${esc(p.numero)}</td><td>${esc(p.cliente)}</td><td>${fCorta(p.fecha)}${viejo(p.fecha) ? ' · viejo' : ''}</td>
          <td class="num">$ ${fmt(p.monto, 0)}</td><td class="muted">${p.lineas.map((l) => `${esc(l.n)} × ${fmt(l.pend, 0)}`).join(' · ')}</td></tr>`).join('')}</tbody></table>` : '<div class="pg-vacio">No hay presupuestos abiertos.</div>'}</div>`;
  }

  function pintarPostergados() {
    const hoy = isoLocal(new Date());
    const act = S.postergados.filter((x) => x.hasta > hoy);
    $('tab-postergados').innerHTML = `
      <div class="pg-nota">Lo postergado no entra al día hasta la fecha elegida; ese día <b>vuelve solo</b> con su prioridad. Postergar un <b>pedido entero</b> también mueve la fecha prevista de su entrega en Odoo.</div>
      <div class="pg-bloque"><header><h3>Postergado a mano</h3><span class="meta">${act.length}</span></header>
      ${act.length ? `<table class="pg-tabla"><thead><tr><th>Qué</th><th>Producto</th><th>Vuelve</th><th>Motivo</th><th>Quién</th><th></th></tr></thead><tbody>
        ${act.map((x) => `<tr><td><b>${esc(x.numero || 'Para stock')}</b> ${x.so_id ? esc((pedidoDe(Number(x.so_id)) || {}).cliente || '') : ''}</td>
          <td>${x.sku === '*' ? 'Pedido entero' : esc(nombreDe(x.sku))}</td><td>${fCorta(x.hasta)}</td><td class="muted">${esc(x.motivo || '')}</td>
          <td class="muted">${esc((x.creado_por || '').split('@')[0])}</td>
          <td><span class="acc"><button data-acc="volver" data-so="${x.so_id}" data-sku="${esc(x.sku)}">Volver a programar</button></span></td></tr>`).join('')}
      </tbody></table>` : '<div class="pg-vacio">No hay nada postergado.</div>'}</div>`;
  }

  function pintarClientes() {
    const ap = S.plan.aprendido;
    const pats = Object.values(ap.patrones).sort((a, b) => (b.pedidos_partidos || 0) - (a.pedidos_partidos || 0));
    const nomGr = (c) => nombreDe(c);
    const clientesConocidos = {};
    for (const p of S.snap.pedidos) clientesConocidos[p.partner_id] = p.cliente;
    for (const p of pats) clientesConocidos[p.p] = p.cli;
    const tandas = Object.entries(ap.tandas).filter(([c, q]) => c.startsWith('1') && q > 1).sort((a, b) => a[0].localeCompare(b[0]));
    $('tab-clientes').innerHTML = `
      <div class="pg-nota">Esto lo <b>aprende solo</b> del historial de Odoo: de a cuánto y cada cuánto se le entrega a cada cliente, y de a cuánto se elabora y se fracciona cada producto. Si algo no es así, <b>fijalo a mano</b> abajo: lo cargado a mano manda sobre lo aprendido.</div>
      <div class="pg-bloque"><header><h3>Clientes que se entregan de a partes</h3><span class="meta">${pats.length}</span></header>
      ${pats.length ? `<table class="pg-tabla"><thead><tr><th>Cliente</th><th class="num">Pedidos partidos</th><th class="num">Entregas por pedido</th><th class="num">Cada</th><th>De a cuánto</th><th>Origen</th></tr></thead><tbody>
        ${pats.map((p) => `<tr><td><b>${esc(p.cli)}</b>${p.nota ? `<div class="muted">${esc(p.nota)}</div>` : ''}</td><td class="num">${p.pedidos_partidos != null ? `${p.pedidos_partidos} de ${p.pedidos}` : '—'}</td>
          <td class="num">${fmt(p.entregas_por_pedido, 0)}</td><td class="num">${fmt(p.dias_entre, 0)} días</td>
          <td class="muted">${[p.tanda_general ? `todo de a ${fmt(p.tanda_general, 0)}` : '', ...Object.entries(p.tandas).map(([c, q]) => `${esc(nombreDe(c))} de a ${fmt(q, 0)}`)].filter(Boolean).join(' · ') || 'varía'}</td>
          <td>${p.manual ? '<span class="prio parcial">a mano</span>' : '<span class="prio sin">aprendido</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="pg-vacio">Todavía no hay clientes con entregas partidas.</div>'}</div>

      <div class="pg-bloque"><header><h3>Fijar a mano</h3><span class="meta">Ej.: Saracho, Descontracturante 10 Kg, de a 2</span></header>
        <div class="ped"><div class="ritmo">
          <select class="sel" id="fc-cli"><option value="">Cliente…</option>${Object.entries(clientesConocidos).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select>
          <input class="inp" id="fc-sku" placeholder="Código (vacío = todos)" style="width:150px">
          <label>de a <input type="number" min="0" class="inp corto" id="fc-tanda"></label>
          <label>cada <input type="number" min="0" class="inp corto" id="fc-dias"> días</label>
          <input class="inp" id="fc-nota" placeholder="Nota (ej.: por el correo)" style="min-width:180px">
          <span class="acc"><button data-acc="guardarcliente">Guardar</button></span>
        </div></div>
        ${S.clientes.length ? `<table class="pg-tabla"><tbody>${S.clientes.map((c) => `<tr><td><b>${esc(c.cliente || clientesConocidos[c.partner_id] || c.partner_id)}</b></td>
          <td>${c.sku === '*' ? 'Todos los productos' : esc(nombreDe(c.sku))}</td><td class="num">${c.tanda ? 'de a ' + fmt(c.tanda, 0) : '—'}</td>
          <td class="num">${c.dias_entre ? 'cada ' + fmt(c.dias_entre, 0) + ' días' : '—'}</td><td class="muted">${esc(c.nota || '')}</td>
          <td><span class="acc"><button data-acc="borrarcliente" data-p="${c.partner_id}" data-sku="${esc(c.sku)}">Quitar</button></span></td></tr>`).join('')}</tbody></table>` : ''}
      </div>

      <div class="pg-bloque"><header><h3>Lotes de elaboración</h3><span class="meta">Cantidad más repetida por orden de fabricación</span></header>
        <table class="pg-tabla"><tbody>${Object.entries(ap.lotes).sort((a, b) => a[0].localeCompare(b[0])).map(([c, kg]) => `<tr><td class="cod">${esc(c)}</td><td>${esc(nomGr(c))}</td><td class="num"><b>${fmt(kg, 2)} kg</b></td></tr>`).join('')}</tbody></table></div>
      <div class="pg-bloque"><header><h3>Tandas de fraccionado</h3><span class="meta">Se usan al fraccionar para stock (no se hace de a 1)</span></header>
        <table class="pg-tabla"><tbody>${tandas.map(([c, q]) => `<tr><td class="cod">${esc(c)}</td><td>${esc(nombreDe(c))}</td><td class="num"><b>de a ${fmt(q, 0)}</b></td></tr>`).join('')}</tbody></table></div>`;
  }

  function pintarAjustes() {
    const c = S.cfg;
    const campo = (id, et, val, ayuda, tipo = 'number') => `<tr><td><b>${et}</b><div class="muted">${ayuda}</div></td><td><input class="inp" type="${tipo}" id="aj-${id}" value="${esc(val)}" style="width:${tipo === 'text' ? 160 : 90}px"></td></tr>`;
    $('tab-ajustes').innerHTML = `
      <div class="pg-nota">El tope del día sale de lo que la planta hizo <b>en un día bueno</b> según Odoo (unos 120 kg de granel y 35 unidades fraccionadas). Si cambia la dotación o el ritmo, se ajusta acá.</div>
      <div class="pg-bloque"><header><h3>Ajustes del programador</h3></header>
      <table class="pg-tabla"><tbody>
        ${campo('cap_kg_dia', 'Tope de elaboración por día (kg)', c.cap_kg_dia, 'Lo que se puede elaborar de granel en un día.')}
        ${campo('cap_u_dia', 'Tope de fraccionado por día (unidades)', c.cap_u_dia, 'Envases que se llenan en un día.')}
        ${campo('dias_stock_objetivo', 'Días de stock a cubrir', c.dias_stock_objetivo, 'Con el lugar que sobra, se fabrica para tener esta cantidad de días de venta.')}
        ${campo('umbral_pedido_grande', 'Pedido grande desde (unidades)', c.umbral_pedido_grande, 'Los renglones de este tamaño o más no cuentan para el ritmo de venta diario.')}
        ${campo('semanas_parcial_default', 'Semanas para un 🔄 sin ritmo', c.semanas_parcial_default, 'Si un pedido parcial no tiene ritmo ni patrón, se reparte en estas semanas.')}
        ${campo('graneles_dia_anterior', 'Se preparan el día anterior', (c.graneles_dia_anterior || []).join(', '), 'Códigos de granel que necesitan reposar (ej. 90302 solución de Carbopol).', 'text')}
      </tbody></table>
      <div class="ped"><button class="btn primary" data-acc="guardarajustes">Guardar ajustes</button></div></div>`;
  }

  // ---------------- acciones ----------------
  async function etiquetar(so, prio) {
    try {
      const r = await fn('etiquetar', { so_id: Number(so), prioridad: prio || 'ninguna' });
      const p = pedidoDe(Number(so)); if (p) p.tag_ids = r.despues;
      calcular(); msg(`${r.numero}: etiqueta cambiada en Odoo`);
    } catch (e) { msg('No se pudo etiquetar: ' + e.message, true); }
  }
  async function postergar(so, sku, hasta, motivo) {
    try {
      const r = await fn('postergar', { so_id: Number(so), sku, hasta, motivo });
      await cargarConfig(); calcular();
      const odoo = r.odoo?.entregas?.length ? ` · entrega ${r.odoo.entregas.map((e) => e.nombre).join(', ')} movida en Odoo` : '';
      msg(hasta ? `Postergado hasta el ${fCorta(hasta)}${odoo}` : `Vuelve a la fila${odoo}`);
    } catch (e) { msg('No se pudo postergar: ' + e.message, true); }
  }
  function abrirPostergar(so, sku, etiqueta) {
    const d = $('dlg-post');
    $('dlg-titulo').textContent = 'Postergar';
    $('dlg-texto').textContent = etiqueta + (sku === '*' && Number(so) ? '. Se mueve también la fecha prevista de la entrega en Odoo.' : '');
    const f = $('dlg-fecha'); f.min = isoLocal(proximoHabil()); f.value = isoLocal(proximoHabil());
    $('dlg-motivo').value = '';
    d.onclose = () => { if (d.returnValue === 'ok' && f.value) postergar(so, sku, f.value, $('dlg-motivo').value.trim() || null); };
    d.showModal();
  }
  function textoLista() {
    const pl = S.plan; const l = [`Producción del ${fCorta(pl.fecha)}`];
    if (pl.preparar.length) { l.push('', 'PREPARAR PARA MAÑANA'); for (const x of pl.preparar) l.push(`- ${x.c} ${x.nombre}: ${fmt(x.kg)} kg`); }
    if (pl.elaborar.length) { l.push('', 'ELABORAR'); for (const e of pl.elaborar) l.push(`- ${e.c} ${e.nombre}: ${fmt(e.kg)} kg`); }
    if (pl.fraccionar.length) {
      l.push('', 'FRACCIONAR');
      for (const f of pl.fraccionar) l.push(`- ${f.c} ${f.nombre}: ${fmt(f.q, 0)} (${f.motivos.map((m) => m.numero ? `${m.numero} ${m.cliente} ${fmt(m.q, 0)}` : `stock ${fmt(m.q, 0)}`).join('; ')})`);
    }
    return l.join('\n');
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-acc]'); if (!t || t.tagName === 'SELECT') return;
    const a = t.dataset.acc;
    if (a === 'post1') { t.disabled = true; await postergar(t.dataset.so, t.dataset.sku, isoLocal(proximoHabil()), null); }
    else if (a === 'posthasta') abrirPostergar(t.dataset.so, t.dataset.sku, t.dataset.et);
    else if (a === 'volver') { t.disabled = true; await postergar(t.dataset.so, t.dataset.sku, null, null); }
    else if (a === 'etiq') { t.disabled = true; await etiquetar(t.dataset.so, t.dataset.prio); }
    else if (a === 'irpedido') { abrirTab('pedidos'); document.getElementById('ped-' + t.dataset.so)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else if (a === 'copiar') { await navigator.clipboard.writeText(textoLista()); msg('Lista copiada'); }
    else if (a === 'imprimir') { abrirTab('hoy'); window.print(); }
    else if (a === 'guardarritmo' || a === 'borrarritmo') {
      const so = Number(t.dataset.so);
      if (a === 'borrarritmo') { const { error } = await sb.from('prod_plan_parciales').delete().eq('so_id', so); if (error) return msg(error.message, true); }
      else {
        const fecha = document.querySelector(`[data-ritmo="fecha"][data-so="${so}"]`).value || null;
        const sem = Number(document.querySelector(`[data-ritmo="sem"][data-so="${so}"]`).value) || null;
        if (!fecha && !sem) return msg('Poné una fecha de fin o unidades por semana', true);
        const { error } = await sb.from('prod_plan_parciales').upsert({ so_id: so, numero: t.dataset.num, fecha_limite: fecha, unidades_semana: sem, actualizado: new Date().toISOString() });
        if (error) return msg(error.message, true);
      }
      await cargarConfig(); calcular(); msg('Ritmo guardado');
    }
    else if (a === 'guardarcliente') {
      const p = Number($('fc-cli').value); if (!p) return msg('Elegí el cliente', true);
      const tanda = Number($('fc-tanda').value) || null, dias = Number($('fc-dias').value) || null;
      if (!tanda && !dias) return msg('Poné de a cuánto o cada cuántos días', true);
      const { error } = await sb.from('prod_plan_clientes').upsert({ partner_id: p, sku: $('fc-sku').value.trim() || '*', cliente: $('fc-cli').selectedOptions[0].textContent, tanda, dias_entre: dias, nota: $('fc-nota').value.trim() || null, actualizado: new Date().toISOString() });
      if (error) return msg(error.message, true);
      await cargarConfig(); calcular(); msg('Guardado');
    }
    else if (a === 'borrarcliente') {
      const { error } = await sb.from('prod_plan_clientes').delete().eq('partner_id', Number(t.dataset.p)).eq('sku', t.dataset.sku);
      if (error) return msg(error.message, true);
      await cargarConfig(); calcular(); msg('Quitado');
    }
    else if (a === 'guardarajustes') {
      const v = (id) => $('aj-' + id).value;
      const fila = {
        cap_kg_dia: Number(v('cap_kg_dia')), cap_u_dia: Number(v('cap_u_dia')), dias_stock_objetivo: Number(v('dias_stock_objetivo')),
        umbral_pedido_grande: Number(v('umbral_pedido_grande')), semanas_parcial_default: Number(v('semanas_parcial_default')),
        graneles_dia_anterior: v('graneles_dia_anterior').split(/[\s,;]+/).filter(Boolean), actualizado: new Date().toISOString(),
      };
      if (!(fila.cap_kg_dia > 0 && fila.cap_u_dia > 0)) return msg('Los topes tienen que ser mayores a cero', true);
      const { error } = await sb.from('prod_plan_config').update(fila).eq('id', 1);
      if (error) return msg(error.message, true);
      await cargarConfig(); calcular(); msg('Ajustes guardados');
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target; if (t.dataset?.acc !== 'etiqsel') return;
    t.disabled = true; etiquetar(t.dataset.so, t.value).finally(() => { t.disabled = false; });
  });

  function abrirTab(id) {
    for (const b of document.querySelectorAll('.pg-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    for (const s of document.querySelectorAll('.pg-panel')) s.hidden = s.id !== 'tab-' + id;
    try { localStorage.setItem('programar.tab', id); } catch { /* */ }
  }
  for (const b of document.querySelectorAll('.pg-tab')) b.addEventListener('click', () => abrirTab(b.dataset.tab));
  $('btn-actualizar').addEventListener('click', actualizarOdoo);

  (async function inicio() {
    try {
      try { const t = localStorage.getItem('programar.tab'); if (t) abrirTab(t); } catch { /* */ }
      await Promise.all([cargarConfig(), cargarRecetas()]);
      const hay = await cargarSnap();
      if (!hay) { await actualizarOdoo(); return; }
      calcular();
      // si la foto tiene más de 20 minutos, se refresca sola en segundo plano
      if (Date.now() - S.snapCreado > 20 * 60000) actualizarOdoo();
    } catch (e) {
      $('tab-hoy').innerHTML = `<div class="pg-bloque"><div class="pg-vacio">No se pudo cargar: ${esc(e.message)}</div></div>`;
      $('cuando').textContent = 'Error al cargar';
    }
  })();
})();
