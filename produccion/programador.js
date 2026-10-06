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

  // "anticipo" = la próxima tanda de un pedido que se entrega de a partes, cuando todavía no le toca:
  // se adelanta solo si sobra lugar, antes que el stock genérico.
  // 'tanda' = la entrega que le TOCA hoy/mañana a un cliente que se entrega de a partes (ej. Saracho, 2 baldes):
  // es un compromiso del día, va antes que 2-3 días.
  const RANGO = { hoy: 0, '1d': 1, tanda: 1.5, '23d': 2, parcial: 3, sin: 4, anticipo: 5, stock: 6 };
  const ETIQUETA = { hoy: '🟥 Hoy', '1d': '🟧 1 día', tanda: '🔄 Entrega que toca', '23d': '🟨 2-3 días', parcial: '🔄 Parcial', sin: 'Sin etiqueta', anticipo: 'Próxima entrega', stock: 'Para stock' };
  const URGENTE = (p) => p === 'hoy' || p === '1d';

  // las fechas 'AAAA-MM-DD' se leen como día local (si no, en Argentina caen el día anterior)
  const d0 = (x) => { const d = typeof x === 'string' && x.length === 10 ? new Date(x + 'T12:00:00') : new Date(x); d.setHours(0, 0, 0, 0); return d; };
  const iso = (d) => d0(d).toISOString().slice(0, 10);
  // días hábiles (lun-vie) desde mañana hasta `hasta` inclusive; hoy cuenta como 1
  function diasHabiles(hoy, hasta) {
    let n = 1; const d = d0(hoy); const h = d0(hasta);
    while (d < h) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  const mediana = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // valor más repetido (empate → el mayor) y qué parte de los casos representa
  function moda(a) {
    const n = {}; for (const x of a) { const k = Math.round(x * 100) / 100; n[k] = (n[k] || 0) + 1; }
    let best = null, cnt = 0; for (const [k, v] of Object.entries(n)) if (v > cnt || (v === cnt && Number(k) > best)) { best = Number(k); cnt = v; }
    return { valor: best, parte: a.length ? cnt / a.length : 0 };
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  // cantidad a su unidad base según cómo se cargó: kg (peso), L (volumen), u (unidades)
  function aBase(q, unidad) {
    const n = String(unidad || '').toLowerCase().trim();
    if (['g', 'gr', 'gramo', 'gramos'].includes(n)) return { q: q / 1000, u: 'kg' };
    if (['cc', 'ml', 'mililitro', 'mililitros'].includes(n)) return { q: q / 1000, u: 'L' };
    if (['l', 'lt', 'lts', 'litro', 'litros'].includes(n)) return { q, u: 'L' };
    if (n === 'un' || n === 'u' || n.startsWith('unidad')) return { q, u: 'u' };
    return { q, u: 'kg' };
  }
  const masDias = (f, n) => { const d = d0(f); d.setDate(d.getDate() + Math.round(n)); return d; };
  function proximoHabil(f) { const d = d0(f); do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); return d; }

  // ---------- Lo que se aprende de cómo trabaja la planta (historial de Odoo) ----------
  // Lote de elaboración y tanda de fraccionado = cantidad más repetida por orden de fabricación.
  // Patrón de entrega por cliente = pedidos que se entregaron en varias veces: de a cuánto por
  // producto (si es constante) y cada cuántos días.
  function aprender(snap) {
    const porProd = {}; for (const m of snap.mo || []) (porProd[m.c] = porProd[m.c] || []).push(m.q);
    const lote = {}, tanda = {};
    for (const [c, qs] of Object.entries(porProd)) {
      const mo = moda(qs);
      if (c.startsWith('9')) lote[c] = mo.parte >= 0.25 ? mo.valor : Math.round(mediana(qs));
      else tanda[c] = mo.valor;
    }
    // entregas agrupadas por pedido → por entrega (picking)
    const porSo = {};
    for (const e of snap.entregas || []) {
      const s = (porSo[e.so] = porSo[e.so] || { so: e.so, so_id: e.so_id, p: e.p, cli: e.cli, picks: {} });
      const k = (s.picks[e.pick] = s.picks[e.pick] || { f: e.f, items: {} });
      if (e.f < k.f) k.f = e.f;
      k.items[e.c] = (k.items[e.c] || 0) + e.q;
    }
    const ultimaEntrega = {}, entregasHechas = {};
    const cli = {};
    for (const s of Object.values(porSo)) {
      const picks = Object.values(s.picks).sort((a, b) => a.f.localeCompare(b.f));
      ultimaEntrega[s.so_id] = picks[picks.length - 1].f; entregasHechas[s.so_id] = picks.length;
      const c = (cli[s.p] = cli[s.p] || { p: s.p, cli: s.cli, pedidos: 0, multi: 0, n_entregas: [], intervalos: [], porSku: {} });
      c.pedidos++;
      if (picks.length < 2) continue;
      c.multi++; c.n_entregas.push(picks.length);
      for (let i = 1; i < picks.length; i++) c.intervalos.push((d0(picks[i].f) - d0(picks[i - 1].f)) / 864e5);
      for (const pk of picks) for (const [sku, q] of Object.entries(pk.items)) (c.porSku[sku] = c.porSku[sku] || []).push(q);
    }
    const patrones = {};
    for (const c of Object.values(cli)) {
      if (c.multi < 2) continue;   // un solo pedido partido no es costumbre
      const tandas = {};
      for (const [sku, qs] of Object.entries(c.porSku)) { const mo = moda(qs); if (qs.length >= 3 && mo.parte >= 0.6) tandas[sku] = mo.valor; }
      patrones[c.p] = { p: c.p, cli: c.cli, pedidos: c.pedidos, pedidos_partidos: c.multi, entregas_por_pedido: Math.round(mediana(c.n_entregas)), dias_entre: Math.max(1, Math.round(mediana(c.intervalos))), tandas, aprendido: true };
    }
    return { lote, tanda, patrones, ultimaEntrega, entregasHechas };
  }

  function programar({ snap, cfg, parciales = [], clientes = [], pres = [], subg = [], hoy = new Date(), postergados = [], entregas = [], hoja = [] }) {
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
    const ap = aprender(snap);
    const loteDe = (g) => ap.lote[g] || 10;
    // patrón de entrega del cliente: lo cargado a mano (prod_plan_clientes) manda sobre lo aprendido
    const patrones = JSON.parse(JSON.stringify(ap.patrones));
    for (const c of clientes) {
      const pt = (patrones[c.partner_id] = patrones[c.partner_id] || { p: c.partner_id, cli: c.cliente, tandas: {}, entregas_por_pedido: 2, dias_entre: 7, aprendido: false });
      if (c.sku && c.sku !== '*') { if (Number(c.tanda) > 0) pt.tandas[c.sku] = Number(c.tanda); }
      else if (Number(c.tanda) > 0) pt.tanda_general = Number(c.tanda);
      if (Number(c.dias_entre) > 0) pt.dias_entre = Number(c.dias_entre);
      pt.manual = true; if (c.nota) pt.nota = c.nota;
    }
    const manana = proximoHabil(hoy);
    // postergado a mano desde Core: no entra hasta la fecha elegida; ese día vuelve solo con su prioridad
    const posDe = {}; for (const x of postergados) if (d0(x.hasta) > d0(hoy)) posDe[`${x.so_id}|${x.sku}`] = x;
    const postergadoA = (so, c) => posDe[`${so || 0}|${c}`] || (so ? posDe[`${so}|*`] : null);
    const fechaCorta = (f) => String(f).slice(0, 10).split('-').reverse().slice(0, 2).join('/');

    // ---------- 1) pedidos → renglones de demanda ----------
    const aConfirmar = [], demanda = [], masAdelante = [];
    // "Entrega de hoy" cargada en Core (ej. José retira al mediodía): esas cantidades son Hoy
    const entregaDe = {}; for (const e of entregas) if (String(e.fecha).slice(0, 10) === iso(hoy)) entregaDe[e.so_id] = e;
    for (const p of snap.pedidos) {
      const presupuesto = (p.estado === 'draft' || p.estado === 'sent') && !p.ml;
      const eh = entregaDe[p.id];
      if (presupuesto && !eh) { aConfirmar.push(p); continue; }
      const claves = (p.tag_ids || []).map((id) => claveTag[id]).filter(Boolean);
      let prio = p.ml ? 'hoy'
        : claves.includes('parcial') ? 'parcial'
        : claves.sort((a, b) => RANGO[a] - RANGO[b])[0] || 'sin';
      if (prio === 'sin' && !presupuesto) alertas.push({ tipo: 'sin_etiqueta', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} (${p.cliente}) no tiene etiqueta: entra al final de la fila.` });
      if (p.ml && p.estado === 'draft') alertas.push({ tipo: 'ml_borrador', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} es una venta de Mercado Libre todavía en borrador en Odoo: se programa igual como Hoy.` });

      // explotar kits (packs y combos) en sus productos reales
      const renglones = [];
      for (const l of p.lineas) {
        const comps = snap.kits[l.c];
        if (comps) for (const k of comps) renglones.push({ c: k.c, pend: l.pend * k.q, kit: l.c });
        else renglones.push({ c: l.c, pend: l.pend });
      }

      if (eh) {
        // lo que se lleva hoy (los kits se desarman igual que en el pedido)
        const pide = {};
        for (const it of eh.items || []) {
          const comps = snap.kits[it.c];
          if (comps) for (const k of comps) pide[k.c] = (pide[k.c] || 0) + it.q * k.q;
          else pide[it.c] = (pide[it.c] || 0) + Number(it.q);
        }
        for (const r of renglones) {
          const t = Math.min(r.pend, pide[r.c] || 0);
          if (t <= 0) continue;
          demanda.push({ c: r.c, prio: 'hoy', q: t, so_id: p.id, numero: p.numero, cliente: p.cliente, fecha: p.fecha, kit: r.kit || null, entrega: true, nota: `entrega de hoy ${eh.hora || ''}`.trim() });
          pide[r.c] -= t; r.pend -= t;
        }
        for (let i = renglones.length - 1; i >= 0; i--) if (renglones[i].pend <= 0) renglones.splice(i, 1);
        if (presupuesto) {
          alertas.push({ tipo: 'confirmar', so_id: p.id, numero: p.numero, cliente: p.cliente, texto: `${p.numero} (${p.cliente}) tiene una entrega cargada para hoy pero sigue como presupuesto: hay que confirmarlo en Odoo para que exista la entrega.` });
          aConfirmar.push(p); continue;
        }
        if (!renglones.length) continue;
      }

      // Cliente que se entrega de a partes (aprendido del historial o cargado a mano):
      // hoy entra la tanda que le toca; si todavía no le toca, la tanda queda como "próxima entrega".
      // Lo que se cargue a mano para ESTE pedido (prod_plan_parciales) manda sobre el patrón.
      const pt = patrones[p.partner_id];
      if (pt && !parcialDe[p.id] && (prio === '23d' || prio === 'sin' || prio === 'parcial')) {
        const ult = ap.ultimaEntrega[p.id];
        const prox = ult ? masDias(ult, pt.dias_entre) : d0(hoy);
        const toca = prox <= manana;
        const restantes = Math.max(1, (pt.entregas_por_pedido || 2) - (ap.entregasHechas[p.id] || 0));
        const nota = `entregas cada ~${pt.dias_entre} días` + (ult ? ` · última ${fechaCorta(ult)} · próxima ${fechaCorta(iso(prox))}` : '');
        for (const r of renglones) {
          const t = pt.tandas[r.c] || pt.tanda_general;
          const tq = t ? Math.min(r.pend, t) : Math.min(r.pend, Math.ceil(r.pend / restantes));
          const base = { c: r.c, so_id: p.id, numero: p.numero, cliente: p.cliente, fecha: p.fecha, kit: r.kit || null, nota: nota + (t ? ` · de a ${t}` : '') };
          let resto = r.pend;
          if (toca) { demanda.push({ ...base, prio: RANGO[prio] < RANGO.tanda ? prio : 'tanda', q: tq }); resto -= tq; }
          const sig = Math.min(resto, t || tq);
          if (sig > 0) { demanda.push({ ...base, prio: 'anticipo', q: sig }); resto -= sig; }
          if (resto > 0) masAdelante.push({ ...base, prio, q: resto, motivo: 'próximas entregas' });
        }
        continue;
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
    // ---------- lo que ya se hizo hoy según la Hoja de Producción de Core ----------
    // Los chicos cargan en la hoja y después eso pasa a Odoo como orden de fabricación (coinciden
    // día por día). Lo cargado hoy que TODAVÍA no está en Odoo se suma como hecho: sube el stock de
    // lo producido y baja el granel que se usó. Lo que ya está en Odoo no se cuenta dos veces.
    // Todo lo hecho hoy (esté o no en Odoo) ya ocupó capacidad del día.
    const hoyIso = iso(hoy);
    const enOdooHoy = {}; for (const m of snap.mo || []) if (m.f === hoyIso) enOdooHoy[m.c] = (enOdooHoy[m.c] || 0) + m.q;
    const hechoPor = {};
    for (const h of hoja) {
      let q = Number(h.cantidad) || 0;
      q = aBase(q, h.unidad).q;   // 500 g = 0,5 kg; 0,6 g = 0,0006 kg (si no coincide con Odoo, lo marca el control)
      const c = String(h.producto_sku || '').trim(); if (!c || q <= 0) continue;
      const x = (hechoPor[c] = hechoPor[c] || { c, q: 0, tipo: h.tipo, cargas: [] });
      x.q += q; x.cargas.push({ hora: String(h.hora || '').slice(0, 5), q, quien: h.iniciales || '' });
    }
    const hechoHoy = [];
    const carga = { u: 0, kg: 0 };
    for (const x of Object.values(hechoPor)) {
      const enOdoo = Math.min(x.q, enOdooHoy[x.c] || 0), falta = x.q - enOdoo;
      const esGranel = x.c.startsWith('9');
      if (esGranel) carga.kg += x.q; else carga.u += x.q;
      if (falta > 1e-9) {
        if (esGranel) {
          dispGr[x.c] = (dispGr[x.c] || 0) + falta;
          for (const sg of subDe[x.c] || []) dispGr[sg.c] = Math.max(0, (dispGr[sg.c] || 0) - falta * sg.pct / 100);
        } else {
          dispPT[x.c] = (dispPT[x.c] || 0) + falta;
          const pr = presDe[x.c]; if (pr) dispGr[pr.g] = Math.max(0, (dispGr[pr.g] || 0) - falta * pr.kg);
        }
      }
      hechoHoy.push({ c: x.c, q: r2(x.q), unidad: esGranel ? 'kg' : 'u', en_odoo: r2(enOdoo), cargas: x.cargas });
    }
    const hechoU = carga.u, hechoKg = carga.kg;
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
      const pz = d.entrega ? null : postergadoA(d.so_id, d.c);
      if (pz) { postergado.push({ ...d, motivo: `postergado a mano hasta el ${fechaCorta(pz.hasta)}`, manual: true, hasta: pz.hasta }); continue; }
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
      sumarFracc(d.c, q, { prio: d.prio, so_id: d.so_id, numero: d.numero, cliente: d.cliente, q, kit: d.kit, nota: d.nota, entrega: !!d.entrega });
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
        if (postergadoA(0, r.c)) continue;
        const lugar = Math.floor(capU - carga.u);
        if (lugar <= 0) break;
        const ya = fraccionar[r.c]?.motivos.filter((m) => m.prio === 'stock').reduce((a, m) => a + m.q, 0) || 0;
        let q = Math.min(lugar, Math.ceil(r.por_dia * objetivoDias - Math.max(0, r.stock_libre)) - ya);
        if (q <= 0) continue;
        // para stock se fracciona en la tanda de siempre (ej. Criógeno 500g de a 6), no de a 1
        const tf = ap.tanda[r.c]; if (tf && q < tf) q = Math.min(tf, lugar);
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
    const moViejas = snap.mo_abiertas.filter((m) => m.inicio && (d0(hoy) - d0(m.inicio)) / 864e5 > 14);
    if (moViejas.length) alertas.push({ tipo: 'mo_vieja', texto: `${moViejas.length === 1 ? 'Hay 1 orden de fabricación abierta' : `Hay ${moViejas.length} órdenes de fabricación abiertas`} hace más de 2 semanas en Odoo (${moViejas.map((m) => `${m.nombre} ${nombre[m.c] || m.c}`).join(' · ')}): si no se van a hacer, conviene cancelarlas.` });
    // pedido grande sin 🔄 que no entra en un día: probablemente sea de entrega parcial
    const postPorSo = {};
    for (const x of postergado) if (x.prio === '23d' || x.prio === 'sin') { postPorSo[x.so_id] = postPorSo[x.so_id] || { ...x, q: 0 }; postPorSo[x.so_id].q += x.q; }
    for (const x of Object.values(postPorSo)) if (x.q >= capU / 2)
      alertas.push({ tipo: 'sugerir_parcial', so_id: x.so_id, numero: x.numero, cliente: x.cliente, texto: `${x.numero} (${x.cliente}) tiene ${x.q} unidades que no entran en el día: si se entrega de a partes, conviene marcarlo 🔄 Entrega parcial.` });
    if (carga.u > capU) alertas.push({ tipo: 'excede', texto: `Entre lo hecho (${r2(hechoU)} u) y lo urgente se fraccionan ${r2(carga.u)} unidades y el tope del día es ${capU}.` });
    if (carga.kg > capKg) alertas.push({ tipo: 'excede', texto: `Entre lo hecho (${r2(hechoKg)} kg) y lo urgente se elaboran ${r2(carga.kg)} kg y el tope del día es ${capKg} kg.` });

    return {
      fecha: iso(hoy), generado: snap.generado,
      carga: { u: carga.u, cap_u: capU, kg: r2(carga.kg), cap_kg: capKg, hecho_u: r2(hechoU), hecho_kg: r2(hechoKg) },
      hecho_hoy: hechoHoy.map((h) => ({ ...h, nombre: nombre[h.c] || h.c })),
      fraccionar: tareasFracc, elaborar: tareasElab, preparar: tareasPrep,
      de_stock: deStock.map(conNombre), postergado: postergado.map(conNombre), mas_adelante: masAdelante.map(conNombre),
      a_confirmar: aConfirmar.map((p) => ({ so_id: p.id, numero: p.numero, cliente: p.cliente, fecha: p.fecha, estado: p.estado, monto: p.monto, lineas: p.lineas })),
      ritmo, alertas,
      postergados: Object.values(posDe),
      entregas_hoy: Object.values(entregaDe),
      aprendido: { lotes: ap.lote, tandas: ap.tanda, patrones },
    };
  }

  // ====== ¿Alcanzan las materias primas y los envases? ======
  // elaborar: [{c: granel, kg}] · fraccionar: [{c: sku, q}] · hechoHoy: lo cargado hoy en la hoja que
  // todavía no está en Odoo (ya se consumió, pero el stock de Odoo todavía no lo descontó).
  // Solo cuenta lo que tiene stock en Odoo (el agua y la hoja de etiquetas no se stockean).
  function necesidadMateriales({ snap, formulas = [], pres = [], elaborar = [], fraccionar = [], hechoHoy = [] }) {
    const stock = {}; for (const x of snap.stock) stock[x.c] = x;
    const comp = {}; for (const r of formulas) (comp[r.g] = comp[r.g] || []).push({ c: r.c, pct: Number(r.pct) });
    const presDe = {}; for (const p of pres) presDe[p.c] = p;
    const nec = {}, motivo = {};
    const sumar = (c, q, para, ya) => {
      if (!(q > 0)) return;
      const x = (nec[c] = nec[c] || { c, plan: 0, hecho: 0, para: new Set() });
      if (ya) x.hecho += q; else { x.plan += q; x.para.add(para); }
    };
    // MP directa de un granel (los sub-graneles se cuentan aparte: o hay stock o están en la lista de elaborar)
    const explotar = (g, kg, ya) => { for (const k of comp[g] || []) if (!k.c.startsWith('9')) sumar(k.c, kg * k.pct / 100, g, ya); };
    for (const e of elaborar) explotar(e.c, Number(e.kg), false);
    for (const f of fraccionar) { const p = presDe[f.c]; if (p && p.env) sumar(p.env, Number(f.q), f.c, false); }
    for (const h of hechoHoy) {
      const extra = Number(h.q) - Number(h.en_odoo || 0); if (!(extra > 0)) continue;
      if (h.c.startsWith('9')) explotar(h.c, extra, true);
      else { const p = presDe[h.c]; if (p && p.env) sumar(p.env, extra, h.c, true); }
    }
    const lista = [], sinStock = [];
    for (const x of Object.values(nec)) {
      const st = stock[x.c];
      if (!st) { if (x.plan > 0) sinStock.push(x.c); continue; }
      const hay = Math.max(0, Number(st.libre)) - x.hecho;     // lo hecho hoy sin pasar a Odoo ya se usó
      const falta = x.plan - hay;
      const r4 = (v) => Math.round(v * 10000) / 10000;
      lista.push({ c: x.c, nombre: st.n, uom: st.uom, necesita: r4(x.plan), hay: r4(Math.max(0, hay)), falta: falta > 1e-6 ? Math.round(falta * 1000) / 1000 : 0, usado_hoy: r2(x.hecho), para: [...x.para], envase: x.c.startsWith('3') });
    }
    lista.sort((a, b) => (b.falta > 0) - (a.falta > 0) || b.falta - a.falta || a.c.localeCompare(b.c));
    return { lista, faltan: lista.filter((x) => x.falta > 0), sin_stock_en_odoo: sinStock };
  }

  const API = { programar, necesidadMateriales, aBase, diasHabiles, RANGO, ETIQUETA };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PROGRAMADOR = API;
})(typeof window !== 'undefined' ? window : globalThis);
