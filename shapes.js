'use strict';
/*
  Shape Study engine: turns a photo into flat, paintable shapes and sorts
  them into painting steps. Plain JavaScript, no AI, runs in the browser.

  Pipeline (each stage is cached by the app, so only changed stages rerun):
    1. prepare   – shrink the photo, optionally blur or "painterly" smooth it
    2. quantize  – reduce to a few colors (or gray values) with k-means in Lab
    3. regions   – tidy edges, merge tiny specks, find connected shapes
    4. plan      – group shapes into painting steps (value / size / depth)
    5. vectorize – trace each shape's outline and simplify it (soft / geometric)
*/
const Shapes = (() => {
  // ---------- color helpers ----------
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const fLab = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbToLab(r, g, b, out, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const fx = fLab((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047);
    const fy = fLab(R * 0.2126729 + G * 0.7151522 + B * 0.072175);
    const fz = fLab((R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883);
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }

  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
    const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    const R = x * 3.2404542 - y * 1.5371385 - z * 0.4985314;
    const G = -x * 0.969266 + y * 1.8760108 + z * 0.041556;
    const B = x * 0.0556434 - y * 0.2040259 + z * 1.0572252;
    const g = c => {
      c = Math.max(0, Math.min(1, c));
      return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    };
    return [g(R), g(G), g(B)];
  }

  const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 1. prepare ----------
  function prepare(source, maxSide, smooth, amount) {
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const photo = document.createElement('canvas');
    photo.width = w; photo.height = h;
    const ctx = photo.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const N = w * h;
    let rgb = new Uint8ClampedArray(N * 3);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      // flatten transparency onto white
      const a = px[j + 3] / 255;
      rgb[i * 3] = px[j] * a + 255 * (1 - a);
      rgb[i * 3 + 1] = px[j + 1] * a + 255 * (1 - a);
      rgb[i * 3 + 2] = px[j + 2] * a + 255 * (1 - a);
    }
    const unit = Math.max(w, h) / 600;
    if (smooth === 'blur') rgb = boxBlur(rgb, w, h, Math.max(1, Math.round(amount * 0.7 * unit)));
    else if (smooth === 'painterly') rgb = kuwahara(rgb, w, h, Math.max(1, Math.round((1 + amount * 0.6) * unit)));

    const lab = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, i * 3);
    return { w, h, rgb, lab, photo };
  }

  function boxBlur(src, w, h, r) {
    let a = Float32Array.from(src), b = new Float32Array(a.length);
    const pass = (from, to, horizontal) => {
      const len = horizontal ? w : h, lines = horizontal ? h : w;
      for (let line = 0; line < lines; line++) {
        for (let c = 0; c < 3; c++) {
          const idx = i => (horizontal ? (line * w + i) : (i * w + line)) * 3 + c;
          let sum = 0;
          for (let i = -r; i <= r; i++) sum += from[idx(Math.min(len - 1, Math.max(0, i)))];
          for (let i = 0; i < len; i++) {
            to[idx(i)] = sum / (2 * r + 1);
            sum += from[idx(Math.min(len - 1, i + r + 1))] - from[idx(Math.max(0, i - r))];
          }
        }
      }
    };
    for (let k = 0; k < 3; k++) { pass(a, b, true); pass(b, a, false); }
    return Uint8ClampedArray.from(a);
  }

  // Kuwahara filter: flattens areas while keeping edges crisp, like a brush.
  function kuwahara(src, w, h, r) {
    const W = w + 1, S = W * (h + 1);
    const sat = [new Float64Array(S), new Float64Array(S), new Float64Array(S), new Float64Array(S), new Float64Array(S)];
    for (let y = 0; y < h; y++) {
      const row = [0, 0, 0, 0, 0];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const R = src[i], G = src[i + 1], B = src[i + 2];
        const Y = 0.299 * R + 0.587 * G + 0.114 * B;
        row[0] += R; row[1] += G; row[2] += B; row[3] += Y; row[4] += Y * Y;
        const o = (y + 1) * W + x + 1, u = y * W + x + 1;
        for (let c = 0; c < 5; c++) sat[c][o] = sat[c][u] + row[c];
      }
    }
    const out = new Uint8ClampedArray(src.length);
    const box = (c, x0, y0, x1, y1) => sat[c][(y1 + 1) * W + x1 + 1] - sat[c][y0 * W + x1 + 1] - sat[c][(y1 + 1) * W + x0] + sat[c][y0 * W + x0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
        for (let q = 0; q < 4; q++) {
          const x0 = q & 1 ? x : Math.max(0, x - r), x1 = q & 1 ? Math.min(w - 1, x + r) : x;
          const y0 = q & 2 ? y : Math.max(0, y - r), y1 = q & 2 ? Math.min(h - 1, y + r) : y;
          const n = (x1 - x0 + 1) * (y1 - y0 + 1);
          const m = box(3, x0, y0, x1, y1) / n;
          const v = box(4, x0, y0, x1, y1) / n - m * m;
          if (v < best) { best = v; bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; }
        }
        const n = (bx1 - bx0 + 1) * (by1 - by0 + 1), i = (y * w + x) * 3;
        out[i] = box(0, bx0, by0, bx1, by1) / n;
        out[i + 1] = box(1, bx0, by0, bx1, by1) / n;
        out[i + 2] = box(2, bx0, by0, bx1, by1) / n;
      }
    }
    return out;
  }

  // ---------- 2. quantize ----------
  function kmeans(data, n, dims, k, rand, iters) {
    const centers = [];
    const d2 = new Float64Array(n).fill(Infinity);
    const dist = (i, c) => { let s = 0; for (let d = 0; d < dims; d++) { const t = data[i * dims + d] - c[d]; s += t * t; } return s; };
    let pick = Math.floor(rand() * n);
    for (let c = 0; c < k; c++) {
      if (c > 0) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += d2[i];
        if (sum < 1e-6) break; // fewer distinct colors than requested
        let r = rand() * sum;
        pick = n - 1;
        for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
      }
      const center = Array.from(data.subarray(pick * dims, pick * dims + dims));
      centers.push(center);
      for (let i = 0; i < n; i++) { const d = dist(i, center); if (d < d2[i]) d2[i] = d; }
    }
    const K = centers.length;
    const assign = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const sums = new Float64Array(K * dims), counts = new Int32Array(K);
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) { const d = dist(i, centers[c]); if (d < bd) { bd = d; best = c; } }
        if (assign[i] !== best) moved++;
        assign[i] = best; counts[best]++;
        for (let d = 0; d < dims; d++) sums[best * dims + d] += data[i * dims + d];
      }
      for (let c = 0; c < K; c++) if (counts[c]) for (let d = 0; d < dims; d++) centers[c][d] = sums[c * dims + d] / counts[c];
      if (it > 0 && moved === 0) break;
    }
    return centers;
  }

  function quantize(prep, k, mode, spacing) {
    const { w, h, lab } = prep, N = w * h;
    const rand = rng(12345);
    const step = Math.max(1, Math.floor(N / 40000));
    const idx = [];
    for (let i = 0; i < N; i += step) idx.push(i);
    let centers; // [L, a, b]
    if (mode === 'value') {
      if (spacing === 'even') {
        const Ls = Float32Array.from(idx, i => lab[i * 3]).sort();
        const lo = Ls[Math.floor(Ls.length * 0.01)], hi = Ls[Math.floor(Ls.length * 0.99)];
        centers = [];
        for (let i = 0; i < k; i++) centers.push([lo + ((i + 0.5) * (hi - lo)) / k, 0, 0]);
      } else {
        const data = Float32Array.from(idx, i => lab[i * 3]);
        centers = kmeans(data, idx.length, 1, k, rand, 30).map(c => [c[0], 0, 0]);
      }
    } else {
      const data = new Float32Array(idx.length * 3);
      idx.forEach((p, j) => { data[j * 3] = lab[p * 3]; data[j * 3 + 1] = lab[p * 3 + 1]; data[j * 3 + 2] = lab[p * 3 + 2]; });
      centers = kmeans(data, idx.length, 3, k, rand, 20);
    }
    // assign every pixel
    const K = centers.length;
    const raw = new Uint8Array(N);
    const sums = new Float64Array(K * 3), counts = new Int32Array(K);
    const valueOnly = mode === 'value';
    for (let i = 0; i < N; i++) {
      const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const dl = L - centers[c][0];
        const d = valueOnly ? dl * dl : dl * dl + (A - centers[c][1]) ** 2 + (B - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      raw[i] = best; counts[best]++;
      sums[best * 3] += L; sums[best * 3 + 1] += A; sums[best * 3 + 2] += B;
    }
    // final colors: mean of their pixels (even value steps keep their exact step)
    const used = [];
    for (let c = 0; c < K; c++) {
      if (!counts[c]) continue;
      let col;
      if (valueOnly && spacing === 'even') col = [centers[c][0], 0, 0];
      else if (valueOnly) col = [sums[c * 3] / counts[c], 0, 0];
      else col = [sums[c * 3] / counts[c], sums[c * 3 + 1] / counts[c], sums[c * 3 + 2] / counts[c]];
      used.push({ old: c, lab: col });
    }
    used.sort((a, b) => a.lab[0] - b.lab[0]); // darkest first
    const remap = new Uint8Array(K);
    used.forEach((u, i) => { remap[u.old] = i; });
    const labels = new Uint8Array(N);
    for (let i = 0; i < N; i++) labels[i] = remap[raw[i]];
    const palette = used.map(u => {
      const rgb = labToRgb(u.lab[0], u.lab[1], u.lab[2]);
      return { lab: u.lab, rgb, hex: hex(rgb), area: 0 };
    });
    return { labels, palette };
  }

  // ---------- 3. regions ----------
  function majority(lab, w, h, K) {
    const out = new Uint8Array(lab.length), cnt = new Int32Array(K), touched = new Int32Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let t = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const l = lab[yy * w + xx];
            if (cnt[l]++ === 0) touched[t++] = l;
          }
        }
        const cur = lab[y * w + x];
        let best = cur, bc = cnt[cur];
        for (let i = 0; i < t; i++) { const l = touched[i]; if (cnt[l] > bc) { bc = cnt[l]; best = l; } cnt[l] = 0; }
        out[y * w + x] = best;
      }
    }
    return out;
  }

  function components(lab, w, h, comp) {
    const N = w * h;
    comp.fill(-1);
    const stack = new Int32Array(N), areas = [];
    let count = 0;
    for (let s = 0; s < N; s++) {
      if (comp[s] !== -1) continue;
      const l = lab[s];
      let sp = 0, area = 0;
      stack[sp++] = s; comp[s] = count;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w;
        if (x > 0 && comp[p - 1] === -1 && lab[p - 1] === l) { comp[p - 1] = count; stack[sp++] = p - 1; }
        if (x < w - 1 && comp[p + 1] === -1 && lab[p + 1] === l) { comp[p + 1] = count; stack[sp++] = p + 1; }
        if (p >= w && comp[p - w] === -1 && lab[p - w] === l) { comp[p - w] = count; stack[sp++] = p - w; }
        if (p < N - w && comp[p + w] === -1 && lab[p + w] === l) { comp[p + w] = count; stack[sp++] = p + w; }
      }
      areas.push(area); count++;
    }
    return { count, areas };
  }

  function buildRegions(prep, quant, minFrac, passes) {
    const { w, h } = prep, N = w * h;
    const pal = quant.palette, K = pal.length;
    let lab = quant.labels;
    for (let i = 0; i < passes; i++) lab = majority(lab, w, h, K);
    if (lab === quant.labels) lab = Uint8Array.from(lab);

    const colorDist = (a, b) => {
      const A = pal[a].lab, B = pal[b].lab;
      return (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2;
    };
    const minArea = Math.max(2, Math.round(minFrac * N));
    const comp = new Int32Array(N);
    const cnt = new Int32Array(K);
    for (let pass = 0; pass < 12; pass++) {
      const { count, areas } = components(lab, w, h, comp);
      if (count <= 1) break;
      const small = [];
      for (let c = 0; c < count; c++) if (areas[c] < minArea) small.push(c);
      if (!small.length) break;
      const start = new Int32Array(count + 1);
      for (let c = 0; c < count; c++) start[c + 1] = start[c] + areas[c];
      const fill = start.slice(0, count), order = new Int32Array(N);
      for (let p = 0; p < N; p++) order[fill[comp[p]]++] = p;
      small.sort((a, b) => areas[a] - areas[b]);
      for (const c of small) {
        const s0 = start[c], s1 = start[c + 1];
        const col = lab[order[s0]];
        cnt.fill(0);
        for (let i = s0; i < s1; i++) {
          const p = order[i], x = p % w;
          if (x > 0 && lab[p - 1] !== col) cnt[lab[p - 1]]++;
          if (x < w - 1 && lab[p + 1] !== col) cnt[lab[p + 1]]++;
          if (p >= w && lab[p - w] !== col) cnt[lab[p - w]]++;
          if (p < N - w && lab[p + w] !== col) cnt[lab[p + w]]++;
        }
        let best = -1, bc = 0;
        for (let j = 0; j < K; j++) {
          if (cnt[j] > bc || (cnt[j] === bc && bc > 0 && colorDist(j, col) < colorDist(best, col))) { bc = cnt[j]; best = j; }
        }
        if (best < 0) continue;
        for (let i = s0; i < s1; i++) lab[order[i]] = best;
      }
    }

    const { count } = components(lab, w, h, comp);
    const regions = [];
    for (let c = 0; c < count; c++) {
      regions.push({ id: c, color: 0, area: 0, minx: w, miny: h, maxx: 0, maxy: 0, edge: 0, sx: 0, sy: 0, lx: 0, ly: 0, lr: -1 });
    }
    const palArea = new Int32Array(K);
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const r = regions[comp[p]];
        r.color = lab[p]; r.area++;
        if (x < r.minx) r.minx = x; if (x > r.maxx) r.maxx = x;
        if (y < r.miny) r.miny = y; if (y > r.maxy) r.maxy = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) r.edge++;
        r.sx += x; r.sy += y;
        palArea[lab[p]]++;
      }
    }
    pal.forEach((c, i) => { c.area = palArea[i] / N; });
    // label spot = point deepest inside each shape (chamfer distance transform)
    const dist = distanceInside(comp, w, h);
    for (let p = 0; p < N; p++) {
      const r = regions[comp[p]];
      if (dist[p] > r.lr) { r.lr = dist[p]; r.lx = (p % w) + 0.5; r.ly = Math.floor(p / w) + 0.5; }
    }
    regions.forEach(r => { r.cx = r.sx / r.area; r.cy = r.sy / r.area; });
    return { w, h, comp, regions, palette: pal };
  }

  function distanceInside(comp, w, h) {
    const N = w * h, d = new Float32Array(N), D = 1.4142;
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const c = comp[p];
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          comp[p - 1] !== c || comp[p + 1] !== c || comp[p - w] !== c || comp[p + w] !== c;
        d[p] = edge ? 1 : 1e9;
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        d[p] = Math.min(d[p], d[p - 1] + 1, d[p - w] + 1, d[p - w - 1] + D, d[p - w + 1] + D);
      }
    }
    for (let y = h - 2; y >= 0; y--) {
      for (let x = w - 2; x > 0; x--) {
        const p = y * w + x;
        d[p] = Math.min(d[p], d[p + 1] + 1, d[p + w] + 1, d[p + w + 1] + D, d[p + w - 1] + D);
      }
    }
    return d;
  }

  // ---------- 4. painting plan ----------
  function plan(R, order) {
    const { regions, palette, w, h } = R, N = w * h, K = palette.length;
    const regionStep = new Int32Array(regions.length);
    let groups = [];
    if (order === 'dark' || order === 'light') {
      const cols = [...Array(K).keys()];
      if (order === 'light') cols.reverse();
      groups = cols.map(c => ({ name: '', ids: regions.filter(r => r.color === c).map(r => r.id) }));
      groups = groups.filter(g => g.ids.length);
      groups.forEach((g, i) => {
        const first = order === 'dark' ? 'Darkest value' : 'Lightest value';
        const last = order === 'dark' ? 'Lightest value' : 'Darkest value';
        g.name = i === 0 ? first : i === groups.length - 1 ? last : (order === 'dark' ? 'Next lighter value' : 'Next darker value');
      });
    } else {
      let tiers, sorted;
      if (order === 'size') {
        tiers = [['Big masses', 0.6], ['Medium shapes', 0.85], ['Small shapes', 0.96], ['Details', Infinity]];
        sorted = regions.slice().sort((a, b) => b.area - a.area);
      } else {
        // background guess: touches the frame, is large, sits away from the center
        tiers = [['Background (estimate)', 0.45], ['Middle ground (estimate)', 0.8], ['Subject & details (estimate)', Infinity]];
        const score = r => {
          const edge = Math.min(1, r.edge / (0.25 * (w + h)));
          const dc = Math.hypot((r.cx - w / 2) / (w / 2), (r.cy - h / 2) / (h / 2)) / Math.SQRT2;
          return 1.5 * edge + 0.8 * dc + Math.sqrt(r.area / N);
        };
        regions.forEach(r => { r.score = score(r); });
        sorted = regions.slice().sort((a, b) => b.score - a.score);
      }
      groups = tiers.map(t => ({ name: t[0], ids: [] }));
      let cum = 0;
      for (const r of sorted) {
        let t = 0;
        while (cum >= tiers[t][1] * N) t++;
        groups[t].ids.push(r.id);
        cum += r.area;
      }
      groups = groups.filter(g => g.ids.length);
    }
    groups.forEach((g, i) => {
      g.ids.forEach(id => { regionStep[id] = i; });
      g.colors = [...new Set(g.ids.map(id => regions[id].color))].sort((a, b) => a - b);
    });
    return { steps: groups, regionStep };
  }

  // ---------- 5. vectorize ----------
  function vectorize(R, P, overlap, style, geo) {
    const { w, comp, regions } = R, { regionStep } = P;
    const unit = Math.max(R.w, R.h) / 600;
    const shapes = [];
    for (const r of regions) {
      const PW = r.maxx - r.minx + 3, PH = r.maxy - r.miny + 3;
      const ox = r.minx - 1, oy = r.miny - 1;
      const mask = new Uint8Array(PW * PH);
      for (let y = r.miny; y <= r.maxy; y++) {
        for (let x = r.minx; x <= r.maxx; x++) if (comp[y * w + x] === r.id) mask[(y - oy) * PW + x - ox] = 1;
      }
      if (overlap === 'over') fillCoveredHoles(mask, PW, PH, ox, oy, w, comp, regionStep, regionStep[r.id]);
      const loops = trace(mask, PW, PH, ox, oy)
        .map(l => simplify(l, style, geo, unit))
        .filter(l => l.length >= 6);
      if (!loops.length) continue;
      shapes.push({ id: r.id, step: regionStep[r.id], color: r.color, loops, lx: r.lx, ly: r.ly, lr: r.lr, area: r.area });
    }
    shapes.sort((a, b) => a.step - b.step || b.area - a.area);
    return shapes;
  }

  // Paint-over mode: a shape ignores holes that later steps will paint on top of,
  // the way a painter blocks in a whole mass and adds the details afterwards.
  function fillCoveredHoles(mask, PW, PH, ox, oy, w, comp, regionStep, step) {
    const seen = new Uint8Array(PW * PH), stack = new Int32Array(PW * PH);
    let sp = 0;
    const push = p => { if (!mask[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < PW; x++) { push(x); push((PH - 1) * PW + x); }
    for (let y = 0; y < PH; y++) { push(y * PW); push(y * PW + PW - 1); }
    const flood = collect => {
      while (sp) {
        const p = stack[--sp]; if (collect) collect.push(p);
        const x = p % PW;
        if (x > 0) push(p - 1); if (x < PW - 1) push(p + 1);
        if (p >= PW) push(p - PW); if (p < PW * (PH - 1)) push(p + PW);
      }
    };
    flood(null);
    for (let s = 0; s < PW * PH; s++) {
      if (mask[s] || seen[s]) continue;
      const hole = [];
      push(s); flood(hole);
      let later = true;
      for (const p of hole) {
        const x = (p % PW) + ox, y = Math.floor(p / PW) + oy;
        if (regionStep[comp[y * w + x]] <= step) { later = false; break; }
      }
      if (later) for (const p of hole) mask[p] = 1;
    }
  }

  // Follow the pixel edges around a mask; returns closed loops of corner points.
  function trace(mask, PW, PH, ox, oy) {
    const V = (PW + 1) * (PH + 1), VW = PW + 1;
    const out1 = new Int32Array(V).fill(-1), out2 = new Int32Array(V).fill(-1);
    const ev = [], ed = [];
    const add = (vx, vy, dir) => {
      const v = vy * VW + vx, e = ev.length;
      ev.push(v); ed.push(dir);
      if (out1[v] < 0) out1[v] = e; else out2[v] = e;
    };
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        if (!mask[y * PW + x]) continue;
        if (y === 0 || !mask[(y - 1) * PW + x]) add(x, y, 0);
        if (x === PW - 1 || !mask[y * PW + x + 1]) add(x + 1, y, 1);
        if (y === PH - 1 || !mask[(y + 1) * PW + x]) add(x + 1, y + 1, 2);
        if (x === 0 || !mask[y * PW + x - 1]) add(x, y + 1, 3);
      }
    }
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const used = new Uint8Array(ev.length), loops = [];
    for (let e0 = 0; e0 < ev.length; e0++) {
      if (used[e0]) continue;
      const pts = [];
      let e = e0, prevDir = -1;
      while (e >= 0 && !used[e]) {
        used[e] = 1;
        const v = ev[e], d = ed[e];
        if (d !== prevDir) pts.push((v % VW) + ox, Math.floor(v / VW) + oy);
        prevDir = d;
        const end = v + DY[d] * VW + DX[d];
        const a = out1[end], b = out2[end];
        let next = -1;
        if (a >= 0 && !used[a] && b >= 0 && !used[b]) next = ed[a] === (d + 1) % 4 ? a : b; // prefer right turn
        else if (a >= 0 && !used[a]) next = a;
        else if (b >= 0 && !used[b]) next = b;
        e = next;
      }
      if (pts.length >= 6) loops.push(pts);
    }
    return loops;
  }

  function simplify(pts, style, geo, unit) {
    if (style === 'pixel') return pts;
    // short pixel steps become their midpoints (staircases turn into clean diagonals);
    // long straight edges keep their ends, so real corners stay put
    const n = pts.length / 2, mid = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1];
      const len = Math.abs(bx - ax) + Math.abs(by - ay);
      if (len < 3) mid.push((ax + bx) / 2, (ay + by) / 2);
      else {
        const ux = Math.sign(bx - ax), uy = Math.sign(by - ay);
        mid.push(ax + ux, ay + uy, bx - ux, by - uy);
      }
    }
    if (style === 'geometric') {
      const eps = (0.4 + geo * 0.55) * unit;
      let s = dpClosed(mid, eps);
      if (s.length < 6) s = dpClosed(mid, eps / 4);
      return s.length >= 6 ? s : mid;
    }
    let s = dpClosed(mid, 0.6 * unit);
    if (s.length < 6) s = mid;
    return chaikin(chaikin(s));
  }

  function dpClosed(p, eps) {
    const n = p.length / 2;
    if (n < 4) return p;
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const keep = new Uint8Array(n);
    keep[0] = keep[far] = 1;
    const stack = [[0, far], [far, n]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = p[(a % n) * 2], ay = p[(a % n) * 2 + 1], bx = p[(b % n) * 2], by = p[(b % n) * 2 + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        // distance to the segment (not the endless line), so concave bends survive
        const t = Math.max(0, Math.min(1, ((p[i * 2] - ax) * dx + (p[i * 2 + 1] - ay) * dy) / len2));
        const d = Math.hypot(p[i * 2] - ax - t * dx, p[i * 2 + 1] - ay - t * dy);
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
  }

  function chaikin(p) {
    const n = p.length / 2, out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[j * 2], y1 = p[j * 2 + 1];
      out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
    }
    return out;
  }

  function pathData(loops, digits = 1) {
    return loops.map(l => {
      let d = 'M' + l[0].toFixed(digits) + ' ' + l[1].toFixed(digits);
      for (let i = 2; i < l.length; i += 2) d += 'L' + l[i].toFixed(digits) + ' ' + l[i + 1].toFixed(digits);
      return d + 'Z';
    }).join('');
  }

  return { prepare, quantize, buildRegions, plan, vectorize, pathData };
})();
