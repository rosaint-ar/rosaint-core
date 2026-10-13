// ═══════════════════════════════════════════════════════════════════════════
// Percepciones de IIBB sufridas por jurisdicción — lo comparten "Percepciones IIBB"
// y el "Cierre mensual".
//
// Por qué existe (13-oct-2026): el contador descuenta en la CM03 solo lo que SIFERE
// importa solo desde SIRCAR. Hay 5 jurisdicciones que NO están en SIRCAR (901 CABA,
// 902 Buenos Aires, 908 Entre Ríos, 913 Mendoza y 924 Tucumán, según la Comisión
// Arbitral): esas percepciones hay que cargarlas a mano. Como nunca se le mandaron,
// las de CABA y Tucumán de mar–sep 2026 no se descontaron.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const NO_SIRCAR = new Set(['901', '902', '908', '913', '924']);
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const FN = window.SUPABASE_URL + '/functions/v1/odoo-percepciones';
  const HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.SUPABASE_KEY, 'apikey': window.SUPABASE_KEY };
  const r2 = (x) => Math.round(x * 100) / 100;
  const nombreMes = (mes) => { const [y, m] = mes.split('-').map(Number); return MESES[m - 1] + ' ' + y; };
  const fechaAR = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/');
  const cuitFmt = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.slice(0, 2) + '-' + d.slice(2, 10) + '-' + d.slice(10) : d; };

  // meses entre dos 'AAAA-MM' (inclusive)
  function rangoMeses(desde, hasta) {
    const out = []; let [y, m] = desde.split('-').map(Number); const [yh, mh] = hasta.split('-').map(Number);
    while (y < yh || (y === yh && m <= mh)) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }

  // Percepciones de Odoo de un rango de meses (una fila por comprobante y jurisdicción)
  async function traerOdoo(desde, hasta) {
    const lineas = [];
    for (const mes of rangoMeses(desde, hasta)) {
      const r = await fetch(FN, { method: 'POST', headers: HEADERS, body: JSON.stringify({ periodo: mes, modo: 'iibb' }) });
      const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Error leyendo Odoo');
      for (const l of d.lineas) lineas.push({ ...l, mes, manual: NO_SIRCAR.has(l.jur_codigo) });
    }
    return lineas;
  }

  // Totales por jurisdicción
  function resumen(lineas) {
    const m = new Map();
    for (const l of lineas) {
      const k = l.jur_codigo + '|' + l.jurisdiccion;
      const e = m.get(k) || { codigo: l.jur_codigo, nombre: l.jurisdiccion, manual: l.manual, total: 0, cbtes: 0 };
      e.total = r2(e.total + l.importe); e.cbtes++; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
  }

  // ---------- Archivo de SIRCAR (SIFERE Web Consultas → SIRCAR → Percepciones) ----------
  // No hay API: se baja a mano. El lector busca las columnas por el nombre del encabezado,
  // así sirve aunque cambie el orden o el formato (xls, xlsx, csv).
  function numAR(v) {
    if (typeof v === 'number') return v; if (v == null) return 0;
    let s = String(v).replace(/[$\s]/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
    return parseFloat(s) || 0;
  }
  function fechaISO(v) {
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
    const s = String(v || '').trim(); let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? m[0] : s;
  }
  function jurDeTexto(s) { const m = /\b(9[0-2]\d)\b/.exec(String(s || '')); return m ? m[1] : ''; }

  function leerSircar(buf, nombreArchivo) {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', raw: true, cellDates: false });
    const filas = [];
    for (const hoja of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: null, raw: true });
      // fila de encabezados: la primera que menciona CUIT e importe/monto
      let hi = rows.findIndex(r => r && r.some(c => /cuit/i.test(String(c || ''))) && r.some(c => /importe|monto/i.test(String(c || ''))));
      if (hi < 0) continue;
      const h = rows[hi].map(c => String(c || '').trim().toLowerCase());
      const col = (re, no) => h.findIndex(x => re.test(x) && !(no && no.test(x)));
      const c = {
        jur: col(/jurisd/), cuit: col(/cuit/), razon: col(/raz|denomin|agente|nombre/, /cuit/),
        fecha: (() => { const i = col(/fecha.*(percep|ret|oper|comprob)/); return i >= 0 ? i : col(/fecha/, /present|venc/); })(),
        tipo: col(/tipo/), letra: col(/letra/), pv: col(/sucursal|punto de venta|pto/),
        nro: col(/comprob|n[uú]mero|nro/, /tipo|letra|fecha|constancia|import/), importe: col(/importe|monto/),
      };
      // jurisdicción del archivo cuando la consulta es por una sola (aparece arriba del encabezado o en el nombre)
      const jurArchivo = jurDeTexto(rows.slice(0, hi).flat().join(' ')) || jurDeTexto(nombreArchivo);
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r || r[c.cuit] == null || !String(r[c.cuit]).replace(/\D/g, '')) continue;
        const imp = numAR(r[c.importe]); if (!imp) continue;
        const tipoTxt = c.tipo >= 0 ? String(r[c.tipo] || '') : '';
        const esNC = /cr[eé]dito|^0?0?3$|^0?0?8$|^0?13$/i.test(tipoTxt.trim());
        const digPv = c.pv >= 0 ? String(r[c.pv] || '').replace(/\D/g, '') : '';
        const digNro = c.nro >= 0 ? String(r[c.nro] || '').replace(/\D/g, '') : '';
        const todo = digPv ? digPv.padStart(5, '0') + digNro.padStart(8, '0') : digNro;
        const numero = todo.slice(-8), pv = todo.length > 8 ? String(parseInt(todo.slice(0, -8), 10) || 0).padStart(5, '0') : '';
        filas.push({
          jur_codigo: (c.jur >= 0 ? jurDeTexto(r[c.jur]) : '') || jurArchivo,
          cuit: String(r[c.cuit]).replace(/\D/g, ''), agente: c.razon >= 0 ? String(r[c.razon] || '') : '',
          fecha: c.fecha >= 0 ? fechaISO(r[c.fecha]) : '', tipo: tipoTxt, letra: c.letra >= 0 ? String(r[c.letra] || '') : '',
          pv, numero, importe: r2(esNC && imp > 0 ? -imp : imp),
        });
      }
    }
    return filas;
  }

  // ---------- Cruce Odoo ⇄ SIRCAR ----------
  // Se cruza por jurisdicción + CUIT del agente + número de comprobante; si el agente informó
  // con otra numeración, por jurisdicción + CUIT + importe exacto.
  function cruzar(odoo, sircar) {
    const jursArchivo = new Set(sircar.map(s => s.jur_codigo).filter(Boolean));
    const sinJur = sircar.some(s => !s.jur_codigo);
    const enAlcance = (l) => !l.manual && (sinJur || jursArchivo.has(l.jur_codigo));
    const pend = sircar.map((s, i) => ({ ...s, i })); const usados = new Set();
    const mismaJur = (s, l) => !s.jur_codigo || s.jur_codigo === l.jur_codigo;
    const coinciden = [], difieren = [], soloOdoo = [], ncNoDescontadas = [];
    for (const l of odoo.filter(enAlcance)) {
      let s = pend.find(x => !usados.has(x.i) && mismaJur(x, l) && x.cuit === l.cuit && x.numero && x.numero === String(l.numero).slice(-8));
      if (!s) s = pend.find(x => !usados.has(x.i) && mismaJur(x, l) && x.cuit === l.cuit && Math.abs(x.importe - l.importe) <= 0.5);
      if (!s) { (l.importe < 0 ? ncNoDescontadas : soloOdoo).push(l); continue; }
      usados.add(s.i);
      if (Math.abs(s.importe - l.importe) <= 0.5) coinciden.push({ odoo: l, sircar: s });
      else difieren.push({ odoo: l, sircar: s, dif: r2(s.importe - l.importe) });
    }
    const soloSircar = pend.filter(x => !usados.has(x.i));
    return { coinciden, difieren, soloOdoo, soloSircar, ncNoDescontadas, jursArchivo: [...jursArchivo], sinJur };
  }

  // ---------- Excel para el contador ----------
  function armarXlsx(lineas, desde, hasta, cruce) {
    const periodo = desde === hasta ? nombreMes(desde) : nombreMes(desde) + ' a ' + nombreMes(hasta);
    const res = resumen(lineas); const manuales = res.filter(r => r.manual && r.total > 0);
    const leeme = [
      ['Percepciones de IIBB sufridas por jurisdicción — VELAZQUEZ DIEGO MARTIN (CUIT 20-31092413-0) — ' + periodo],
      [''],
      ['Fuente: comprobantes de compra cargados en Odoo (una fila por comprobante y jurisdicción). Período = fecha del comprobante.'],
      ['SIFERE importa solo las percepciones de las jurisdicciones adheridas a SIRCAR.'],
      ['Las de 901 CABA, 902 Buenos Aires, 908 Entre Ríos, 913 Mendoza y 924 Tucumán NO se importan: hay que cargarlas a mano (Deducciones → Ingreso Manual o por Lotes).'],
      [manuales.length ? 'Este período hay que cargar a mano: ' + manuales.map(r => r.nombre + ' $' + r.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })).join(' · ') + '. Detalle en la hoja "Cargar a mano en SIFERE".' : 'Este período no hay percepciones de jurisdicciones no adheridas a SIRCAR.'],
      ['Las notas de crédito figuran en negativo: SIRCAR suele informar la percepción original pero no su anulación.'],
    ];
    const resumenAoa = [['Código', 'Jurisdicción', 'Comprobantes', 'Total percibido', 'Cómo entra a SIFERE']];
    for (const r of res) resumenAoa.push([r.codigo, r.nombre, r.cbtes, r.total, r.manual ? 'CARGAR A MANO (no está en SIRCAR)' : 'Se importa de SIRCAR']);
    resumenAoa.push(['', 'Total', lineas.length, r2(lineas.reduce((a, l) => a + l.importe, 0)), '']);
    const encab = ['Código jur.', 'Jurisdicción', 'Período', 'Fecha', 'Agente de percepción', 'CUIT del agente', 'Tipo', 'Código tipo', 'Letra', 'Punto de venta', 'Número', 'Importe percibido'];
    const fila = (l) => [l.jur_codigo, l.jurisdiccion, nombreMes(l.mes), fechaAR(l.fecha), l.agente, cuitFmt(l.cuit), l.tipo, l.tipo_codigo, l.letra, l.pv, l.numero, l.importe];
    const manualAoa = [encab, ...lineas.filter(l => l.manual).map(fila)];
    const todasAoa = [encab, ...lineas.map(fila)];
    const wb = XLSX.utils.book_new();
    const hoja = (aoa, nombre, anchos) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = anchos.map(w => ({ wch: w }));
      for (const k of Object.keys(ws)) if (ws[k] && typeof ws[k].v === 'number' && !/^C\d/.test(k)) ws[k].z = '#,##0.00';
      XLSX.utils.book_append_sheet(wb, ws, nombre);
    };
    const anchosDet = [10, 16, 15, 11, 30, 15, 16, 10, 6, 13, 11, 16];
    hoja(leeme, 'Leeme', [150]);
    hoja(resumenAoa, 'Resumen por jurisdicción', [8, 22, 13, 16, 34]);
    hoja(manualAoa, 'Cargar a mano en SIFERE', anchosDet);
    hoja(todasAoa, 'Todas las percepciones', anchosDet);
    if (cruce) {
      const c = [['Situación', 'Jurisdicción', 'Fecha', 'Agente', 'CUIT', 'Comprobante', 'Odoo', 'SIRCAR', 'Diferencia']];
      const cb = (l) => (l.pv ? l.pv + '-' : '') + l.numero;
      for (const l of cruce.soloOdoo) c.push(['En Odoo, el agente no la informó en SIRCAR: cargar a mano o reclamar al agente', l.jurisdiccion, fechaAR(l.fecha), l.agente, cuitFmt(l.cuit), cb(l), l.importe, '', '']);
      for (const l of cruce.ncNoDescontadas) c.push(['Nota de crédito que SIRCAR no descuenta: restarla a mano', l.jurisdiccion, fechaAR(l.fecha), l.agente, cuitFmt(l.cuit), cb(l), l.importe, '', '']);
      for (const s of cruce.soloSircar) c.push(['En SIRCAR pero no en Odoo: falta cargar el comprobante o la percepción', s.jur_codigo, fechaAR(s.fecha), s.agente, cuitFmt(s.cuit), cb(s), '', s.importe, '']);
      for (const d of cruce.difieren) c.push(['Importe distinto', d.odoo.jurisdiccion, fechaAR(d.odoo.fecha), d.odoo.agente, cuitFmt(d.odoo.cuit), cb(d.odoo), d.odoo.importe, d.sircar.importe, d.dif]);
      hoja(c, 'Diferencias con SIRCAR', [70, 16, 11, 30, 15, 16, 14, 14, 12]);
    }
    const nombre = 'Percepciones IIBB por jurisdicción - ' + periodo + '.xlsx';
    return { filename: nombre, base64: XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }), mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', manuales };
  }

  window.PercepIIBB = { NO_SIRCAR, traerOdoo, resumen, leerSircar, cruzar, armarXlsx, nombreMes, fechaAR, cuitFmt, rangoMeses };
})();
