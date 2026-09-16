/* =========================================================================
   Rosaint · CORE — Stock y reposición
   Calcula el ritmo de uso de cada materia prima a partir del consumo real de
   las órdenes de fabricación, y de ahí el punto de pedido y cuánto conviene
   comprar. La foto de Odoo la trae la edge function `odoo-reposicion`; acá
   está toda la matemática, para que se pueda leer y discutir.
   ========================================================================= */

const REPO = (() => {

  // ---- Utilidades ---------------------------------------------------------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const pesos = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
  const num = (n, d = 2) => {
    const v = Number(n) || 0;
    // Las materias primas van de 0,05 kg a 5.000 kg: sin decimales no se ve nada,
    // con tres decimales en un balde tampoco. Se ajusta a la magnitud.
    const dec = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : d;
    return v.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: dec });
  };
  // Para leyendas del tipo "$6.120 por kg" / "por unidad": la unidad de Odoo
  // viene en plural ("Unidades") y ahí queda mal.
  const SINGULAR = { 'Unidades': 'unidad', 'unidades': 'unidad', 'Litros': 'litro', 'Metros': 'metro', 'Docenas': 'docena' };
  const uni = u => SINGULAR[String(u ?? '').trim()] || String(u ?? '');
  const plural = (n, sing, plur) => (Math.abs(n) === 1 ? sing : plur);

  const fecha = s => s ? new Date(s + (String(s).length === 10 ? 'T12:00:00' : '')).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) : '—';
  const fechaHora = s => s ? new Date(s).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const hoy = () => new Date();
  const dias = (a, b) => Math.round((b - a) / 86400000);
  const mediana = arr => {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };

  function toast(msg, tipo = '') {
    let t = document.getElementById('repo-toast');
    if (!t) { t = document.createElement('div'); t.id = 'repo-toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show ' + tipo;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast ' + tipo; }, tipo === 'err' ? 5000 : 2600);
  }

  // ---- Meses: el consumo viene por mes, el cálculo necesita días ----------
  // Cada mes del historial aporta solo los días que realmente cubre: marzo
  // arranca el 10 (día que se cargó Odoo) y el mes corriente termina hoy.
  const mesInicio = m => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1);
  const mesFin = m => new Date(+m.slice(0, 4), +m.slice(5, 7), 0, 23, 59, 59);
  function diasCubiertos(mes, desde, hasta) {
    const a = new Date(Math.max(mesInicio(mes), desde));
    const b = new Date(Math.min(mesFin(mes), hasta));
    return b <= a ? 0 : Math.max(1, Math.round((b - a) / 86400000));
  }

  /* Uso diario de una materia prima.
     Se mezclan dos miradas: la ventana corta (por defecto 90 días), que capta
     el ritmo de hoy, y toda la historia, que amortigua un mes raro. Si en la
     ventana corta no se usó nada, manda la historia sola. */
  function usoDiario(meses, cfg, desde, hasta) {
    const claves = Object.keys(meses || {}).sort();
    if (!claves.length) return { diario: 0, largo: 0, corto: 0 };
    const corteCorto = new Date(hasta.getTime() - (cfg.ventana_corta_dias || 90) * 86400000);

    let qL = 0, dL = 0, qC = 0, dC = 0;
    for (const m of claves) {
      const q = Number(meses[m]) || 0;
      const d = diasCubiertos(m, desde, hasta);
      if (!d) continue;
      qL += q; dL += d;
      const dc = diasCubiertos(m, new Date(Math.max(corteCorto, desde)), hasta);
      if (dc) { qC += q * (dc / d); dC += dc; }
    }
    const largo = dL ? qL / dL : 0;
    const corto = dC ? qC / dC : 0;
    const peso = cfg.peso_corto ?? 0.65;
    return { diario: corto > 0 ? peso * corto + (1 - peso) * largo : largo, largo, corto };
  }

  /* ---- El cálculo completo -------------------------------------------------
     Junta la foto de Odoo con los ajustes guardados y devuelve una fila por
     materia prima, lista para pintar. */
  function calcular({ datos, cfg, plazos, ajustes, maestro }) {
    const desde = new Date((datos.historia_desde || '2026-01-01') + 'T00:00:00');
    const hasta = hoy();

    // Compras agrupadas por producto
    const porProducto = new Map();
    for (const c of datos.compras || []) {
      if (c.producto_id == null) continue;
      if (!porProducto.has(c.producto_id)) porProducto.set(c.producto_id, []);
      porProducto.get(c.producto_id).push(c);
    }

    const filas = [];
    for (const p of datos.productos || []) {
      const aj = ajustes[p.codigo] || {};
      const meses = datos.consumo[p.id] || {};
      const { diario, largo, corto } = usoDiario(meses, cfg, desde, hasta);
      const compras = (porProducto.get(p.id) || []).slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

      // Proveedor: el que más veces vendió; si empatan, el más reciente.
      const veces = {};
      for (const c of compras) veces[c.proveedor] = (veces[c.proveedor] || 0) + 1;
      const ultimo = compras.length ? compras[compras.length - 1] : null;
      let proveedor = aj.proveedor_pref || null;
      if (!proveedor) {
        const ranking = Object.entries(veces).sort((a, b) => b[1] - a[1] || (a[0] === ultimo?.proveedor ? -1 : 1));
        proveedor = ranking.length ? ranking[0][0] : null;
      }
      const plazo = (proveedor && plazos[proveedor]?.plazo_dias != null)
        ? plazos[proveedor].plazo_dias : cfg.plazo_default;
      const plazoEstimado = !(proveedor && plazos[proveedor]?.confirmado && plazos[proveedor]?.plazo_dias != null);

      // Lote habitual de compra: la mediana de lo que se pidió.
      const lote = aj.lote_compra != null ? Number(aj.lote_compra) : mediana(compras.map(c => c.cantidad));

      // Lo que viene en camino lo dice Odoo: `previsto` ya suma las recepciones
      // pendientes y resta lo reservado. Es mas confiable que mirar los renglones
      // de compra, porque los liquidos se reciben con merma (piden 10 kg, entran
      // 9,53) y esos renglones quedan "parciales" para siempre sin que falte nada.
      const enCamino = Math.max(0, p.previsto - p.stock);

      // Ordenes que quedaron colgadas: pedidas hace mas de 21 dias y nunca
      // llegaron, o llegaron muy cortas. Se avisan aparte, NO cuentan como stock.
      const corte = new Date(hasta.getTime() - 21 * 86400000);
      const colgadas = [];
      for (const c of compras) {
        if (!c.fecha || new Date(c.fecha + 'T12:00:00') > corte) continue;
        if (c.recibida <= 0 && c.cantidad > 0) colgadas.push({ ...c, tipo: 'nunca_llego' });
        else if (c.recibida < c.cantidad * 0.9) colgadas.push({ ...c, tipo: 'corta' });
      }

      const disponible = p.stock + enCamino;
      const puntoPedido = diario * (plazo + cfg.dias_seguridad);
      const diasObjetivo = aj.dias_objetivo != null ? Number(aj.dias_objetivo) : plazo + cfg.dias_seguridad + cfg.ciclo_dias;
      const objetivo = diario * diasObjetivo;
      let sugerido = Math.max(0, objetivo - disponible);
      if (lote && sugerido > 0) sugerido = Math.ceil(sugerido / lote) * lote;

      // Intervalo entre compras: cuánto tarda hoy en volver a comprarse.
      const inter = [];
      for (let i = 1; i < compras.length; i++) {
        inter.push(dias(new Date(compras[i - 1].fecha + 'T12:00:00'), new Date(compras[i].fecha + 'T12:00:00')));
      }

      const m = maestro[p.codigo] || {};
      filas.push({
        ...p,
        familia: m.categoria || null,
        nombre_core: m.nombre || null,
        meses, diario, usoLargo: largo, usoCorto: corto,
        mensual: diario * 30,
        excluido: !!aj.excluido, motivo_excluido: aj.motivo_excluido || null,
        notas: aj.notas || null,
        proveedor, plazo, plazoEstimado, lote,
        loteManual: aj.lote_compra != null,
        enCamino, colgadas,
        disponible, puntoPedido, diasObjetivo, sugerido,
        cobertura: diario > 0 ? Math.round(disponible / diario) : null,
        alerta: !aj.excluido && diario > 0 && p.se_compra && disponible <= puntoPedido,
        compras,
        nCompras: compras.length,
        ultimaCompra: ultimo ? ultimo.fecha : null,
        ultimoPrecio: ultimo ? ultimo.precio : null,
        moneda: ultimo ? ultimo.moneda : null,
        intervalo: mediana(inter),
        valorStock: p.stock * (p.costo || 0),
        valorSugerido: sugerido * (ultimo?.moneda === 'ARS' ? ultimo.precio : (p.costo || 0)),
      });
    }

    filas.sort((a, b) => (a.cobertura ?? 1e9) - (b.cobertura ?? 1e9) || a.nombre.localeCompare(b.nombre, 'es'));
    return filas;
  }

  /* Comprar de a poco sale más caro. Para cada compra busca si, dentro de ±45
     días, el mismo insumo se consiguió más barato por unidad PIDIENDO MÁS.
     Las dos condiciones importan: la ventana de 45 días evita confundirlo con
     la inflación, y exigir un lote mayor evita contar como "oportunidad" una
     simple suba de precio entre dos compras del mismo tamaño. */
  function oportunidades(filas) {
    const out = [];
    for (const f of filas) {
      const c = (f.compras || []).filter(x => x.moneda === 'ARS' && x.precio > 0 && x.cantidad > 0);
      if (c.length < 3) continue;
      let sobre = 0, casos = 0;
      let mejorLote = null, mejorPrecio = null, peorLote = null, peorPrecio = null;
      for (const x of c) {
        const alternativas = c.filter(y =>
          Math.abs(new Date(y.fecha) - new Date(x.fecha)) <= 45 * 86400000 &&
          y.cantidad > x.cantidad && y.precio < x.precio * 0.95);
        if (!alternativas.length) continue;
        const mejor = alternativas.reduce((a, b) => (b.precio < a.precio ? b : a));
        sobre += (x.precio - mejor.precio) * x.cantidad;
        casos++;
        if (peorPrecio == null || x.precio > peorPrecio) { peorPrecio = x.precio; peorLote = x.cantidad; }
        if (mejorPrecio == null || mejor.precio < mejorPrecio) { mejorPrecio = mejor.precio; mejorLote = mejor.cantidad; }
      }
      if (sobre > 1000) {
        out.push({
          ...f, sobreprecio: sobre, casos, mejorLote, mejorPrecio, peorLote, peorPrecio,
          brecha: peorPrecio && mejorPrecio ? peorPrecio / mejorPrecio - 1 : null,
        });
      }
    }
    return out.sort((a, b) => b.sobreprecio - a.sobreprecio);
  }

  // ---- Semáforo de cobertura ---------------------------------------------
  // Solo se le pone semáforo a lo que se repone comprando. Los graneles y
  // semielaborados se fabrican: su faltante lo resuelve producción, no una
  // orden de compra, así que quedan aparte y no ensucian la lista de alertas.
  function nivel(f) {
    if (!f.se_compra) return 'fabricado';
    if (f.excluido) return 'off';
    if (!(f.diario > 0) || f.cobertura == null) return 'quieto';
    if (f.cobertura <= 3) return 'critico';
    if (f.alerta) return 'bajo';
    if (f.cobertura <= f.diasObjetivo) return 'ok';
    return 'holgado';
  }
  const NIVEL_TXT = {
    critico: 'Sin stock o a punto de cortarse',
    bajo: 'Debajo del punto de pedido',
    ok: 'En rango',
    holgado: 'De sobra',
    quieto: 'Sin consumo en el período',
    off: 'Excluido de las alertas',
    fabricado: 'Se fabrica, no se compra',
  };

  return { esc, norm, pesos, num, uni, plural, fecha, fechaHora, dias, mediana, toast, calcular, oportunidades, usoDiario, nivel, NIVEL_TXT };
})();
