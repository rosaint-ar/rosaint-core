/* =========================================================================
   Rosaint · CORE — shared/charts.js
   Toolkit de gráficos SVG animados, con brillo y tooltip. Sin librerías.
   Uso: <script src="../shared/charts.js"></script>  →  window.Charts.*
   Los colores se pasan como strings CSS (ej 'var(--accent)'), así siguen
   el tema claro/oscuro automáticamente.
   El gráfico de tendencia se dibuja al ANCHO REAL del contenedor (1:1, sin
   escalar el texto) y se re-dibuja solo cuando ese ancho cambia.
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
  //   fmt?:v=>string, height?, sharedScale?:bool, rotateLabels?:bool })
  function trend(el, opts) {
    if (!el) return;
    const labels = opts.labels || [];
    const series = (opts.series || []).map(s => ({ ...s, values: (s.values || []).map(num) }));
    const n = labels.length;
    const H = opts.height || 240;
    const fmt = opts.fmt || (v => Math.round(v).toLocaleString('es-AR'));
    const rot = !!opts.rotateLabels;
    let first = true;

    if (!n || !series.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Sin datos</div>'; return; }

    let sharedMax = 1;
    if (opts.sharedScale) sharedMax = Math.max(1, ...series.flatMap(s => s.values));
    series.forEach(s => { s._max = opts.sharedScale ? sharedMax : Math.max(1, ...s.values); });

    function draw() {
      const W = Math.max(320, Math.floor(el.clientWidth) || opts.width || 620);
      const anim = first && !reduce();
      const mL = 12, mR = 12, mT = 16, mB = rot ? 52 : 26, iw = W - mL - mR, ih = H - mT - mB;
      const xc = n > 1 ? (i => mL + iw * i / (n - 1)) : (() => mL + iw / 2);
      const yOf = (s, v) => mT + ih - ih * num(v) / s._max;
      const barSeries = series.filter(s => s.type === 'bar');
      const lineSeries = series.filter(s => s.type !== 'bar');
      const slot = iw / n;
      const bw = Math.min(46, (slot * 0.6) / Math.max(1, barSeries.length));

      let defs = '', body = '', labelsSvg = '';
      let axis = `<line x1="${mL}" y1="${mT + ih}" x2="${W - mR}" y2="${mT + ih}" stroke="var(--border)"/>`;

      barSeries.forEach((s, bi) => {
        const off = (bi - (barSeries.length - 1) / 2) * bw;
        const gid = uid();
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}"/><stop offset="1" stop-color="${s.color}" stop-opacity=".55"/></linearGradient>`;
        s.values.forEach((v, i) => {
          const x = xc(i) + off, y = yOf(s, v), h = Math.max(0, mT + ih - y);
          if (anim) body += `<rect x="${x - bw / 2}" y="${mT + ih}" width="${bw}" height="0" rx="3" fill="url(#${gid})"><animate attributeName="y" to="${y}" dur=".7s" begin="${i * 0.04}s" fill="freeze" calcMode="spline" keySplines="0.22 0.7 0.3 1" keyTimes="0;1" values="${mT + ih};${y}"/><animate attributeName="height" to="${h}" dur=".7s" begin="${i * 0.04}s" fill="freeze" calcMode="spline" keySplines="0.22 0.7 0.3 1" keyTimes="0;1" values="0;${h}"/></rect>`;
          else body += `<rect x="${x - bw / 2}" y="${y}" width="${bw}" height="${h}" rx="3" fill="url(#${gid})"/>`;
        });
      });

      lineSeries.forEach(s => {
        let d = '', dots = '';
        s.values.forEach((v, i) => { d += (i ? 'L' : 'M') + xc(i) + ' ' + yOf(s, v); });
        const glow = s.glow !== false ? `filter:drop-shadow(0 0 6px color-mix(in srgb, ${s.color} 55%, transparent))` : '';
        if (s.area) {
          const gid = uid();
          defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
          body += `<path d="${d} L${xc(n - 1)} ${mT + ih} L${xc(0)} ${mT + ih} Z" fill="url(#${gid})" opacity="${anim ? 0 : 1}">${anim ? '<animate attributeName="opacity" to="1" dur=".6s" begin=".35s" fill="freeze"/>' : ''}</path>`;
        }
        const dash = W * 3;
        body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="${glow}"${anim ? ` stroke-dasharray="${dash}" stroke-dashoffset="${dash}"` : ''}>${anim ? `<animate attributeName="stroke-dashoffset" to="0" dur="1s" begin=".25s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" values="${dash};0"/>` : ''}</path>`;
        s.values.forEach((v, i) => { dots += `<circle cx="${xc(i)}" cy="${yOf(s, v)}" r="3.4" fill="${s.color}" style="${glow}"${anim ? ' opacity="0"' : ''}>${anim ? `<animate attributeName="opacity" to="1" dur=".25s" begin="${0.5 + i * 0.04}s" fill="freeze"/>` : ''}</circle>`; });
        body += dots;
      });

      labels.forEach((lb, i) => {
        const lx = xc(i), ly = mT + ih + 15;
        if (rot) labelsSvg += `<text x="${lx}" y="${ly}" text-anchor="end" font-size="10.5" fill="var(--muted)" transform="rotate(-30 ${lx} ${ly})">${esc(lb)}</text>`;
        else labelsSvg += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(lb)}</text>`;
      });

      el.style.position = 'relative';
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:${H}px;display:block;overflow:visible"><defs>${defs}</defs>${axis}${body}${labelsSvg}<line class="ch-guide" x1="0" y1="${mT}" x2="0" y2="${mT + ih}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/></svg><div class="ch-tip" style="position:absolute;pointer-events:none;background:var(--surface-2,#222);border:1px solid var(--border,#333);color:var(--text,#fff);font-size:11.5px;font-weight:600;padding:7px 10px;border-radius:8px;opacity:0;transform:translate(-50%,-8px);transition:opacity .12s;white-space:nowrap;box-shadow:var(--shadow,0 6px 20px rgba(0,0,0,.2));z-index:5"></div>`;

      const svg = el.querySelector('svg'), tip = el.querySelector('.ch-tip'), gl = el.querySelector('.ch-guide');
      svg.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        let i = Math.round(((e.clientX - r.left) / r.width * W - mL) / iw * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        const rows = series.map(s => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name || '')} <b>${fmt(s.values[i])}</b>`).join('<br>');
        gl.setAttribute('x1', xc(i)); gl.setAttribute('x2', xc(i)); gl.setAttribute('opacity', '.55');
        tip.style.opacity = '1';
        tip.style.left = (xc(i) / W * r.width) + 'px';
        tip.style.top = '2px';
        tip.innerHTML = `<div style="margin-bottom:3px">${esc(labels[i])}</div>${rows}`;
      });
      svg.addEventListener('mouseleave', () => { tip.style.opacity = '0'; gl.setAttribute('opacity', '0'); });
      first = false;
    }

    draw();
    // Re-dibuja cuando cambia el ancho real (ej. cuando el shell acomoda la
    // página o al redimensionar). Sin animación en los redibujos.
    if (window.ResizeObserver) {
      let lastW = Math.floor(el.clientWidth), t = 0;
      const ro = new ResizeObserver(() => {
        const w = Math.floor(el.clientWidth);
        if (Math.abs(w - lastW) < 6) return;
        lastW = w; clearTimeout(t); t = setTimeout(draw, 90);
      });
      try { ro.observe(el); } catch (_e) { /* */ }
    }
  }

  // ---- Anillo (donut) animado -------------------------------------------
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
    el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;display:block">${ring}</svg>${center}`;
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
  function countUp(el, dur) {
    if (!el) return;
    const n = num(el.dataset.n), pre = el.dataset.pre || '', suf = el.dataset.suf || '', money = el.dataset.money, dec = +el.dataset.dec || 0;
    const render = (p) => { const e = 1 - Math.pow(1 - p, 3); let val = n * e, s; if (money === 'M') s = (val / 1e6).toFixed(1) + 'M'; else s = val.toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }); el.textContent = pre + s + suf; };
    if (reduce()) { render(1); return; }
    dur = dur || 950; const t0 = performance.now();
    function step(t) { const p = Math.min(1, (t - t0) / dur); render(p); if (p < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  function countUpAll(root) { (root || document).querySelectorAll('[data-n]').forEach(e => countUp(e)); }

  // ---- Curva suave (Catmull-Rom → Bézier) -------------------------------
  function smoothPath(pts) {
    if (pts.length < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
    let d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const t = 0.16;
      const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
      const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
      d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
    }
    return d;
  }
  const nice = (v) => {
    v = Math.abs(v); if (!v) return '0';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(v));
  };

  // ---- Área / líneas suaves con grilla (tendencias mensuales) -----------
  // Charts.area(el, { labels, series:[{name,values,color,fill?,width?}], fmt, height, prefix? })
  function area(el, opts) {
    if (!el) return;
    const labels = opts.labels || [];
    const series = (opts.series || []).map((s, i) => ({ fill: i === 0, ...s, values: (s.values || []).map(num) }));
    const n = labels.length;
    const H = opts.height || 230;
    const fmt = opts.fmt || (v => Math.round(v).toLocaleString('es-AR'));
    const pfx = opts.prefix || '';
    let first = true;
    if (!n || !series.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Sin datos</div>'; return; }
    const maxV = Math.max(1, ...series.flatMap(s => s.values));

    function draw() {
      const W = Math.max(320, Math.floor(el.clientWidth) || opts.width || 620);
      const anim = first && !reduce();
      const mL = 42, mR = 14, mT = 14, mB = 26, iw = W - mL - mR, ih = H - mT - mB;
      const xc = n > 1 ? (i => mL + iw * i / (n - 1)) : (() => mL + iw / 2);
      const yOf = v => mT + ih - ih * num(v) / maxV;
      let defs = '', grid = '', body = '', xl = '';
      // grilla horizontal + labels del eje Y
      [0, .25, .5, .75, 1].forEach(g => {
        const y = mT + ih - ih * g;
        grid += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="var(--border)" stroke-opacity="${g === 0 ? 1 : .5}"/>`;
        grid += `<text x="${mL - 8}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${pfx}${nice(maxV * g)}</text>`;
      });
      series.forEach(s => {
        const pts = s.values.map((v, i) => [xc(i), yOf(v)]);
        const dPath = smoothPath(pts);
        const glow = `filter:drop-shadow(0 0 6px color-mix(in srgb, ${s.color} 50%, transparent))`;
        if (s.fill) {
          const gid = uid();
          defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".30"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
          body += `<path d="${dPath} L${xc(n - 1)} ${mT + ih} L${xc(0)} ${mT + ih} Z" fill="url(#${gid})" opacity="${anim ? 0 : 1}">${anim ? '<animate attributeName="opacity" to="1" dur=".7s" begin=".3s" fill="freeze"/>' : ''}</path>`;
        }
        const dash = W * 3;
        body += `<path d="${dPath}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.6}" stroke-linecap="round" stroke-linejoin="round" style="${glow}"${anim ? ` stroke-dasharray="${dash}" stroke-dashoffset="${dash}"` : ''}>${anim ? `<animate attributeName="stroke-dashoffset" to="0" dur="1.05s" begin=".15s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" values="${dash};0"/>` : ''}</path>`;
        pts.forEach((p, i) => { body += `<circle cx="${p[0]}" cy="${p[1]}" r="3.1" fill="var(--surface)" stroke="${s.color}" stroke-width="2" style="${glow}"${anim ? ' opacity="0"' : ''}>${anim ? `<animate attributeName="opacity" to="1" dur=".25s" begin="${0.55 + i * 0.03}s" fill="freeze"/>` : ''}</circle>`; });
      });
      labels.forEach((lb, i) => { xl += `<text x="${xc(i)}" y="${mT + ih + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(lb)}</text>`; });
      el.style.position = 'relative';
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:${H}px;display:block;overflow:visible"><defs>${defs}</defs>${grid}${body}${xl}<line class="ch-guide" x1="0" y1="${mT}" x2="0" y2="${mT + ih}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/></svg><div class="ch-tip" style="position:absolute;pointer-events:none;background:var(--surface-2,#222);border:1px solid var(--border,#333);color:var(--text,#fff);font-size:11.5px;font-weight:600;padding:7px 10px;border-radius:8px;opacity:0;transform:translate(-50%,-8px);transition:opacity .12s;white-space:nowrap;box-shadow:var(--shadow,0 6px 20px rgba(0,0,0,.2));z-index:5"></div>`;
      const svg = el.querySelector('svg'), tip = el.querySelector('.ch-tip'), gl = el.querySelector('.ch-guide');
      svg.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        let i = Math.round(((e.clientX - r.left) / r.width * W - mL) / iw * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        const rows = series.map(s => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name || '')} <b>${fmt(s.values[i])}</b>`).join('<br>');
        gl.setAttribute('x1', xc(i)); gl.setAttribute('x2', xc(i)); gl.setAttribute('opacity', '.55');
        tip.style.opacity = '1'; tip.style.left = (xc(i) / W * r.width) + 'px'; tip.style.top = '2px';
        tip.innerHTML = `<div style="margin-bottom:3px">${esc(labels[i])}</div>${rows}`;
      });
      svg.addEventListener('mouseleave', () => { tip.style.opacity = '0'; gl.setAttribute('opacity', '0'); });
      first = false;
    }
    draw();
    if (window.ResizeObserver) { let lw = Math.floor(el.clientWidth), t = 0; const ro = new ResizeObserver(() => { const w = Math.floor(el.clientWidth); if (Math.abs(w - lw) < 6) return; lw = w; clearTimeout(t); t = setTimeout(draw, 90); }); try { ro.observe(el); } catch (_e) { } }
  }

  // ---- Ranking de barras horizontales (categorías / provincias) ----------
  // Charts.barsH(el, { items:[{label,value}], color?, fmt? })   (HTML, texto nítido)
  function barsH(el, opts) {
    if (!el) return;
    const items = (opts.items || []).map(it => ({ ...it, value: num(it.value) }));
    const fmt = opts.fmt || (v => Math.round(v).toLocaleString('es-AR'));
    const color = opts.color || 'var(--accent)';
    if (!items.length) { el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Sin datos</div>'; return; }
    const max = Math.max(1, ...items.map(i => i.value));
    const anim = !reduce();
    el.innerHTML = '<div style="display:flex;flex-direction:column;gap:9px">' + items.map(it => {
      const pct = Math.max(2, Math.round(it.value / max * 100));
      return `<div style="display:flex;align-items:center;gap:12px">
        <span style="width:34%;max-width:190px;flex-shrink:0;font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.label)}">${esc(it.label)}</span>
        <span style="flex:1;height:13px;border-radius:7px;background:var(--surface-2);overflow:hidden"><span class="chbh-fill" style="display:block;height:100%;border-radius:7px;background:linear-gradient(90deg, color-mix(in srgb, ${color} 78%, transparent), ${color});box-shadow:0 0 10px -3px ${color};width:${anim ? 0 : pct}%;transition:width .8s cubic-bezier(.22,.7,.3,1)" data-w="${pct}"></span></span>
        <span style="width:66px;text-align:right;font-weight:750;font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--text)">${fmt(it.value)}</span>
      </div>`;
    }).join('') + '</div>';
    if (anim) requestAnimationFrame(() => requestAnimationFrame(() => { el.querySelectorAll('.chbh-fill').forEach(f => { f.style.width = f.dataset.w + '%'; }); }));
  }

  window.Charts = { trend, area, barsH, donut, sparkline, countUp, countUpAll };
})();

