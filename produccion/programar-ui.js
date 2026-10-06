// ====== Programar el día — pantalla ======
// Carga la foto de Odoo (prod_plan_snapshot) + lo que se configura en Core, corre el motor
// (programador.js) y muestra el resultado. Las acciones que tocan Odoo (etiquetar, postergar)
// pasan por la edge sync-produccion con la sesión del usuario.
(function () {
  'use strict';
  const FN = window.SUPABASE_URL + '/functions/v1/sync-produccion';
  const P = window.PROGRAMADOR;
  const S = { snap: null, snapCreado: null, cfg: null, parciales: [], clientes: [], postergados: [], pres: [], subg: [], dia: [], entregas: [], hoja: [], plan: null };
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
  async function cargarDia() {
    const { data, error } = await sb.from('prod_plan_dia').select('*').eq('fecha', isoLocal(new Date())).order('orden');
    if (error) throw new Error('plan del día: ' + error.message);
    S.dia = data;
  }
  // lo que los chicos van cargando hoy en la Hoja de Producción
  async function cargarHoja() {
    const { data, error } = await sb.from('prod_hoja_diaria').select('producto_sku,producto_nombre,cantidad,unidad,tipo,hora,iniciales').eq('fecha', isoLocal(new Date())).order('hora');
    if (error) throw new Error('hoja de producción: ' + error.message);
    const firma = JSON.stringify(data);
    const cambio = firma !== S._hojaFirma; S._hojaFirma = firma; S.hoja = data;
    return cambio;
  }
  async function cargarEntregas() {
    const { data, error } = await sb.from('prod_plan_entregas').select('*').gte('fecha', isoLocal(new Date())).order('hora');
    if (error) throw new Error('entregas: ' + error.message);
    S.entregas = data;
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
      sb.from('presentaciones').select('codigo_sku,codigo_granel,tamanio_kg,codigo_envase'),
      sb.from('formulas').select('id,codigo_granel').eq('estado', 'vigente'),
      sb.from('formula_componentes').select('formula_id,codigo_componente,composicion_pct').range(0, 4999),
    ]);
    for (const r of [pr, fo, fc]) if (r.error) throw new Error(r.error.message);
    S.pres = pr.data.map((p) => ({ c: p.codigo_sku, g: p.codigo_granel, kg: p.tamanio_kg, env: p.codigo_envase }));
    const gDe = {}; for (const f of fo.data) gDe[f.id] = f.codigo_granel;
    S.formulas = fc.data.filter((x) => gDe[x.formula_id]).map((x) => ({ g: gDe[x.formula_id], c: x.codigo_componente, pct: x.composicion_pct }));
    S.subg = S.formulas.filter((x) => String(x.c).startsWith('9'));
  }

  async function actualizarOdoo() {
    const b = $('btn-actualizar'); b.disabled = true; b.textContent = 'Leyendo Odoo…';
    try { await fn('plan'); await Promise.all([cargarSnap(), cargarHoja()]); calcular(); msg('Datos de Odoo y de la hoja actualizados'); }
    catch (e) { msg('No se pudo actualizar: ' + e.message, true); }
    finally { b.disabled = false; b.textContent = 'Actualizar desde Odoo'; }
  }

  function calcular() {
    S.plan = P.programar({ snap: S.snap, cfg: S.cfg, parciales: S.parciales, clientes: S.clientes, postergados: S.postergados, entregas: S.entregas, hoja: S.hoja, pres: S.pres, subg: S.subg, hoy: new Date() });
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
  function calcMateriales() {
    const fl = filasDelDia().filter((x) => x.cantidad > 0);
    S.mat = P.necesidadMateriales({ snap: S.snap, formulas: S.formulas, pres: S.pres,
      elaborar: fl.filter((x) => x.tipo === 'elaborar' || x.tipo === 'preparar').map((x) => ({ c: x.codigo, kg: x.cantidad })),
      fraccionar: fl.filter((x) => x.tipo === 'fraccionar').map((x) => ({ c: x.codigo, q: x.cantidad })),
      hechoHoy: S.plan.hecho_hoy });
    avisarMateriales();
  }
  // deja en Inicio un aviso por cada material que falta para el plan del día (y cierra los que ya no faltan)
  async function avisarMateriales() {
    const firma = JSON.stringify(S.mat.faltan.map((x) => [x.c, x.falta]));
    if (firma === S._matFirma) return; S._matFirma = firma;
    try {
      const ahora = new Date().toISOString();
      const filas = S.mat.faltan.map((x) => ({ clave: 'falta_mp|' + x.c, area: 'materiales', tipo: 'falta_mp', severidad: 'critico', codigo: x.c, fecha_ref: isoLocal(new Date()),
        titulo: `Falta ${x.nombre} para el plan de hoy: faltan ${cantMat(x.falta, x.uom)}`, detalle: `Necesita ${cantMat(x.necesita, x.uom)} · hay ${cantMat(x.hay, x.uom)} en Odoo · para ${x.para.map(nombreDe).join(', ')}`,
        href: 'produccion/programar.html', estado: 'abierta', ultima_vez: ahora, resuelta_en: null }));
      if (filas.length) await sb.from('control_alertas').upsert(filas, { onConflict: 'clave' });
      const { data: ab } = await sb.from('control_alertas').select('clave').eq('area', 'materiales').eq('estado', 'abierta');
      const vivas = new Set(filas.map((x) => x.clave));
      const cerrar = (ab || []).map((a) => a.clave).filter((k) => !vivas.has(k));
      if (cerrar.length) await sb.from('control_alertas').update({ estado: 'resuelta', resuelta_en: ahora }).in('clave', cerrar);
    } catch { /* el aviso en Inicio no frena la pantalla */ }
  }
  const cantMat = (q, uom) => (uom === 'kg' && q > 0 && q < 1) ? fmt(q * 1000, 0) + ' g' : fmt(q, q < 10 ? 2 : 0) + ' ' + (uom === 'Unidades' ? 'u' : uom || '');

  function pintar() {
    const pl = S.plan;
    calcMateriales();
    // encabezado
    const mins = Math.round((Date.now() - S.snapCreado) / 60000);
    const c = $('cuando');
    c.textContent = `Datos de Odoo de las ${S.snapCreado.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} (${mins < 1 ? 'recién' : mins < 60 ? 'hace ' + mins + ' min' : 'hace ' + Math.round(mins / 60) + ' h'})`;
    c.classList.toggle('viejo', mins > 30);
    const barra = (v, cap) => { const pct = cap ? v / cap : 0; return `<div class="barra ${pct > 1 ? 'pasada' : pct >= 0.95 ? 'llena' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div>`; };
    const confirmados = S.snap.pedidos.filter((p) => !esPresupuesto(p));
    const fl = filasDelDia();
    const uHoy = pl.carga.hecho_u + fl.filter((x) => x.tipo === 'fraccionar').reduce((a, x) => a + x.cantidad, 0);
    const kgHoy = pl.carga.hecho_kg + fl.filter((x) => x.tipo === 'elaborar').reduce((a, x) => a + x.cantidad, 0);
    $('kpis').innerHTML = `
      <div class="pg-kpi"><div class="k">Fraccionar hoy</div><div class="v">${fmt(uHoy, 0)} <small>/ ${fmt(pl.carga.cap_u, 0)} u</small></div>${barra(uHoy, pl.carga.cap_u)}<div class="sub">ya hecho ${fmt(pl.carga.hecho_u, 0)} · falta ${fmt(uHoy - pl.carga.hecho_u, 0)}</div></div>
      <div class="pg-kpi"><div class="k">Elaborar hoy</div><div class="v">${fmt(kgHoy, 0)} <small>/ ${fmt(pl.carga.cap_kg, 0)} kg</small></div>${barra(kgHoy, pl.carga.cap_kg)}<div class="sub">ya hecho ${fmt(pl.carga.hecho_kg, 0)} · falta ${fmt(kgHoy - pl.carga.hecho_kg, 0)}</div></div>
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

  // ---------------- plan del día (cantidades editables → Hoja de Producción) ----------------
  const hoyIso = () => isoLocal(new Date());
  // Junta lo que sugiere el programador con lo que se editó/agregó a mano hoy (prod_plan_dia)
  function filasDelDia() {
    const pl = S.plan, guard = {};
    for (const r of S.dia) guard[r.tipo + '|' + r.codigo] = r;
    const filas = [];
    const sumar = (tipo, codigo, nombre, sugerido, extra) => {
      const g = guard[tipo + '|' + codigo];
      filas.push({ tipo, codigo, nombre, sugerido, cantidad: g?.editado ? Number(g.cantidad) : sugerido, editado: !!g?.editado, agregado: false, en_hoja: !!g?.en_hoja, guardada: g, ...extra });
      delete guard[tipo + '|' + codigo];
    };
    for (const x of pl.preparar) sumar('preparar', x.c, x.nombre, x.kg, { x });
    for (const x of pl.elaborar) sumar('elaborar', x.c, x.nombre, x.kg, { x });
    for (const x of pl.fraccionar) sumar('fraccionar', x.c, x.nombre, x.q, { x });
    for (const g of Object.values(guard)) if (g.agregado || g.editado)
      filas.push({ tipo: g.tipo, codigo: g.codigo, nombre: g.nombre || nombreDe(g.codigo), sugerido: g.agregado ? null : 0, cantidad: Number(g.cantidad), editado: true, agregado: !!g.agregado, en_hoja: !!g.en_hoja, guardada: g });
    return filas;
  }
  async function guardarCantidad(tipo, codigo, nombre, cantidad, sugerido, agregado) {
    const { data: u } = await sb.auth.getUser();
    const fila = { fecha: hoyIso(), tipo, codigo, nombre, cantidad, sugerido, editado: true, agregado: !!agregado, actualizado: new Date().toISOString(), actualizado_por: u?.user?.email || null };
    const prev = S.dia.find((r) => r.tipo === tipo && r.codigo === codigo);
    if (prev) fila.en_hoja = prev.en_hoja;
    const { error } = await sb.from('prod_plan_dia').upsert(fila);
    if (error) return msg('No se pudo guardar: ' + error.message, true);
    await cargarDia(); pintar();
  }
  async function restaurar(tipo, codigo) {
    const { error } = await sb.from('prod_plan_dia').delete().eq('fecha', hoyIso()).eq('tipo', tipo).eq('codigo', codigo);
    if (error) return msg(error.message, true);
    await cargarDia(); pintar();
  }
  function inputCant(f, unidad) {
    const dif = f.sugerido != null && f.cantidad !== f.sugerido;
    return `<div class="cant-edit">
      <div class="cant-fila"><input type="number" min="0" step="${unidad === 'kg' ? '0.5' : '1'}" class="inp cant-in" value="${f.cantidad}" data-acc="cant" data-tipo="${f.tipo}" data-cod="${esc(f.codigo)}" data-nom="${esc(f.nombre)}" data-sug="${f.sugerido ?? ''}" data-agr="${f.agregado ? 1 : ''}" aria-label="Cantidad a hacer"><span class="u">${unidad}</span></div>
      <div class="sug">${f.agregado ? `a mano · <a href="#" data-acc="restaurar" data-tipo="${f.tipo}" data-cod="${esc(f.codigo)}">quitar</a>`
        : dif ? `sugerido ${fmt(f.sugerido)} · <a href="#" data-acc="restaurar" data-tipo="${f.tipo}" data-cod="${esc(f.codigo)}">volver</a>` : 'sugerido'}</div>
    </div>`;
  }
  function formAgregar(tipo) {
    const lista = S.snap.stock.filter((s) => (tipo === 'fraccionar' ? /^1/ : /^9/).test(s.c));
    return `<div class="agregar"><input class="inp" list="dl-${tipo}" id="ag-${tipo}" placeholder="Agregar ${tipo === 'fraccionar' ? 'un producto' : 'un granel'}: código o nombre">
      <datalist id="dl-${tipo}">${lista.map((s) => `<option value="${esc(s.c)} · ${esc(s.n)}">`).join('')}</datalist>
      <input type="number" min="0" class="inp corto" id="ag-${tipo}-q" placeholder="${tipo === 'fraccionar' ? 'u' : 'kg'}">
      <span class="acc"><button data-acc="agregar" data-tipo="${tipo}">Agregar</button></span></div>`;
  }

  // estado de cada producto de una entrega de hoy, según lo que armó el programador
  function estadoEntrega(e) {
    const pl = S.plan, so = Number(e.so_id), por = {};
    const add = (c, k, q) => { por[c] = por[c] || { c, listo: 0, fracc: 0, falta: 0 }; por[c][k] += q; };
    for (const d of pl.de_stock) if (d.so_id === so && d.entrega) add(d.c, 'listo', d.q);
    for (const fr of pl.fraccionar) for (const m of fr.motivos) if (m.so_id === so && m.entrega) add(fr.c, 'fracc', m.q);
    for (const d of pl.postergado) if (d.so_id === so && d.entrega) add(d.c, 'falta', d.q);
    return Object.values(por);
  }
  function bloqueMateriales() {
    const m = S.mat; if (!m) return '';
    const fila = (x) => `<tr class="${x.falta ? 'falta' : ''}"><td class="cod">${esc(x.c)}</td><td><b>${esc(x.nombre)}</b></td><td class="num">${cantMat(x.necesita, x.uom)}</td><td class="num">${cantMat(x.hay, x.uom)}${x.usado_hoy > 0 ? `<div class="muted" style="font-size:11px">ya se usaron ${cantMat(x.usado_hoy, x.uom)} hoy, sin pasar a Odoo</div>` : ""}</td>
      <td class="num">${x.falta ? `<b class="rojo">${cantMat(x.falta, x.uom)}</b>` : '✓'}</td><td class="muted">${x.para.map((c) => esc(nombreDe(c))).join(', ')}</td></tr>`;
    const cab = '<thead><tr><th>Código</th><th>Material</th><th class="num">Necesita</th><th class="num">Hay en Odoo</th><th class="num">Falta</th><th>Para</th></tr></thead>';
    return `<div class="pg-bloque mat ${m.faltan.length ? 'conFaltas' : ''}"><header><h3>Materiales</h3>
      <span class="meta">${m.faltan.length ? `Faltan ${m.faltan.length} para hacer este plan` : `Alcanzan las materias primas y envases (${m.lista.length} revisados)`}${m.sin_stock_en_odoo.length ? ` · sin stock en Odoo: ${m.sin_stock_en_odoo.join(', ')}` : ''}</span>
      ${m.faltan.length ? '<span class="der"><a class="btn secondary" href="../laboratorio/reposicion.html">Ir a Stock y reposición</a></span>' : ''}</header>
      ${m.faltan.length ? `<table class="pg-tabla">${cab}<tbody>${m.faltan.map(fila).join('')}</tbody></table>` : ''}
      <details class="todos"><summary>Ver todos los materiales del plan (${m.lista.length})</summary><table class="pg-tabla">${cab}<tbody>${m.lista.map(fila).join('')}</tbody></table></details></div>`;
  }
  // ¿a esta tarea le falta algún material?
  function faltaPara(cod) { return (S.mat?.faltan || []).filter((x) => x.para.includes(cod)); }
  const chipFalta = (cod) => { const fx = faltaPara(cod); return fx.length ? ` <span class="prio hoy" title="${esc(fx.map((x) => x.nombre).join(', '))}">falta ${fx.length === 1 ? esc(fx[0].nombre.split(' ').slice(0, 3).join(' ')) : fx.length + ' materiales'}</span>` : ''; };
  function bloqueHecho() {
    const h = S.plan.hecho_hoy;
    if (!h.length) return '';
    const sinOdoo = h.filter((x) => x.q > x.en_odoo).length;
    return `<div class="pg-bloque hecho"><header><h3>Ya hecho hoy</h3><span class="meta">Según la Hoja de Producción · ${fmt(S.plan.carga.hecho_kg, 0)} kg elaborados · ${fmt(S.plan.carga.hecho_u, 0)} u fraccionadas${sinOdoo ? ` · ${sinOdoo} todavía sin pasar a Odoo (ya se cuentan)` : ''}</span></header>
      <table class="pg-tabla"><tbody>${h.map((x) => `<tr><td class="cod">${esc(x.c)}</td><td>${esc(x.nombre)}</td><td class="num"><b>${fmt(x.q)} ${x.unidad}</b></td>
        <td class="muted">${x.cargas.map((c) => `${esc(c.hora)} ${esc(c.quien)}`).join(' · ')}</td><td class="muted">${x.q > x.en_odoo ? 'falta en Odoo' : 'en Odoo'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function bloqueEntregas() {
    const hoy = isoLocal(new Date());
    const es = S.entregas.filter((e) => String(e.fecha).slice(0, 10) === hoy);
    if (!es.length) return '';
    return `<div class="pg-bloque entregas"><header><h3>Entregas de hoy</h3><span class="meta">Retiran o se despachan hoy · marcadas con la estrella en Odoo</span></header>
      ${es.map((e) => {
        const p = pedidoDe(Number(e.so_id));
        const est = estadoEntrega(e);
        const falta = est.reduce((a, x) => a + x.falta, 0), fracc = est.reduce((a, x) => a + x.fracc, 0);
        const estado = falta ? `<span class="prio hoy">Falta ${fmt(falta, 0)} u</span>` : fracc ? `<span class="prio d23">Fraccionar ${fmt(fracc, 0)} u</span>` : '<span class="prio stock">Todo listo en stock</span>';
        return `<div class="ped"><div class="cab"><span class="hora">${esc(e.hora || '')}</span><span class="num">${esc(e.numero)}</span><span class="cli">${esc(e.cliente || p?.cliente || '')}</span>${estado}
          ${p && esPresupuesto(p) ? '<span class="prio sin">sin confirmar en Odoo</span>' : ''}
          <span class="der"><span class="acc"><button data-acc="entrega" data-so="${e.so_id}">Editar</button><button data-acc="quitarentrega" data-so="${e.so_id}">Quitar</button></span></span></div>
          <div class="detalle">${(e.items || []).map((i) => `${esc(i.n || nombreDe(i.c))} × <b>${fmt(i.q, 0)}</b>`).join(' · ')}${e.nota ? ` · <i>${esc(e.nota)}</i>` : ''}</div>
          ${falta ? `<div class="detalle" style="color:var(--hot)">No alcanza: ${est.filter((x) => x.falta).map((x) => `${esc(nombreDe(x.c))} × ${fmt(x.falta, 0)}`).join(' · ')}</div>` : ''}</div>`;
      }).join('')}</div>`;
  }

  // ---------------- diálogo "Entrega de hoy" ----------------
  function abrirEntrega(soId) {
    const p = pedidoDe(Number(soId)); if (!p) return;
    const hoy = isoLocal(new Date());
    const prev = S.entregas.find((e) => Number(e.so_id) === p.id && String(e.fecha).slice(0, 10) === hoy);
    const q = {}; for (const i of prev?.items || []) q[i.c] = i.q;
    $('ent-titulo').textContent = `Entrega de hoy · ${p.numero} ${p.cliente}`;
    $('ent-texto').textContent = esPresupuesto(p) ? 'Ojo: este pedido sigue como presupuesto. Confirmalo en Odoo para que exista la entrega.' : 'Se marca la entrega en Odoo con la estrella (Urgente) y la fecha programada a esta hora.';
    $('ent-hora').value = prev?.hora || '12:00';
    $('ent-nota').value = prev?.nota || '';
    $('ent-lineas').innerHTML = p.lineas.map((l) => `<tr><td>${esc(l.n)}</td><td class="num muted">${fmt(l.pend, 0)} pend.</td>
      <td class="num"><input type="number" min="0" max="${l.pend}" class="inp corto" data-ent="${esc(l.c)}" data-n="${esc(l.n)}" value="${q[l.c] ?? ''}" placeholder="0"></td>
      <td><span class="acc"><button type="button" data-todo="${esc(l.c)}" data-max="${l.pend}">todo</button></span></td></tr>`).join('');
    $('ent-quitar').hidden = !prev;
    const d = $('dlg-ent');
    d.querySelector('form').onsubmit = async (ev) => {
      const rv = ev.submitter?.value;
      if (rv === 'quitar') return quitarEntrega(p.id);
      if (rv !== 'ok') return;
      const items = [...document.querySelectorAll('[data-ent]')].map((i) => ({ c: i.dataset.ent, n: i.dataset.n, q: Math.min(Number(i.max), Math.max(0, Number(i.value) || 0)) })).filter((i) => i.q > 0);
      if (!items.length) return msg('No pusiste cantidades', true);
      try {
        const r = await fn('entrega_hoy', { so_id: p.id, fecha: hoy, hora: $('ent-hora').value || '12:00', items, nota: $('ent-nota').value.trim() || null });
        await cargarEntregas(); calcular(); abrirTab('hoy');
        msg(r.sin_entrega_en_odoo ? `${r.numero}: guardada en Core. Confirmá el pedido en Odoo para que exista la entrega.` : `${r.numero}: entrega de hoy marcada en Odoo (${r.entregas.join(', ')})`);
      } catch (e) { msg('No se pudo guardar: ' + e.message, true); }
    };
    d.showModal();
  }
  async function quitarEntrega(soId) {
    try { const r = await fn('entrega_hoy', { so_id: Number(soId), fecha: isoLocal(new Date()), quitar: true }); await cargarEntregas(); calcular(); msg(`${r.numero}: entrega de hoy quitada`); }
    catch (e) { msg('No se pudo quitar: ' + e.message, true); }
  }

  function pintarHoy() {
    const pl = S.plan;
    const filas = filasDelDia();
    const de = (tipo) => filas.filter((f) => f.tipo === tipo);
    const hora = (t) => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const ico = { sin_etiqueta: '🏷️', sugerir_parcial: '🔄', ml_borrador: '🟡', parcial_sin_ritmo: '🔄', parcial_vencido: '⏰', sin_ficha: '❓', mo_vieja: '🗂️', excede: '⚠️', confirmar: '📝' };
    const alertas = pl.alertas.length ? `
      <div class="pg-bloque"><header><h3>Avisos</h3><span class="meta">${pl.alertas.length}</span></header>
      ${pl.alertas.map((a) => `<div class="alerta"><span class="ico">${ico[a.tipo] || '•'}</span><span class="txt">${esc(a.texto)}</span>
        ${(a.tipo === 'sin_etiqueta' || a.tipo === 'sugerir_parcial') && a.so_id ? accEtiquetas(a.so_id) : ''}
        ${a.tipo === 'parcial_sin_ritmo' ? `<span class="acc"><button data-acc="irpedido" data-so="${a.so_id}">Cargar ritmo</button></span>` : ''}</div>`).join('')}
      </div>` : '';

    const barraHoja = `<div class="pg-hoja">
      <div class="txt"><b>Revisá y ajustá las cantidades</b> (quedan guardadas) y después imprimí el plan del día para planta.</div>
      <span class="der"><button class="btn primary" data-acc="imprimirplan">Imprimir el plan del día</button></span></div>`;

    const prep = de('preparar').length ? `
      <div class="pg-bloque"><header><h3>Preparar hoy para mañana</h3><span class="meta">Necesitan reposar o mezclar de un día para el otro</span></header>
      ${de('preparar').map((f) => `<div class="fila elab"><div class="cod">${esc(f.codigo)}</div><div><div class="nom">${esc(f.nombre)}</div>${f.x ? `<div class="m-nota">lote de ${fmt(f.x.lote)} kg · ${esc(f.x.texto)}</div>` : ''}</div>${inputCant(f, 'kg')}</div>`).join('')}</div>` : '';

    const kgTot = de('elaborar').reduce((a, f) => a + f.cantidad, 0);
    const elab = `
      <div class="pg-bloque"><header><h3>Elaborar</h3><span class="meta">${fmt(kgTot, 0)} kg · tope ${fmt(pl.carga.cap_kg, 0)} kg</span></header>
      ${de('elaborar').map((f) => `<div class="fila elab${f.cantidad === 0 ? ' anulada' : ''}"><div class="cod">${esc(f.codigo)}</div>
        <div><div class="nom">${esc(f.nombre)}${chipFalta(f.codigo)}</div>${f.x ? `<div class="m-nota">lote habitual ${fmt(f.x.lote)} kg${f.x.kg > f.x.lote ? ` (${fmt(f.x.kg / f.x.lote, 1)} lotes)` : ''} · para ${f.x.para.map((c) => esc(nombreDe(c))).join(', ')}</div>` : ''}</div>
        ${inputCant(f, 'kg')}</div>`).join('') || '<div class="pg-vacio">No hace falta elaborar granel hoy: alcanza con lo que hay.</div>'}
      ${formAgregar('elaborar')}</div>`;

    const uTot = de('fraccionar').reduce((a, f) => a + f.cantidad, 0);
    const motivoHtml = (f, m) => `<div class="motivo">
        <div class="m-quien">${m.prio !== f.x.prio ? pill(m.prio) + ' ' : ''}${m.numero ? `<b>${esc(m.numero)}</b> <span class="cli">${esc(m.cliente)}</span>` : '<span class="cli">Para stock</span>'}</div>
        <div class="m-q">${fmt(m.q, 0)} u</div>
        <div class="m-acc">${accPost(m.so_id || 0, f.codigo, m.numero, m.numero ? `${m.numero} · ${f.nombre}` : `${f.nombre} para stock`)}</div>
        ${m.nota || m.kit ? `<div class="m-nota">${m.kit ? `va en ${esc(m.kit)}` : ''}${m.kit && m.nota ? ' · ' : ''}${esc(m.nota || '')}</div>` : ''}
      </div>`;
    const fracc = `
      <div class="pg-bloque"><header><h3>Fraccionar</h3><span class="meta">${fmt(uTot, 0)} unidades · tope ${fmt(pl.carga.cap_u, 0)}</span>
        <span class="der"><button class="btn secondary" data-acc="copiar">Copiar lista</button><button class="btn secondary" data-acc="imprimir">Imprimir</button></span></header>
      ${de('fraccionar').map((f) => `
        <div class="fila${f.cantidad === 0 ? ' anulada' : ''}">
          <div>${f.x ? pill(f.x.prio) : '<span class="prio sin">A mano</span>'}</div>
          <div class="cod">${esc(f.codigo)}</div>
          <div><div class="nom">${esc(f.nombre)}${chipFalta(f.codigo)}</div>${f.x ? `<div class="motivos">${f.x.motivos.map((m) => motivoHtml(f, m)).join('')}</div>` : ''}</div>
          ${inputCant(f, 'u')}
        </div>`).join('') || '<div class="pg-vacio">Nada para fraccionar hoy.</div>'}
      ${formAgregar('fraccionar')}</div>`;

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
      ${bloqueEntregas()}${alertas}${barraHoja}${bloqueHecho()}${bloqueMateriales()}${prep}${elab}${fracc}${deStock}${noEntraHtml}`;
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
            <span class="acc"><button data-acc="entrega" data-so="${p.id}">Entrega de hoy</button></span>
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
        ${pres.length ? `<table class="pg-tabla"><thead><tr><th>Pedido</th><th>Cliente</th><th>Fecha</th><th class="num">Monto</th><th>Productos</th><th></th></tr></thead><tbody>
        ${pres.map((p) => `<tr class="${viejo(p.fecha) ? 'dim' : ''}"><td class="cod">${esc(p.numero)}</td><td>${esc(p.cliente)}</td><td>${fCorta(p.fecha)}${viejo(p.fecha) ? ' · viejo' : ''}</td>
          <td class="num">$ ${fmt(p.monto, 0)}</td><td class="muted">${p.lineas.map((l) => `${esc(l.n)} × ${fmt(l.pend, 0)}`).join(' · ')}</td><td><span class="acc"><button data-acc="entrega" data-so="${p.so_id}">Entrega de hoy</button></span></td></tr>`).join('')}</tbody></table>` : '<div class="pg-vacio">No hay presupuestos abiertos.</div>'}</div>`;
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
    d.querySelector('form').onsubmit = (ev) => { if (ev.submitter?.value === 'ok' && f.value) postergar(so, sku, f.value, $('dlg-motivo').value.trim() || null); };
    d.showModal();
  }
  // Plan del día para imprimir: hoja A4 limpia, con casillas para tachar y para firmar
  function imprimirPlan() {
    const fl = filasDelDia().filter((x) => x.cantidad > 0);
    const de = (t) => fl.filter((x) => x.tipo === t);
    const hoy = new Date(), hoyIso = isoLocal(hoy);
    const fechaLarga = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const es = S.entregas.filter((e) => String(e.fecha).slice(0, 10) === hoyIso);
    const caja = '<td class="caja"></td>';
    const quien = (x) => x.x ? x.x.motivos.map((m) => m.numero ? `${esc(m.numero)} ${esc(m.cliente.split(/[ ,]/)[0])} ${fmt(m.q, 0)}${m.entrega ? ' (retira hoy)' : ''}` : `stock ${fmt(m.q, 0)}`).join(' · ') : 'agregado a mano';
    const tabla = (titulo, cab, filas) => filas ? `<h2>${titulo}</h2><table><thead><tr>${cab}</tr></thead><tbody>${filas}</tbody></table>` : '';
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Plan de producción ${fCorta(hoyIso)}</title><style>
      @page { size: A4; margin: 12mm; }
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11.5px; color: #111; margin: 0; }
      header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 10px; }
      header .marca { font-weight: 800; letter-spacing: .12em; font-size: 13px; }
      header h1 { font-size: 18px; margin: 2px 0 0; }
      header .der { text-align: right; font-size: 10.5px; color: #444; }
      h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; margin: 14px 0 5px; }
      table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
      tr { page-break-inside: avoid; }
      th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: #444; border-bottom: 1.5px solid #111; padding: 4px 6px; }
      td { border-bottom: 1px solid #bbb; padding: 6px; vertical-align: top; }
      td.num, th.num { text-align: right; white-space: nowrap; }
      td.cant { font-size: 15px; font-weight: 800; text-align: right; white-space: nowrap; }
      td.caja { width: 22px; } td.caja::before { content: ''; display: inline-block; width: 13px; height: 13px; border: 1.5px solid #111; }
      td.firma { width: 70px; }
      .cod { font-family: Consolas, monospace; color: #555; font-size: 10.5px; }
      .det { color: #444; font-size: 10.5px; }
      .obs { border: 1px solid #999; height: 70px; margin-top: 4px; }
      footer { margin-top: 14px; display: flex; justify-content: space-between; font-size: 10.5px; color: #444; }
    </style></head><body>
      <header><div><div class="marca">ROSAINT</div><h1>Plan de producción</h1><div>${esc(fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1))}</div></div>
        <div class="der">Falta elaborar: <b>${fmt(de('elaborar').reduce((a, x) => a + x.cantidad, 0), 0)} kg</b><br>Falta fraccionar: <b>${fmt(de('fraccionar').reduce((a, x) => a + x.cantidad, 0), 0)} u</b><br>Impreso ${hoy.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</div></header>
      ${tabla('Entregas de hoy', '<th></th><th>Hora</th><th>Cliente</th><th>Qué se lleva</th>', es.map((e) => `<tr>${caja}<td><b>${esc(e.hora || '')}</b></td><td><b>${esc(e.cliente || '')}</b><div class="det">${esc(e.numero)}</div></td>
        <td>${(e.items || []).map((i) => `${esc(i.n || nombreDe(i.c))} × <b>${fmt(i.q, 0)}</b>`).join('<br>')}${e.nota ? `<div class="det">${esc(e.nota)}</div>` : ''}</td></tr>`).join(''))}
      ${S.mat && S.mat.faltan.length ? tabla('⚠ Faltan materiales para este plan', '<th>Material</th><th class="num">Necesita</th><th class="num">Hay</th><th class="num">Falta</th><th>Para</th>', S.mat.faltan.map((x) => `<tr><td><span class="cod">${esc(x.c)}</span> <b>${esc(x.nombre)}</b></td><td class="num">${cantMat(x.necesita, x.uom)}</td><td class="num">${cantMat(x.hay, x.uom)}</td><td class="num"><b>${cantMat(x.falta, x.uom)}</b></td><td class="det">${x.para.map((c) => esc(nombreDe(c))).join(', ')}</td></tr>`).join('')) : ''}
      ${S.plan.hecho_hoy.length ? tabla('Ya hecho hoy (según la Hoja de Producción)', '<th>Producto</th><th class="num">Cantidad</th><th>Cargado</th>', S.plan.hecho_hoy.map((x) => `<tr><td><span class="cod">${esc(x.c)}</span> ${esc(x.nombre)}</td><td class="num">${fmt(x.q)} ${x.unidad}</td><td class="det">${x.cargas.map((c) => `${esc(c.hora)} ${esc(c.quien)}`).join(' · ')}</td></tr>`).join('')) : ''}
      ${tabla('Preparar hoy para mañana', '<th></th><th>Granel</th><th class="num">Cantidad</th><th>Hecho por</th>', de('preparar').map((x) => `<tr>${caja}<td><span class="cod">${esc(x.codigo)}</span> ${esc(x.nombre)}</td><td class="cant">${fmt(x.cantidad)} kg</td><td class="firma"></td></tr>`).join(''))}
      ${tabla('Elaborar', '<th></th><th>Granel</th><th class="num">Cantidad</th><th>Para</th><th>Hecho por</th>', de('elaborar').map((x) => `<tr>${caja}<td><span class="cod">${esc(x.codigo)}</span> <b>${esc(x.nombre)}</b>${x.x ? `<div class="det">lote habitual ${fmt(x.x.lote)} kg</div>` : ''}</td>
        <td class="cant">${fmt(x.cantidad)} kg</td><td class="det">${x.x ? x.x.para.map((c) => esc(nombreDe(c))).join(', ') : 'agregado a mano'}</td><td class="firma"></td></tr>`).join(''))}
      ${tabla('Fraccionar', '<th></th><th>Producto</th><th class="num">Cantidad</th><th>Para</th><th>Hecho por</th>', de('fraccionar').map((x) => `<tr>${caja}<td><span class="cod">${esc(x.codigo)}</span> <b>${esc(x.nombre)}</b></td>
        <td class="cant">${fmt(x.cantidad, 0)}</td><td class="det">${quien(x)}</td><td class="firma"></td></tr>`).join(''))}
      <h2>Observaciones</h2><div class="obs"></div>
      <footer><span>Controló: ______________________</span><span>Rosaint Core · Programar el día</span></footer>
      <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return msg('El navegador bloqueó la ventana de impresión: permití ventanas emergentes para Core', true);
    w.document.open(); w.document.write(html); w.document.close();
  }

  function textoLista() {
    const fl = filasDelDia().filter((x) => x.cantidad > 0);
    const l = [`Producción del ${fCorta(S.plan.fecha)}`];
    const bloque = (tipo, titulo, u) => {
      const xs = fl.filter((x) => x.tipo === tipo); if (!xs.length) return;
      l.push('', titulo);
      for (const x of xs) l.push(`- ${x.codigo} ${x.nombre}: ${fmt(x.cantidad)} ${u}` + (tipo === 'fraccionar' && x.x ? ` (${x.x.motivos.map((m) => m.numero ? `${m.numero} ${m.cliente} ${fmt(m.q, 0)}` : `stock ${fmt(m.q, 0)}`).join('; ')})` : ''));
    };
    bloque('preparar', 'PREPARAR PARA MAÑANA', 'kg'); bloque('elaborar', 'ELABORAR', 'kg'); bloque('fraccionar', 'FRACCIONAR', 'u');
    return l.join('\n');
  }

  document.addEventListener('click', async (ev) => {
    const todo = ev.target.closest('[data-todo]');
    if (todo) { const i = document.querySelector(`[data-ent="${todo.dataset.todo}"]`); if (i) i.value = todo.dataset.max; return; }
    const t = ev.target.closest('[data-acc]'); if (!t || t.tagName === 'SELECT') return;
    const a = t.dataset.acc;
    if (a === 'post1') { t.disabled = true; await postergar(t.dataset.so, t.dataset.sku, isoLocal(proximoHabil()), null); }
    else if (a === 'posthasta') abrirPostergar(t.dataset.so, t.dataset.sku, t.dataset.et);
    else if (a === 'volver') { t.disabled = true; await postergar(t.dataset.so, t.dataset.sku, null, null); }
    else if (a === 'etiq') { t.disabled = true; await etiquetar(t.dataset.so, t.dataset.prio); }
    else if (a === 'irpedido') { abrirTab('pedidos'); document.getElementById('ped-' + t.dataset.so)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else if (a === 'entrega') abrirEntrega(t.dataset.so);
    else if (a === 'quitarentrega') { t.disabled = true; await quitarEntrega(t.dataset.so); }
    else if (a === 'restaurar') { ev.preventDefault(); await restaurar(t.dataset.tipo, t.dataset.cod); }
    else if (a === 'imprimirplan') imprimirPlan();
    else if (a === 'agregar') {
      const tipo = t.dataset.tipo, txt = $('ag-' + tipo).value.trim(), q = Number($('ag-' + tipo + '-q').value);
      const cod = txt.split('·')[0].trim();
      const prod = S.snap.stock.find((x) => x.c === cod) || S.snap.stock.find((x) => x.n.toLowerCase() === txt.toLowerCase());
      if (!prod) return msg('Elegí un producto de la lista', true);
      if (!(q > 0)) return msg('Poné la cantidad', true);
      const ya = filasDelDia().find((x) => x.tipo === tipo && x.codigo === prod.c);
      await guardarCantidad(tipo, prod.c, prod.n, ya ? ya.cantidad + q : q, ya ? ya.sugerido : null, !ya || ya.agregado);
      msg(ya ? `Sumado a ${prod.n}` : `Agregado: ${prod.n}`);
    }
    else if (a === 'copiar') { await navigator.clipboard.writeText(textoLista()); msg('Lista copiada'); }
    else if (a === 'imprimir') imprimirPlan();
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
    const t = ev.target;
    if (t.dataset?.acc === 'cant') {
      const v = Math.max(0, Number(t.value) || 0);
      const sug = t.dataset.sug === '' ? null : Number(t.dataset.sug);
      if (sug !== null && v === sug && !t.dataset.agr) { restaurar(t.dataset.tipo, t.dataset.cod); return; }
      guardarCantidad(t.dataset.tipo, t.dataset.cod, t.dataset.nom, v, sug, !!t.dataset.agr);
      return;
    }
    if (t.dataset?.acc !== 'etiqsel') return;
    t.disabled = true; etiquetar(t.dataset.so, t.value).finally(() => { t.disabled = false; });
  });

  function abrirTab(id) {
    for (const b of document.querySelectorAll('.pg-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    for (const s of document.querySelectorAll('.pg-panel')) s.hidden = s.id !== 'tab-' + id;
    try { localStorage.setItem('programar.tab', id); } catch { /* */ }
  }
  for (const b of document.querySelectorAll('.pg-tab')) b.addEventListener('click', () => abrirTab(b.dataset.tab));
  $('btn-actualizar').addEventListener('click', actualizarOdoo);
  setInterval(async () => {
    if (!S.plan || document.hidden) return;
    const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    if (document.querySelector('dialog[open]')) return;
    try { if (await cargarHoja()) { calcular(); msg('Se actualizó con lo nuevo cargado en la Hoja de Producción'); } } catch { /* */ }
  }, 3 * 60000);

  (async function inicio() {
    try {
      try { const t = localStorage.getItem('programar.tab'); if (t) abrirTab(t); } catch { /* */ }
      await Promise.all([cargarConfig(), cargarRecetas(), cargarDia(), cargarEntregas(), cargarHoja()]);
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
