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
    const minArea = Math.max(2, Math.round(minFrac * N));
    const comp = new Int32Array(N);
    // "fine" keeps small shapes for the optional final details step
    const fineMin = Math.max(2, Math.round(minArea / 10));
    const fine = mergeSmall(Uint8Array.from(lab), w, h, pal, fineMin, comp);
    lab = mergeSmall(Uint8Array.from(lab), w, h, pal, minArea, comp);
    const R = describe(lab, w, h, pal, comp);
    R.fine = fine; R.fineMin = fineMin;
    return R;
  }

  // Absorb shapes smaller than minArea into the neighbor they share the most edge with.
  function mergeSmall(lab, w, h, pal, minArea, comp) {
    const N = w * h, K = pal.length;
    const colorDist = (a, b) => {
      const A = pal[a].lab, B = pal[b].lab;
      return (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2;
    };
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
    return lab;
  }

  function describe(lab, w, h, pal, comp) {
    const N = w * h, K = pal.length;
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
    return { w, h, comp, labels: lab, regions, palette: pal };
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
  // Split sorted values into `S` groups, keeping similar values together.
  function groupValues(Ls, S) {
    const K = Ls.length;
    S = Math.max(1, Math.min(S, K));
    const cost = (a, b) => {
      let m = 0;
      for (let i = a; i < b; i++) m += Ls[i];
      m /= b - a;
      let c = 0;
      for (let i = a; i < b; i++) c += (Ls[i] - m) ** 2;
      return c;
    };
    const dp = [], cut = [];
    for (let s = 0; s <= S; s++) { dp.push(new Float64Array(K + 1).fill(Infinity)); cut.push(new Int32Array(K + 1)); }
    dp[0][0] = 0;
    for (let s = 1; s <= S; s++) {
      for (let j = s; j <= K; j++) {
        for (let i = s - 1; i < j; i++) {
          const v = dp[s - 1][i] + cost(i, j);
          if (v < dp[s][j]) { dp[s][j] = v; cut[s][j] = i; }
        }
      }
    }
    const groups = [];
    for (let s = S, j = K; s > 0; s--) {
      const i = cut[s][j];
      groups.unshift([...Array(j - i).keys()].map(k => i + k));
      j = i;
    }
    return groups;
  }

  const VALUE_NAMES = {
    1: ['All values'],
    2: ['Darks', 'Lights'],
    3: ['Darks', 'Midtones', 'Lights'],
    4: ['Darks', 'Dark midtones', 'Light midtones', 'Lights'],
    5: ['Darks', 'Dark midtones', 'Midtones', 'Light midtones', 'Lights'],
    6: ['Darkest darks', 'Darks', 'Dark midtones', 'Light midtones', 'Lights', 'Highlights'],
  };

  // The plan is a list of "items" in painting order. Each item paints one color
  // (value orders) or one shape (size / depth orders). Items are grouped into steps.
  function plan(R, order, layers, details) {
    const { regions, palette, w, h, comp, labels } = R, N = w * h, K = palette.length;
    const steps = [], items = [];
    const pixelRank = new Int32Array(N);
    if (order === 'dark' || order === 'light') {
      let groups = groupValues(palette.map(c => c.lab[0]), layers);
      const S = groups.length;
      let names = VALUE_NAMES[S] ? VALUE_NAMES[S].slice() : groups.map((g, i) => `Values ${i + 1}`);
      if (order === 'light') { groups = groups.reverse().map(g => g.reverse()); names.reverse(); }
      const colorRank = new Int32Array(K);
      groups.forEach((g, s) => {
        steps.push({ name: names[s] });
        g.forEach(c => { colorRank[c] = items.length; items.push({ color: c, stage: s }); });
      });
      for (let p = 0; p < N; p++) pixelRank[p] = colorRank[labels[p]];
    } else {
      let sorted, q, names;
      const S = Math.max(1, Math.min(layers, regions.length));
      if (order === 'size') {
        sorted = regions.slice().sort((a, b) => b.area - a.area);
        q = 0.4;
        names = ['Big masses', ...(S === 3 ? ['Medium shapes'] : S === 4 ? ['Medium shapes', 'Small shapes'] : [...Array(Math.max(0, S - 2)).keys()].map(i => `Smaller shapes ${i + 1}`)), 'Smallest shapes'];
      } else {
        // background guess: touches the frame, is large, sits away from the center
        const score = r => {
          const edge = Math.min(1, r.edge / (0.25 * (w + h)));
          const dc = Math.hypot((r.cx - w / 2) / (w / 2), (r.cy - h / 2) / (h / 2)) / Math.SQRT2;
          return 1.5 * edge + 0.8 * dc + Math.sqrt(r.area / N);
        };
        sorted = regions.slice().sort((a, b) => score(b) - score(a));
        q = 0.5;
        names = ['Back (estimate)', ...(S === 3 ? ['Middle'] : [...Array(Math.max(0, S - 2)).keys()].map(i => `Middle ${i + 1}`)), 'Front (estimate)'];
      }
      if (S === 1) names = ['Everything'];
      for (let s = 0; s < S; s++) steps.push({ name: names[s] });
      const regionRank = new Int32Array(regions.length);
      let cum = 0, s = 0;
      for (const r of sorted) {
        while (s < S - 1 && cum >= (1 - Math.pow(q, s + 1)) * N) s++;
        regionRank[r.id] = items.length;
        items.push({ region: r.id, color: r.color, stage: s });
        cum += r.area;
      }
      for (let p = 0; p < N; p++) pixelRank[p] = regionRank[comp[p]];
    }
    // drop empty steps
    const used = [...new Set(items.map(it => it.stage))].sort((a, b) => a - b);
    const remap = new Map(used.map((s, i) => [s, i]));
    const kept = used.map(s => steps[s]);
    items.forEach(it => { it.stage = remap.get(it.stage); });
    kept.forEach((st, i) => { st.colors = [...new Set(items.filter(it => it.stage === i).map(it => it.color))].sort((a, b) => a - b); });
    if (details) kept.push({ name: 'Details & accents', details: true, colors: [] });
    return { steps: kept, items, pixelRank, details };
  }

  // ---------- 5. vectorize ----------
  // Exact Euclidean distance transform (Felzenszwalb). Returns squared distance
  // from each pixel to the nearest pixel where `on` is 1.
  const BIG = 1e20;
  function edt(on, W, H) {
    const d = new Float64Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = on[i] ? 0 : BIG;
    const n = Math.max(W, H);
    const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const pass1d = len => {
      let k = 0; v[0] = 0; z[0] = -BIG; z[1] = BIG;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = d[y * W + x];
      pass1d(H);
      for (let y = 0; y < H; y++) d[y * W + x] = out[y];
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f[x] = d[y * W + x];
      pass1d(W);
      for (let x = 0; x < W; x++) d[y * W + x] = out[x];
    }
    return d;
  }

  // For each item, work out the shape a painter would lay down: the visible part,
  // plus (with overlap) a bolder mass that bridges gaps, swallows islands and spills
  // a little into areas that LATER items will paint over. It never spills onto
  // anything an earlier item already finished, so the final picture stays correct.
  function vectorize(R, P, overlap, style, geo) {
    const { w, h, comp, labels, regions, palette } = R, N = w * h;
    const unit = Math.max(w, h) / 600;
    const rc = overlap * 2.4 * unit, rb = overlap * 0.6 * unit;
    const pad = Math.ceil(rc + rb) + 2;
    const shapes = [];

    // bounding box of each color (for value orders)
    const cb = palette.map(() => ({ minx: w, miny: h, maxx: -1, maxy: -1 }));
    for (const r of regions) {
      const b = cb[r.color];
      b.minx = Math.min(b.minx, r.minx); b.miny = Math.min(b.miny, r.miny);
      b.maxx = Math.max(b.maxx, r.maxx); b.maxy = Math.max(b.maxy, r.maxy);
    }

    P.items.forEach((it, rank) => {
      const byRegion = it.region !== undefined;
      const b = byRegion ? regions[it.region] : cb[it.color];
      if (b.maxx < 0) return;
      const x0 = Math.max(0, b.minx - pad), y0 = Math.max(0, b.miny - pad);
      const x1 = Math.min(w - 1, b.maxx + pad), y1 = Math.min(h - 1, b.maxy + pad);
      const WW = x1 - x0 + 1, WH = y1 - y0 + 1, WN = WW * WH;
      const tgt = new Uint8Array(WN), allowed = new Uint8Array(WN);
      for (let y = 0; y < WH; y++) {
        for (let x = 0; x < WW; x++) {
          const p = (y + y0) * w + x + x0, i = y * WW + x;
          const t = byRegion ? comp[p] === it.region : labels[p] === it.color;
          tgt[i] = t ? 1 : 0;
          allowed[i] = t || P.pixelRank[p] > rank ? 1 : 0;
        }
      }
      let mask = tgt;
      if (overlap > 0) {
        const dT = edt(tgt, WW, WH);
        const rc2 = rc * rc, rb2 = rb * rb;
        const dil = new Uint8Array(WN);
        for (let i = 0; i < WN; i++) dil[i] = dT[i] <= rc2 ? 0 : 1; // 1 = outside the grown shape
        const dO = edt(dil, WW, WH);
        const shape = new Uint8Array(WN);
        for (let i = 0; i < WN; i++) shape[i] = tgt[i] || dT[i] <= rb2 || (!dil[i] && dO[i] > rc2) ? 1 : 0;
        fillHoles(shape, WW, WH);
        mask = new Uint8Array(WN);
        for (let i = 0; i < WN; i++) mask[i] = tgt[i] || (allowed[i] && shape[i]) ? 1 : 0;
      }
      addShapes(mask, tgt, WW, WH, x0, y0, rank, it.stage, it.color);
    });

    if (P.details) {
      // final step: small shapes that the bold version merged away
      const diff = new Uint8Array(N);
      for (let p = 0; p < N; p++) diff[p] = R.fine[p] !== labels[p] ? R.fine[p] : 255;
      const dc = new Int32Array(N);
      const { count, areas } = components(diff, w, h, dc);
      const rank = P.items.length, stage = P.steps.length - 1;
      const boxes = [];
      for (let c = 0; c < count; c++) boxes.push({ minx: w, miny: h, maxx: -1, maxy: -1, color: 255 });
      for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p++) {
          const bx = boxes[dc[p]];
          bx.color = diff[p];
          if (x < bx.minx) bx.minx = x; if (x > bx.maxx) bx.maxx = x;
          if (y < bx.miny) bx.miny = y; if (y > bx.maxy) bx.maxy = y;
        }
      }
      boxes.forEach((bx, c) => {
        if (bx.color === 255 || areas[c] < R.fineMin) return;
        const WW = bx.maxx - bx.minx + 1, WH = bx.maxy - bx.miny + 1;
        const m = new Uint8Array(WW * WH);
        for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) m[y * WW + x] = dc[(y + bx.miny) * w + x + bx.minx] === c ? 1 : 0;
        addShapes(m, m, WW, WH, bx.minx, bx.miny, rank, stage, bx.color);
      });
    }

    shapes.sort((a, b) => a.rank - b.rank || b.area - a.area);
    return shapes;

    // split a mask into connected pieces and trace each one
    function addShapes(mask, tgt, WW, WH, x0, y0, rank, stage, color) {
      const WN = WW * WH;
      const pc = new Int32Array(WN);
      const { count, areas } = components(mask, WW, WH, pc);
      const inv = new Uint8Array(WN);
      for (let i = 0; i < WN; i++) inv[i] = mask[i] ? 0 : 1;
      const din = edt(inv, WW, WH); // distance to the shape's edge, for number placement
      const info = [];
      for (let c = 0; c < count; c++) info.push({ minx: WW, miny: WH, maxx: -1, maxy: -1, hasT: false, on: false, lr: -1, lx: 0, ly: 0 });
      for (let y = 0, i = 0; y < WH; y++) {
        for (let x = 0; x < WW; x++, i++) {
          const f = info[pc[i]];
          if (!mask[i]) continue;
          f.on = true;
          if (tgt[i]) f.hasT = true;
          if (x < f.minx) f.minx = x; if (x > f.maxx) f.maxx = x;
          if (y < f.miny) f.miny = y; if (y > f.maxy) f.maxy = y;
          const gx = x + x0, gy = y + y0;
          const r = Math.min(Math.sqrt(din[i]), gx + 1, gy + 1, w - gx, h - gy);
          if (r > f.lr) { f.lr = r; f.lx = gx + 0.5; f.ly = gy + 0.5; }
        }
      }
      info.forEach((f, c) => {
        if (!f.on || !f.hasT) return;
        const PW = f.maxx - f.minx + 3, PH = f.maxy - f.miny + 3;
        const m = new Uint8Array(PW * PH);
        for (let y = f.miny; y <= f.maxy; y++) {
          for (let x = f.minx; x <= f.maxx; x++) if (pc[y * WW + x] === c) m[(y - f.miny + 1) * PW + x - f.minx + 1] = 1;
        }
        const loops = trace(m, PW, PH, f.minx - 1 + x0, f.miny - 1 + y0)
          .map(l => simplify(l, style, geo, unit))
          .filter(l => l.length >= 6);
        if (loops.length) shapes.push({ rank, step: stage, color, loops, lx: f.lx, ly: f.ly, lr: f.lr, area: areas[c] });
      });
    }
  }

  // Fill enclosed holes (anything not reachable from the window border).
  function fillHoles(mask, W, H) {
    const seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
    let sp = 0;
    const push = p => { if (!mask[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp) {
      const p = stack[--sp], x = p % W;
      if (x > 0) push(p - 1); if (x < W - 1) push(p + 1);
      if (p >= W) push(p - W); if (p < W * (H - 1)) push(p + W);
    }
    for (let i = 0; i < W * H; i++) if (!mask[i] && !seen[i]) mask[i] = 1;
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
