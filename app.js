'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const DEFAULTS = {
    mode: 'color', k: 8, layers: 4, spacing: 'fit',
    style: 'soft', geo: 4, minSize: 50, clean: 2, smooth: 'painterly', amount: 4, size: '700',
    order: 'dark', overlap: 5, details: true,
    show: 'shapes', view: 'build', outlines: false, numbers: false, grid: '0',
  };
  const STORE = 'shapeStudy.opts';
  let opts = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const key in DEFAULTS) if (typeof saved[key] === typeof DEFAULTS[key]) opts[key] = saved[key];
  } catch (e) { /* private mode */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(opts)); } catch (e) { /* ignore */ } };

  const ORDER_HINTS = {
    dark: 'Block in the darks first, then work up to the lights.',
    light: 'Start with the lights and finish with the darkest accents.',
    size: 'Largest masses first, details last.',
    depth: 'A guess at background first, subject last, based on where shapes sit in the frame.',
  };
  const overlapHint = v => v === 0
    ? 'Off: each shape is only its visible part, fitted together like a puzzle.'
    : 'Each layer is laid down as a bolder mass that runs under the next layers, which then paint over it.';
  const minFrac = v => 0.00005 * Math.pow(600, v / 100);

  // ---------- state ----------
  let source = null, sourceId = 0;
  const cache = {};
  let result = null; // { R, P, shapes, paths }
  let step = 0, focusColor = -1;

  // ---------- controls ----------
  function syncControls() {
    document.querySelectorAll('.seg[data-opt]').forEach(seg => {
      const v = String(opts[seg.dataset.opt]);
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    });
    document.querySelectorAll('input[data-opt]').forEach(inp => {
      if (inp.type === 'checkbox') inp.checked = !!opts[inp.dataset.opt];
      else inp.value = opts[inp.dataset.opt];
    });
    document.querySelectorAll('[data-show]').forEach(el => {
      const m = el.dataset.show.match(/^(\w+)(!?=)(\w+)$/);
      const eq = String(opts[m[1]]) === m[3];
      el.classList.toggle('hide', m[2] === '=' ? !eq : eq);
    });
    $('kOut').textContent = opts.k;
    $('layersOut').textContent = opts.layers >= opts.k && (opts.order === 'dark' || opts.order === 'light') ? 'one per color' : opts.layers;
    $('overlapOut').textContent = opts.overlap === 0 ? 'off' : opts.overlap <= 3 ? `${opts.overlap} · subtle` : opts.overlap <= 7 ? `${opts.overlap} · bold` : `${opts.overlap} · very bold`;
    $('geoOut').textContent = opts.geo;
    $('cleanOut').textContent = opts.clean === 0 ? 'off' : opts.clean;
    $('amountOut').textContent = opts.amount;
    const f = minFrac(opts.minSize) * 100;
    $('minSizeOut').textContent = (f < 0.1 ? f.toFixed(3) : f < 1 ? f.toFixed(2) : f.toFixed(1)) + '% of picture';
    $('orderHint').textContent = ORDER_HINTS[opts.order];
    $('overlapHint').textContent = overlapHint(opts.overlap);
  }

  const PROCESS_KEYS = ['mode', 'k', 'layers', 'spacing', 'style', 'geo', 'minSize', 'clean', 'smooth', 'amount', 'size', 'order', 'overlap', 'details'];
  function setOpt(name, value) {
    opts[name] = value;
    save(); syncControls();
    if (PROCESS_KEYS.includes(name)) schedule(); else render();
  }

  document.querySelectorAll('.seg[data-opt]').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const name = seg.dataset.opt;
      setOpt(name, typeof DEFAULTS[name] === 'number' ? Number(b.dataset.v) : b.dataset.v);
    });
  });
  document.querySelectorAll('input[data-opt]').forEach(inp => {
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      setOpt(inp.dataset.opt, inp.type === 'checkbox' ? inp.checked : Number(inp.value));
    });
  });
  $('reset').addEventListener('click', () => {
    opts = { ...DEFAULTS }; save(); syncControls(); schedule();
  });

  // ---------- loading ----------
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200);
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('That file isn’t an image.'); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { setSource(im); URL.revokeObjectURL(url); };
    im.onerror = () => { toast('This image type can’t be opened here. Try a JPG or PNG.'); URL.revokeObjectURL(url); };
    im.src = url;
  }

  function setSource(src) {
    source = src; sourceId++;
    step = Infinity; focusColor = -1;
    $('empty').classList.add('hide');
    $('canvases').classList.remove('hide');
    $('stepbar').classList.remove('hide');
    $('savePng').disabled = $('saveSvg').disabled = false;
    schedule(0);
  }

  ['file', 'file2'].forEach(id => $(id).addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; }));
  ['sample', 'sample2'].forEach(id => $(id).addEventListener('click', () => setSource(makeSample())));
  const stage = $('stage');
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', e => {
    e.preventDefault(); stage.classList.remove('drag');
    loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // ---------- processing ----------
  let timer = 0;
  function schedule(delay = 180) {
    if (!source) return;
    $('busy').classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => requestAnimationFrame(() => setTimeout(processNow, 0)), delay);
  }

  function stage_(name, key, fn) {
    if (cache[name] && cache[name].key === key) return cache[name].val;
    const val = fn();
    cache[name] = { key, val };
    return val;
  }

  function processNow() {
    try {
      const k1 = [sourceId, opts.size, opts.smooth, opts.amount].join('|');
      const prep = stage_('prep', k1, () => Shapes.prepare(source, Number(opts.size), opts.smooth, opts.amount));
      const k2 = [k1, opts.mode, opts.k, opts.spacing].join('|');
      const quant = stage_('quant', k2, () => Shapes.quantize(prep, opts.k, opts.mode, opts.spacing));
      const k3 = [k2, opts.minSize, opts.clean].join('|');
      const R = stage_('regions', k3, () => Shapes.buildRegions(prep, quant, minFrac(opts.minSize), opts.clean));
      const k4 = [k3, opts.order, opts.layers, opts.details].join('|');
      const P = stage_('plan', k4, () => Shapes.plan(R, opts.order, opts.layers, opts.details));
      const k5 = [k4, opts.overlap, opts.style, opts.geo].join('|');
      const shapes = stage_('shapes', k5, () => {
        const list = Shapes.vectorize(R, P, opts.overlap, opts.style, opts.geo);
        list.forEach(s => { s.path = new Path2D(Shapes.pathData(s.loops, 2)); });
        return list;
      });
      const last = P.steps.length - 1;
      if (!result || result.P !== P) step = Math.min(step, last);
      if (step === Infinity || step > last) step = last;
      if (focusColor >= R.palette.length) focusColor = -1;
      result = { prep, R, P, shapes };
      buildPalette();
      render();
    } catch (err) {
      console.error(err);
      toast('Something went wrong processing this photo.');
    }
    $('busy').classList.remove('on');
  }

  // ---------- drawing ----------
  const cvS = $('cvShapes'), cvP = $('cvPhoto');

  function layout() {
    if (!result) return null;
    const { w, h } = result.R;
    const pad = 24, gap = 12;
    // on narrow screens the frame hugs the picture instead of a fixed height
    if (window.innerWidth <= 900) {
      const W0 = stage.clientWidth - pad * 2;
      const need = (opts.show === 'both' ? 2 * W0 * h / w + gap : W0 * h / w) + pad * 2;
      stage.style.height = Math.round(Math.max(200, Math.min(window.innerHeight * 0.75, need))) + 'px';
    } else stage.style.height = '';
    const box = stage.getBoundingClientRect();
    const W = box.width - pad * 2, H = box.height - pad * 2;
    const both = opts.show === 'both';
    let cw, stack = false;
    if (!both) cw = Math.min(W, H * w / h);
    else {
      const side = Math.min((W - gap) / 2, H * w / h);
      const stacked = Math.min(W, ((H - gap) / 2) * w / h);
      stack = stacked > side; cw = Math.max(side, stacked);
    }
    cw = Math.max(40, Math.floor(cw));
    const ch = Math.round(cw * h / w);
    $('canvases').classList.toggle('stack', stack);
    return { cw, ch };
  }

  function sizeCanvas(cv, cw, ch, show) {
    cv.classList.toggle('hide', !show);
    if (!show) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    return cv.getContext('2d');
  }

  function render() {
    if (!result) return;
    const L = layout(); if (!L) return;
    const showShapes = opts.show !== 'photo', showPhoto = opts.show !== 'shapes';
    const cs = sizeCanvas(cvS, L.cw, L.ch, showShapes);
    const cp = sizeCanvas(cvP, L.cw, L.ch, showPhoto);
    if (cs) drawShapes(cs, cvS.width, cvS.height, opts);
    if (cp) {
      cp.setTransform(1, 0, 0, 1, 0, 0);
      cp.imageSmoothingQuality = 'high';
      cp.drawImage(result.prep.photo, 0, 0, cvP.width, cvP.height);
      drawGrid(cp, cvP.width, cvP.height, Number(opts.grid));
    }
    updateStepbar();
  }

  function drawShapes(ctx, W, H, o, forExport) {
    const { R, P, shapes } = result, pal = R.palette;
    const s = W / R.w;
    const ground = '#fbfaf7';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ground; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.lineJoin = o.style === 'geometric' ? 'miter' : 'round';
    ctx.miterLimit = 3;
    // thin stroke in the shape's own color hides hairline gaps between neighbors
    const seam = o.style === 'pixel' ? 0.3 : o.style === 'geometric' ? 1.2 : 0.8;
    const paint = list => list.forEach(sh => {
      const c = pal[sh.color].hex;
      ctx.fillStyle = c; ctx.fill(sh.path, 'evenodd');
      ctx.strokeStyle = c; ctx.lineWidth = seam; ctx.stroke(sh.path);
    });
    const outline = (list, color, px) => {
      ctx.strokeStyle = color; ctx.lineWidth = px / s;
      list.forEach(sh => ctx.stroke(sh.path));
    };
    const veil = () => {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(251,250,247,.72)'; ctx.fillRect(0, 0, W, H); ctx.restore();
    };
    const dpr = forExport ? 1 : Math.min(window.devicePixelRatio || 1, 3);
    const cur = forExport ? P.steps.length - 1 : step;
    const before = shapes.filter(sh => sh.step < cur);
    const now = shapes.filter(sh => sh.step === cur);
    let visible;
    if (o.view === 'alone' && !forExport) { paint(now); visible = now; }
    else { paint(before); if (o.view === 'highlight' && !forExport && cur > 0) veil(); paint(now); visible = before.concat(now); }

    if (o.outlines) outline(visible, 'rgba(30,25,20,.55)', 0.9 * dpr);
    if (o.view === 'highlight' && !forExport) outline(now, '#d9481f', 1.8 * dpr);

    if (focusColor >= 0 && !forExport) {
      veil();
      const f = visible.filter(sh => sh.color === focusColor);
      paint(f); outline(f, '#d9481f', 1.8 * dpr);
    }
    if (o.numbers) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      visible.forEach(sh => {
        const r = sh.lr * s;
        if (r < 6 * dpr) return;
        if (focusColor >= 0 && sh.color !== focusColor) return;
        const fs = Math.max(9 * dpr, Math.min(r * 1.1, 22 * dpr));
        ctx.font = `600 ${fs}px ui-sans-serif, -apple-system, system-ui, sans-serif`;
        ctx.fillStyle = pal[sh.color].lab[0] > 58 ? 'rgba(20,18,15,.8)' : 'rgba(255,255,255,.9)';
        ctx.fillText(String(sh.color + 1), sh.lx * s, sh.ly * s);
      });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawGrid(ctx, W, H, Number(o.grid), dpr);
  }

  function drawGrid(ctx, W, H, n, dpr = Math.min(window.devicePixelRatio || 1, 3)) {
    if (!n) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lines = () => {
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        const x = Math.round(W * i / n) + 0.5, y = Math.round(H * i / n) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2.5 * dpr; lines();
    ctx.strokeStyle = 'rgba(20,18,15,.6)'; ctx.lineWidth = 1 * dpr; lines();
    ctx.restore();
  }

  // ---------- step bar & palette ----------
  function updateStepbar() {
    const { P, shapes, R } = result;
    const n = P.steps.length, st = P.steps[step];
    $('stepSlider').max = n - 1;
    $('stepSlider').value = step;
    $('prev').disabled = step <= 0;
    $('next').disabled = step >= n - 1;
    $('stepTitle').textContent = `Step ${step + 1} of ${n} · ${st.name}`;
    const inStep = shapes.filter(s => s.step === step);
    const colors = [...new Set(inStep.map(s => s.color))].sort((a, b) => a - b);
    $('stepMeta').textContent = `${inStep.length} shape${inStep.length === 1 ? '' : 's'} · ${colors.length} color${colors.length === 1 ? '' : 's'}`;
    $('stepSw').innerHTML = colors.map(c => `<i title="Color ${c + 1}" style="background:${R.palette[c].hex}"></i>`).join('');
  }

  function buildPalette() {
    const pal = result.R.palette;
    $('palette').innerHTML = pal.map((c, i) => {
      const v = (c.lab[0] / 10).toFixed(1);
      const txt = c.lab[0] > 58 ? '#1a1815' : '#fff';
      return `<button class="chipc${i === focusColor ? ' on' : ''}" data-c="${i}" title="Click to highlight this color">
        <i style="background:${c.hex};color:${txt}">${i + 1}</i>
        <div><b>${c.hex.toUpperCase()}</b><br><span>value ${v} · ${(c.area * 100).toFixed(1)}%</span></div></button>`;
    }).join('');
  }
  $('palette').addEventListener('click', e => {
    const b = e.target.closest('.chipc'); if (!b) return;
    const c = Number(b.dataset.c);
    focusColor = focusColor === c ? -1 : c;
    buildPalette(); render();
  });

  const go = d => { if (!result) return; step = Math.max(0, Math.min(result.P.steps.length - 1, step + d)); render(); };
  $('prev').addEventListener('click', () => go(-1));
  $('next').addEventListener('click', () => go(1));
  $('stepSlider').addEventListener('input', e => { step = Number(e.target.value); render(); });
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'Escape' && focusColor >= 0) { focusColor = -1; buildPalette(); render(); }
  });
  let rt = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(render); });

  // ---------- saving ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('savePng').addEventListener('click', () => {
    if (!result) return;
    const { w, h } = result.R;
    const scale = Math.max(1, 2000 / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    const ctx = cv.getContext('2d');
    if (opts.show === 'photo') { ctx.drawImage(result.prep.photo, 0, 0, cv.width, cv.height); drawGrid(ctx, cv.width, cv.height, Number(opts.grid), scale / 2); }
    else drawShapes(ctx, cv.width, cv.height, opts, false);
    cv.toBlob(b => download(b, `shape-study-step-${step + 1}.png`), 'image/png');
  });
  $('saveSvg').addEventListener('click', () => {
    if (!result) return;
    const { R, P, shapes } = result;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${R.w} ${R.h}" width="${R.w * 2}" height="${R.h * 2}">\n`;
    svg += `<rect width="${R.w}" height="${R.h}" fill="#fbfaf7"/>\n`;
    P.steps.forEach((st, i) => {
      svg += `<g id="step-${i + 1}" data-name="Step ${i + 1} - ${esc(st.name)}">\n`;
      shapes.filter(s => s.step === i).forEach(s => {
        const c = R.palette[s.color].hex;
        svg += `<path d="${Shapes.pathData(s.loops)}" fill="${c}" fill-rule="evenodd" stroke="${c}" stroke-width="0.6" stroke-linejoin="round" data-color="${s.color + 1}"/>\n`;
      });
      svg += '</g>\n';
    });
    svg += '</svg>';
    download(new Blob([svg], { type: 'image/svg+xml' }), 'shape-study-layers.svg');
  });

  // ---------- sample still life (drawn in code, so no photo is needed) ----------
  function makeSample() {
    const W = 960, H = 720, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    let g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#8b8579'); g.addColorStop(1, '#4a463f');
    c.fillStyle = g; c.fillRect(0, 0, W, H * 0.62);
    g = c.createLinearGradient(0, H * 0.62, 0, H);
    g.addColorStop(0, '#7a5a3f'); g.addColorStop(1, '#4e3827');
    c.fillStyle = g; c.fillRect(0, H * 0.62, W, H);
    // cloth
    c.fillStyle = '#d9d2c3';
    c.beginPath(); c.moveTo(80, H * 0.66); c.bezierCurveTo(300, H * 0.6, 520, H * 0.72, 700, H * 0.66);
    c.lineTo(760, H); c.lineTo(30, H); c.closePath(); c.fill();
    g = c.createLinearGradient(0, H * 0.66, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,50,40,.35)');
    c.fillStyle = g; c.fill();
    // shadows
    c.fillStyle = 'rgba(30,20,12,.45)';
    c.beginPath(); c.ellipse(530, 575, 150, 34, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(345, 555, 120, 26, 0, 0, Math.PI * 2); c.fill();
    // vase
    g = c.createLinearGradient(230, 0, 400, 0);
    g.addColorStop(0, '#6f8ea8'); g.addColorStop(0.35, '#3e5d78'); g.addColorStop(1, '#1d2e3d');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(280, 220); c.lineTo(350, 220);
    c.bezierCurveTo(345, 290, 420, 330, 410, 430); c.bezierCurveTo(405, 520, 370, 555, 315, 555);
    c.bezierCurveTo(260, 555, 225, 520, 220, 430); c.bezierCurveTo(210, 330, 285, 290, 280, 220); c.closePath(); c.fill();
    c.fillStyle = '#2b4054'; c.beginPath(); c.ellipse(315, 220, 36, 9, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,.55)'; c.beginPath(); c.ellipse(262, 400, 9, 40, -0.1, 0, Math.PI * 2); c.fill();
    // orange
    g = c.createRadialGradient(470, 440, 10, 520, 490, 110);
    g.addColorStop(0, '#ffcf8a'); g.addColorStop(0.35, '#e98a2e'); g.addColorStop(0.8, '#a4501a'); g.addColorStop(1, '#5e2c0e');
    c.fillStyle = g; c.beginPath(); c.arc(520, 490, 100, 0, Math.PI * 2); c.fill();
    // lemon
    g = c.createRadialGradient(650, 520, 6, 680, 545, 80);
    g.addColorStop(0, '#fff6b8'); g.addColorStop(0.45, '#e9cf3b'); g.addColorStop(1, '#8a7412');
    c.fillStyle = g; c.beginPath(); c.ellipse(685, 548, 78, 50, -0.2, 0, Math.PI * 2); c.fill();
    // film grain so it behaves more like a photo
    const img = c.getImageData(0, 0, W, H), d = img.data;
    let seed = 7;
    for (let i = 0; i < d.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed >> 8) % 17) - 8;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  window.shapeStudyDebug = () => result;
  syncControls();
})();
