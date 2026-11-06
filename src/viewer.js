/* 画像ビューア: 実 CT (int16 HU) + ラベル体積 + モデルの ΔHU(t)
   data/phantom.json, data/phantom_ct.bin.gz, data/phantom_lab.bin.gz を読む。無ければパネルごと非表示 */
const Viewer = (function () {
  'use strict';
  const PRESETS = { soft: [400, 40], lung: [1500, -600], bone: [1800, 400], vessel: [700, 150] };
  const SIZE = 640;
  // ΔHU カラー表示: 0〜DMAX HU を青→水色→黄→赤。計算で加えた分だけを色にし、下地は単純 CT のグレー
  const DMAX = 300;
  const STOPS = [[0, 40, 70, 220], [0.33, 0, 200, 230], [0.66, 250, 220, 40], [1, 235, 40, 40]];
  const CMAP = (() => { const c = new Uint8Array(256 * 3); for (let i = 0; i < 256; i++) { const f = i / 255; let a = STOPS[0], b = STOPS[STOPS.length - 1]; for (let j = 0; j + 1 < STOPS.length; j++) if (f >= STOPS[j][0] && f <= STOPS[j + 1][0]) { a = STOPS[j]; b = STOPS[j + 1]; break; } const w = (f - a[0]) / (b[0] - a[0] || 1); for (let k = 0; k < 3; k++) c[i * 3 + k] = a[k + 1] + (b[k + 1] - a[k + 1]) * w; } return c; })();
  function create(host, app) {
    const st = { lang: app.lang, ct: null, lab: null, meta: null, loaded: false, t: 70, follow: true, playing: false, playT: 0, last: 0,
      ww: 400, wl: 40, names: false, mode: 'img', plane: 'ax', pos: null, pick: null, geo: null };
    const tr = () => app.T();
    host.innerHTML = `
      <div class="vbar">
        <div class="seg" id="vPlane"><button data-v="ax"></button><button data-v="co"></button><button data-v="sa"></button></div>
        <div class="seg" id="vWin"><button data-v="soft"></button><button data-v="lung"></button><button data-v="bone"></button><button data-v="vessel"></button></div>
        <div class="seg" id="vMode"><button data-v="img"></button><button data-v="dhu"></button></div>
        <label class="chk"><input type="checkbox" id="vNames"><span id="vNamesL"></span></label>
      </div>
      <div class="vp"><canvas id="vCv" width="${SIZE}" height="${SIZE}"></canvas><span class="lbl" id="vInfo"></span><span class="lbl br" id="vPick"></span></div>
      <div class="vctl"><span id="vSliceL"></span><input type="range" id="vS" min="0" max="1" step="1"><span class="v" id="vS_v"></span></div>
      <div class="vctl"><span id="vtl"></span><input type="range" id="vT" min="0" max="300" step="0.5"><span class="v" id="vT_v"></span></div>
      <div class="vrow"><button class="btn small" id="vPlay"></button><label class="chk"><input type="checkbox" id="vFollow" checked><span id="vFollowL"></span></label><span class="note" id="vClick"></span></div>
      <div class="note" id="vNote"></div>`;
    const $ = id => host.querySelector('#' + id);
    const cv = $('vCv'), ctx = cv.getContext('2d');
    const off = document.createElement('canvas');

    function setLang(l) {
      st.lang = l; const t = tr();
      $('vPlane').querySelectorAll('button').forEach(b => b.textContent = t[{ ax: 'axial', co: 'coronal', sa: 'sagittal' }[b.dataset.v]]);
      $('vWin').querySelectorAll('button').forEach(b => b.textContent = t.win[b.dataset.v]);
      $('vMode').querySelectorAll('button').forEach(b => b.textContent = t.mode[b.dataset.v]);
      $('vNamesL').textContent = t.labels; $('vSliceL').textContent = t.slice; $('vtl').textContent = t.imgTime;
      $('vPlay').textContent = st.playing ? t.stop : t.play; $('vFollowL').textContent = t.follow; $('vClick').textContent = t.clickOrgan;
      note(); credit(); if (st.loaded) render();
    }
    function note() {
      const t = tr(); let src = '';
      if (st.meta) { const s = st.meta.source || {}; src = st.meta.synthetic ? t.imgSynthetic : `${t.imgCredit}: ${s.dataset || ''}${s.license ? ' (' + s.license + ')' : ''}.`; }
      $('vNote').textContent = (src ? src + ' ' : '') + t.imgNote + ' ' + t.imgOverlayNote;
    }
    function credit() {
      const el = document.getElementById('aboutImg'); if (!el) return;
      if (!st.loaded) { el.textContent = ''; return; }
      const s = st.meta.source || {}, t = tr();
      el.textContent = st.meta.synthetic ? `${t.imgCredit}: ${t.imgSynthetic}` : t.imgCase(s.case || '', s.license || '');
    }
    function panel(show) { const p = host.closest('.panel'); if (p) p.classList.toggle('hidden', !show); }
    async function gunzip(url) {
      const res = await fetch(url); if (!res.ok) throw new Error(url);
      return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    async function load() {
      try {
        if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unsupported');
        const mres = await fetch('data/phantom.json'); if (!mres.ok) throw new Error('no data');
        const meta = await mres.json(); const files = meta.files || { ct: 'phantom_ct.bin.gz', lab: 'phantom_lab.bin.gz' };
        const [cb, lb] = await Promise.all([gunzip('data/' + files.ct), gunzip('data/' + files.lab)]);
        const [nx, ny, nz] = meta.dims; const n = nx * ny * nz;
        if (cb.byteLength < n * 2 || lb.byteLength < n) throw new Error('size mismatch');
        st.meta = meta; st.ct = new Int16Array(cb, 0, n); st.lab = new Uint8Array(lb, 0, n); st.loaded = true;
        // tissueFrac のラベル（肺）: 区画の ΔHU にボクセルの組織分率 (HU + 1000) / 1000 を掛ける（含気分だけ薄まる）
        st.tf = new Uint8Array(meta.labels.length); meta.labels.forEach(L => { if (L.tissueFrac) st.tf[L.id] = 1; });
        st.pos = [nx >> 1, ny >> 1, nz >> 1];
        // 既定スライス: 肝の中心（あれば）
        const li = meta.labels.find(L => L.key === 'liver');
        if (li) { let s = 0, c = 0; for (let z = 0; z < nz; z += 2) for (let y = 0; y < ny; y += 2) for (let x = 0; x < nx; x += 2) if (st.lab[z * nx * ny + y * nx + x] === li.id) { s += z; c++; } if (c) st.pos[2] = Math.round(s / c); }
        setPlane('ax'); setPreset('soft'); setMode('img'); panel(true); credit(); note(); update();
      } catch (e) { st.loaded = false; panel(false); console.warn('image panel disabled:', e.message); }
    }
    // ラベル → ΔHU(t)
    function dhuTable(t) {
      const m = st.meta, d = new Float32Array(m.labels.length);
      for (let i = 0; i < m.labels.length; i++) {
        const L = m.labels[i]; if (!L.series) continue;
        let v = 0; if (Array.isArray(L.series)) { for (const k of L.series) v += app.huAt(k, t); v /= L.series.length; } else v = app.huAt(L.series, t);
        d[L.id] = v;
      }
      return d;
    }
    function dhuAt(d, l, hu) { let v = d[l]; if (st.tf[l]) { let f = (hu + 1000) / 1000; f = f < 0 ? 0 : f > 1 ? 1 : f; v *= f; } return v; }
    function cursorTime() { return st.loaded && !st.follow ? st.t : null; }
    function currentT() { if (st.follow) { const w = app.scanWindow(); return w.start == null ? app.S.delay : (w.start + w.end) / 2; } return st.t == null ? 70 : st.t; }
    function update() { if (!st.loaded) return; const t = Math.min(currentT(), +app.S.tEnd); st.t = t; $('vT').max = app.S.tEnd; $('vT').value = t; $('vT_v').textContent = t.toFixed(1) + ' s'; render(); }

    // 断面の幾何: 画像 (u,v) → ボクセル index
    function plane() {
      const [nx, ny, nz] = st.meta.dims, [sx, sy, sz] = st.meta.spacing, [px, py, pz] = st.pos, nxy = nx * ny;
      if (st.plane === 'ax') return { W: nx, H: ny, pw: sx, ph: sy, idx: (u, v) => pz * nxy + v * nx + u, n: nz, k: pz, mark: ['R', 'L', 'A', 'P'] };
      if (st.plane === 'co') return { W: nx, H: nz, pw: sx, ph: sz, idx: (u, v) => (nz - 1 - v) * nxy + py * nx + u, n: ny, k: py, mark: ['R', 'L', 'S', 'I'] };
      return { W: ny, H: nz, pw: sy, ph: sz, idx: (u, v) => (nz - 1 - v) * nxy + u * nx + px, n: nx, k: px, mark: ['A', 'P', 'S', 'I'] };
    }
    function render() {
      if (!st.loaded) return;
      const g = plane(), { W, H } = g, d = dhuTable(st.t), ct = st.ct, lab = st.lab;
      // 断面を取り出し、ΔHU は 3×3 平滑化してから加算（ラベル境界の段差を抑える）
      const labS = new Uint8Array(W * H), dh = new Float32Array(W * H), tmp = new Float32Array(W * H), ctS = new Int16Array(W * H);
      for (let v = 0, p = 0; v < H; v++) for (let u = 0; u < W; u++, p++) { const i = g.idx(u, v); labS[p] = lab[i]; ctS[p] = ct[i]; dh[p] = dhuAt(d, lab[i], ct[i]); }
      for (let v = 0; v < H; v++) { const r = v * W; for (let u = 0; u < W; u++) { const a = dh[r + Math.max(0, u - 1)], b = dh[r + u], c = dh[r + Math.min(W - 1, u + 1)]; tmp[r + u] = (a + b + c) / 3; } }
      for (let v = 0; v < H; v++) { const r0 = Math.max(0, v - 1) * W, r1 = v * W, r2 = Math.min(H - 1, v + 1) * W; for (let u = 0; u < W; u++) dh[r1 + u] = (tmp[r0 + u] + tmp[r1 + u] + tmp[r2 + u]) / 3; }
      const lo = st.wl - st.ww / 2, k = 255 / st.ww;
      off.width = W; off.height = H; const octx = off.getContext('2d'); const im = octx.createImageData(W, H), px = im.data;
      const ov = st.mode === 'dhu';
      for (let p = 0, o = 0; p < W * H; p++, o += 4) {
        // 造影画像: CT + ΔHU をグレーで。ΔHU 表示: 単純 CT のグレーに、加えた ΔHU を色で重ねる（透明度は ΔHU に応じて 0〜0.75）
        let gv = (ctS[p] + (ov ? 0 : dh[p]) - lo) * k; gv = gv < 0 ? 0 : gv > 255 ? 255 : gv;
        if (ov && dh[p] > 5) { const f = dh[p] / DMAX; const ci = (f >= 1 ? 255 : Math.round(f * 255)) * 3; const a = Math.min(0.75, dh[p] / 40 * 0.75); px[o] = gv + (CMAP[ci] - gv) * a; px[o + 1] = gv + (CMAP[ci + 1] - gv) * a; px[o + 2] = gv + (CMAP[ci + 2] - gv) * a; }
        else px[o] = px[o + 1] = px[o + 2] = gv;
        px[o + 3] = 255;
      }
      octx.putImageData(im, 0, 0);
      const aspect = (W * g.pw) / (H * g.ph); let dw = SIZE, dhh = SIZE; if (aspect > 1) dhh = SIZE / aspect; else dw = SIZE * aspect;
      const ox = (SIZE - dw) / 2, oy = (SIZE - dhh) / 2;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SIZE, SIZE); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(off, ox, oy, dw, dhh);
      st.geo = { ox, oy, kx: dw / W, ky: dhh / H, W, H };
      // 向きマーカー
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.fillText(g.mark[0], 8, SIZE / 2); ctx.textAlign = 'right'; ctx.fillText(g.mark[1], SIZE - 8, SIZE / 2);
      ctx.textAlign = 'center'; ctx.fillText(g.mark[2], SIZE / 2, 12); ctx.fillText(g.mark[3], SIZE / 2, SIZE - 12);
      if (ov) colorbar();
      if (st.names) labelsOn(labS, W, H);
      const t = tr();
      $('vInfo').textContent = `${t[{ ax: 'axial', co: 'coronal', sa: 'sagittal' }[st.plane]]}  ${g.k + 1}/${g.n}   ${st.t.toFixed(1)} s   W ${st.ww} / L ${st.wl}`;
      $('vS').max = g.n - 1; $('vS').value = g.k; $('vS_v').textContent = `${g.k + 1} / ${g.n}`;
      pickText();
    }
    // ΔHU のカラーバー（左下）
    function colorbar() {
      const x0 = 12, y0 = SIZE - 34, w = 130, h = 10;
      for (let i = 0; i < w; i++) { const ci = Math.round(i / (w - 1) * 255) * 3; ctx.fillStyle = `rgb(${CMAP[ci]},${CMAP[ci + 1]},${CMAP[ci + 2]})`; ctx.fillRect(x0 + i, y0, 1, h); }
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1; ctx.strokeRect(x0 - 0.5, y0 - 0.5, w + 1, h + 1);
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillText('0', x0, y0 + h + 3); ctx.textAlign = 'right'; ctx.fillText(DMAX + ' HU', x0 + w, y0 + h + 3);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(tr().mode.dhu, x0, y0 - 3);
    }
    function labelsOn(labS, W, H) {
      const sums = new Map(), m = st.meta, { ox, oy, kx, ky } = st.geo;
      for (let v = 0; v < H; v += 2) for (let u = 0; u < W; u += 2) { const l = labS[v * W + u]; const s = sums.get(l) || { n: 0, x: 0, y: 0 }; s.n++; s.x += u; s.y += v; sums.set(l, s); }
      ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [l, s] of sums) { if (s.n < 30) continue; const L = m.labels[l]; if (!L || L.key === 'bone' || L.key === 'soft' || L.key === 'fat') continue; const name = st.lang === 'ja' ? L.ja : L.en; const X = ox + s.x / s.n * kx, Y = oy + s.y / s.n * ky; ctx.fillStyle = 'rgba(0,0,0,.55)'; const w = ctx.measureText(name).width + 8; ctx.fillRect(X - w / 2, Y - 8, w, 16); ctx.fillStyle = '#ffe9a8'; ctx.fillText(name, X, Y); }
    }
    function pickText() {
      const el = $('vPick'); if (!st.pick) { el.textContent = ''; return; }
      const [x, y, z] = st.pick, [nx, ny] = st.meta.dims, i = z * nx * ny + y * nx + x, L = st.meta.labels[st.lab[i]], d = dhuTable(st.t);
      const dv = dhuAt(d, st.lab[i], st.ct[i]), hu = st.ct[i] + dv; const name = L ? (st.lang === 'ja' ? L.ja : L.en) : '';
      el.textContent = `${name}  ${hu.toFixed(0)} HU` + (L && L.series ? `  (Δ ${dv.toFixed(0)})` : '');
    }
    // 操作
    function setPlane(p) { st.plane = p; $('vPlane').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p)); render(); }
    function setPreset(p) { [st.ww, st.wl] = PRESETS[p]; $('vWin').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p)); render(); }
    function setMode(m) { st.mode = m; $('vMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === m)); render(); }
    $('vPlane').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPlane(b.dataset.v); });
    $('vWin').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPreset(b.dataset.v); });
    $('vMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
    $('vNames').onchange = e => { st.names = e.target.checked; render(); };
    $('vS').oninput = () => { const k = +$('vS').value; if (st.plane === 'ax') st.pos[2] = k; else if (st.plane === 'co') st.pos[1] = k; else st.pos[0] = k; render(); };
    cv.addEventListener('wheel', e => { if (!st.loaded) return; e.preventDefault(); const g = plane(); const k = Math.max(0, Math.min(g.n - 1, g.k + (e.deltaY > 0 ? 1 : -1))); $('vS').value = k; $('vS').oninput(); }, { passive: false });
    $('vT').oninput = () => { st.follow = false; $('vFollow').checked = false; stopPlay(); st.t = +$('vT').value; update(); app.redrawChart(); };
    $('vFollow').onchange = e => { st.follow = e.target.checked; if (st.follow) stopPlay(); update(); app.redrawChart(); };
    function stopPlay() { st.playing = false; $('vPlay').textContent = tr().play; }
    $('vPlay').onclick = () => { if (st.playing) { stopPlay(); return; } st.playing = true; st.follow = false; $('vFollow').checked = false; $('vPlay').textContent = tr().stop; st.playT = 0; st.last = performance.now(); requestAnimationFrame(frame); };
    function frame(now) { if (!st.playing) return; st.playT += (now - st.last) / 1000 * 5; st.last = now; if (st.playT > +app.S.tEnd) st.playT = 0; st.t = st.playT; $('vT').value = st.t; $('vT_v').textContent = st.t.toFixed(1) + ' s'; render(); app.redrawChart(); requestAnimationFrame(frame); }
    // クリック: その点を通るように他断面の位置を合わせ、臓器名と CT 値を表示、曲線を強調
    cv.addEventListener('click', e => {
      if (!st.loaded) return; const g = st.geo, r = cv.getBoundingClientRect();
      const X = (e.clientX - r.left) / r.width * SIZE, Y = (e.clientY - r.top) / r.height * SIZE;
      const u = Math.floor((X - g.ox) / g.kx), v = Math.floor((Y - g.oy) / g.ky); if (u < 0 || v < 0 || u >= g.W || v >= g.H) return;
      const [nx, ny, nz] = st.meta.dims;
      if (st.plane === 'ax') { st.pos[0] = u; st.pos[1] = v; } else if (st.plane === 'co') { st.pos[0] = u; st.pos[2] = nz - 1 - v; } else { st.pos[1] = u; st.pos[2] = nz - 1 - v; }
      st.pick = st.pos.slice();
      const L = st.meta.labels[st.lab[st.pos[2] * nx * ny + st.pos[1] * nx + st.pos[0]]];
      if (L && L.series) { const k = Array.isArray(L.series) ? L.series[0] : L.series; app.showSeries(k); }
      render();
    });
    setLang(st.lang); load();
    return { setLang, update, cursorTime };
  }
  return { create };
})();
