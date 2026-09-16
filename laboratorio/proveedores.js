/* =========================================================================
   Rosaint · CORE — Proveedores
   Una sola ficha por proveedor, espejada con Odoo: lo que se edita acá se
   escribe allá (edge function `odoo-proveedores`). Lo que Odoo no tiene
   —plazo de entrega, cómo se pide, mínimos, notas— vive sólo en el Core.
   Usa los ayudantes de reposicion.js (REPO) para no repetirlos.
   ========================================================================= */

(() => {
  const { esc, norm, pesos, num, fecha, fechaHora, toast, mediana } = REPO;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const FN = window.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') + '/odoo-proveedores';

  let PROV = [];        // proveedores (Core + espejo de Odoo)
  let ITEMS = [];       // materias primas e insumos, todos los estados
  let SNAP = null;      // foto de Odoo (stock, consumo, compras) del módulo de reposición
  let SINFO = [];       // product.supplierinfo: lo que Odoo tiene cargado por producto
  let TERMINOS = [];    // condiciones de pago de Odoo
  let REAL = {};        // codigo -> { proveedor, veces, ultima, ultimoPrecio, moneda, compras[] }
  let CFG = null, AJUSTES = {}, CALC = [];   // el mismo cálculo que hace Stock y reposición
  let drawerId = null;

  // Cómo se ve la lista de proveedores. Filas por defecto: se leen de un vistazo
  // y entran más en pantalla. La preferencia queda en este navegador.
  const VISTA_KEY = 'rosaint-prov-vista';
  let VISTA = 'filas';
  try { VISTA = localStorage.getItem(VISTA_KEY) || 'filas'; } catch { /* sin localStorage */ }

  const provPorId = id => PROV.find(p => p.id === id) || null;
  const provPorOdooNombre = n => PROV.find(p => (p.odoo_nombre || p.nombre) === n) || null;

  // ---- Llamada a la edge function ----------------------------------------
  async function fn(body) {
    const { data: s } = await sb.auth.getSession();
    const token = s?.session?.access_token || window.SUPABASE_KEY;
    const r = await fetch(FN, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Odoo no respondió');
    return j;
  }

  // ---- Carga --------------------------------------------------------------
  async function cargar() {
    const [prov, items, snap, cfg, aj, cats] = await Promise.all([
      sb.from('proveedores').select('*').order('nombre'),
      sb.from('items').select('codigo,nombre,tipo,estado,proveedor_id,codigo_proveedor,unidad,categoria_id,notas')
        .in('tipo', ['MP', 'IN']),
      sb.from('repo_snapshot').select('generado_en,datos').order('generado_en', { ascending: false }).limit(1),
      sb.from('repo_config').select('*').eq('id', 1).single(),
      sb.from('repo_items').select('*'),
      sb.from('categorias').select('id,nombre'),
    ]);
    CFG = cfg.data || { dias_seguridad: 15, ciclo_dias: 30, plazo_default: 7, peso_corto: 0.65, ventana_corta_dias: 90 };
    AJUSTES = {}; for (const a of aj.data || []) AJUSTES[a.codigo] = a;
    const catNom = {}; for (const c of cats.data || []) catNom[c.id] = c.nombre;
    if (prov.error) throw new Error(prov.error.message);
    PROV = prov.data || [];
    ITEMS = items.data || [];
    SNAP = snap.data?.length ? snap.data[0].datos : null;

    // Quién factura de verdad cada insumo, según el historial de compras de Odoo.
    REAL = {};
    if (SNAP) {
      const codigoDe = {};
      for (const p of SNAP.productos) codigoDe[p.id] = p.codigo;
      const porCodigo = {};
      for (const c of SNAP.compras) {
        const cod = codigoDe[c.producto_id];
        if (!cod) continue;
        (porCodigo[cod] = porCodigo[cod] || []).push(c);
      }
      for (const [cod, compras] of Object.entries(porCodigo)) {
        compras.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
        const veces = {};
        for (const c of compras) veces[c.proveedor] = (veces[c.proveedor] || 0) + 1;
        const ranking = Object.entries(veces).sort((a, b) => b[1] - a[1]);
        const ult = compras[compras.length - 1];
        REAL[cod] = {
          proveedor: ranking[0][0], veces: ranking[0][1], distintos: ranking.length,
          ultima: ult.fecha, ultimoPrecio: ult.precio, moneda: ult.moneda,
          loteHabitual: mediana(compras.map(c => c.cantidad)), compras,
        };
      }
    }

    // Mismo cálculo que Stock y reposición, para que la ficha del insumo muestre
    // stock, cobertura y sugerencia también desde acá.
    const plazos = {};
    for (const p of PROV) {
      plazos[p.odoo_nombre || p.nombre] = {
        plazo_dias: p.plazo_entrega_dias, confirmado: p.plazo_confirmado,
      };
    }
    const maestro = {};
    for (const i of ITEMS) maestro[i.codigo] = { ...i, categoria: catNom[i.categoria_id] || null };
    CALC = SNAP ? REPO.calcular({ datos: SNAP, cfg: CFG, plazos, ajustes: AJUSTES, maestro }) : [];
  }

  async function cargarSupplierinfo() {
    try { SINFO = (await fn({ modo: 'supplierinfo' })).filas || []; }
    catch (e) { SINFO = []; console.warn('supplierinfo:', e.message); }
  }

  async function sincronizar() {
    const btn = $('#btn-sync');
    btn.disabled = true; btn.textContent = 'Leyendo Odoo…';
    try {
      const r = await fn({ modo: 'sincronizar' });
      TERMINOS = r.terminos || [];
      await cargar();
      await cargarSupplierinfo();
      pintarTodo();
      toast(`Odoo: ${r.partners} proveedores · ${r.creados} nuevos, ${r.actualizados} actualizados`);
    } catch (e) {
      toast('No se pudo sincronizar: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Sincronizar con Odoo';
    }
  }

  // ---- Cifras por proveedor ----------------------------------------------
  function resumenProv(p) {
    const clave = p.odoo_nombre || p.nombre;
    const insumos = ITEMS.filter(i => i.proveedor_id === p.id && i.estado === 'vigente');
    let comprado = 0, compras = 0, ultima = null;
    if (SNAP) {
      for (const c of SNAP.compras) {
        if (c.proveedor !== clave) continue;
        compras++;
        if (c.moneda === 'ARS') comprado += c.subtotal;
        if (!ultima || String(c.fecha) > ultima) ultima = c.fecha;
      }
    }
    // Insumos que este proveedor factura aunque la ficha diga otra cosa
    const facturaReal = Object.entries(REAL).filter(([, r]) => r.proveedor === clave).length;
    return { insumos: insumos.length, comprado, compras, ultima, facturaReal };
  }

  // ---- Cosas para corregir ------------------------------------------------
  function desactualizados() {
    // La ficha dice un proveedor, pero desde que arrancó Odoo le comprás a otro.
    const out = [];
    for (const i of ITEMS) {
      if (i.estado !== 'vigente') continue;
      const r = REAL[i.codigo];
      if (!r) continue;
      const actual = provPorId(i.proveedor_id);
      const real = provPorOdooNombre(r.proveedor);
      if (!real) continue;
      if (actual && actual.id === real.id) continue;
      out.push({ item: i, actual, real, veces: r.veces, ultima: r.ultima });
    }
    return out.sort((a, b) => b.veces - a.veces);
  }

  function sinEnOdoo() {
    // Insumos con proveedor en el Core que Odoo no tiene cargado como proveedor del producto.
    const cargados = new Set(SINFO.map(s => s.codigo));
    return ITEMS.filter(i => i.estado === 'vigente' && i.proveedor_id && !cargados.has(i.codigo))
      .map(i => ({ item: i, prov: provPorId(i.proveedor_id), real: REAL[i.codigo] || null }))
      .filter(x => x.prov && x.prov.odoo_partner_id)
      .sort((a, b) => (b.real?.veces || 0) - (a.real?.veces || 0));
  }

  function preciosViejos() {
    const out = [];
    for (const s of SINFO) {
      const r = REAL[s.codigo];
      if (!r || r.moneda !== 'ARS' || !s.precio) continue;
      if (s.proveedor !== r.proveedor) continue;
      const dif = r.ultimoPrecio / s.precio - 1;
      if (Math.abs(dif) <= 0.05) continue;
      const item = ITEMS.find(i => i.codigo === s.codigo);
      out.push({ s, r, dif, item });
    }
    return out.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
  }

  function candidatosArchivar() {
    if (!SNAP) return [];
    const usado = new Set();
    const codigoDe = {};
    for (const p of SNAP.productos) codigoDe[p.id] = p.codigo;
    for (const [pid, meses] of Object.entries(SNAP.consumo)) {
      if (Object.values(meses).some(v => v > 0)) usado.add(codigoDe[pid]);
    }
    const stockDe = {};
    for (const p of SNAP.productos) stockDe[p.codigo] = p.stock;
    return ITEMS.filter(i => i.estado === 'vigente' && !usado.has(i.codigo) && !REAL[i.codigo])
      .map(i => ({ item: i, stock: stockDe[i.codigo] ?? null, prov: provPorId(i.proveedor_id) }))
      .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0) || a.item.codigo.localeCompare(b.item.codigo));
  }

  // ---- Encabezado ---------------------------------------------------------
  function pintarKpis() {
    const activos = PROV.filter(p => p.activo !== false);
    const conOdoo = PROV.filter(p => p.odoo_partner_id);
    const arch = ITEMS.filter(i => i.estado === 'descontinuado');
    let comprado = 0;
    if (SNAP) for (const c of SNAP.compras) if (c.moneda === 'ARS') comprado += c.subtotal;

    const nCorr = desactualizados().length + sinEnOdoo().length + preciosViejos().length;
    $('#k-prov').textContent = activos.length;
    $('#k-prov-sub').textContent = conOdoo.length + ' con ficha en Odoo';
    $('#k-comprado').textContent = pesos(comprado);
    $('#k-comprado-sub').textContent = SNAP ? 'desde ' + fecha(SNAP.historia_desde) : '—';
    $('#k-corregir').textContent = nCorr;
    $('#k-archivados').textContent = arch.length;

    $('#n-lista').textContent = activos.length;
    $('#n-insumos').textContent = ITEMS.filter(i => i.estado === 'vigente').length;
    $('#n-corregir').textContent = nCorr;
    $('#n-arch').textContent = arch.length;

    const ultSync = PROV.map(p => p.sincronizado_en).filter(Boolean).sort().pop();
    $('#sync-estado').innerHTML = ultSync
      ? 'Última sincronización:<br><b>' + esc(fechaHora(ultSync)) + '</b>'
      : 'Todavía no se sincronizó con Odoo.';
  }

  // ---- Pestaña: lista de proveedores -------------------------------------
  function pintarLista() {
    const q = norm($('#q-prov').value);
    const filtro = $('#f-estado-prov').value;
    let lista = PROV.slice();
    if (filtro === 'activos') lista = lista.filter(p => p.activo !== false && (p.odoo_partner_id || ITEMS.some(i => i.proveedor_id === p.id && i.estado === 'vigente')));
    else if (filtro === 'sin_odoo') lista = lista.filter(p => !p.odoo_partner_id);
    else if (filtro === 'inactivos') lista = lista.filter(p => p.activo === false);
    if (q) lista = lista.filter(p => norm([p.nombre, p.odoo_nombre, p.cuit, p.email, p.contacto].join(' ')).includes(q));

    const conDatos = lista.map(p => ({ p, r: resumenProv(p) }))
      .sort((a, b) => b.r.comprado - a.r.comprado || b.r.insumos - a.r.insumos || a.p.nombre.localeCompare(b.p.nombre, 'es'));

    const cont = $('#grilla-prov');
    if (!conDatos.length) {
      cont.className = '';
      cont.innerHTML = '<div class="vacio">Nada coincide con el filtro.</div>';
      return;
    }
    if (VISTA === 'tarjetas') {
      cont.className = 'pv-grid';
      cont.innerHTML = conDatos.map(({ p, r }) => tarjetaProv(p, r)).join('');
    } else {
      cont.className = '';
      cont.innerHTML = `<div class="table-wrap"><div class="table-scroll">
        <table class="pv-tabla">
          <thead><tr>
            <th>Proveedor</th><th>Situación</th><th>Entrega</th><th>Condición de pago</th>
            <th class="num">Insumos</th><th class="num">Compras</th><th class="num">Facturado</th>
          </tr></thead>
          <tbody>${conDatos.map(({ p, r }) => filaProv(p, r)).join('')}</tbody>
        </table></div></div>`;
    }
    $$('#grilla-prov [data-id]').forEach(c => c.addEventListener('click', () => abrirFicha(Number(c.dataset.id))));
  }

  function chipsProv(p) {
    return [
      p.odoo_partner_id ? '<span class="chip ok">en Odoo</span>' : '<span class="chip est">solo en el Core</span>',
      p.activo === false ? '<span class="chip">inactivo</span>' : '',
    ].filter(Boolean).join(' ');
  }
  const entregaProv = p => p.plazo_entrega_dias != null
    ? p.plazo_entrega_dias + ' d' + (p.plazo_confirmado ? '' : ' <span class="chip est">est.</span>')
    : '<span class="chip est">sin cargar</span>';
  const pagoProv = p => p.condicion_pago
    ? esc(p.condicion_pago) : '<span class="chip est">sin definir</span>';

  function filaProv(p, r) {
    return `<tr data-id="${p.id}" style="cursor:pointer${p.activo === false ? ';opacity:.7' : ''}">
      <td><b>${esc(p.nombre)}</b>
        <div class="cod">${p.cuit ? esc(p.cuit) : 'sin CUIT'}${p.contacto ? ' · ' + esc(p.contacto) : ''}</div></td>
      <td>${chipsProv(p)}</td>
      <td class="num">${entregaProv(p)}</td>
      <td>${pagoProv(p)}</td>
      <td class="num">${r.insumos || '—'}</td>
      <td class="num">${r.compras || '—'}</td>
      <td class="num">${r.comprado ? pesos(r.comprado) : '—'}</td>
    </tr>`;
  }

  function tarjetaProv(p, r) {
    return `<article class="pv-card ${p.activo === false ? 'inactivo' : ''}" data-id="${p.id}">
      <h3>${esc(p.nombre)}</h3>
      <div class="cuit">${p.cuit ? esc(p.cuit) : '<span style="color:var(--muted)">sin CUIT</span>'}</div>
      <div class="linea">
        ${chipsProv(p)}
        ${p.plazo_entrega_dias != null
          ? `<span class="chip">entrega ${p.plazo_entrega_dias} d${p.plazo_confirmado ? '' : ' (est.)'}</span>` : ''}
        ${p.condicion_pago ? `<span class="chip">${esc(p.condicion_pago)}</span>` : '<span class="chip est">sin condición de pago</span>'}
      </div>
      <div class="cifras">
        <div class="cifra"><div class="v">${r.insumos}</div><div class="k">insumos</div></div>
        <div class="cifra"><div class="v">${r.compras}</div><div class="k">compras</div></div>
        <div class="cifra"><div class="v">${r.comprado ? pesos(r.comprado) : '—'}</div><div class="k">facturado</div></div>
      </div>
    </article>`;
  }

  // ---- Pestaña: quién provee qué -----------------------------------------
  function pintarInsumos() {
    const q = norm($('#q-ins').value);
    const fp = $('#f-prov-ins').value;
    const fc = $('#f-coincide').value;

    let filas = ITEMS.filter(i => i.estado === 'vigente').map(i => {
      const actual = provPorId(i.proveedor_id);
      const r = REAL[i.codigo];
      const real = r ? provPorOdooNombre(r.proveedor) : null;
      const coincide = !r ? null : (actual && real && actual.id === real.id);
      return { i, actual, r, real, coincide };
    });
    if (fp) filas = filas.filter(f => String(f.actual?.id) === fp || String(f.real?.id) === fp);
    if (fc === 'no') filas = filas.filter(f => f.coincide === false);
    if (fc === 'si') filas = filas.filter(f => f.coincide === true);
    if (q) filas = filas.filter(f => norm([f.i.codigo, f.i.nombre, f.actual?.nombre, f.r?.proveedor].join(' ')).includes(q));
    filas.sort((a, b) => (a.coincide === false ? -1 : 1) - (b.coincide === false ? -1 : 1)
      || a.i.codigo.localeCompare(b.i.codigo));

    $('#tbody-ins').innerHTML = filas.length ? filas.map(f => `
      <tr data-insumo="${esc(f.i.codigo)}">
        <td class="cod">${esc(f.i.codigo)}</td>
        <td><b>${esc(f.i.nombre)}</b>${f.i.codigo_proveedor ? `<div class="cod">cód. del proveedor: ${esc(f.i.codigo_proveedor)}</div>` : ''}</td>
        <td>${f.actual ? esc(f.actual.nombre) : '<span class="chip">sin asignar</span>'}</td>
        <td>${f.r
          ? (f.coincide === false ? `<b style="color:var(--warn)">${esc(f.r.proveedor)}</b>` : esc(f.r.proveedor))
            + `<div class="cod">${f.r.veces} ${f.r.veces === 1 ? 'compra' : 'compras'}${f.r.distintos > 1 ? ' · ' + f.r.distintos + ' proveedores' : ''}</div>`
          : '<span class="chip">sin compras desde marzo</span>'}</td>
        <td class="num">${f.r ? esc(fecha(f.r.ultima)) : '—'}</td>
        <td class="num">${f.r ? (f.r.moneda === 'ARS' ? pesos(f.r.ultimoPrecio) : 'US$ ' + num(f.r.ultimoPrecio)) : '—'}</td>
        <td><button class="btn secondary" data-cambiar="${esc(f.i.codigo)}">Cambiar</button></td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="vacio">Nada coincide con el filtro.</div></td></tr>';

    $$('[data-cambiar]').forEach(b => b.addEventListener('click', () => cambiarProveedor(b.dataset.cambiar)));
    FICHA.enlazar('#tbody-ins tr[data-insumo]');
  }

  // ---- Pestaña: para corregir --------------------------------------------
  function pintarCorregir() {
    const q = norm($('#q-corregir')?.value || '');
    const coincide = (...campos) => !q || norm(campos.filter(Boolean).join(' ')).includes(q);
    const desT = desactualizados(), sinT = sinEnOdoo(), preT = preciosViejos();
    const des = desT.filter(d => coincide(d.item.codigo, d.item.nombre, d.actual?.nombre, d.real?.nombre));
    const sin = sinT.filter(x => coincide(x.item.codigo, x.item.nombre, x.prov?.nombre));
    const pre = preT.filter(x => coincide(x.s.codigo, x.item?.nombre, x.s.proveedor));
    const cuenta = $('#cuenta-corregir');
    if (cuenta) cuenta.textContent = q
      ? `${des.length + sin.length + pre.length} de ${desT.length + sinT.length + preT.length}`
      : '';
    let html = '';

    html += `<h3 class="pv-h4" style="margin-top:0">El proveedor de la ficha ya no es el que factura
      <span class="chip ${des.length ? 'hot' : 'ok'}">${des.length}</span></h3>
      <div class="pv-nota">Odoo arrancó el ${SNAP ? esc(fecha(SNAP.historia_desde)) : '—'}, cuando cambiaron de cuenta:
      lo anterior a esa fecha no figura. Así que esto <b>no quiere decir que la ficha esté mal</b>, sino que
      desde entonces le venís comprando a otro. Actualizá los que ya cambiaste de verdad.</div>`;
    html += des.length ? des.map(d => `
      <div class="arreglo" data-insumo="${esc(d.item.codigo)}">
        <div class="desc">
          <b>${esc(d.item.nombre)}</b> <span class="cod">${esc(d.item.codigo)}</span><br>
          ${d.actual ? esc(d.actual.nombre) : '<i>sin asignar</i>'} <span class="flecha">→</span>
          <b>${esc(d.real.nombre)}</b>
          <span class="cod">· ${d.veces} ${d.veces === 1 ? 'compra' : 'compras'}, la última el ${esc(fecha(d.ultima))}</span>
        </div>
        <button class="btn primary" data-actualizar-prov="${esc(d.item.codigo)}|${d.real.id}">Actualizar</button>
      </div>`).join('') : '<div class="vacio">Todos coinciden.</div>';

    html += `<h3 class="pv-h4">Odoo no sabe quién provee esto
      <span class="chip ${sin.length ? 'est' : 'ok'}">${sin.length}</span></h3>
      <div class="pv-nota">Al cargar una orden de compra en Odoo no aparece el proveedor sugerido ni su precio.
      Cargarlo también deja registrado el plazo de entrega del proveedor.</div>`;
    html += sin.length ? sin.slice(0, 60).map(x => `
      <div class="arreglo" data-insumo="${esc(x.item.codigo)}">
        <div class="desc"><b>${esc(x.item.nombre)}</b> <span class="cod">${esc(x.item.codigo)}</span><br>
          <span class="cod">Lo provee ${esc(x.prov.nombre)}${x.real ? ' · último precio ' + (x.real.moneda === 'ARS' ? pesos(x.real.ultimoPrecio) : 'US$ ' + num(x.real.ultimoPrecio)) : ''}</span></div>
        <button class="btn primary" data-cargar-odoo="${esc(x.item.codigo)}|${x.prov.id}">Cargar en Odoo</button>
      </div>`).join('') + (sin.length > 60 ? `<div class="pv-nota">y ${sin.length - 60} más.</div>` : '')
      : '<div class="vacio">Odoo tiene el proveedor de todo lo que se compra.</div>';

    html += `<h3 class="pv-h4">Precio desactualizado en Odoo
      <span class="chip ${pre.length ? 'est' : 'ok'}">${pre.length}</span></h3>
      <div class="pv-nota">El precio de referencia que Odoo propone al comprar quedó viejo frente a lo último que pagaste.</div>`;
    html += pre.length ? pre.map(x => `
      <div class="arreglo" data-insumo="${esc(x.s.codigo)}">
        <div class="desc"><b>${esc(x.item ? x.item.nombre : x.s.codigo)}</b> <span class="cod">${esc(x.s.codigo)}</span><br>
          <span class="cod">${esc(x.s.proveedor)} · Odoo dice ${pesos(x.s.precio)} y pagaste ${pesos(x.r.ultimoPrecio)} el ${esc(fecha(x.r.ultima))}</span></div>
        <span class="chip ${x.dif > 0 ? 'hot' : 'ok'}">${x.dif > 0 ? '+' : ''}${Math.round(x.dif * 100)}%</span>
        <button class="btn primary" data-precio="${esc(x.s.codigo)}|${x.s.odoo_partner_id}|${x.r.ultimoPrecio}">Actualizar precio</button>
      </div>`).join('') : '<div class="vacio">Los precios de Odoo están al día.</div>';

    $('#bloques-corregir').innerHTML = html;
    FICHA.enlazar('#bloques-corregir [data-insumo]');

    $$('[data-actualizar-prov]').forEach(b => b.addEventListener('click', () => {
      const [codigo, provId] = b.dataset.actualizarProv.split('|');
      aplicarCambioProveedor(codigo, Number(provId), 'Actualizado desde «Para corregir»');
    }));
    $$('[data-cargar-odoo]').forEach(b => b.addEventListener('click', () => {
      const [codigo, provId] = b.dataset.cargarOdoo.split('|');
      cargarEnOdoo(codigo, Number(provId));
    }));
    $$('[data-precio]').forEach(b => b.addEventListener('click', () => {
      const [codigo, partner, precio] = b.dataset.precio.split('|');
      actualizarPrecio(codigo, Number(partner), Number(precio));
    }));
  }

  // ---- Pestaña: archivados -----------------------------------------------
  function pintarArchivados() {
    const q = norm($('#q-arch')?.value || '');
    const filtra = l => q ? l.filter(x => norm([(x.item || x).codigo, (x.item || x).nombre].join(' ')).includes(q)) : l;
    const archT = ITEMS.filter(i => i.estado === 'descontinuado')
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    const arch = filtra(archT);
    $('#chip-arch').textContent = archT.length;
    $('#lista-archivados').innerHTML = arch.length ? arch.map(i => `
      <div class="arreglo" data-insumo="${esc(i.codigo)}">
        <div class="desc"><b>${esc(i.nombre)}</b> <span class="cod">${esc(i.codigo)}</span>
          ${i.proveedor_id ? `<br><span class="cod">${esc(provPorId(i.proveedor_id)?.nombre || '')}</span>` : ''}</div>
        <button class="btn secondary" data-reactivar="${esc(i.codigo)}">Volver a usar</button>
      </div>`).join('') : '<div class="vacio">Todavía no archivaste nada.</div>';

    const candT = candidatosArchivar();
    const cand = filtra(candT);
    const cuentaA = $('#cuenta-arch');
    if (cuentaA) cuentaA.textContent = q ? `${arch.length + cand.length} de ${archT.length + candT.length}` : '';
    $('#lista-candidatos').innerHTML = cand.length ? cand.map(c => `
      <div class="arreglo" data-insumo="${esc(c.item.codigo)}">
        <div class="desc"><b>${esc(c.item.nombre)}</b> <span class="cod">${esc(c.item.codigo)}</span><br>
          <span class="cod">Sin consumo ni compras${c.stock != null ? ' · stock ' + num(c.stock) : ''}${c.prov ? ' · ' + esc(c.prov.nombre) : ''}</span></div>
        <button class="btn secondary" data-archivar="${esc(c.item.codigo)}">Archivar</button>
      </div>`).join('') : '<div class="vacio">Todo lo vigente se está usando.</div>';

    FICHA.enlazar('#lista-archivados [data-insumo]');
    FICHA.enlazar('#lista-candidatos [data-insumo]');
    $$('[data-archivar]').forEach(b => b.addEventListener('click', () => cambiarEstadoItem(b.dataset.archivar, 'descontinuado')));
    $$('[data-reactivar]').forEach(b => b.addEventListener('click', () => cambiarEstadoItem(b.dataset.reactivar, 'vigente')));
  }

  // ---- Acciones -----------------------------------------------------------
  async function cambiarEstadoItem(codigo, estado) {
    const { error } = await sb.from('items').update({ estado, actualizado_en: new Date().toISOString() }).eq('codigo', codigo);
    if (error) return toast('No se pudo guardar: ' + error.message, 'err');
    const it = ITEMS.find(i => i.codigo === codigo);
    if (it) it.estado = estado;
    pintarTodo();
    toast(estado === 'descontinuado' ? 'Archivado. En Odoo no se tocó nada.' : 'Volvió a estar vigente');
  }

  async function aplicarCambioProveedor(codigo, nuevoProvId, motivo) {
    const it = ITEMS.find(i => i.codigo === codigo);
    if (!it) return;
    const antes = it.proveedor_id;
    const { error } = await sb.from('items')
      .update({ proveedor_id: nuevoProvId, actualizado_en: new Date().toISOString() }).eq('codigo', codigo);
    if (error) return toast('No se pudo guardar: ' + error.message, 'err');
    it.proveedor_id = nuevoProvId;

    const { data: s } = await sb.auth.getSession();
    await sb.from('prov_cambios').insert({
      codigo_item: codigo, desde_id: antes, hasta_id: nuevoProvId,
      motivo: motivo || null, quien: s?.session?.user?.email || null,
    });

    // Si el proveedor nuevo existe en Odoo, dejarlo también como proveedor del producto.
    const p = provPorId(nuevoProvId);
    let aviso = '';
    if (p?.odoo_partner_id) {
      try {
        const r = REAL[codigo];
        await fn({
          modo: 'proveedor_item', codigo_item: codigo, odoo_partner_id: p.odoo_partner_id,
          precio: r && r.moneda === 'ARS' ? r.ultimoPrecio : undefined,
          plazo_dias: p.plazo_entrega_dias ?? undefined,
        });
        await cargarSupplierinfo();
      } catch (e) { aviso = ' (en Odoo no se pudo: ' + e.message + ')'; }
    } else {
      aviso = ' · en Odoo no se tocó: ese proveedor todavía no existe allá';
    }
    pintarTodo();
    toast('Proveedor actualizado' + aviso, aviso.includes('no se pudo') ? 'err' : '');
  }

  function cambiarProveedor(codigo) {
    const it = ITEMS.find(i => i.codigo === codigo);
    if (!it) return;
    const r = REAL[codigo];
    const opciones = PROV.filter(p => p.activo !== false)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const sugerido = r ? provPorOdooNombre(r.proveedor) : null;

    abrirPanel(`Cambiar el proveedor de ${it.nombre}`, it.codigo, `
      ${r ? `<div class="pv-nota">Desde ${esc(fecha(SNAP.historia_desde))} se lo comprás a
        <b>${esc(r.proveedor)}</b> (${r.veces} ${r.veces === 1 ? 'vez' : 'veces'}, la última el ${esc(fecha(r.ultima))}).</div>` : ''}
      <div class="pv-campo">
        <label>Nuevo proveedor</label>
        <select id="cp-prov">${opciones.map(p =>
          `<option value="${p.id}" ${sugerido && p.id === sugerido.id ? 'selected' : ''}>${esc(p.nombre)}${p.odoo_partner_id ? '' : ' (no está en Odoo)'}</option>`).join('')}</select>
      </div>
      <div class="pv-campo" style="margin-top:12px">
        <label>Por qué cambiás</label>
        <input id="cp-motivo" placeholder="Ej: mejor precio, dejó de traerlo, más rápido">
        <div class="ayuda">Queda en el historial del insumo.</div>
      </div>
      <button class="btn primary" id="cp-guardar" style="margin-top:16px">Cambiar proveedor</button>
    `);
    $('#cp-guardar').addEventListener('click', async () => {
      const id = Number($('#cp-prov').value);
      await aplicarCambioProveedor(codigo, id, $('#cp-motivo').value.trim());
      cerrarFicha();
    });
  }

  async function cargarEnOdoo(codigo, provId) {
    const p = provPorId(provId);
    if (!p?.odoo_partner_id) return toast('Ese proveedor no existe en Odoo todavía', 'err');
    try {
      const r = REAL[codigo];
      const res = await fn({
        modo: 'proveedor_item', codigo_item: codigo, odoo_partner_id: p.odoo_partner_id,
        precio: r && r.moneda === 'ARS' ? r.ultimoPrecio : undefined,
        plazo_dias: p.plazo_entrega_dias ?? undefined,
      });
      await cargarSupplierinfo();
      pintarTodo();
      toast('Cargado en Odoo (' + res.accion + ')');
    } catch (e) { toast('No se pudo: ' + e.message, 'err'); }
  }

  async function actualizarPrecio(codigo, partnerId, precio) {
    try {
      await fn({ modo: 'proveedor_item', codigo_item: codigo, odoo_partner_id: partnerId, precio });
      await cargarSupplierinfo();
      pintarTodo();
      toast('Precio actualizado en Odoo');
    } catch (e) { toast('No se pudo: ' + e.message, 'err'); }
  }

  // ---- Ficha del proveedor ------------------------------------------------
  function abrirPanel(titulo, sub, html) {
    $('#d-nombre').textContent = titulo;
    $('#d-sub').textContent = sub || '';
    $('#d-cuerpo').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#velo').classList.add('open');
  }
  function cerrarFicha() {
    drawerId = null;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#velo').classList.remove('open');
  }

  function abrirFicha(id) {
    const p = provPorId(id);
    if (!p) return;
    drawerId = id;
    const r = resumenProv(p);
    const clave = p.odoo_nombre || p.nombre;
    const insumos = ITEMS.filter(i => i.proveedor_id === p.id && i.estado === 'vigente')
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    const compras = SNAP ? SNAP.compras.filter(c => c.proveedor === clave)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 12) : [];
    const codigoDe = {};
    if (SNAP) for (const pr of SNAP.productos) codigoDe[pr.id] = pr;

    abrirPanel(p.nombre, [p.cuit, p.odoo_partner_id ? 'en Odoo' : 'solo en el Core'].filter(Boolean).join(' · '), `
      ${!p.odoo_partner_id ? `<div class="pv-nota">
        Este proveedor <b>no existe en Odoo</b>. Suele pasar con los anteriores al cambio de cuenta de
        ${SNAP ? esc(fecha(SNAP.historia_desde)) : 'marzo'}: sus compras viejas no están en el historial.
        Podés dejarlo así como referencia, o crearlo en Odoo para volver a comprarle.
        <div style="margin-top:10px"><button class="btn primary" id="f-crear">Crear en Odoo</button></div>
      </div>` : ''}

      <div class="pv-form">
        <div class="pv-campo"><label>Nombre</label><input id="f-nombre" value="${esc(p.nombre)}"></div>
        <div class="pv-campo"><label>CUIT</label><input id="f-cuit" value="${esc(p.cuit || '')}" placeholder="30-12345678-9"></div>
        <div class="pv-campo"><label>Email</label><input id="f-email" type="email" value="${esc(p.email || '')}"></div>
        <div class="pv-campo"><label>Teléfono</label><input id="f-telefono" value="${esc(p.telefono || '')}"></div>
        <div class="pv-campo ancho"><label>Dirección</label><input id="f-direccion" value="${esc(p.direccion || '')}"></div>
        <div class="pv-campo"><label>Contacto</label><input id="f-contacto" value="${esc(p.contacto || '')}" placeholder="Con quién hablás">
          <div class="ayuda">Solo en el Core.</div></div>
        <div class="pv-campo"><label>Condición de pago</label>
          <select id="f-pago"><option value="">Sin definir</option>
            ${TERMINOS.map(t => `<option value="${t.id}" ${p.condicion_pago_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
          <div class="ayuda">Se escribe en Odoo y se usa al cargar la factura de compra.</div></div>
        <div class="pv-campo"><label>Plazo de entrega (días)</label>
          <input id="f-plazo" type="number" min="0" max="180" value="${p.plazo_entrega_dias ?? ''}">
          <label style="display:flex;gap:6px;align-items:center;margin-top:7px;font-weight:400;cursor:pointer">
            <input type="checkbox" id="f-plazo-conf" ${p.plazo_confirmado ? 'checked' : ''}> confirmado</label>
          <div class="ayuda">Manda el punto de pedido de Stock y reposición.</div></div>
        <div class="pv-campo"><label>Mínimo de compra</label>
          <input id="f-minimo" value="${esc(p.minimo_compra || '')}" placeholder="Ej: 5 kg, o $100.000"></div>
        <div class="pv-campo"><label>Cómo se le pide</label>
          <input id="f-como" value="${esc(p.como_pedir || '')}" placeholder="Ej: WhatsApp al vendedor, web"></div>
        <div class="pv-campo ancho"><label>Notas</label>
          <textarea id="f-notas" rows="2">${esc(p.notas || '')}</textarea></div>
        <div class="pv-campo ancho">
          <label style="display:flex;gap:8px;align-items:center;font-weight:400;cursor:pointer">
            <input type="checkbox" id="f-inactivo" ${p.activo === false ? 'checked' : ''}>
            Ya no le compro (queda en Inactivos)</label></div>
      </div>
      <button class="btn primary" id="f-guardar" style="margin-top:14px">Guardar</button>
      ${p.odoo_partner_id ? '<span style="font-size:11.5px;color:var(--muted);margin-left:10px">Los datos de arriba se escriben también en Odoo.</span>' : ''}

      <h4 class="pv-h4">Qué le comprás <span class="chip">${insumos.length}</span></h4>
      ${insumos.length ? `<table class="mini">
        <thead><tr><th>Código</th><th>Insumo</th><th style="text-align:right">Últ. precio</th><th></th></tr></thead>
        <tbody>${insumos.map(i => {
          const rr = REAL[i.codigo];
          const ajeno = rr && rr.proveedor !== clave;
          return `<tr data-insumo="${esc(i.codigo)}">
            <td class="txt cod">${esc(i.codigo)}</td>
            <td class="txt">${esc(i.nombre)}${ajeno ? `<div class="cod" style="color:var(--warn)">hoy se lo comprás a ${esc(rr.proveedor)}</div>` : ''}</td>
            <td style="text-align:right">${rr ? (rr.moneda === 'ARS' ? pesos(rr.ultimoPrecio) : 'US$ ' + num(rr.ultimoPrecio)) : '—'}</td>
            <td class="txt"><button class="btn secondary" data-cambiar2="${esc(i.codigo)}" style="padding:3px 9px;font-size:11.5px">Cambiar</button></td>
          </tr>`;
        }).join('')}</tbody></table>`
        : '<div class="vacio">Ningún insumo tiene a este proveedor asignado.</div>'}

      <h4 class="pv-h4">Últimas compras</h4>
      ${compras.length ? `<table class="mini">
        <thead><tr><th>Fecha</th><th>Insumo</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Importe</th></tr></thead>
        <tbody>${compras.map(c => `<tr>
          <td class="txt">${esc(fecha(c.fecha))}</td>
          <td class="txt" style="font-size:11.5px">${esc(codigoDe[c.producto_id]?.nombre || '')}</td>
          <td style="text-align:right">${num(c.cantidad)}</td>
          <td style="text-align:right">${c.moneda === 'ARS' ? pesos(c.subtotal) : 'US$ ' + num(c.subtotal)}</td>
        </tr>`).join('')}</tbody></table>
        <div style="font-size:11.5px;color:var(--muted);margin-top:8px">
          ${r.compras} ${r.compras === 1 ? 'compra' : 'compras'} en el período${r.comprado ? ', ' + pesos(r.comprado) : ''}.</div>`
        : '<div class="vacio">Sin compras desde que arrancó el historial.</div>'}
    `);

    $('#f-guardar').addEventListener('click', () => guardarFicha(p.id));
    const crear = $('#f-crear');
    if (crear) crear.addEventListener('click', () => crearEnOdoo(p.id));
    $$('[data-cambiar2]').forEach(b => b.addEventListener('click', () => cambiarProveedor(b.dataset.cambiar2)));
    FICHA.enlazar('#d-cuerpo tr[data-insumo]');
  }

  async function guardarFicha(id) {
    const plazo = $('#f-plazo').value.trim();
    const pago = $('#f-pago').value;
    const campos = {
      nombre: $('#f-nombre').value.trim(),
      cuit: $('#f-cuit').value.trim() || null,
      email: $('#f-email').value.trim() || null,
      telefono: $('#f-telefono').value.trim() || null,
      direccion: $('#f-direccion').value.trim() || null,
      contacto: $('#f-contacto').value.trim() || null,
      condicion_pago_id: pago ? Number(pago) : null,
      plazo_entrega_dias: plazo === '' ? null : Number(plazo),
      plazo_confirmado: $('#f-plazo-conf').checked,
      minimo_compra: $('#f-minimo').value.trim() || null,
      como_pedir: $('#f-como').value.trim() || null,
      notas: $('#f-notas').value.trim() || null,
      activo: !$('#f-inactivo').checked,
    };
    if (!campos.nombre) return toast('El nombre no puede quedar vacío', 'err');
    try {
      const r = await fn({ modo: 'guardar', proveedor_id: id, campos });
      await cargar();
      pintarTodo();
      abrirFicha(id);
      toast(r.aviso || (r.escrito_en_odoo ? 'Guardado, también en Odoo' : 'Guardado'));
    } catch (e) { toast('No se pudo guardar: ' + e.message, 'err'); }
  }

  async function crearEnOdoo(id) {
    try {
      const r = await fn({ modo: 'crear', proveedor_id: id });
      await cargar();
      pintarTodo();
      abrirFicha(id);
      toast(r.reutilizado ? 'Se vinculó con el que ya existía en Odoo' : 'Creado en Odoo');
    } catch (e) { toast('No se pudo crear: ' + e.message, 'err'); }
  }

  async function nuevoProveedor() {
    const nombre = prompt('Nombre del proveedor nuevo:');
    if (!nombre || !nombre.trim()) return;
    const { data, error } = await sb.from('proveedores').insert({ nombre: nombre.trim() }).select().single();
    if (error) return toast('No se pudo crear: ' + error.message, 'err');
    await cargar();
    pintarTodo();
    abrirFicha(data.id);
    toast('Creado en el Core. Desde la ficha lo podés crear también en Odoo.');
  }

  // ---- Pestañas -----------------------------------------------------------
  function irA(tab) {
    $$('.pv-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('main section').forEach(s => { s.hidden = s.id !== 'tab-' + tab; });
    location.hash = tab;
  }

  function marcarVista() {
    $$('.pv-vista button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.vista === VISTA)));
  }

  function pintarSelectProv() {
    const sel = $('#f-prov-ins');
    const actual = sel.value;
    sel.innerHTML = '<option value="">Todos los proveedores</option>' +
      PROV.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        .map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
    sel.value = actual;
  }

  function pintarTodo() {
    pintarKpis();
    pintarLista();
    pintarSelectProv();
    pintarInsumos();
    pintarCorregir();
    pintarArchivados();
  }

  // ---- Arranque -----------------------------------------------------------
  async function iniciar() {
    $$('.pv-tab').forEach(b => b.addEventListener('click', () => irA(b.dataset.tab)));
    $('#btn-sync').addEventListener('click', sincronizar);
    $('#btn-nuevo').addEventListener('click', nuevoProveedor);
    $('#d-cerrar').addEventListener('click', cerrarFicha);
    $('#velo').addEventListener('click', cerrarFicha);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarFicha(); });
    ['#q-prov', '#f-estado-prov'].forEach(s => {
      $(s).addEventListener('input', pintarLista); $(s).addEventListener('change', pintarLista);
    });
    $$('.pv-vista button').forEach(b => b.addEventListener('click', () => {
      VISTA = b.dataset.vista;
      try { localStorage.setItem(VISTA_KEY, VISTA); } catch { /* sin localStorage */ }
      marcarVista();
      pintarLista();
    }));
    marcarVista();
    ['#q-ins', '#f-prov-ins', '#f-coincide'].forEach(s => {
      $(s).addEventListener('input', pintarInsumos); $(s).addEventListener('change', pintarInsumos);
    });
    $('#q-corregir').addEventListener('input', pintarCorregir);
    $('#q-arch').addEventListener('input', pintarArchivados);

    // La ficha del insumo es la misma que usa Stock y reposición.
    FICHA.configurar({
      getItem: c => ITEMS.find(i => i.codigo === c) || null,
      getProveedores: () => PROV,
      getSnap: () => SNAP,
      getCfg: () => CFG,
      getCalculo: c => CALC.find(x => x.codigo === c) || null,
      getAjuste: c => AJUSTES[c] || null,
      getReal: c => REAL[c] || null,
      alGuardar: async () => { await cargar(); pintarTodo(); },
    });

    irA(['lista', 'insumos', 'corregir', 'archivados'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'lista');

    try {
      await cargar();
      pintarTodo();
      // Las condiciones de pago y lo que Odoo tiene cargado llegan después: la
      // pantalla ya es útil sin ellas y así no se queda en blanco esperando.
      // Al abrir NO se sincroniza (eso escribe): para eso está el botón.
      try { TERMINOS = (await fn({ modo: 'terminos' })).terminos || []; } catch (e) { console.warn(e); }
      await cargarSupplierinfo();
      pintarTodo();
    } catch (e) {
      console.error(e);
      toast('No se pudo cargar: ' + e.message, 'err');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
