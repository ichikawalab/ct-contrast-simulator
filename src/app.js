/* CT Contrast Simulator — 画面ロジック */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const COLORS = { aortaAsc: '#d1322a', aortaThor: '#e0603a', aortaAbd: '#d1322a', aortaInfra: '#e0603a', portal: '#7b3fa0', hepaticVein: '#b4569c', ivcInfra: '#2f6fb5', liver: '#d98b1f', splStom: '#2a9d8f', pancInt: '#8c8c2a', kidney: '#3a9a3a', trunk: '#7a6a5a', pulmArtery: '#5c8ad6', pulmVein: '#8fb0c9', rightHeart: '#9b2f5c', leftHeart: '#d04a7a', heartM: '#9b2f5c', lungPar: '#8fb0c9', iliacArtery: '#d1322a', iliacVein: '#2f6fb5' };
const REGIONS = {
  chest: { series: ['pulmArtery', 'aortaAsc', 'heartM', 'lungPar', 'rightHeart', 'leftHeart', 'aortaThor', 'pulmVein'], def: ['pulmArtery', 'aortaAsc', 'heartM'], cards: ['paPeak', 'aortaPeak', 'arrival', 'atScan'], aorta: 'aortaAsc', organ: 'heartM', phases: ['pa', 'ea', 'la', 'eq'], defaults: { volume: 70, rate: 4, saline: 40, timing: 'bt', btThr: 100, btMon: 5, btDiag: 8, delay: 25 } },
  abd: { series: ['aortaAbd', 'portal', 'liver', 'splStom', 'pancInt', 'kidney', 'hepaticVein', 'ivcInfra', 'trunk'], def: ['aortaAbd', 'portal', 'liver'], cards: ['aortaPeak', 'liverPeak', 'arrival', 'atScan'], aorta: 'aortaAbd', organ: 'liver', phases: ['ea', 'la', 'pv', 'eq'], defaults: { volume: 100, rate: 3, saline: 30, timing: 'fixed', delay: 70 } },
  pelvis: { series: ['iliacArtery', 'iliacVein', 'trunk', 'aortaInfra', 'ivcInfra'], def: ['iliacArtery', 'iliacVein', 'trunk'], cards: ['iaPeak', 'ivPeak', 'arrival', 'atScan'], aorta: 'iliacArtery', organ: 'iliacVein', phases: ['ea', 'la', 'ven', 'eq'], defaults: { volume: 100, rate: 4, saline: 40, timing: 'bt', btThr: 100, btMon: 8, btDiag: 10, delay: 30 } },
};
const CARD_KEY = { aortaPeak: r => REGIONS[r].aorta, liverPeak: () => 'liver', paPeak: () => 'pulmArtery', iaPeak: () => 'iliacArtery', ivPeak: () => 'iliacVein' };
const DEFAULTS = { region: 'abd', sex: 'M', height: 170, weight: 60, age: 60, coMode: 'estimate', coPct: 100, coAbs: 5, conc: 350, doseMode: 'volume', volume: 100, mgkg: 600, injMode: 'rate', rate: 3, duration: 30, biphasic: '0', rate2: 1, frac2: 60, saline: 30, huCoef: 25, timing: 'fixed', delay: 70, btThr: 100, btMon: 10, btDiag: 15, btRoi: 'aorta', scanDur: 5, psq: '5', tEnd: '300', optVar: 'volume', phase: '' };
const RANGES = ['height', 'weight', 'age', 'coPct', 'coAbs', 'volume', 'mgkg', 'rate', 'duration', 'rate2', 'frac2', 'saline', 'delay', 'btThr', 'btMon', 'btDiag', 'scanDur'];

let S = Object.assign({}, DEFAULTS);
let lang = (location.hash === '#en' || location.hash === '#ja') ? location.hash.slice(1) : (localStorage.getItem('ccs.lang') || document.documentElement.lang || 'ja');
let adv = localStorage.getItem('ccs.adv') === '1';
let theme = localStorage.getItem('ccs.theme') || 'auto';
let sim = null, ref = null, visible = new Set(REGIONS.abd.def);
let lessonId = localStorage.getItem('ccs.lesson') || I18N.lessons[0].id;
let viewer = null;
const T = () => I18N[lang];

/* ---------- i18n ---------- */
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(el => { const v = T()[el.dataset.t]; if (typeof v === 'string') el.innerHTML = v; });
  document.title = T().title;
  $('langSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === lang));
  $('themeBtn').title = T().theme; $('aboutBtn').title = T().aboutTitle; $('aboutClose').title = T().close;
  rebuildPhaseSelect();
  $('optTarget').innerHTML = Object.entries(T().optTargets).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  renderAbout();
  if (viewer) viewer.setLang(lang);
}
function rebuildPhaseSelect() { const ps = $('phasePreset'); ps.innerHTML = `<option value="">${T().phaseNone}</option>` + REGIONS[S.region].phases.map(k => `<option value="${k}">${T().phases[k]}</option>`).join(''); ps.value = S.phase || ''; }

/* ---------- UI 配線 ---------- */
for (const id of RANGES) $(id).addEventListener('input', () => { S[id] = +$(id).value; if (id === 'delay') S.timing = 'fixed'; if (['delay', 'btThr', 'btMon', 'btDiag'].includes(id)) S.phase = ''; update(); });
for (const id of ['conc', 'psq', 'tEnd']) $(id).addEventListener('change', () => { S[id] = $(id).value; update(); });
$('phasePreset').addEventListener('change', () => applyPreset($('phasePreset').value));
$('huCoef').addEventListener('change', () => { const v = +$('huCoef').value; if (v >= 5 && v <= 80) S.huCoef = v; update(); });
document.querySelectorAll('.seg[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const k = seg.dataset.seg; S[k] = b.dataset.v;
  if (k === 'timing') { S.phase = ''; S.btRoi = 'aorta'; }
  update();
})));
$('regions').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setRegion(b.dataset.v, true)));
$('langSeg').querySelectorAll('button').forEach(b => b.onclick = () => { if (lang === b.dataset.v) return; lang = b.dataset.v; localStorage.setItem('ccs.lang', lang); history.replaceState(null, '', '#' + lang); applyLang(); update(); });
$('themeBtn').onclick = () => { theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto'; localStorage.setItem('ccs.theme', theme); applyTheme(); drawChart(); };
function applyTheme() { if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme); $('themeBtn').textContent = theme === 'auto' ? '◐' : theme === 'light' ? '☀' : '☾'; }
const snapshotRef = () => ({ series: sim.series, hu: S.huCoef, label: describe() });
$('btnCompare').onclick = () => { ref = ref ? null : snapshotRef(); update(); };
$('btnReset').onclick = () => { resetState(S.region); buildChips(); update(); };
$('btnOpt').onclick = optimize;
$('advToggle').onchange = e => { adv = e.target.checked; localStorage.setItem('ccs.adv', adv ? '1' : '0'); if (!adv && currentLesson().adv) gotoLesson('free', false); else { renderLesson(); update(); } };
$('aboutBtn').onclick = () => $('aboutDlg').showModal();
$('aboutClose').onclick = () => $('aboutDlg').close();
$('aboutDlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('btnPrev').onclick = () => stepLesson(-1);
$('btnNext').onclick = () => stepLesson(1);
$('btnCompareShow').onclick = runCompare;

// 状態を既定 + 部位既定 (+ extra) に戻す
function resetState(region, extra) { S = Object.assign({}, DEFAULTS, { region }, REGIONS[region].defaults, extra || {}); ref = null; visible = new Set(REGIONS[region].def); }
function setRegion(r, applyDefaults) {
  S.region = r;
  if (applyDefaults) { Object.assign(S, { delay: DEFAULTS.delay, btThr: DEFAULTS.btThr, btMon: DEFAULTS.btMon, btDiag: DEFAULTS.btDiag }, REGIONS[r].defaults); S.phase = ''; S.btRoi = 'aorta'; }
  visible = new Set(REGIONS[r].def);
  rebuildPhaseSelect(); buildChips(); update();
}
function applyPreset(v) {
  S.phase = v; if (!v) { update(); return; }
  S.btRoi = 'aorta';
  if (v === 'pa') { S.timing = 'bt'; S.btThr = 100; S.btMon = 5; S.btDiag = 4; S.btRoi = 'pa'; }
  else if (v === 'ea' || v === 'la') { S.timing = 'bt'; S.btThr = 100; S.btMon = 8; S.btDiag = v === 'ea' ? 8 : 18; }
  else if (v === 'pv') { S.timing = 'fixed'; S.delay = 70; }
  else if (v === 'ven') { S.timing = 'fixed'; S.delay = 90; }
  else if (v === 'eq') { S.timing = 'fixed'; S.delay = 180; }
  update();
}

function syncUI() {
  document.body.dataset.adv = adv ? '1' : '0';
  $('advToggle').checked = adv;
  document.querySelectorAll('.seg[data-seg]').forEach(seg => { const k = seg.dataset.seg; const cur = String(S[k]); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', cur === b.dataset.v)); });
  $('regions').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S.region));
  for (const id of RANGES) $(id).value = S[id];
  for (const id of ['conc', 'psq', 'tEnd']) $(id).value = S[id];
  $('phasePreset').value = S.phase || '';
  $('huCoef').value = S.huCoef;
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  show('coPctRow', S.coMode === 'percent'); show('coAbsRow', S.coMode === 'absolute');
  show('volRow', S.doseMode === 'volume'); show('mgkgRow', S.doseMode === 'mgkg');
  show('rateRow', S.injMode === 'rate'); show('durRow', S.injMode === 'duration');
  show('biRows', S.biphasic === '1'); show('btRows', S.timing === 'bt'); show('delayRow', S.timing === 'fixed');
  $('height_v').textContent = S.height + ' cm'; $('weight_v').textContent = S.weight + ' kg'; $('age_v').textContent = S.age + (lang === 'ja' ? ' 歳' : ' y');
  $('coPct_v').textContent = S.coPct + ' %'; $('coAbs_v').textContent = S.coAbs.toFixed(1) + ' L/min';
  $('volume_v').textContent = S.volume + ' mL'; $('mgkg_v').textContent = S.mgkg + ' mgI/kg';
  $('rate_v').textContent = S.rate.toFixed(1) + ' mL/s'; $('duration_v').textContent = S.duration + ' s';
  $('rate2_v').textContent = S.rate2.toFixed(1) + ' mL/s'; $('frac2_v').textContent = S.frac2 + ' %'; $('saline_v').textContent = S.saline + ' mL';
  $('delay_v').textContent = S.delay + ' s';
  $('btThr_v').textContent = '+' + S.btThr + ' HU'; $('btMon_v').textContent = S.btMon + ' s'; $('btDiag_v').textContent = S.btDiag + ' s';
  $('scanDur_v').textContent = S.scanDur + ' s';
  const b = $('btnCompare'); b.textContent = ref ? T().compareClear : T().compareFix; b.classList.toggle('on', !!ref);
}

/* ---------- 注入プロトコル ---------- */
function protocol() {
  const conc = +S.conc;
  let vol = S.doseMode === 'volume' ? S.volume : S.mgkg * S.weight / conc;
  vol = Math.max(5, Math.min(300, vol));
  let phases;
  if (S.biphasic === '1') {
    const v2 = vol * S.frac2 / 100, v1 = vol - v2;
    const r1 = S.injMode === 'rate' ? S.rate : Math.max(0.2, v1 / Math.max(1, S.duration - v2 / S.rate2));
    phases = [{ rate: r1, volume: v1 }, { rate: S.rate2, volume: v2 }];
  } else phases = [{ rate: S.injMode === 'rate' ? S.rate : vol / S.duration, volume: vol }];
  const saline = { rate: phases[phases.length - 1].rate, volume: S.saline };
  const dur = phases.reduce((s, p) => s + p.volume / p.rate, 0);
  return { conc, vol, phases, saline, dur, iodine: vol * conc / 1000, idr: phases[0].rate * conc / 1000 };
}
function describe() {
  const p = protocol(); const parts = [`${S.weight} kg`, `${p.conc} mgI/mL`, `${p.vol.toFixed(0)} mL`, `${p.phases.map(x => x.rate.toFixed(1)).join('+')} mL/s`, `NaCl ${S.saline} mL`];
  if (S.coMode === 'percent' && S.coPct !== 100) parts.push(`CO ${S.coPct} %`);
  if (S.coMode === 'absolute') parts.push(`CO ${S.coAbs.toFixed(1)} L/min`);
  if (+S.huCoef !== 25) parts.push(`${S.huCoef} HU/(mgI/mL)`);
  return parts.join(' · ');
}

/* ---------- 計算 ---------- */
function runSim() {
  const p = protocol();
  sim = BaeModel.simulate({ sex: S.sex, heightCm: S.height, weightKg: S.weight, age: S.age,
    coMode: S.coMode, coValue: S.coMode === 'percent' ? S.coPct : S.coAbs, bvMode: 'estimate',
    psFactor: S.psq === 'Infinity' ? Infinity : +S.psq,
    conc: p.conc, phases: p.phases, saline: p.saline, tEnd: +S.tEnd, dt: 0.05, sample: 0.5 });
  sim.proto = p;
}
function valueAt(series, key, t, coef) { const ts = series.t; if (t <= 0) return 0; if (t >= ts[ts.length - 1]) return series[key][ts.length - 1] * coef; const i = Math.min(ts.length - 2, Math.floor(t / (ts[1] - ts[0]))); const f = (t - ts[i]) / (ts[i + 1] - ts[i]); return (series[key][i] * (1 - f) + series[key][i + 1] * f) * coef; }
function meanOver(series, key, t0, t1, coef) { let n = 0, s = 0; for (let t = t0; t <= t1 + 1e-9; t += 0.5) { s += valueAt(series, key, t, coef); n++; } return n ? s / n : 0; }
function firstReach(series, key, thr, tFrom, coef) { const ts = series.t; for (let i = 0; i < ts.length; i++) if (ts[i] >= tFrom && series[key][i] * coef >= thr) return ts[i]; return null; }
function btKey() { return S.btRoi === 'pa' ? 'pulmArtery' : REGIONS[S.region].aorta; }
function scanWindow() {
  if (S.timing === 'bt') { const tr = firstReach(sim.series, btKey(), S.btThr, S.btMon, S.huCoef); if (tr == null) return { start: null, end: null, trig: null }; return { start: tr + S.btDiag, end: tr + S.btDiag + S.scanDur, trig: tr }; }
  return { start: S.delay, end: S.delay + S.scanDur, trig: null };
}
function peak(key) { const q = BaeModel.peakOf(sim.series.t, sim.series[key]); return { v: q.v * S.huCoef, t: q.t }; }
function durAbove(key, thr) { const s = sim.series; let n = 0; for (let i = 0; i < s.t.length; i++) if (s[key][i] * S.huCoef >= thr) n++; return n ? (n * 0.5).toFixed(0) + ' s' : '—'; }

/* ---------- 更新 ---------- */
function update() {
  syncUI(); runSim();
  const t = T(), p = sim.proto, R = REGIONS[S.region];
  $('bv_v').textContent = sim.info.BV.toFixed(0) + ' mL'; $('co_v2').textContent = (sim.info.CO / 1000).toFixed(2) + ' L/min';
  $('injSummary').textContent = t.injSummary(p, S.weight);
  $('refLabel').textContent = ref ? `${t.ref}: ${ref.label}` : '';
  const w = scanWindow();
  // 数値ストリップ
  const cards = R.cards.map(k => {
    if (k === 'arrival') { const a = firstReach(sim.series, R.aorta, 50, 0, S.huCoef); return { k: t.cards.arrival, v: a == null ? '—' : a.toFixed(1), u: 's' }; }
    if (k === 'atScan') { if (w.start == null) return { k: t.cards.atScan, v: t.notReached, bad: true }; const a = meanOver(sim.series, R.aorta, w.start, w.end, S.huCoef), b = meanOver(sim.series, R.organ, w.start, w.end, S.huCoef); return { k: `${t.cards.atScan} (${w.start.toFixed(0)}–${w.end.toFixed(0)} s)`, v: `${a.toFixed(0)} / ${b.toFixed(0)}`, u: 'HU', d: `${t.series[R.aorta]} / ${t.series[R.organ]}` }; }
    const key = CARD_KEY[k](S.region), pk = peak(key); return { k: t.cards[k], v: pk.v.toFixed(0), u: 'HU', d: `${t.at} ${pk.t.toFixed(1)} s` };
  });
  $('cards').innerHTML = cards.map(c => `<div class="stat${c.bad ? ' bad' : ''}"><div class="k">${c.k}</div><div class="v">${c.v}${c.u ? `<small>${c.u}</small>` : ''}</div><div class="d">${c.d || ''}</div></div>`).join('');
  // 詳細パネル (数値表)
  if (adv) {
    let h = `<tr><th>${t.peakTbl[0]}</th><th>${t.peakTbl[1]}</th><th>${t.peakTbl[2]}</th></tr>`;
    for (const k of R.series) { const pk = peak(k); h += `<tr><td>${t.series[k]}</td><td>${pk.v.toFixed(0)}</td><td>${pk.t.toFixed(1)}</td></tr>`; }
    $('peakTable').innerHTML = h;
    h = `<tr><th>${t.tblHead[0]}</th><th>${t.tblHead[1]}</th>${ref ? `<th>${t.tblHead[2]}</th>` : ''}</tr>`;
    for (const k of R.series) { const v = w.start == null ? NaN : meanOver(sim.series, k, w.start, w.end, S.huCoef); const rv = ref && w.start != null ? meanOver(ref.series, k, w.start, w.end, ref.hu) : NaN; h += `<tr><td>${t.series[k]}</td><td>${isNaN(v) ? '—' : v.toFixed(0)}</td>${ref ? `<td>${isNaN(rv) ? '—' : rv.toFixed(0)}</td>` : ''}</tr>`; }
    $('scanTable').innerHTML = h;
    const ex = sim.series.excreted[sim.series.excreted.length - 1] / sim.info.totalIodine * 100;
    $('misc').innerHTML = `${t.bvco}: ${sim.info.BV.toFixed(0)} mL / ${(sim.info.CO / 1000).toFixed(2)} L/min · ${t.scanWindow}: ${w.start == null ? t.notReached : `${w.start.toFixed(1)}–${w.end.toFixed(1)} s`}${w.trig != null ? ` (${t.trig} ${w.trig.toFixed(1)} s)` : ''} · ${t.dur200}: ${durAbove(R.aorta, 200)} · ${t.dur50}: ${durAbove('liver', 50)} · ${t.excreted}: ${ex.toFixed(1)} %`;
  }
  drawChart();
  if (viewer) viewer.update();
}

/* ---------- グラフ ---------- */
const chart = $('chart'), ctx = chart.getContext('2d');
const CH = { x0: 44, y0: 12, x1: 0, y1: 0, tmax: 300, ymax: 400, W: 0, H: 380 };
function buildChips() { $('chips').innerHTML = REGIONS[S.region].series.map(k => `<span class="chip${visible.has(k) ? ' on' : ''}" data-k="${k}"><i style="background:${COLORS[k]}"></i>${T().series[k]}</span>`).join(''); $('chips').querySelectorAll('.chip').forEach(c => c.onclick = () => { const k = c.dataset.k; visible.has(k) ? visible.delete(k) : visible.add(k); c.classList.toggle('on'); drawChart(); }); }
function tx(t) { return CH.x0 + (t / CH.tmax) * (CH.x1 - CH.x0); }
function ty(v) { return CH.y1 - (v / CH.ymax) * (CH.y1 - CH.y0); }
function drawChart() {
  const r = chart.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; if (r.width === 0) return;
  chart.width = Math.round(r.width * dpr); chart.height = Math.round(CH.H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); CH.W = r.width;
  const s = sim.series, coef = S.huCoef, t = T(); CH.x1 = CH.W - 12; CH.y1 = CH.H - 52; CH.tmax = +S.tEnd;
  let ym = 100; for (const k of visible) { if (!s[k]) continue; for (let i = 0; i < s.t.length; i++) ym = Math.max(ym, s[k][i] * coef); if (ref) for (let i = 0; i < ref.series.t.length; i++) ym = Math.max(ym, ref.series[k][i] * ref.hu); }
  CH.ymax = Math.ceil(ym / 50) * 50 + 25;
  const css = getComputedStyle(document.documentElement); const mute = css.getPropertyValue('--mute').trim(), line = css.getPropertyValue('--line').trim(), accent = css.getPropertyValue('--accent').trim(), rgb = css.getPropertyValue('--accent-rgb').trim();
  ctx.clearRect(0, 0, CH.W, CH.H); ctx.font = '11px sans-serif'; ctx.fillStyle = mute; ctx.strokeStyle = line; ctx.lineWidth = 1;
  const ystep = CH.ymax > 600 ? 200 : CH.ymax > 300 ? 100 : 50;
  for (let v = 0; v <= CH.ymax; v += ystep) { ctx.beginPath(); ctx.moveTo(CH.x0, ty(v)); ctx.lineTo(CH.x1, ty(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(v, CH.x0 - 6, ty(v) + 4); }
  const xstep = CH.tmax > 400 ? 60 : 30;
  for (let x = 0; x <= CH.tmax; x += xstep) { ctx.beginPath(); ctx.moveTo(tx(x), CH.y0); ctx.lineTo(tx(x), CH.y1); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(x, tx(x), CH.y1 + 14); }
  ctx.textAlign = 'left'; ctx.fillText(t.yLabel, CH.x0 + 4, CH.y0 + 10);
  ctx.textAlign = 'right'; ctx.fillText(t.xLabel, CH.x1, CH.y1 + 27);
  const w = scanWindow();
  if (w.start != null) { ctx.fillStyle = `rgba(${rgb},.12)`; ctx.fillRect(tx(w.start), CH.y0, Math.max(2, tx(w.end) - tx(w.start)), CH.y1 - CH.y0); ctx.fillStyle = accent; ctx.textAlign = 'left'; ctx.fillText(t.scanBand, tx(w.start) + 3, CH.y1 - 5); }
  if (S.timing === 'bt') { const col = COLORS[btKey()]; ctx.setLineDash([3, 3]); ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(tx(S.btMon), ty(S.btThr)); ctx.lineTo(CH.x1, ty(S.btThr)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.fillText(t.btLine, CH.x1 - 2, ty(S.btThr) - 3); if (w.trig != null) { ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(tx(w.trig), CH.y0); ctx.lineTo(tx(w.trig), CH.y1); ctx.stroke(); } }
  // 注入ストリップ
  const p = sim.proto; let t0 = 0; const ys = CH.y1 + 32;
  for (const ph of p.phases) { const d = ph.volume / ph.rate; ctx.fillStyle = mute; const hh = 3 + Math.min(9, ph.rate * 1.4); ctx.fillRect(tx(t0), ys + 12 - hh, tx(t0 + d) - tx(t0), hh); t0 += d; }
  if (p.saline.volume > 0) { const d = p.saline.volume / p.saline.rate; ctx.fillStyle = line; const hh = 3 + Math.min(9, p.saline.rate * 1.4); ctx.fillRect(tx(t0), ys + 12 - hh, tx(t0 + d) - tx(t0), hh); t0 += d; }
  ctx.fillStyle = mute; ctx.textAlign = 'left'; ctx.fillText(t.injStrip, tx(t0) + 6, ys + 10);
  if (viewer && viewer.cursorTime() != null) { ctx.strokeStyle = mute; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(tx(viewer.cursorTime()), CH.y0); ctx.lineTo(tx(viewer.cursorTime()), CH.y1); ctx.stroke(); ctx.setLineDash([]); }
  ctx.save(); ctx.beginPath(); ctx.rect(CH.x0, CH.y0, CH.x1 - CH.x0, CH.y1 - CH.y0); ctx.clip();
  const plot = (series, key, c, color, dashed) => { if (!series[key]) return; ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.3 : 2; ctx.setLineDash(dashed ? [5, 4] : []); ctx.beginPath(); for (let i = 0; i < series.t.length; i++) { const x = tx(series.t[i]), y = ty(series[key][i] * c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.setLineDash([]); };
  for (const k of REGIONS[S.region].series) if (visible.has(k)) { if (ref) plot(ref.series, k, ref.hu, COLORS[k], true); plot(s, k, coef, COLORS[k], false); }
  ctx.restore();
}
chart.addEventListener('mousemove', e => { const r = chart.getBoundingClientRect(); const x = e.clientX - r.left; const tt = (x - CH.x0) / (CH.x1 - CH.x0) * CH.tmax; const tip = $('tip'); if (tt < 0 || tt > CH.tmax) { tip.style.display = 'none'; return; } let h = `<b>${tt.toFixed(1)} s</b>`; for (const k of REGIONS[S.region].series) if (visible.has(k)) h += `<br><span style="color:${COLORS[k]}">●</span> ${T().series[k]}: ${valueAt(sim.series, k, tt, S.huCoef).toFixed(0)}` + (ref ? ` <span style="opacity:.7">(${valueAt(ref.series, k, tt, ref.hu).toFixed(0)})</span>` : ''); tip.innerHTML = h; tip.style.display = 'block'; tip.style.left = Math.min(x + 12, r.width - 190) + 'px'; tip.style.top = (e.clientY - r.top + 10) + 'px'; });
chart.addEventListener('mouseleave', () => $('tip').style.display = 'none');
chart.addEventListener('click', e => { const r = chart.getBoundingClientRect(); const tt = (e.clientX - r.left - CH.x0) / (CH.x1 - CH.x0) * CH.tmax; if (tt >= 0 && tt <= CH.tmax) { S.timing = 'fixed'; S.delay = Math.round(tt); S.phase = ''; update(); } });
window.addEventListener('resize', drawChart);

/* ---------- レッスン ---------- */
function lessons() { return I18N.lessons.filter(l => adv || !l.adv); }
function currentLesson() { return I18N.lessons.find(l => l.id === lessonId) || I18N.lessons[0]; }
function applySetup(l) { resetState(l.region, l.setup); rebuildPhaseSelect(); buildChips(); }
function gotoLesson(id, applyConditions) {
  lessonId = id; localStorage.setItem('ccs.lesson', id);
  const l = currentLesson();
  if (applyConditions && l.setup) applySetup(l);
  renderLesson(); update();
}
function stepLesson(d) { const ls = lessons(); const i = ls.findIndex(l => l.id === lessonId); const j = Math.max(0, Math.min(ls.length - 1, i + d)); if (j !== i) gotoLesson(ls[j].id, true); }
function renderLesson() {
  const t = T(), ls = lessons(), l = currentLesson(), i = ls.findIndex(x => x.id === l.id), n = ls.filter(x => !x.adv && x.id !== 'free').length, txt = l[lang];
  const isFree = l.id === 'free';
  $('lessonN').textContent = isFree ? '' : l.adv ? t.lesson : t.lessonOf(i + 1, n);
  $('lessonTag').textContent = l.adv ? t.advTag : '';
  $('lessonT').textContent = txt.t; $('lessonP').textContent = txt.p; $('lessonPoint').textContent = txt.point || '';
  $('lessonR').textContent = txt.r ? `${t.seeRef}: ${txt.r}` : '';
  $('btnPrev').textContent = '‹ ' + t.prev; $('btnNext').textContent = t.next + ' ›';
  $('btnPrev').disabled = i <= 0; $('btnNext').disabled = i >= ls.length - 1;
  $('btnCompareShow').textContent = t.compareShow; $('btnCompareShow').classList.toggle('hidden', !l.compare);
  document.querySelectorAll('[data-f]').forEach(el => el.classList.toggle('focus', !!l.focus && el.dataset.f === l.focus));
}
function runCompare() {
  const l = currentLesson(); if (!l.compare) return;
  applySetup(l); Object.assign(S, l.compare.A);
  update();
  ref = snapshotRef();
  Object.assign(S, l.compare.B);
  update();
  $('chart').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderAbout() { $('modelInfo').innerHTML = T().about; $('refs').innerHTML = I18N.refs.map(r => `<li>${r}</li>`).join(''); }

/* ---------- 簡易最適化 ---------- */
function optimize() {
  const t = T(), target = $('optTarget').value, goal = +$('optHU').value, modeV = S.optVar || 'volume';
  if (!(goal > 0)) return;
  const saved = Object.assign({}, S), savedRef = ref, R = REGIONS[S.region];
  const metric = () => { runSim(); const w = scanWindow(); if (target === 'aortaPeak') return peak(R.aorta).v; if (target === 'liverPeak') return peak('liver').v; if (w.start == null) return 0; return meanOver(sim.series, target === 'aortaScan' ? R.aorta : 'liver', w.start, w.end, S.huCoef); };
  S.doseMode = 'volume'; if (modeV === 'volumeDur') { if (S.injMode === 'rate') S.duration = Math.round(protocol().dur); S.injMode = 'duration'; } else S.injMode = 'rate';
  let lo = 5, hi = 250; S.volume = hi; const mx = metric();
  if (mx < goal) { S = saved; ref = savedRef; update(); $('optOut').innerHTML = `<span style="color:var(--accent)">${t.optFail(mx)}</span>`; return; }
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; S.volume = mid; if (metric() >= goal) hi = mid; else lo = mid; }
  const v = Math.ceil(hi); S.volume = v; const got = metric(); const p = protocol();
  $('optOut').innerHTML = t.optOk(v, p, S.weight, got, target.includes('Scan'), modeV, modeV === 'volumeDur' ? S.duration : p.dur, p.phases[0].rate);
  ref = savedRef; update();
}

/* ---------- 画像 (viewer.js) ---------- */
window.CCS = {
  get S() { return S; }, get lang() { return lang; }, T, scanWindow,
  huAt(key, tt) { return sim && sim.series[key] ? valueAt(sim.series, key, tt, S.huCoef) : 0; },
  showSeries(k) { if (REGIONS[S.region].series.includes(k)) { visible.add(k); buildChips(); drawChart(); } },
  redrawChart: drawChart,
};

/* ---------- 起動 ---------- */
applyTheme();
// 保存されたレッスン id が無効 (削除済み / 詳細設定 OFF の応用) なら先頭へ
if (!I18N.lessons.some(l => l.id === lessonId) || (!adv && currentLesson().adv)) { lessonId = I18N.lessons[0].id; localStorage.setItem('ccs.lesson', lessonId); }
{ const l = currentLesson(); resetState(l.setup ? l.region : 'abd', l.setup); }
applyLang(); buildChips(); renderLesson(); update();
if (typeof Viewer !== 'undefined') viewer = Viewer.create($('viewerHost'), window.CCS);
})();
