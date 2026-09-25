/* =========================================================================
   Rosaint · CORE — shared/charts.js
   Toolkit de gráficos SVG animados, con brillo y tooltip. Sin librerías.
   Uso: <script src="../shared/charts.js"></script>  →  window.Charts.*
   Los colores se pasan como strings CSS (ej 'var(--accent)'), así siguen
   el tema claro/oscuro automáticamente.
   ========================================================================= */
(function () {
  const uid = () => 'c' + Math.random().toString(36).slice(2, 8);
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const x = Number(v); return isNaN(x) ? 0 : x; };

  // ---- Gráfico de tendencia: barras y/o líneas (con área y glow) --------
  // Charts.trend(el, {
  //   labels:['Mar',...],
  //   series:[ {name,type:'bar'|'line',values:[],color:'var(--accent)',area?:bool,glow?:bool} ],
  //   fmt?:v=>string, tipFmt?:(label,rowsHTML)=>string, height?, sharedScale?:bool })
  function trend(el, opts) {
    if (!el) return;
    const labels = opts.labels || [];
    const series = (opts.series || []).map(s => ({ ...s, values: (s.values || []).map(num) }));
    const n = labels.length;
    const W = opts.width || 560, H = opts.height || 230;
    const mL = 12, mR = 12, mT = 16, mB = 26, iw = W - mL - mR, ih = H - mT - mB;
    const fmt = opts.fmt || (v => Math.round(v).toLocaleString('es-AR'));
    const anim = !reduce();

    if (!n || !series.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Sin datos</div>'; return; }

    let sharedMax = 1;
    if (opts.sharedScale) sharedMax = Math.max(1, ...series.flatMap(s => s.values));
    series.forEach(s => { s._max = opts.sharedScale ? sharedMax : Math.max(1, ...s.values); });

    const xc = n > 1 ? (i => mL + iw * i / (n - 1)) : (() => mL + iw / 2);
    const yOf = (s, v) => mT + ih - ih * num(v) / s._max;

    const barSeries = series.filter(s => s.type === 'bar');
    const lineSeries = series.filter(s => s.type !== 'bar');
    const slot = iw / n;
    const bw = Math.min(42, (slot * 0.55) / Math.max(1, barSeries.length));

    let defs = '', body = '', axis = '', labelsSvg = '';
    axis += `<line x1="${mL}" y1="${mT + ih}" x2="${W - mR}" y2="${mT + ih}" stroke="var(--border)"/>`;

    // barras
    barSeries.forEach((s, bi) => {
      const off = (bi - (barSeries.length - 1) / 2) * bw;
      const gid = uid();
      defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}"/><stop offset="1" stop-color="${s.color}" stop-opacity=".55"/></linearGradient>`;
      s.values.forEach((v, i) => {
        const x = xc(i) + off, y = yOf(s, v), h = mT + ih - y;
        if (anim) {
          body += `<rect x="${x - bw / 2}" y="${mT + ih}" width="${bw}" height="0" rx="3" fill="url(#${gid})">
            <animate attributeName="y" to="${y}" dur=".7s" begin="${i * 0.04}s" fill="freeze" calcMode="spline" keySplines="0.22 0.7 0.3 1" keyTimes="0;1" values="${mT + ih};${y}"/>
            <animate attributeName="height" to="${h}" dur=".7s" begin="${i * 0.04}s" fill="freeze" calcMode="spline" keySplines="0.22 0.7 0.3 1" keyTimes="0;1" values="0;${h}"/></rect>`;
        } else {
          body += `<rect x="${x - bw / 2}" y="${y}" width="${bw}" height="${h}" rx="3" fill="url(#${gid})"/>`;
        }
      });
    });

    // líneas + área
    lineSeries.forEach(s => {
      let d = '', dots = '';
      s.values.forEach((v, i) => { d += (i ? 'L' : 'M') + xc(i) + ' ' + yOf(s, v); });
      const glow = s.glow !== false ? `filter:drop-shadow(0 0 6px color-mix(in srgb, ${s.color} 55%, transparent))` : '';
      if (s.area) {
        const gid = uid();
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
        const af = d + ` L${xc(n - 1)} ${mT + ih} L${xc(0)} ${mT + ih} Z`;
        body += `<path d="${af}" fill="url(#${gid})" opacity="${anim ? 0 : 1}">${anim ? '<animate attributeName="opacity" to="1" dur=".6s" begin=".35s" fill="freeze"/>' : ''}</path>`;
      }
      const dash = 2000;
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="${glow}"${anim ? ` stroke-dasharray="${dash}" stroke-dashoffset="${dash}"` : ''}>${anim ? `<animate attributeName="stroke-dashoffset" to="0" dur="1s" begin=".25s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" values="${dash};0"/>` : ''}</path>`;
      s.values.forEach((v, i) => {
        dots += `<circle cx="${xc(i)}" cy="${yOf(s, v)}" r="3.4" fill="${s.color}" style="${glow}"${anim ? ' opacity="0"' : ''}>${anim ? `<animate attributeName="opacity" to="1" dur=".25s" begin="${0.5 + i * 0.04}s" fill="freeze"/>` : ''}</circle>`;
      });
      body += dots;
    });

    labels.forEach((lb, i) => { labelsSvg += `<text x="${xc(i)}" y="${mT + ih + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(lb)}</text>`; });
    const guide = `<line class="ch-guide" x1="0" y1="${mT}" x2="0" y2="${mT + ih}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/>`;

    el.style.position = 'relative';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible"><defs>${defs}</defs>${axis}${body}${labelsSvg}${guide}</svg><div class="ch-tip" style="position:absolute;pointer-events:none;background:var(--surface-2,#222);border:1px solid var(--border,#333);color:var(--text,#fff);font-size:11.5px;font-weight:600;padding:7px 10px;border-radius:8px;opacity:0;transform:translate(-50%,-8px);transition:opacity .12s;white-space:nowrap;box-shadow:var(--shadow,0 6px 20px rgba(0,0,0,.2));z-index:5"></div>`;

    // tooltip
    const svg = el.querySelector('svg'), tip = el.querySelector('.ch-tip'), gl = el.querySelector('.ch-guide');
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      let i = Math.round(((e.clientX - r.left) / r.width * W - mL) / iw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      const rows = series.map(s => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name || '')} <b>${fmt(s.values[i])}</b>`).join('<br>');
      gl.setAttribute('x1', xc(i)); gl.setAttribute('x2', xc(i)); gl.setAttribute('opacity', '.55');
      tip.style.opacity = '1';
      tip.style.left = (xc(i) / W * r.width) + 'px';
      tip.style.top = (mT / H * r.height) + 'px';
      tip.innerHTML = opts.tipFmt ? opts.tipFmt(labels[i], rows) : `<div style="margin-bottom:3px">${esc(labels[i])}</div>${rows}`;
    });
    svg.addEventListener('mouseleave', () => { tip.style.opacity = '0'; gl.setAttribute('opacity', '0'); });
  }

  // ---- Anillo (donut) animado -------------------------------------------
  // Charts.donut(el, { segments:[{label,value,color}], centerBig?, centerSmall?, size? })
  function donut(el, opts) {
    if (!el) return;
    const segs = (opts.segments || []).map(s => ({ ...s, value: num(s.value) }));
    const size = opts.size || 150, R = size * 0.35, C = 2 * Math.PI * R, cc = size / 2;
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;
    const anim = !reduce();
    let ring = `<circle cx="${cc}" cy="${cc}" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="${size * 0.1}"/>`;
    let off = 0;
    segs.forEach((s, i) => {
      const len = C * s.value / total;
      ring += `<circle cx="${cc}" cy="${cc}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${size * 0.1}" stroke-linecap="round" stroke-dasharray="${anim ? 0 : len} ${anim ? C : C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cc} ${cc})" style="filter:drop-shadow(0 0 6px color-mix(in srgb, ${s.color} 45%, transparent))">${anim ? `<animate attributeName="stroke-dasharray" from="0 ${C}" to="${len} ${C - len}" dur=".9s" begin="${0.3 + i * 0.15}s" fill="freeze" calcMode="spline" keySplines="0.3 0.7 0.3 1" keyTimes="0;1"/>` : ''}</circle>`;
      off += len;
    });
    const center = (opts.centerBig != null || opts.centerSmall != null)
      ? `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center"><div><div style="font-size:${size * 0.15}px;font-weight:850;letter-spacing:-.02em">${esc(opts.centerBig || '')}</div><div style="font-size:${size * 0.07}px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${esc(opts.centerSmall || '')}</div></div></div>` : '';
    el.style.position = 'relative';
    el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;display:block">${ring}</svg>${center}`;
  }

  // ---- Sparkline (mini línea) -------------------------------------------
  function sparkline(el, values, opts) {
    if (!el) return;
    opts = opts || {};
    const v = (values || []).map(num); if (v.length < 2) { el.innerHTML = ''; return; }
    const W = 120, H = 36, mx = Math.max(...v), mn = Math.min(...v), rng = (mx - mn) || 1;
    const color = opts.color || 'var(--accent)';
    let d = ''; v.forEach((y, i) => { d += (i ? 'L' : 'M') + (i / (v.length - 1) * W) + ' ' + (H - ((y - mn) / rng) * (H - 6) - 3); });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" opacity=".6" style="filter:drop-shadow(0 0 4px color-mix(in srgb, ${color} 55%, transparent))"/></svg>`;
  }

  // ---- Count-up de números ----------------------------------------------
  // Anima un elemento con data-n (número destino). data-pre / data-suf / data-money('1'|'M')
  function countUp(el, dur) {
    if (!el) return;
    if (reduce()) { render(1); return; }
    const n = num(el.dataset.n), pre = el.dataset.pre || '', suf = el.dataset.suf || '', money = el.dataset.money, dec = +el.dataset.dec || 0;
    dur = dur || 950; const t0 = performance.now();
    function render(p) {
      const e = 1 - Math.pow(1 - p, 3); let val = n * e, s;
      if (money === 'M') s = (val / 1e6).toFixed(1) + 'M';
      else s = val.toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      el.textContent = pre + s + suf;
    }
    function step(t) { const p = Math.min(1, (t - t0) / dur); render(p); if (p < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  function countUpAll(root) { (root || document).querySelectorAll('[data-n]').forEach(e => countUp(e)); }

  window.Charts = { trend, donut, sparkline, countUp, countUpAll };
})();
