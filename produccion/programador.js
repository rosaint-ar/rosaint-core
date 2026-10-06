// ====== Programador de producción — el cerebro (sin pantalla) ======
// Arma la producción del día a partir de la foto de sync-produccion (modo "plan").
// Toda la matemática vive acá para poder discutirla; la pantalla solo la muestra.
//
// Orden de la fila: 🟥 Hoy (y TODO Mercado Libre) → 🟧 1 día → 🟨 2-3 días →
// 🔄 cuota del día de los pedidos de entrega parcial → confirmados sin etiqueta →
// relleno para stock con lo que sobra de capacidad.
// Los presupuestos (borrador/enviado que no son de ML) se muestran, no se programan.
// Capacidad: dos "mesas" en paralelo — elaborar granel (kg/día) y fraccionar (unidades/día).
// Lo urgente (Hoy, 1 día) entra siempre aunque pase el tope: la pantalla avisa.
(function (root) {
  'use strict';

  const RANGO = { hoy: 0, '1d': 1, '23d': 2, parcial: 3, sin: 4, stock: 5 };
  const ETIQUETA = { hoy: '🟥 Hoy', '1d': '🟧 1 día', '23d': '🟨 2-3 días', parcial: '🔄 Parcial', sin: 'Sin etiqueta', stock: 'Para stock' };
  const URGENTE = (p) => p === 'hoy' || p === '1d';

  const d0 = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d; };
  const iso = (d) => d0(d).toISOString().slice(0, 10);
  // días hábiles (lun-vie) desde mañana hasta `hasta` inclusive; hoy cuenta como 1
  function diasHabiles(hoy, hasta) {
    let n = 1; const d = d0(hoy); const h = d0(hasta);
    while (d < h) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  const mediana = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r2 = (x) => Math.round(x * 100) / 100;

  function programar({ snap, cfg, parciales = [], pres = [], subg = [], hoy = new Date(), quitar = {} }) {
    const capU = Number(cfg.cap_u_dia), capKg = Number(cfg.cap_kg_dia);
    const umbral = Number(cfg.umbral_pedido_grande || 10);
    const diaAnterior = new Set(cfg.graneles_dia_anterior || []);
    const alertas = [];

    // ---------- índices ----------
    const claveTag = {}; for (const [k, id] of Object.entries(snap.prioridad || {})) claveTag[id] = k;
    const stock = {}; for (const s of snap.stock) stock[s.c] = s;
    const nombre = {}; for (const s of snap.stock) nombre[s.c] = s.n;
    const presDe = {}; for (const p of pres) presDe[p.c] = { g: p.g, kg: Number(p.kg) };
    const subDe = {}; for (const s of subg) (subDe[s.g] = subDe[s.g] || []).push({ c: s.c, pct: Number(s.pct) });
    const parcialDe = {}; for (const p of parciales) parcialDe[p.so_id] = p;
    // lote habitual de cada granel = mediana de lo elaborado por orden (historial)
    const lotes = {}; for (const r of snap.produccion) if (r.c.startsWith('9')) (lotes[r.c] = lotes[r.c] || []).push(r.q / Math.max(1, r.n));
    const loteDe = (g) => Math.max(1, Math.round(mediana(lotes[g] || [])) || 10);

    // ---------- 1) pedidos → renglones de demanda ----------
    const aConfirmar = [], demanda = [], masAdelante = [];
    for (const p of snap.pedidos) {
      const presupuesto = (p.estado === 'draft' || p.estado === 'sent') && !p.ml;
      if (presupuesto) { aConfirmar.push(p); continue; }
      const claves = (p.tag_ids || []).map((id) => claveTag[id]).filter(Boolean);
      let prio = p.ml ? 'hoy'
        : claves.includes('parcial') ? 'parcial'
        : claves.sort((a, b) => RANGO[a] - RANGO[b])[0] || 'sin';
      if (prio === 'sin') alertas.push({ tipo: 'sin_etiqueta', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} (${p.cliente}) no tiene etiqueta: entra al final de la fila.` });
      if (p.ml && p.estado === 'draft') alertas.push({ tipo: 'ml_borrador', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} es una venta de Mercado Libre todavía en borrador en Odoo: se programa igual como Hoy.` });

      // explotar kits (packs y combos) en sus productos reales
      const renglones = [];
      for (const l of p.lineas) {
        const comps = snap.kits[l.c];
        if (comps) for (const k of comps) renglones.push({ c: k.c, pend: l.pend * k.q, kit: l.c });
        else renglones.push({ c: l.c, pend: l.pend });
      }

      // pedidos de entrega parcial: solo la cuota de hoy
      let factor = 1, notaParcial = null;
      if (prio === 'parcial') {
        const cfgP = parcialDe[p.id];
        const totalPend = renglones.reduce((a, r) => a + r.pend, 0);
        if (cfgP && Number(cfgP.unidades_semana) > 0) {
          factor = Math.min(1, (Number(cfgP.unidades_semana) / 5) / totalPend);
          notaParcial = `${cfgP.unidades_semana} u/semana`;
        } else {
          let limite = cfgP?.fecha_limite ? new Date(cfgP.fecha_limite + 'T12:00:00') : null;
          if (!limite) {
            limite = new Date(d0(hoy).getTime() + Number(cfg.semanas_parcial_default || 4) * 7 * 864e5);
            alertas.push({ tipo: 'parcial_sin_ritmo', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} (${p.cliente}) es de entrega parcial pero no tiene ritmo cargado: se reparte en ${cfg.semanas_parcial_default || 4} semanas.` });
          }
          if (d0(limite) < d0(hoy)) {
            prio = '23d';
            alertas.push({ tipo: 'parcial_vencido', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} (${p.cliente}) pasó su fecha límite (${iso(limite)}): lo que falta entra como 2-3 días.` });
          } else {
            const dh = diasHabiles(hoy, limite);
            factor = 1 / dh; notaParcial = `hasta el ${iso(limite)} (${dh} días hábiles)`;
          }
        }
      }
      // La cuota del día se arma con productos ENTEROS del pedido (fraccionar de a 1 unidad
      // de 7 productos distintos es ineficiente). Un renglón grande (más del doble de la cuota)
      // se parte; uno chico va completo.
      const cuota = factor >= 1 ? Infinity : Math.ceil(renglones.reduce((a, r) => a + r.pend, 0) * factor);
      let acum = 0;
      const orden = factor >= 1 ? renglones : [...renglones].sort((a, b) => a.pend - b.pend);
      for (const r of orden) {
        let hoyQ = 0;
        if (acum < cuota) hoyQ = r.pend <= 2 * cuota ? r.pend : Math.min(r.pend, cuota - acum);
        acum += hoyQ;
        const base = { c: r.c, prio, so_id: p.id, numero: p.numero, cliente: p.cliente, fecha: p.fecha, kit: r.kit || null, nota: notaParcial };
        if (hoyQ > 0) demanda.push({ ...base, q: hoyQ });
        if (r.pend - hoyQ > 0) masAdelante.push({ ...base, q: r.pend - hoyQ, motivo: 'cuota de próximos días' });
      }
    }
    demanda.sort((a, b) => RANGO[a.prio] - RANGO[b.prio] || String(a.fecha).localeCompare(String(b.fecha)) || String(a.numero).localeCompare(String(b.numero)));

    // ---------- estado del día ----------
    const dispPT = {}; for (const s of snap.stock) dispPT[s.c] = Math.max(0, s.disp);
    const dispGr = {}; for (const s of snap.stock) if (s.c.startsWith('9')) dispGr[s.c] = Math.max(0, s.libre);
    const carga = { u: 0, kg: 0 };
    const deStock = [], fraccionar = {}, elaborar = {}, preparar = {}, postergado = [];

    // ¿Qué hay que elaborar para tener `kg` de granel g? Devuelve el plan sin aplicarlo.
    function planGranel(g, kg, est, prof = 0) {
      const tengo = est.gr[g] ?? dispGr[g] ?? 0;
      if (tengo >= kg - 1e-9) { est.gr[g] = tengo - kg; return { ok: true }; }
      if (prof > 5) return { ok: false, motivo: `receta de ${g} demasiado profunda` };
      const falta = kg - tengo, lote = loteDe(g);
      const hacer = Math.ceil(falta / lote) * lote;
      for (const s of subDe[g] || []) {
        const nec = hacer * s.pct / 100;
        const tengoS = est.gr[s.c] ?? dispGr[s.c] ?? 0;
        if (tengoS < nec - 1e-9 && diaAnterior.has(s.c)) {
          est.prep[s.c] = Math.max(est.prep[s.c] || 0, nec - tengoS);
          return { ok: false, motivo: `falta ${nombre[s.c] || s.c} y hay que prepararlo el día anterior`, preparar: s.c };
        }
        const sub = planGranel(s.c, nec, est, prof + 1);
        if (!sub.ok) return sub;
      }
      est.gr[g] = tengo + hacer - kg;
      est.elab[g] = (est.elab[g] || 0) + hacer;
      est.kg += hacer;
      return { ok: true };
    }
    const nuevoEst = () => ({ gr: {}, elab: {}, prep: {}, kg: 0 });
    function aplicar(est) {
      for (const [g, v] of Object.entries(est.gr)) dispGr[g] = v;
      for (const [g, kg] of Object.entries(est.elab)) { elaborar[g] = elaborar[g] || { c: g, kg: 0, para: new Set() }; elaborar[g].kg += kg; }
      carga.kg += est.kg;
    }
    function sumarFracc(c, q, motivo) {
      const f = (fraccionar[c] = fraccionar[c] || { c, q: 0, motivos: [], prio: motivo.prio });
      f.q += q; f.motivos.push(motivo);
      if (RANGO[motivo.prio] < RANGO[f.prio]) f.prio = motivo.prio;
      carga.u += q;
    }

    // ---------- 2) atender la demanda en orden ----------
    for (const d of demanda) {
      if (quitar[`${d.so_id}|${d.c}`]) { postergado.push({ ...d, motivo: 'sacado a mano' }); continue; }
      // a) primero el producto terminado que ya está hecho
      const usa = Math.min(dispPT[d.c] || 0, d.q);
      if (usa > 0) { dispPT[d.c] -= usa; deStock.push({ ...d, q: usa }); }
      let q = d.q - usa;
      if (q <= 0) continue;

      const pr = presDe[d.c];
      if (!pr) { postergado.push({ ...d, q, motivo: 'el producto no tiene ficha de presentación en Core (no sé qué granel lleva)' }); alertas.push({ tipo: 'sin_ficha', texto: `${d.c} ${nombre[d.c] || ''} no tiene presentación en Core: no se puede programar.` }); continue; }

      // b) capacidad de fraccionar (lo urgente entra igual)
      if (!URGENTE(d.prio)) {
        const lugar = Math.floor(capU - carga.u);
        if (lugar <= 0) { postergado.push({ ...d, q, motivo: 'no entra en el día (fraccionado completo)' }); continue; }
        if (q > lugar) { postergado.push({ ...d, q: q - lugar, motivo: 'no entra en el día (fraccionado completo)' }); q = lugar; }
      }
      // c) granel: lo que hay o lo que hay que elaborar
      let est = nuevoEst();
      const plan = planGranel(pr.g, q * pr.kg, est);
      if (!plan.ok) {
        for (const [s, kg] of Object.entries(est.prep)) preparar[s] = { c: s, kg: Math.max(preparar[s]?.kg || 0, kg) };
        postergado.push({ ...d, q, motivo: plan.motivo }); continue;
      }
      if (!URGENTE(d.prio) && est.kg > 0 && carga.kg + est.kg > capKg) {
        // no entra todo: buscar la mayor cantidad cuya elaboración sí entre en el día
        let lo = 0, hi = q - 1, mejor = null;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2), e2 = nuevoEst();
          if (planGranel(pr.g, mid * pr.kg, e2).ok && carga.kg + e2.kg <= capKg) { lo = mid; mejor = e2; } else hi = mid - 1;
        }
        if (lo > 0 && !mejor) { mejor = nuevoEst(); planGranel(pr.g, lo * pr.kg, mejor); }
        postergado.push({ ...d, q: q - lo, motivo: 'no entra en el día (elaboración completa)' });
        if (lo <= 0) continue;
        q = lo; est = mejor;
      }
      aplicar(est);
      for (const g of Object.keys(est.elab)) elaborar[g].para.add(d.c);
      sumarFracc(d.c, q, { prio: d.prio, so_id: d.so_id, numero: d.numero, cliente: d.cliente, q, kit: d.kit, nota: d.nota });
    }

    // ---------- 3) ritmo de venta (solo renglones chicos: los pedidos grandes se planifican como pedido) ----------
    const desde = new Date(snap.desde + 'T12:00:00');
    const diasVentana = Math.max(1, diasHabiles(desde, hoy) - 1);
    const vendido = {};
    for (const v of snap.ventas) {
      if (v.q >= umbral) continue;
      const comps = snap.kits[v.c];
      if (comps) for (const k of comps) vendido[k.c] = (vendido[k.c] || 0) + v.q * k.q;
      else vendido[v.c] = (vendido[v.c] || 0) + v.q;
    }
    const pendFuturo = {}; for (const x of [...postergado, ...masAdelante]) pendFuturo[x.c] = (pendFuturo[x.c] || 0) + x.q;
    const ritmo = {};
    for (const [c, q] of Object.entries(vendido)) {
      const rd = q / diasVentana;
      const proy = (dispPT[c] || 0) - (pendFuturo[c] || 0);
      ritmo[c] = { c, por_dia: r2(rd), por_semana: r2(rd * 5), stock_libre: proy, cobertura_dias: rd > 0 ? r2(Math.max(0, proy) / rd) : null };
    }

    // ---------- 4) relleno para stock con la capacidad que sobra ----------
    const objetivoDias = Number(cfg.dias_stock_objetivo || 10);
    const candidatos = Object.values(ritmo)
      .filter((r) => r.c.startsWith('1') && presDe[r.c] && r.por_dia * 20 >= 1 && r.cobertura_dias !== null && r.cobertura_dias < objetivoDias)
      .sort((a, b) => a.cobertura_dias - b.cobertura_dias || b.por_dia - a.por_dia);
    // primero los que se hacen con granel que ya está; después los que piden elaborar
    for (const pasada of ['con_granel', 'elaborando']) {
      for (const r of candidatos) {
        const lugar = Math.floor(capU - carga.u);
        if (lugar <= 0) break;
        const ya = fraccionar[r.c]?.motivos.filter((m) => m.prio === 'stock').reduce((a, m) => a + m.q, 0) || 0;
        let q = Math.min(lugar, Math.ceil(r.por_dia * objetivoDias - Math.max(0, r.stock_libre)) - ya);
        const pr = presDe[r.c];
        // primera pasada: solo lo que alcanza con el granel que ya está hecho
        if (pasada === 'con_granel') q = Math.min(q, Math.floor((dispGr[pr.g] ?? 0) / pr.kg + 1e-9));
        if (q <= 0) continue;
        const est = nuevoEst();
        const plan = planGranel(pr.g, q * pr.kg, est);
        if (!plan.ok) continue;
        if (est.kg > 0 && (pasada === 'con_granel' || carga.kg + est.kg > capKg)) continue;
        aplicar(est);
        for (const g of Object.keys(est.elab)) elaborar[g].para.add(r.c);
        sumarFracc(r.c, q, { prio: 'stock', q, nota: `cubre ${r.cobertura_dias} días, objetivo ${objetivoDias}` });
      }
    }

    // ---------- 5) armado del resultado ----------
    const conNombre = (o) => ({ ...o, nombre: nombre[o.c] || o.c });
    const tareasFracc = Object.values(fraccionar).map((f) => ({ ...conNombre(f), granel: presDe[f.c]?.g, kg: r2(f.q * (presDe[f.c]?.kg || 0)), etiqueta: ETIQUETA[f.prio] }))
      .sort((a, b) => RANGO[a.prio] - RANGO[b.prio] || b.q - a.q);
    const tareasElab = Object.values(elaborar).map((e) => ({ ...conNombre(e), kg: r2(e.kg), lote: loteDe(e.c), para: [...e.para], dia_anterior: diaAnterior.has(e.c) }));
    const tareasPrep = Object.values(preparar).map((p) => { const lote = loteDe(p.c); return { ...conNombre(p), kg: Math.ceil(p.kg / lote) * lote, lote, texto: 'preparar hoy para poder elaborar mañana' }; });
    for (const m of snap.mo_abiertas) if (m.inicio && (d0(hoy) - d0(m.inicio)) / 864e5 > 14)
      alertas.push({ tipo: 'mo_vieja', texto: `Orden de fabricación ${m.nombre} (${nombre[m.c] || m.c}) abierta desde ${m.inicio}: si no se va a hacer, conviene cancelarla.` });
    if (carga.u > capU) alertas.push({ tipo: 'excede', texto: `Lo urgente suma ${carga.u} unidades a fraccionar y el tope del día es ${capU}.` });
    if (carga.kg > capKg) alertas.push({ tipo: 'excede', texto: `Lo urgente pide elaborar ${r2(carga.kg)} kg y el tope del día es ${capKg} kg.` });

    return {
      fecha: iso(hoy), generado: snap.generado,
      carga: { u: carga.u, cap_u: capU, kg: r2(carga.kg), cap_kg: capKg },
      fraccionar: tareasFracc, elaborar: tareasElab, preparar: tareasPrep,
      de_stock: deStock.map(conNombre), postergado: postergado.map(conNombre), mas_adelante: masAdelante.map(conNombre),
      a_confirmar: aConfirmar.map((p) => ({ so_id: p.id, numero: p.numero, cliente: p.cliente, fecha: p.fecha, estado: p.estado, monto: p.monto, lineas: p.lineas })),
      ritmo, alertas,
    };
  }

  const API = { programar, diasHabiles, RANGO, ETIQUETA };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PROGRAMADOR = API;
})(typeof window !== 'undefined' ? window : globalThis);
