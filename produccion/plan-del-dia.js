// ====== Plan del día (compartido) ======
// Calcula lo mismo que "Programar el día" (foto de Odoo + lo configurado en Core + lo que ya se cargó
// hoy en la Hoja) para que la Hoja, Inicio y la pantalla de Producción muestren el mismo pendiente.
// Necesita programador.js cargado antes. Uso: const r = await PLAN_DEL_DIA.cargar(sb);
(function (root) {
  'use strict';
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Junta lo sugerido por el motor con lo editado a mano en "Programar el día" (prod_plan_dia).
  function filasDelDia(plan, dia, nombreDe) {
    const guard = {};
    for (const r of dia) guard[r.tipo + '|' + r.codigo] = r;
    const filas = [];
    const sumar = (tipo, codigo, nombre, sugerido, extra) => {
      const g = guard[tipo + '|' + codigo];
      filas.push({ tipo, codigo, nombre, sugerido, cantidad: g?.editado ? Number(g.cantidad) : sugerido, editado: !!g?.editado, agregado: false, en_hoja: !!g?.en_hoja, guardada: g, ...extra });
      delete guard[tipo + '|' + codigo];
    };
    for (const x of plan.preparar) sumar('preparar', x.c, x.nombre, x.kg, { x });
    for (const x of plan.elaborar) sumar('elaborar', x.c, x.nombre, x.kg, { x });
    for (const x of plan.fraccionar) sumar('fraccionar', x.c, x.nombre, x.q, { x });
    for (const g of Object.values(guard)) if (g.agregado || g.editado)
      filas.push({ tipo: g.tipo, codigo: g.codigo, nombre: g.nombre || nombreDe(g.codigo), sugerido: g.agregado ? null : 0, cantidad: Number(g.cantidad), editado: true, agregado: !!g.agregado, en_hoja: !!g.en_hoja, guardada: g });
    return filas;
  }

  // Lo que todavía falta hacer hoy. Lo sugerido por el motor ya descuenta lo cargado en la Hoja;
  // una cantidad editada a mano es el total del día, así que a esa se le resta lo ya hecho.
  function pendientes(r) {
    const hecho = {}; for (const h of r.plan.hecho_hoy) hecho[h.c] = (hecho[h.c] || 0) + Number(h.q || 0);
    const falta = (f) => f.editado ? Math.max(0, f.cantidad - (hecho[f.codigo] || 0)) : f.cantidad;
    const filas = r.filas.map((f) => ({ ...f, falta: Math.round(falta(f) * 1000) / 1000 })).filter((f) => f.falta > 0);
    return {
      elaborar: filas.filter((f) => f.tipo === 'elaborar' || f.tipo === 'preparar'),
      fraccionar: filas.filter((f) => f.tipo === 'fraccionar'),
    };
  }

  async function cargar(sb, { hoy = new Date() } = {}) {
    const dia = isoLocal(hoy);
    const q = await Promise.all([
      sb.from('prod_plan_snapshot').select('id,creado,datos').order('id', { ascending: false }).limit(1),
      sb.from('prod_plan_config').select('*').eq('id', 1).single(),
      sb.from('prod_plan_parciales').select('*'),
      sb.from('prod_plan_clientes').select('*'),
      sb.from('prod_plan_postergados').select('*').order('hasta'),
      sb.from('prod_plan_entregas').select('*').gte('fecha', dia).order('hora'),
      sb.from('prod_hoja_diaria').select('producto_sku,producto_nombre,cantidad,unidad,tipo,hora,iniciales').eq('fecha', dia).order('hora'),
      sb.from('prod_plan_dia').select('*').eq('fecha', dia).order('orden'),
      sb.from('presentaciones').select('codigo_sku,codigo_granel,tamanio_kg,codigo_envase'),
      sb.from('formulas').select('id,codigo_granel').eq('estado', 'vigente'),
      sb.from('formula_componentes').select('formula_id,codigo_componente,composicion_pct').range(0, 4999),
    ]);
    const err = q.find((x) => x.error);
    if (err) throw new Error(err.error.message);
    const [snapR, cfg, par, cli, pos, ent, hoja, diaR, pr, fo, fc] = q.map((x) => x.data);
    if (!snapR.length) throw new Error('todavía no hay foto de Odoo: abrí "Programar el día" una vez');
    const snap = snapR[0].datos, creado = new Date(snapR[0].creado);
    const pres = pr.map((p) => ({ c: p.codigo_sku, g: p.codigo_granel, kg: p.tamanio_kg, env: p.codigo_envase }));
    const gDe = {}; for (const f of fo) gDe[f.id] = f.codigo_granel;
    const subg = fc.filter((x) => gDe[x.formula_id] && String(x.codigo_componente).startsWith('9'))
      .map((x) => ({ g: gDe[x.formula_id], c: x.codigo_componente, pct: x.composicion_pct }));
    const plan = root.PROGRAMADOR.programar({ snap, cfg, parciales: par, clientes: cli, postergados: pos, entregas: ent, hoja, pres, subg, hoy });
    const nombreDe = (c) => (snap.stock.find((s) => s.c === c) || {}).n || c;
    const r = { snap, creado, plan, hoja, filas: filasDelDia(plan, diaR, nombreDe), nombreDe };
    r.pendientes = pendientes(r);
    // pedidos confirmados con algo por entregar (los presupuestos se ven en Programar el día, no cuentan acá)
    r.pedidos = snap.pedidos.filter((p) => p.estado === 'sale' || p.ml);
    return r;
  }

  // "Datos de Odoo de las 14:20 (hace 5 min)"
  function textoFoto(creado) {
    const mins = Math.round((Date.now() - creado) / 60000);
    return `datos de Odoo de las ${creado.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })} (${mins < 1 ? 'recién' : mins < 60 ? 'hace ' + mins + ' min' : 'hace ' + Math.round(mins / 60) + ' h'})`;
  }

  root.PLAN_DEL_DIA = { cargar, filasDelDia, pendientes, textoFoto, isoLocal };
})(typeof window !== 'undefined' ? window : globalThis);
