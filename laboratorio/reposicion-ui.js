/* =========================================================================
   Rosaint · CORE — Stock y reposición (pantalla)
   Arma las cuatro pestañas sobre lo que devuelve REPO.calcular().
   La matemática vive en reposicion.js; acá solo se pinta y se guarda.
   ========================================================================= */

(() => {
  const { esc, norm, pesos, num, uni, plural, fecha, fechaHora, toast, nivel, NIVEL_TXT, textoPedido } = REPO;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const FN = window.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') + '/odoo-reposicion';
  const FN_DEM = window.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') + '/odoo-demanda';

  let CFG = null, PLAZOS = {}, AJUSTES = {}, MAESTRO = {}, DATOS = null, FILAS = [], GENERADO = null;
  let PROVEEDORES = [];
  let SKU_INSUMO = {};      // sku -> [{ insumo, cant_por_unidad }]  (vista v_sku_insumo)
  let COMPROMETIDO = {};    // codigo insumo -> cantidad reservada por pedidos de venta
  let SIN_FICHA = [];       // pedidos de productos que no se pueden explotar (SKU sin ficha)
  let orden = { campo: 'cobertura', asc: true };
  // Simulador de pedido a proveedor
  let PEDPROV = '';                  // proveedor elegido
  const PEDON = new Set();           // códigos incluidos en el pedido
  const PEDQTY = new Map();          // códigos con cantidad editada a mano

  // ---- Carga --------------------------------------------------------------
  async function cargarTablas() {
    const [cfg, prov, aj, items, cats] = await Promise.all([
      sb.from('repo_config').select('*').eq('id', 1).single(),
      sb.from('proveedores').select('*').order('nombre'),
      sb.from('repo_items').select('*'),
      sb.from('items').select('codigo,nombre,tipo,estado,proveedor_id,codigo_proveedor,unidad,categoria_id,notas')
        .in('tipo', ['MP', 'IN', 'SE', 'TE']),
      sb.from('categorias').select('id,nombre'),
    ]);
    CFG = cfg.data || { dias_seguridad: 15, ciclo_dias: 30, plazo_default: 7, peso_corto: 0.65, ventana_corta_dias: 90 };
    // Los plazos viven en la ficha del proveedor (Laboratorio → Proveedores).
    // Se indexan por el nombre de Odoo, que es con el que viene el historial de compras.
    PROVEEDORES = prov.data || [];
    PLAZOS = {};
    for (const p of prov.data || []) {
      const clave = p.odoo_nombre || p.nombre;
      PLAZOS[clave] = {
        id: p.id, nombre: clave, nombre_core: p.nombre,
        plazo_dias: p.plazo_entrega_dias, confirmado: p.plazo_confirmado,
        condicion_pago: p.condicion_pago, notas: p.notas,
      };
    }
    AJUSTES = {}; for (const a of aj.data || []) AJUSTES[a.codigo] = a;
    const catNom = {}; for (const c of cats.data || []) catNom[c.id] = c.nombre;
    MAESTRO = {};
    for (const i of items.data || []) MAESTRO[i.codigo] = { ...i, categoria: catNom[i.categoria_id] || null };

    // Explosión SKU → insumo (materia prima en kg + envase/etiqueta por unidad).
    // Puede superar el límite de 1000 de PostgREST, así que se pagina.
    SKU_INSUMO = {};
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await sb.from('v_sku_insumo')
        .select('sku,insumo_codigo,cant_por_unidad').range(desde, desde + 999);
      if (error) { console.warn('v_sku_insumo:', error.message); break; }
      for (const r of data) (SKU_INSUMO[r.sku] = SKU_INSUMO[r.sku] || []).push({ insumo: r.insumo_codigo, cant: Number(r.cant_por_unidad) });
      if (data.length < 1000) break;
    }
  }

  // Demanda comprometida: pedidos de venta CONFIRMADOS sin entregar, explotados
  // a insumo con la vista. Se descuenta de lo disponible en el cálculo.
  async function cargarDemanda() {
    try {
      const { data: s } = await sb.auth.getSession();
      const token = s?.session?.access_token || window.SUPABASE_KEY;
      const r = await fetch(FN_DEM, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ estados: ['sale', 'done'] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'sin demanda');
      const comp = {}, sinFicha = [];
      for (const d of j.demanda || []) {
        const receta = SKU_INSUMO[d.codigo];
        if (!receta) { if (/^1[0-3]\d{3}$/.test(d.codigo)) sinFicha.push(d); continue; }
        for (const it of receta) comp[it.insumo] = (comp[it.insumo] || 0) + d.pendiente * it.cant;
      }
      COMPROMETIDO = comp; SIN_FICHA = sinFicha;
    } catch (e) {
      console.warn('demanda comprometida:', e.message);
      COMPROMETIDO = {}; SIN_FICHA = [];
    }
  }

  async function cargarFoto() {
    const { data, error } = await sb.from('repo_snapshot')
      .select('generado_en,datos').order('generado_en', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) return null;
    GENERADO = data[0].generado_en;
    return data[0].datos;
  }

  async function actualizar() {
    const btn = $('#btn-actualizar');
    btn.disabled = true; btn.textContent = 'Leyendo Odoo…';
    try {
      const { data: s } = await sb.auth.getSession();
      const token = s?.session?.access_token || window.SUPABASE_KEY;
      const r = await fetch(FN, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, apikey: window.SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Odoo no respondió');
      DATOS = j.datos; GENERADO = j.generado_en;
      await cargarDemanda();
      recalcular(); pintarTodo();
      toast('Actualizado desde Odoo');
    } catch (e) {
      toast('No se pudo actualizar: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Actualizar desde Odoo';
    }
  }

  function recalcular() {
    FILAS = DATOS ? REPO.calcular({ datos: DATOS, cfg: CFG, plazos: PLAZOS, ajustes: AJUSTES, maestro: MAESTRO, comprometido: COMPROMETIDO }) : [];
  }

  // ---- Encabezado ---------------------------------------------------------
  function pintarKpis() {
    const alertas = FILAS.filter(f => f.alerta);
    const criticos = alertas.filter(f => (f.cobertura ?? 99) <= 3);
    const monto = alertas.reduce((a, b) => a + b.valorSugerido, 0);
    // Lo archivado no suma en ningún total: dejó de ser parte del laboratorio.
    const enUso = FILAS.filter(f => f.se_compra && !f.archivado);
    const stock = enUso.reduce((a, b) => a + b.valorStock, 0);
    const consumo = enUso.reduce((a, b) => a + b.diario * 30 * (b.costo || 0), 0);

    $('#k-reponer').textContent = alertas.length;
    $('#k-reponer-sub').textContent = criticos.length
      ? criticos.length + ' a punto de cortarse'
      : 'ninguna urgente';
    $('#k-monto').textContent = pesos(monto);
    $('#k-stock').textContent = pesos(stock);
    $('#k-stock-sub').textContent = enUso.length + ' materias primas y envases';
    $('#k-consumo').textContent = pesos(consumo);

    $('#n-reponer').textContent = alertas.length;
    $('#n-todas').textContent = enUso.length;

    const desde = DATOS?.historia_desde;
    $('#sync-estado').innerHTML = GENERADO
      ? 'Última lectura: <b>' + esc(fechaHora(GENERADO)) + '</b><br>Historia desde ' + esc(fecha(desde)) + '.'
      : 'Todavía no se leyó Odoo.';
  }

  // ---- Pestaña: reponer ahora --------------------------------------------
  function celdaCobertura(f) {
    const n = nivel(f);
    const txt = f.cobertura == null ? '—' : f.cobertura > 999 ? '999+' : f.cobertura;
    return `<span class="cob ${n}" title="${esc(NIVEL_TXT[n])}"><b>${txt}</b><span>días</span></span>`;
  }

  // Distintivo de "esto ya está pedido", con el detalle en el globo de ayuda.
  function chipPedido(f) {
    const t = textoPedido(f);
    return t ? ` <span class="chip ${t.clase}" title="${esc(t.largo)}">${esc(t.corto)}</span>` : '';
  }

  function filaHTML(f) {
    const chipComp = f.comprometido > 0
      ? ` <span class="chip est" title="Reservado por pedidos de venta confirmados sin entregar">−${num(f.comprometido)} ${esc(f.unidad)} en pedidos</span>`
      : '';
    return `<div class="rp-fila" data-insumo="${esc(f.codigo)}">
      <div>${celdaCobertura(f)}</div>
      <div><div class="nom">${esc(f.nombre)}${chipPedido(f)}${chipComp}</div><div class="cod">${esc(f.codigo)}${f.familia ? ' · ' + esc(f.familia) : ''}</div></div>
      <div class="dato"><span class="et">Stock</span>${num(f.stock)} ${esc(f.unidad)}${f.comprometido > 0 ? `<span class="et" style="color:var(--warn)">libre ${num(f.dispEfectivo)} ${esc(f.unidad)}</span>` : ''}</div>
      <div class="dato"><span class="et">Uso por mes</span>${num(f.mensual)} ${esc(f.unidad)}</div>
      <div class="pedirCel"><span class="et" style="display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase">Pedir</span>
        ${f.sugerido > 0
          ? `<span class="pedir">${num(f.sugerido)} ${esc(f.unidad)}</span>`
          : '<span class="chip ok">ya está pedido</span>'}</div>
      <div class="dato" style="text-align:right">${f.valorSugerido ? pesos(f.valorSugerido) : '<span class="chip">sin precio</span>'}</div>
    </div>`;
  }

  function pintarReponer() {
    const todas = FILAS.filter(f => f.alerta);
    const q = norm($('#q-reponer')?.value || '');
    const ocultarPedidos = $('#f-pedidos')?.checked;
    const conPedido = todas.filter(f => f.tienePedido).length;
    let alertas = ocultarPedidos ? todas.filter(f => !f.tienePedido) : todas;
    if (q) alertas = alertas.filter(f => norm([f.codigo, f.nombre, f.nombre_core, f.proveedor, f.familia].join(' ')).includes(q));
    const cont = $('#lista-reponer');
    const nota = $('#nota-reponer');
    const cuenta = $('#cuenta-reponer');
    const lblPed = $('#lbl-pedidos');
    if (lblPed) {
      lblPed.hidden = !conPedido;
      const n = lblPed.querySelector('span');
      if (n) n.textContent = `Ocultar los ${conPedido} que ya pedí`;
    }
    if (cuenta) cuenta.textContent = (q || ocultarPedidos)
      ? `${alertas.length} de ${todas.length}`
      : (todas.length ? `${todas.length} para reponer` : '');

    if (!todas.length) {
      nota.innerHTML = 'Ninguna materia prima está por debajo de su punto de pedido.';
      cont.innerHTML = '<div class="vacio">Nada para reponer hoy.</div>';
      return;
    }
    if (!alertas.length) {
      cont.innerHTML = '<div class="vacio">Nada coincide con la búsqueda.</div>';
      return;
    }

    const conProv = alertas.filter(f => f.proveedor);
    const sinProv = alertas.filter(f => !f.proveedor);
    const avisoSinFicha = SIN_FICHA.length
      ? `<br><b style="color:var(--hot)">Ojo:</b> ${SIN_FICHA.length} producto${SIN_FICHA.length === 1 ? '' : 's'} con pedidos no ${SIN_FICHA.length === 1 ? 'tiene' : 'tienen'} ficha en el Core y no se ${SIN_FICHA.length === 1 ? 'pudo' : 'pudieron'} explotar (${SIN_FICHA.slice(0, 4).map(d => esc(d.codigo)).join(', ')}${SIN_FICHA.length > 4 ? '…' : ''}). Cargalos en Presentaciones para que cuenten su consumo.`
      : '';
    nota.innerHTML = `Agrupado por proveedor para que salga <b>un pedido por proveedor</b> en vez de
      una compra suelta por cada faltante. La cantidad ya viene redondeada al lote con el que
      solés comprar cada cosa, y cubre ${CFG.dias_seguridad + CFG.ciclo_dias} días más el plazo de entrega.
      Ya descuenta lo <b>comprometido en pedidos de venta confirmados</b>.${avisoSinFicha}`;

    const grupos = new Map();
    for (const f of conProv) {
      if (!grupos.has(f.proveedor)) grupos.set(f.proveedor, []);
      grupos.get(f.proveedor).push(f);
    }
    const ordenados = [...grupos.entries()].sort((a, b) =>
      Math.min(...a[1].map(x => x.cobertura ?? 999)) - Math.min(...b[1].map(x => x.cobertura ?? 999)));

    let html = '';
    for (const [prov, items] of ordenados) {
      items.sort((a, b) => (a.cobertura ?? 999) - (b.cobertura ?? 999));
      const total = items.reduce((a, b) => a + b.valorSugerido, 0);
      const p = PLAZOS[prov];
      const plazo = p ? p.plazo_dias : CFG.plazo_default;
      const est = !(p && p.confirmado);
      html += `<article class="rp-prov">
        <header>
          <div>
            <h3>${esc(prov)}</h3>
            <div class="meta">Entrega en ${plazo} día${plazo === 1 ? '' : 's'}${est ? ' <span class="chip est">estimado</span>' : ' <span class="chip ok">confirmado</span>'}
              · ${items.length} ${items.length === 1 ? 'insumo' : 'insumos'}</div>
          </div>
          <div class="total">${pesos(total)}</div>
          <button class="btn secondary" data-copiar="${esc(prov)}">Copiar pedido</button>
        </header>
        ${items.map(filaHTML).join('')}
      </article>`;
    }

    if (sinProv.length) {
      html += `<article class="rp-prov huerfano">
        <header><div><h3>Sin proveedor registrado</h3>
          <div class="meta">Se usan en producción pero nunca se compraron desde que existe el historial:
            están viviendo de stock viejo. Hay que decidir a quién comprarlas antes de que se terminen.</div></div></header>
        ${sinProv.map(filaHTML).join('')}
      </article>`;
    }
    cont.innerHTML = html;

    $$('[data-copiar]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      copiarPedido(b.dataset.copiar, grupos.get(b.dataset.copiar) || []);
    }));
    FICHA.enlazar('#lista-reponer .rp-fila');
  }

  function copiarPedido(prov, items) {
    const lineas = items.filter(f => f.sugerido > 0).map(f => `• ${f.nombre} — ${num(f.sugerido)} ${f.unidad}`);
    if (!lineas.length) return toast('Todo lo de este proveedor ya está pedido', 'err');
    const txt = `Pedido para ${prov}\n\n${lineas.join('\n')}\n\n(Rosaint · ${new Date().toLocaleDateString('es-AR')})`;
    navigator.clipboard.writeText(txt)
      .then(() => toast('Pedido copiado — pegalo en el mail o WhatsApp'))
      .catch(() => toast('No se pudo copiar', 'err'));
  }

  // ---- Pestaña: todas -----------------------------------------------------
  function barritas(f) {
    const meses = Object.keys(f.meses || {}).sort().slice(-7);
    if (!meses.length) return '<span class="chip">sin uso</span>';
    const max = Math.max(...meses.map(m => f.meses[m]));
    return '<div class="barras" title="Consumo de los últimos meses">' + meses.map((m, i) =>
      `<i style="height:${max ? Math.max(8, (f.meses[m] / max) * 100) : 8}%" class="${i === meses.length - 1 ? 'ult' : ''}" title="${m}: ${num(f.meses[m])} ${esc(f.unidad)}"></i>`
    ).join('') + '</div>';
  }

  function filtradas() {
    const q = norm($('#q').value);
    const fn = $('#f-nivel').value, ft = $('#f-tipo').value, fp = $('#f-prov').value;
    let out = FILAS.filter(f => ft === 'todo' ? true : f.se_compra);
    // Lo archivado solo se ve si se lo pide expresamente.
    if (fn !== 'archivado') out = out.filter(f => !f.archivado);
    if (fn) out = out.filter(f => nivel(f) === fn);
    if (fp) out = out.filter(f => f.proveedor === fp);
    if (q) out = out.filter(f => norm(f.codigo + ' ' + f.nombre + ' ' + (f.nombre_core || '') + ' ' + (f.proveedor || '') + ' ' + (f.familia || '')).includes(q));
    const { campo, asc } = orden;
    out.sort((a, b) => {
      let x = a[campo], y = b[campo];
      if (x == null) x = asc ? Infinity : -Infinity;
      if (y == null) y = asc ? Infinity : -Infinity;
      const r = typeof x === 'string' ? String(x).localeCompare(String(y), 'es') : x - y;
      return asc ? r : -r;
    });
    return out;
  }

  function pintarTabla() {
    const filas = filtradas();
    $('#tbody').innerHTML = filas.length ? filas.map(f => {
      const n = nivel(f);
      return `<tr data-insumo="${esc(f.codigo)}">
        <td><span class="punto ${n}" title="${esc(NIVEL_TXT[n])}"></span></td>
        <td class="cod">${esc(f.codigo)}</td>
        <td><b>${esc(f.nombre)}</b>${f.familia ? `<div class="cod">${esc(f.familia)}</div>` : ''}</td>
        <td class="num">${num(f.stock)} <span style="color:var(--muted);font-size:11px">${esc(f.unidad)}</span></td>
        <td class="num">${f.diario > 0 ? num(f.mensual) : '—'}</td>
        <td class="num">${f.cobertura == null ? '—' : (f.cobertura > 999 ? '+999' : f.cobertura + ' d')}</td>
        <td>${chipPedido(f).trim() || ''}</td>
        <td style="width:90px">${barritas(f)}</td>
        <td>${f.proveedor ? esc(f.proveedor) : '<span class="chip">sin compras</span>'}</td>
        <td class="num">${f.ultimaCompra ? esc(fecha(f.ultimaCompra)) : '—'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="10"><div class="vacio">Nada coincide con el filtro.</div></td></tr>';
    FICHA.enlazar('#tbody tr[data-insumo]');
  }

  // ---- Pestaña: comprar mejor --------------------------------------------
  function pintarComprar() {
    const todas = REPO.oportunidades(FILAS.filter(f => f.se_compra && !f.archivado));
    const q = norm($('#q-comprar')?.value || '');
    const op = q ? todas.filter(f => norm([f.codigo, f.nombre, f.proveedor].join(' ')).includes(q)) : todas;
    const total = todas.reduce((a, b) => a + b.sobreprecio, 0);
    const meses = DATOS?.historia_desde
      ? Math.max(1, (new Date() - new Date(DATOS.historia_desde)) / (30.4 * 86400000)) : 6;

    $('#n-comprar').textContent = todas.length;
    $('#nota-comprar').innerHTML = todas.length
      ? `Comparando cada compra contra otra del <b>mismo insumo, dentro de ±45 días</b> (para no
         confundirlo con la inflación) en la que se pidió <b>más cantidad a menor precio por unidad</b>.
         En el período se pagaron <b>${pesos(total)}</b> de más por comprar de a poco:
         unos <b>${pesos(total / meses * 12)}</b> al año si sigue el mismo ritmo. No es un problema de
         precio, es la consecuencia de comprar apurado cuando ya no queda.`
      : 'No se detectaron compras chicas más caras que una compra grande cercana.';

    $('#lista-oport').innerHTML = op.length ? op.map(f => `
      <article class="rp-prov" data-insumo="${esc(f.codigo)}">
        <header>
          <div><h3>${esc(f.nombre)}</h3>
            <div class="meta">${esc(f.codigo)} · ${esc(f.proveedor || 'varios proveedores')} · ${f.casos} ${plural(f.casos, 'compra chica', 'compras chicas')}</div></div>
          <div class="total" style="color:var(--hot)">${pesos(f.sobreprecio)}</div>
        </header>
        <div class="rp-fila" style="grid-template-columns:1fr 1fr 1fr">
          <div class="dato"><span class="et">Comprando de a</span>${num(f.mejorLote)} ${esc(f.unidad)} → ${pesos(f.mejorPrecio)} por ${esc(uni(f.unidad))}</div>
          <div class="dato"><span class="et">Comprando de a</span>${num(f.peorLote)} ${esc(f.unidad)} → ${pesos(f.peorPrecio)} por ${esc(uni(f.unidad))}</div>
          <div class="dato"><span class="et">Diferencia</span><b style="color:var(--hot)">${f.brecha != null ? '+' + Math.round(f.brecha * 100) + '%' : '—'}</b></div>
        </div>
      </article>`).join('') : `<div class="vacio">${q ? 'Nada coincide con la búsqueda.' : 'Nada para señalar.'}</div>`;
    FICHA.enlazar('#lista-oport article[data-insumo]');

    // Órdenes colgadas
    let colg = [];
    for (const f of FILAS) { if (f.archivado) continue; for (const c of (f.colgadas || [])) colg.push({ ...c, insumo: f }); }
    const totalColg = colg.length;
    if (q) colg = colg.filter(c => norm([c.oc, c.proveedor, c.insumo.codigo, c.insumo.nombre].join(' ')).includes(q));
    const cuentaC = $('#cuenta-comprar');
    if (cuentaC) cuentaC.textContent = q
      ? `${op.length} de ${todas.length} · ${colg.length} de ${totalColg} órdenes`
      : (todas.length || totalColg ? `${todas.length} para mejorar · ${totalColg} ${plural(totalColg, 'orden colgada', 'órdenes colgadas')}` : '');
    colg.sort((a, b) => (a.tipo === b.tipo ? String(b.fecha).localeCompare(String(a.fecha)) : a.tipo === 'nunca_llego' ? -1 : 1));
    $('#lista-colgadas').innerHTML = colg.length ? `
      <div class="table-wrap"><div class="table-scroll"><table class="rp-tabla">
        <thead><tr><th class="na">Orden</th><th class="na">Fecha</th><th class="na">Proveedor</th>
          <th class="na">Materia prima</th><th class="na num">Pedido</th><th class="na num">Recibido</th><th class="na">Qué pasó</th></tr></thead>
        <tbody>${colg.map(c => `<tr data-insumo="${esc(c.insumo.codigo)}">
          <td class="cod">${esc(c.oc)}</td><td>${esc(fecha(c.fecha))}</td><td>${esc(c.proveedor)}</td>
          <td>${esc(c.insumo.nombre)}</td>
          <td class="num">${num(c.cantidad)} ${esc(c.insumo.unidad)}</td>
          <td class="num">${num(c.recibida)}</td>
          <td>${c.tipo === 'nunca_llego'
            ? '<span class="chip est">no llegó nada</span>'
            : '<span class="chip">llegó corta</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>` : `<div class="vacio">${q ? 'Ninguna orden coincide con la búsqueda.' : 'Ninguna orden quedó colgada.'}</div>`;
    FICHA.enlazar('#lista-colgadas tr[data-insumo]');
  }

  // ---- Pestaña: armar pedido ---------------------------------------------
  const precioUnit = f => (f.moneda === 'ARS' && f.ultimoPrecio > 0) ? f.ultimoPrecio : (f.costo || 0);
  const precioEst = f => !(f.moneda === 'ARS' && f.ultimoPrecio > 0);
  const coberturaTxt = f => f.cobertura == null ? 'sin ritmo' : (f.cobertura > 999 ? 'alcanza 999+ d' : 'alcanza ' + f.cobertura + ' d');
  // Cantidad por defecto: lo sugerido si hay que reponer; si no, el lote habitual.
  function pedDefaultQty(f) {
    if (f.sugerido > 0) return f.sugerido;
    return f.lote || Math.max(1, Math.round(f.mensual || 0));
  }
  const pedQty = f => PEDQTY.has(f.codigo) ? PEDQTY.get(f.codigo) : pedDefaultQty(f);

  // Ítems del proveedor elegido, separados en "hay que reponer" y "conviene sumar".
  function pedItems(prov) {
    const items = FILAS.filter(f => f.se_compra && !f.archivado && !f.excluido && f.proveedor === prov);
    const reponer = items.filter(f => f.sugerido > 0).sort((a, b) => (a.cobertura ?? 999) - (b.cobertura ?? 999));
    // "Se viene": todavía no urgente pero caería antes del próximo ciclo de compra.
    const horizonte = f => (f.diasObjetivo || 0) + (CFG.ciclo_dias || 30);
    const sumar = items.filter(f => f.sugerido <= 0 && f.cobertura != null && f.cobertura <= horizonte(f))
      .sort((a, b) => a.cobertura - b.cobertura);
    return { items, reponer, sumar };
  }

  function seleccionarProv(prov) {
    PEDPROV = prov; PEDON.clear(); PEDQTY.clear();
    for (const f of pedItems(prov).reponer) PEDON.add(f.codigo); // lo urgente entra por defecto
    pintarPedido();
  }

  function pedLineHTML(f) {
    const q = pedQty(f), pu = precioUnit(f), tot = q * pu;
    return `<div class="rp-fila" style="grid-template-columns:34px minmax(160px,1fr) 118px 130px 120px" data-cod="${esc(f.codigo)}">
      <div><input type="checkbox" class="ped-inc" data-cod="${esc(f.codigo)}" ${PEDON.has(f.codigo) ? 'checked' : ''}></div>
      <div><div class="nom">${esc(f.nombre)}</div><div class="cod">${esc(f.codigo)} · ${coberturaTxt(f)}${f.comprometido > 0 ? ` · <span style="color:var(--warn)">−${num(f.comprometido)} en pedidos</span>` : ''}</div></div>
      <div class="dato"><input type="number" class="input ped-qty" data-cod="${esc(f.codigo)}" value="${q}" min="0" step="any" style="width:78px;text-align:right"> <span style="font-size:11px;color:var(--muted)">${esc(f.unidad)}</span></div>
      <div class="dato" style="text-align:right">${pu ? pesos(pu) : '—'}<span class="et">${precioEst(f) ? 'estimado' : 'últ. precio'} · x ${esc(uni(f.unidad))}</span></div>
      <div class="dato" style="text-align:right"><b>${pu ? pesos(tot) : '<span class="chip">sin precio</span>'}</b></div>
    </div>`;
  }

  function pedTotal(items) {
    let total = 0, n = 0;
    for (const f of items) if (PEDON.has(f.codigo)) { const q = pedQty(f); total += q * precioUnit(f); if (q > 0) n++; }
    return { total, n };
  }

  function pintarPedidoSelect() {
    const sel = $('#ped-prov'); if (!sel) return;
    const provs = [...new Set(FILAS.filter(f => f.se_compra && !f.archivado && f.proveedor).map(f => f.proveedor))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    sel.innerHTML = '<option value="">Elegí un proveedor…</option>' +
      provs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    sel.value = PEDPROV || '';
  }

  function pintarPedido() {
    pintarPedidoSelect();
    const cont = $('#ped-cont'); if (!cont) return;
    if (!PEDPROV) { cont.innerHTML = '<div class="vacio">Elegí un proveedor para armar el pedido.</div>'; return; }
    const { items, reponer, sumar } = pedItems(PEDPROV);
    const { total, n } = pedTotal(items);
    const p = PLAZOS[PEDPROV];
    const plazo = p ? p.plazo_dias : CFG.plazo_default;

    let html = `<article class="rp-prov"><header>
        <div><h3>${esc(PEDPROV)}</h3>
          <div class="meta">Entrega ${plazo} día${plazo === 1 ? '' : 's'}${p?.condicion_pago ? ' · paga a ' + esc(p.condicion_pago) : ''}</div></div>
        <div class="total">${pesos(total)}</div>
        <div class="meta">${n} ítem${n === 1 ? '' : 's'}</div>
      </header>`;
    html += `<div class="rp-nota" style="margin:0;border:none;border-radius:0"><b>Hay que reponer</b> · ya descuenta lo comprometido en pedidos</div>`;
    html += reponer.length ? reponer.map(pedLineHTML).join('') : '<div class="vacio">Nada urgente de este proveedor.</div>';
    if (sumar.length) {
      html += `<div class="rp-nota" style="margin:8px 0 0;border:none;border-radius:0"><b>Conviene sumar</b> · está por caer y ya aprovechás el envío</div>`;
      html += sumar.map(pedLineHTML).join('');
    }
    html += `<div class="rp-fila" style="grid-template-columns:1fr auto auto;gap:10px;background:var(--surface-2)">
        <div class="dato"><b>Total del pedido: ${pesos(total)}</b></div>
        <button class="btn secondary" id="ped-copiar">Copiar pedido</button>
        <button class="btn primary" id="ped-odoo" disabled title="Etapa 3: crea el borrador de compra en Odoo (próximamente)">Crear borrador en Odoo</button>
      </div></article>`;
    cont.innerHTML = html;

    $$('#ped-cont .ped-inc').forEach(c => c.addEventListener('change', () => {
      c.checked ? PEDON.add(c.dataset.cod) : PEDON.delete(c.dataset.cod);
      pintarPedido();
    }));
    $$('#ped-cont .ped-qty').forEach(i => i.addEventListener('change', () => {
      const v = Number(i.value);
      PEDQTY.set(i.dataset.cod, isNaN(v) || v < 0 ? 0 : v);
      if (v > 0) PEDON.add(i.dataset.cod);
      pintarPedido();
    }));
    const bc = $('#ped-copiar'); if (bc) bc.addEventListener('click', () => copiarPedidoProv(items));
  }

  function completarHastaMonto() {
    if (!PEDPROV) return toast('Elegí un proveedor primero', 'err');
    const monto = Number($('#ped-monto').value) || 0;
    if (!monto) return toast('Poné un presupuesto', 'err');
    const { reponer, sumar } = pedItems(PEDPROV);
    PEDON.clear();
    let total = 0;
    for (const f of reponer) { PEDON.add(f.codigo); total += pedQty(f) * precioUnit(f); }
    if (total > monto) { toast('Solo lo necesario ya supera el monto'); return pintarPedido(); }
    for (const f of sumar) {
      const line = pedQty(f) * precioUnit(f);
      if (line <= 0) continue;
      if (total + line <= monto) { PEDON.add(f.codigo); total += line; }
    }
    pintarPedido();
    toast('Completado hasta ' + pesos(monto));
  }

  function copiarPedidoProv(items) {
    const lineas = items.filter(f => PEDON.has(f.codigo) && pedQty(f) > 0)
      .map(f => `• ${f.nombre} — ${num(pedQty(f))} ${f.unidad}`);
    if (!lineas.length) return toast('No hay nada seleccionado', 'err');
    const { total } = pedTotal(items);
    const txt = `Pedido para ${PEDPROV}\n\n${lineas.join('\n')}\n\nTotal aprox: ${pesos(total)}\n(Rosaint · ${new Date().toLocaleDateString('es-AR')})`;
    navigator.clipboard.writeText(txt)
      .then(() => toast('Pedido copiado — pegalo en el mail o WhatsApp'))
      .catch(() => toast('No se pudo copiar', 'err'));
  }

  // ---- Pestaña: ajustes ---------------------------------------------------
  function pintarAjustes() {
    $('#c-seg').value = CFG.dias_seguridad;
    $('#c-ciclo').value = CFG.ciclo_dias;
    $('#c-plazo').value = CFG.plazo_default;
    $('#c-peso').value = CFG.peso_corto;
    $('#lbl-ventana').textContent = CFG.ventana_corta_dias;

    // Cuántas materias primas depende de cada proveedor: ordena la tabla por peso real.
    const cuenta = {};
    for (const f of FILAS) if (f.proveedor) cuenta[f.proveedor] = (cuenta[f.proveedor] || 0) + 1;
    const provs = Object.values(PLAZOS).sort((a, b) => (cuenta[b.nombre] || 0) - (cuenta[a.nombre] || 0) || a.nombre.localeCompare(b.nombre, 'es'));

    // Solo los que hoy proveen algo: la lista completa vive en Proveedores.
    const conInsumos = provs.filter(p => cuenta[p.nombre]);
    $('#tabla-plazos tbody').innerHTML = conInsumos.map(p => `
      <tr>
        <td class="txt"><b>${esc(p.nombre)}</b>
          <div style="font-size:11px;color:var(--muted)">${cuenta[p.nombre]} ${cuenta[p.nombre] === 1 ? 'insumo' : 'insumos'}${p.condicion_pago ? ' · paga a ' + esc(p.condicion_pago) : ''}</div></td>
        <td style="width:120px" class="txt">
          <input class="plazo-in" type="number" min="0" max="180" value="${p.plazo_dias ?? ''}"
            placeholder="${CFG.plazo_default}" data-plazo="${esc(p.nombre)}"> días</td>
        <td style="width:130px" class="txt">
          <label style="font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer">
            <input type="checkbox" data-conf="${esc(p.nombre)}" ${p.confirmado ? 'checked' : ''}> confirmado</label></td>
      </tr>`).join('')
      || '<tr><td><div class="vacio">Todavía no hay proveedores con insumos.</div></td></tr>';

    $$('[data-plazo]').forEach(i => i.addEventListener('change', () => guardarPlazo(i.dataset.plazo, { plazo_dias: Number(i.value) })));
    $$('[data-conf]').forEach(i => i.addEventListener('change', () => guardarPlazo(i.dataset.conf, { confirmado: i.checked })));

    const ex = FILAS.filter(f => f.excluido);
    $('#lista-excluidas').innerHTML = ex.length ? ex.map(f => `
      <div class="rp-fila" style="grid-template-columns:1fr auto; border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:8px">
        <div><div class="nom">${esc(f.nombre)}</div>
          <div class="cod">${esc(f.codigo)}${f.motivo_excluido ? ' · ' + esc(f.motivo_excluido) : ''}</div></div>
        <button class="btn secondary" data-incluir="${esc(f.codigo)}">Volver a vigilar</button>
      </div>`).join('')
      : '<div class="vacio">Ninguna está excluida. Se excluyen desde la ficha de cada materia prima.</div>';
    $$('[data-incluir]').forEach(b => b.addEventListener('click', () => guardarAjuste(b.dataset.incluir, { excluido: false, motivo_excluido: null })));
  }

  async function guardarPlazo(nombre, cambios) {
    const p = PLAZOS[nombre];
    if (!p?.id) return toast('Ese proveedor no está en la ficha de proveedores', 'err');
    const aTabla = {};
    if ('plazo_dias' in cambios) aTabla.plazo_entrega_dias = cambios.plazo_dias;
    if ('confirmado' in cambios) aTabla.plazo_confirmado = cambios.confirmado;
    const { error } = await sb.from('proveedores')
      .update({ ...aTabla, actualizado_en: new Date().toISOString() }).eq('id', p.id);
    if (error) return toast('No se pudo guardar: ' + error.message, 'err');
    PLAZOS[nombre] = { ...p, ...cambios };
    recalcular(); pintarTodo();
    toast('Plazo actualizado');
  }

  async function guardarAjuste(codigo, cambios) {
    const fila = { codigo, ...AJUSTES[codigo], ...cambios, actualizado_en: new Date().toISOString() };
    const { error } = await sb.from('repo_items').upsert(fila, { onConflict: 'codigo' });
    if (error) return toast('No se pudo guardar: ' + error.message, 'err');
    AJUSTES[codigo] = fila;
    recalcular(); pintarTodo();
    toast('Guardado');
  }

  async function guardarConfig() {
    const cambios = {
      dias_seguridad: Number($('#c-seg').value),
      ciclo_dias: Number($('#c-ciclo').value),
      plazo_default: Number($('#c-plazo').value),
      peso_corto: Number($('#c-peso').value),
      actualizado_en: new Date().toISOString(),
    };
    const { error } = await sb.from('repo_config').update(cambios).eq('id', 1);
    if (error) return toast('No se pudo guardar: ' + error.message, 'err');
    CFG = { ...CFG, ...cambios };
    recalcular(); pintarTodo();
    toast('Parámetros guardados');
  }

  // ---- Pestañas -----------------------------------------------------------
  function irA(tab) {
    $$('.rp-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('main section').forEach(s => { s.hidden = s.id !== 'tab-' + tab; });
    location.hash = tab;
  }

  function pintarTodo() {
    pintarKpis();
    pintarReponer();
    pintarPedido();
    pintarSelectProv();
    pintarTabla();
    pintarComprar();
    pintarAjustes();
  }

  function pintarSelectProv() {
    const sel = $('#f-prov');
    const actual = sel.value;
    const provs = [...new Set(FILAS.filter(f => f.proveedor).map(f => f.proveedor))].sort((a, b) => a.localeCompare(b, 'es'));
    sel.innerHTML = '<option value="">Todos los proveedores</option>' +
      provs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    sel.value = actual;
  }

  // ---- Arranque -----------------------------------------------------------
  async function iniciar() {
    $$('.rp-tab').forEach(b => b.addEventListener('click', () => irA(b.dataset.tab)));
    $('#btn-actualizar').addEventListener('click', actualizar);
    $('#btn-guardar-cfg').addEventListener('click', guardarConfig);
    ['#q', '#f-nivel', '#f-tipo', '#f-prov'].forEach(s => {
      $(s).addEventListener('input', pintarTabla);
      $(s).addEventListener('change', pintarTabla);
    });
    $('#q-reponer').addEventListener('input', pintarReponer);
    $('#f-pedidos').addEventListener('change', pintarReponer);
    $('#q-comprar').addEventListener('input', pintarComprar);
    $('#ped-prov').addEventListener('change', e => seleccionarProv(e.target.value));
    $('#ped-completar').addEventListener('click', completarHastaMonto);

    // La ficha del insumo es la misma que usa Proveedores: se abre desde
    // cualquier lista donde aparezca una materia prima.
    FICHA.configurar({
      getItem: c => MAESTRO[c] || null,
      getProveedores: () => PROVEEDORES,
      getSnap: () => DATOS,
      getCfg: () => CFG,
      getCalculo: c => FILAS.find(f => f.codigo === c) || null,
      getAjuste: c => AJUSTES[c] || null,
      getReal: c => FILAS.find(f => f.codigo === c) || null,
      alGuardar: async () => { await cargarTablas(); recalcular(); pintarTodo(); },
    });
    $$('#tabla th[data-orden]').forEach(th => th.addEventListener('click', () => {
      const c = th.dataset.orden;
      orden = { campo: c, asc: orden.campo === c ? !orden.asc : true };
      pintarTabla();
    }));

    irA(['reponer', 'pedido', 'todas', 'comprar', 'ajustes'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'reponer');

    try {
      await cargarTablas();
      DATOS = await cargarFoto();
      if (!DATOS) {
        $('#sync-estado').textContent = 'Todavía no se leyó Odoo. Tocá «Actualizar».';
        await actualizar();
        return;
      }
      await cargarDemanda();
      recalcular();
      pintarTodo();
    } catch (e) {
      console.error(e);
      toast('No se pudo cargar: ' + e.message, 'err');
    }
  }

  // shell.js valida la sesión y arma la barra; recién después tiene sentido pintar.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
