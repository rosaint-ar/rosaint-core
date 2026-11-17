// ═══════════════════════════════════════════════════════════════════════════
// Percepciones de IVA y retenciones sufridas — Excel para la contadora (Cierre mensual).
//
// Por qué existe (17-nov-2026): la contadora carga A MANO en ARCA las percepciones y retenciones
// (en la F.2051 pide CUIT del agente, fecha, comprobante e importe). No puede sacarlas del Libro IVA
// Digital (es un txt para importar), y en la DDJJ de octubre 2026 quedaron afuera $57.064,39 de
// percepciones RG 2408 de Mercado Libre / Mercado Pago que sí estaban en el libro.
// Datos: función odoo-percepciones, modos "iva" y "retenciones" (lo cargado en Odoo).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const FN = window.SUPABASE_URL + '/functions/v1/odoo-percepciones';
  const HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.SUPABASE_KEY, 'apikey': window.SUPABASE_KEY };
  const r2 = (x) => Math.round(x * 100) / 100;
  const nombreMes = (mes) => { const [y, m] = mes.split('-').map(Number); return MESES[m - 1] + ' ' + y; };
  const fechaAR = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/');
  const cuitFmt = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.slice(0, 2) + '-' + d.slice(2, 10) + '-' + d.slice(10) : d; };
  const pesos = (v) => '$ ' + v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const FIRMA = 'VELAZQUEZ DIEGO MARTIN (CUIT 20-31092413-0)';

  async function traer(mes, modo) {
    const r = await fetch(FN, { method: 'POST', headers: HEADERS, body: JSON.stringify({ periodo: mes, modo }) });
    const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Error leyendo Odoo');
    return d;
  }

  function libro() {
    const wb = XLSX.utils.book_new();
    const hoja = (aoa, nombre, anchos, colsImporte) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = anchos.map(w => ({ wch: w }));
      for (const k of Object.keys(ws)) { const col = k.replace(/\d+$/, ''); if (ws[k] && typeof ws[k].v === 'number' && colsImporte.includes(col)) ws[k].z = '#,##0.00'; }
      XLSX.utils.book_append_sheet(wb, ws, nombre);
    };
    return { wb, hoja, base64: () => XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }) };
  }

  // ---------- Percepciones de IVA ----------
  async function percepIvaXlsx(mes) {
    const d = await traer(mes, 'iva'); const L = d.lineas; const per = nombreMes(mes);
    const total = r2(L.reduce((a, l) => a + l.importe, 0));
    const porReg = {}; for (const l of L) { const k = l.regimen_codigo + '|' + l.regimen; porReg[k] = r2((porReg[k] || 0) + l.importe); }
    const porAg = {}; for (const l of L) { const k = l.cuit + '|' + l.agente; porAg[k] = r2((porAg[k] || 0) + l.importe); }
    const { hoja, base64 } = libro();
    hoja([
      ['Percepciones de IVA sufridas — ' + FIRMA + ' — ' + per],
      [''],
      ['Para cargar a mano en la DDJJ de IVA (F.2051) → Percepciones: una fila por comprobante y régimen, con el CUIT del agente, la fecha, el comprobante y el importe.'],
      ['Total a computar en el período: ' + pesos(total) + ' (' + L.length + ' renglones).'],
      ...Object.entries(porReg).map(([k, v]) => ['   ' + k.split('|')[1] + ' (régimen ' + k.split('|')[0] + '): ' + pesos(v)]),
      ['Las notas de crédito figuran en NEGATIVO: anulan una percepción ya computada y hay que restarlas.'],
      ['Fuente: comprobantes de compra cargados en Odoo y conciliados contra Mis Comprobantes Recibidos de ARCA. Período = fecha del comprobante.'],
      ['Es el mismo total de percepciones que trae el Libro de IVA Compras de este período (campo "percepciones de IVA").'],
    ], 'Leeme', [150], []);
    const enc = ['Fecha', 'CUIT del agente', 'Agente de percepción', 'Tipo de comprobante', 'Código tipo', 'Letra', 'Punto de venta', 'Número', 'Comprobante completo', 'Código régimen', 'Régimen', 'Neto gravado del comprobante', 'Importe percibido'];
    const filas = L.map(l => [fechaAR(l.fecha), cuitFmt(l.cuit), l.agente, l.tipo, l.tipo_codigo, l.letra, l.pv, l.numero, l.numero_completo, l.regimen_codigo, l.regimen, l.base, l.importe]);
    hoja([enc, ...filas, ['', '', 'TOTAL', '', '', '', '', '', '', '', '', '', total]], 'Para cargar en ARCA', [11, 15, 30, 18, 10, 6, 13, 11, 19, 13, 34, 20, 17], ['L', 'M']);
    const res = [['CUIT del agente', 'Agente', 'Total percibido']];
    for (const [k, v] of Object.entries(porAg)) res.push([cuitFmt(k.split('|')[0]), k.split('|')[1], v]);
    res.push(['', 'TOTAL', total]);
    hoja(res, 'Resumen por agente', [15, 34, 17], ['C']);
    return { filename: `Percepciones de IVA - ${per}.xlsx`, base64: base64(), mimetype: XLSX_MIME, total, cantidad: L.length };
  }

  // ---------- Retenciones sufridas ----------
  async function retencionesXlsx(mes) {
    const d = await traer(mes, 'retenciones'); const L = d.lineas; const per = nombreMes(mes);
    const total = r2(L.reduce((a, l) => a + l.importe, 0));
    const porJur = {}; for (const l of L) { const k = [l.impuesto, l.jur_codigo, l.jurisdiccion, l.regimen].join('|'); porJur[k] = r2((porJur[k] || 0) + l.importe); }
    const { hoja, base64 } = libro();
    hoja([
      ['Retenciones sufridas — ' + FIRMA + ' — ' + per],
      [''],
      [L.length ? 'Total del período: ' + pesos(total) + ' (' + L.length + ' renglones), por impuesto, jurisdicción y régimen.' : 'En Odoo no hay retenciones cargadas para este período.'],
      ['IIBB: las de SIRTAC, SIRCREB (recaudaciones bancarias) y SIRCAR las informa el agente y SIFERE las importa; acá van para controlar lo que se descuenta en la CM03.'],
      ['Las retenciones que no estén en este listado pero tengan certificado (por ejemplo las de Pago Nube / dLocal) van adjuntas por separado.'],
      ['Fuente: asientos de cobro y de banco en Odoo. No incluye el uso de saldos en las liquidaciones de meses anteriores.'],
    ], 'Leeme', [150], []);
    const enc = ['Impuesto', 'Régimen', 'Código jur.', 'Jurisdicción', 'Fecha', 'CUIT del agente', 'Agente de retención', 'Asiento en Odoo', 'Detalle', 'Importe retenido'];
    const filas = L.map(l => [l.impuesto, l.regimen, l.jur_codigo, l.jurisdiccion, fechaAR(l.fecha), cuitFmt(l.cuit), l.agente, l.comprobante, l.detalle, l.importe]);
    hoja([enc, ...filas, ...(L.length ? [['', '', '', '', '', '', '', '', 'TOTAL', total]] : [])], 'Retenciones', [9, 26, 10, 18, 11, 15, 34, 18, 60, 16], ['J']);
    const res = [['Impuesto', 'Código jur.', 'Jurisdicción', 'Régimen', 'Total retenido']];
    for (const [k, v] of Object.entries(porJur)) { const [i, c, j, r] = k.split('|'); res.push([i, c, j, r, v]); }
    if (L.length) res.push(['', '', '', 'TOTAL', total]);
    hoja(res, 'Resumen por jurisdicción', [9, 10, 18, 26, 16], ['E']);
    return { filename: `Retenciones sufridas - ${per}.xlsx`, base64: base64(), mimetype: XLSX_MIME, total, cantidad: L.length, hayIva: L.some(l => l.impuesto !== 'IIBB') };
  }

  window.PercepRet = { percepIvaXlsx, retencionesXlsx };
})();
