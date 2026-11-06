/*
 * Bae 型 全身コンパートメント薬物動態モデル (CT 造影剤)
 *
 * 出典:
 *  [1] Bae KT, Heiken JP, Brink JA. Aortic and hepatic contrast medium enhancement at CT.
 *      Part I. Prediction with a computer model. Radiology 1998;207:647-655. (PMID 9609886)
 *  [2] Bae KT. US Patent 5,583,902 (1996) "Method of and apparatus for predicting computed
 *      tomography contrast enhancement" — [1] と同じモデルの式・表 (Tables 1-6) が全文で公開されている。
 *  [12] Sahbaee P, et al. Radiology 2017;283:739-748 (区画の流量・容量の照合に使用)
 *  [13] Higaki T, et al. PLoS ONE 2018;13:e0191347 (同上)
 *  (番号は docs/MODEL.md の出典リストと同じ)
 *
 * モデルの要点 ([2] の記述そのまま):
 *  - 血管・心臓: well-stirred compartment  V dC/dt = Q (Cin - C)
 *      大血管は直列に分割 (動脈 20 mL, 静脈 100 mL 刻み)
 *  - 臓器: 血管内 (IV) と細胞外 (EC) の 2 区画。細胞内 (IC) には入らない。
 *      V_iv dC_iv/dt = q (C_in - C_iv) - PS (C_iv - C_ec)
 *      V_ec dC_ec/dt = PS (C_iv - C_ec)
 *      PS は流量 Q に対する比 PS/Q で与える (flow-limited: 全臓器同一の係数, 2-10 が推奨範囲)
 *  - 臓器の濃度 = (IV + EC のヨード質量) / (IV + EC + IC 容量)
 *  - 腎排泄 = 血漿濃度 × GFR, GFR ≈ 腎血漿流量の 19 %
 *  - 標準体: 血液量 5000 mL (血漿 3 L), 心拍出量 6500 mL/min, 体重 70 kg, 全体水 40 L,
 *      ECF 18.9 L (iohexol の分布容積 0.27 L/kg), ECF:ICF 比は全臓器同一
 *  - 体格補正: 血液量 BV と心拍出量 CO を身長・体重 (・性別) の回帰式で推定し,
 *      標準値との比を全容量 / 全流量に掛ける。年齢補正 CO × (1 - 0.008 (age - 30))
 *  - 1 mg I/mL = 25 HU (120 kVp, Ioversol-320, Siemens Somatom Plus で実測)
 *
 * 本実装で [1][2] に無いもの (UI 側で明示):
 *  - 生理食塩水後押し: 注入部位の区画に造影剤濃度ゼロの液を同じ速度で続けて入れるだけ
 */
(function (root) {
  'use strict';

  const STD = {
    BV: 5000,          // mL
    CO: 6500,          // mL/min
    HU_PER_MGI: 25,    // HU per (mg I / mL) at 120 kVp [2]
  };

  // ---- 標準モデルの構成 ---------------------------------------------------
  // 流量は mL/min ([2] Table 2 / [13] Fig 2), 容量は mL ([12] Table 1 / [2] Tables 4,5)
  const F = {
    CO: 6500, head: 975, arm: 325, coronary: 260, bronchial: 130,
    hepaticA: 455, portal: 1430, splStom: 430, pancInt: 1000, kidney: 1430, trunk: 1495,
  };
  // 臓器: IV (毛細血管), EC, IC  ([2] Table 4,5: ECF = (fluid - cap) × 15.9/35, ICF = 残り)
  const ORGANS = {
    lungPar:  { name: '肺 (実質)',          iv: 150, ec: 144,  ic: 173.5 },
    lungNon:  { name: '肺 (非実質)',        iv: 5,   ec: 144,  ic: 173.5 },
    head:     { name: '頭部',               iv: 37,  ec: 484,  ic: 581 },
    upperExt: { name: '上肢',               iv: 12,  ec: 2751, ic: 3304 },
    heartM:   { name: '心筋',               iv: 10,  ec: 103,  ic: 124 },
    liver:    { name: '肝',                 iv: 71,  ec: 524,  ic: 629 },
    splStom:  { name: '脾・胃',             iv: 16,  ec: 94.5, ic: 113.5 },
    pancInt:  { name: '膵・腸',             iv: 38,  ec: 565,  ic: 678 },
    kidney:   { name: '腎',                 iv: 54,  ec: 89,   ic: 106 },
    trunk:    { name: '体幹・下肢 (筋など)', iv: 57,  ec: 11002, ic: 13217 },
  };

  // ---- ネットワーク構築 ------------------------------------------------------
  function buildNetwork() {
    const comps = [];           // {id, name, kind:'vessel'|'iv'|'ec', V, Qout, inflows:[{from, Q}]}
    const idx = {};
    function add(c) { idx[c.id] = comps.length; c.inflows = []; comps.push(c); return c.id; }
    function link(from, to, Qmin) { comps[idx[to]].inflows.push({ from, Q: Qmin / 60 }); }
    // 直列分割 (動脈 20 mL, 静脈 100 mL)
    function chain(id, name, Vtot, Qmin, seg) {
      const n = Math.max(1, Math.round(Vtot / seg));
      const ids = [];
      for (let i = 0; i < n; i++) {
        const cid = n === 1 ? id : id + '_' + (i + 1);
        add({ id: cid, name: name + (n === 1 ? '' : ' ' + (i + 1) + '/' + n), kind: 'vessel', V: Vtot / n, Qout: Qmin / 60 });
        if (i > 0) link(ids[i - 1], cid, Qmin);
        ids.push(cid);
      }
      return { first: ids[0], last: ids[n - 1], ids };
    }
    function organ(id, Qmin) {
      const o = ORGANS[id];
      add({ id: id + '_iv', name: o.name + ' (血管内)', kind: 'iv', V: o.iv, Qout: Qmin / 60, organ: id, Qorgan: Qmin / 60 });
      add({ id: id + '_ec', name: o.name + ' (細胞外)', kind: 'ec', V: o.ec, Qout: 0, organ: id });
      return { in: id + '_iv', out: id + '_iv' };
    }
    const A = 20, Vn = 100; // 動脈 / 静脈の分割単位

    // 右心 → 肺動脈 → 肺 → 肺静脈 → 左心 → 大動脈
    add({ id: 'RH', name: '右心', kind: 'vessel', V: 180, Qout: F.CO / 60 });
    const PA = chain('PA', '肺動脈', 130, F.CO, A);            link('RH', PA.first, F.CO);
    const lung = organ('lungPar', F.CO);                        link(PA.last, lung.in, F.CO);
    const PV = chain('PV', '肺静脈', 160, F.CO, Vn);            link(lung.out, PV.first, F.CO);
    add({ id: 'LH', name: '左心', kind: 'vessel', V: 180, Qout: F.CO / 60 }); link(PV.last, 'LH', F.CO);
    const AO = chain('AO', '上行〜弓部大動脈', 100, F.CO, A);   link('LH', AO.first, F.CO);

    // 頭部
    const car = chain('CAR', '頸動脈', 20, F.head, A);          link(AO.last, car.first, F.head);
    const head = organ('head', F.head);                          link(car.last, head.in, F.head);
    const jug = chain('JUG', '頸静脈', 80, F.head, Vn);          link(head.out, jug.first, F.head); link(jug.last, 'RH', F.head);
    // 上肢 (両側) → 肘静脈 (注入側 / 対側) → 右心
    const sub = chain('SUB', '鎖骨下動脈', 20, F.arm, A);        link(AO.last, sub.first, F.arm);
    const arm = organ('upperExt', F.arm);                        link(sub.last, arm.in, F.arm);
    add({ id: 'VINJ', name: '肘静脈〜上大静脈 (注入側)', kind: 'vessel', V: 40, Qout: F.arm / 2 / 60, injectionSite: true });
    add({ id: 'VARM', name: '肘静脈〜上大静脈 (対側)', kind: 'vessel', V: 40, Qout: F.arm / 2 / 60 });
    link(arm.out, 'VINJ', F.arm / 2); link(arm.out, 'VARM', F.arm / 2);
    link('VINJ', 'RH', F.arm / 2);    link('VARM', 'RH', F.arm / 2);
    // 冠循環
    const hm = organ('heartM', F.coronary);                      link(AO.last, hm.in, F.coronary); link(hm.out, 'RH', F.coronary);
    // 胸部下行大動脈 → 気管支 / 腹部
    const Fthor = F.CO - F.head - F.arm - F.coronary;            // 4940
    const TA = chain('TA', '胸部下行大動脈', 100, Fthor, A);     link(AO.last, TA.first, Fthor);
    const ln = organ('lungNon', F.bronchial);                    link(TA.last, ln.in, F.bronchial); link(ln.out, 'RH', F.bronchial);
    const Fdesc = Fthor - F.bronchial;                           // 4810
    const DA = chain('DA', '腹部大動脈 (横隔膜〜腹腔動脈)', 100, Fdesc, A); link(TA.last, DA.first, Fdesc);
    // 肝 (肝動脈 + 門脈), 脾胃, 膵腸
    const ha = chain('HA', '肝動脈', 20, F.hepaticA, A);         link(DA.last, ha.first, F.hepaticA);
    const ce = chain('CE', '腹腔動脈 (脾胃枝)', 20, F.splStom, A); link(DA.last, ce.first, F.splStom);
    const me = chain('ME', '腸間膜動脈', 20, F.pancInt, A);      link(DA.last, me.first, F.pancInt);
    const ss = organ('splStom', F.splStom);                      link(ce.last, ss.in, F.splStom);
    const pi = organ('pancInt', F.pancInt);                      link(me.last, pi.in, F.pancInt);
    const pv = chain('PORT', '門脈', 100, F.portal, Vn);         link(ss.out, pv.first, F.splStom); link(pi.out, pv.first, F.pancInt);
    const liv = organ('liver', F.hepaticA + F.portal);           link(ha.last, liv.in, F.hepaticA); link(pv.last, liv.in, F.portal);
    const hv = chain('HV', '肝静脈', 100, F.hepaticA + F.portal, Vn); link(liv.out, hv.first, F.hepaticA + F.portal);
    const Fivcu = Fdesc;                                         // 4810 = 肝静脈 1885 + 下部 IVC 2925
    const IVCU = chain('IVCU', '下大静脈 (肝部〜右房)', 800, Fivcu, Vn); link(hv.last, IVCU.first, F.hepaticA + F.portal); link(IVCU.last, 'RH', Fivcu);
    // 腎, 体幹下肢
    const Fabd = Fdesc - F.hepaticA - F.splStom - F.pancInt;     // 2925
    const AA = chain('AA', '腹部大動脈 (腎動脈レベル以下)', 80, Fabd, A); link(DA.last, AA.first, Fabd);
    const ra = chain('RA', '腎動脈', 20, F.kidney, A);           link(AA.last, ra.first, F.kidney);
    const kid = organ('kidney', F.kidney);                       link(ra.last, kid.in, F.kidney);
    const rv = chain('RV', '腎静脈', 100, F.kidney, Vn);         link(kid.out, rv.first, F.kidney);
    const ia = chain('IA', '腸骨動脈', 200, F.trunk, A);         link(AA.last, ia.first, F.trunk);
    const tr = organ('trunk', F.trunk);                          link(ia.last, tr.in, F.trunk);
    const iv = chain('IV', '腸骨静脈', 1000, F.trunk, Vn);       link(tr.out, iv.first, F.trunk);
    const IVCL = chain('IVCL', '下大静脈 (腎静脈〜肝部)', 700, Fabd, Vn); link(rv.last, IVCL.first, F.kidney); link(iv.last, IVCL.first, F.trunk);
    link(IVCL.last, IVCU.first, Fabd);

    // 流量の整合チェック (流入合計 = 流出)
    for (const c of comps) {
      if (c.kind === 'ec') continue;
      const qin = c.inflows.reduce((s, e) => s + e.Q, 0);
      if (Math.abs(qin - c.Qout) > 1e-6) throw new Error('flow mismatch at ' + c.id + ': ' + qin + ' vs ' + c.Qout);
    }
    return { comps, idx, measure: {
      aortaAsc: AO.first, aortaArch: AO.last, aortaThor: TA.last, aortaAbd: DA.last, aortaInfra: AA.last,
      portal: pv.last, hepaticVein: hv.last, ivcInfra: IVCL.first, ivcSupra: IVCU.last,
      pulmArtery: PA.last, pulmVein: PV.last, rightHeart: 'RH', leftHeart: 'LH', injSite: 'VINJ',
      iliacArtery: ia.last, iliacVein: iv.last, renalVein: rv.last,
      carotid: car.last, jugular: jug.last,
    } };
  }

  // ---- 体格の推定式 ([2]: W [lb], H [in]) -------------------------------------
  function estimateBV(sex, heightCm, weightKg) {
    const H = heightCm / 2.54, W = weightKg * 2.20462;
    const k = Math.pow(H, 0.725) * Math.pow(W, 0.425);
    return sex === 'F' ? 34.85 * k - 1954 : 33.164 * k - 1229;   // mL
  }
  function estimateCO(heightCm, weightKg, age) {
    const H = heightCm / 2.54, W = weightKg * 2.20462;
    let co = 36.36 * Math.pow(H, 0.725) * Math.pow(W, 0.425);   // mL/min
    if (age != null && age > 30) co *= (1 - 0.008 * (age - 30));  // [2] の年齢補正 (6500 基準) を比として適用
    return co;
  }

  // ---- シミュレーション --------------------------------------------------------
  /**
   * p = {
   *   sex:'M'|'F', heightCm, weightKg, age,
   *   coMode:'estimate'|'absolute'|'percent', coValue (L/min or %),
   *   bvMode:'estimate'|'absolute', bvValue (mL),
   *   psFactor (PS/Q, 既定 5; Infinity で障壁なし),
   *   conc (mg I/mL), phases:[{rate (mL/s), volume (mL)}], saline:{rate, volume},
   *   tEnd (s), dt (s), sample (s)
   * }
   */
  function simulate(p) {
    const net = buildNetwork();
    const comps = net.comps;
    const n = comps.length;
    // 体格スケール
    const BV = p.bvMode === 'absolute' ? p.bvValue : estimateBV(p.sex, p.heightCm, p.weightKg);
    let CO;
    if (p.coMode === 'absolute') CO = p.coValue * 1000;
    else if (p.coMode === 'percent') CO = estimateCO(p.heightCm, p.weightKg, p.age) * p.coValue / 100;
    else CO = estimateCO(p.heightCm, p.weightKg, p.age);
    const sV = BV / STD.BV, sQ = CO / STD.CO;
    const V = new Float64Array(n), Qout = new Float64Array(n);
    for (let i = 0; i < n; i++) { V[i] = comps[i].V * sV; Qout[i] = comps[i].Qout * sQ; }
    // 流入リスト (index 化)
    const inFrom = comps.map(c => c.inflows.map(e => net.idx[e.from]));
    const inQ = comps.map(c => c.inflows.map(e => e.Q * sQ));
    // 臓器の PS, 腎 GFR
    const psFactor = p.psFactor == null ? 5 : p.psFactor;
    const ivIdx = [], ecIdx = [], PS = [];
    for (let i = 0; i < n; i++) if (comps[i].kind === 'iv') {
      ivIdx.push(i); ecIdx.push(net.idx[comps[i].organ + '_ec']);
      PS.push(isFinite(psFactor) ? psFactor * comps[i].Qorgan * sQ : Infinity);
    }
    const kidIv = net.idx['kidney_iv'];
    const GFRblood = 0.19 * comps[kidIv].Qorgan * sQ; // GFR(血漿) × (1/plasmaFrac) = 0.19 × 腎血流量 (血液濃度に掛ける)
    const injIdx = net.idx['VINJ'];
    const injQbase = Qout[injIdx];

    // 注入プログラム → (q(t), Cin(t))
    const segs = [];
    let t0 = 0;
    for (const ph of (p.phases || [])) {
      if (ph.volume > 0 && ph.rate > 0) { const d = ph.volume / ph.rate; segs.push({ t0, t1: t0 + d, q: ph.rate, c: p.conc }); t0 += d; }
    }
    if (p.saline && p.saline.volume > 0 && p.saline.rate > 0) {
      const d = p.saline.volume / p.saline.rate; segs.push({ t0, t1: t0 + d, q: p.saline.rate, c: 0 }); t0 += d;
    }
    const tInjEnd = t0;
    // 1 ステップ [ta, tb] の平均注入流量 q と ヨード流量 q·C (mg/s)。段階状の入力を RK4 の 4 段で同じ値にして、質量を厳密に保存する
    let curQ = 0, curQC = 0;
    function injAvg(ta, tb) { let q = 0, qc = 0; for (const s of segs) { const o = Math.min(tb, s.t1) - Math.max(ta, s.t0); if (o > 0) { q += s.q * o; qc += s.q * s.c * o; } } curQ = q / (tb - ta); curQC = qc / (tb - ta); }
    const dt = p.dt || 0.05, tEnd = p.tEnd || 300, sample = p.sample || 0.5;

    // 状態: 質量 M[i] (mg)。追加: M[n] = 排泄済み
    const N = n + 1;
    const M = new Float64Array(N);
    const dM = new Float64Array(N), k1 = new Float64Array(N), k2 = new Float64Array(N), k3 = new Float64Array(N), k4 = new Float64Array(N), tmp = new Float64Array(N);
    const C = new Float64Array(n);

    function deriv(t, M, out) {
      const q = curQ;
      for (let i = 0; i < n; i++) C[i] = M[i] / V[i];
      for (let i = 0; i < n; i++) {
        const c = comps[i];
        if (c.kind === 'ec') { out[i] = 0; continue; }
        let d = 0;
        const fr = inFrom[i], fq = inQ[i];
        for (let k = 0; k < fr.length; k++) {
          let Qk = fq[k];
          if (fr[k] === injIdx) Qk += q;               // 注入側の静脈は注入分だけ流量が増える
          d += Qk * C[fr[k]];
        }
        let qo = Qout[i];
        if (i === injIdx) { d += curQC; qo = injQbase + q; }
        d -= qo * C[i];
        out[i] = d;
      }
      // 経毛細血管交換
      for (let j = 0; j < ivIdx.length; j++) {
        const a = ivIdx[j], b = ecIdx[j];
        if (isFinite(PS[j])) {
          const x = PS[j] * (C[a] - C[b]);
          out[a] -= x; out[b] += x;
        } else {
          // 障壁なし: IV と EC を一体として扱う (濃度を瞬時に等しくする)
          const tot = M[a] + M[b], vt = V[a] + V[b];
          // 速い一次緩和で瞬時平衡を近似 (時定数 = dt。RK4 の安定条件 k·dt < 2.8 を満たす)
          const kfast = 1 / dt;
          const x = kfast * (M[a] - tot * V[a] / vt);
          out[a] -= x; out[b] += x;
        }
      }
      // 腎排泄
      const ex = GFRblood * C[kidIv];
      out[kidIv] -= ex;
      out[n] = ex;
    }

    const steps = Math.round(tEnd / dt), every = Math.max(1, Math.round(sample / dt));
    const meas = net.measure;
    const organs = Object.keys(ORGANS);
    const series = { t: [] };
    const vesselKeys = Object.keys(meas);
    for (const k of vesselKeys) series[k] = [];
    for (const o of organs) series[o] = [];
    series.excreted = []; series.totalIodine = [];
    const Vorg = {}; for (const o of organs) Vorg[o] = (ORGANS[o].iv + ORGANS[o].ec + ORGANS[o].ic) * sV;
    const kidV = Vorg.kidney;

    function record(t) {
      series.t.push(t);
      for (const k of vesselKeys) series[k].push(M[net.idx[meas[k]]] / V[net.idx[meas[k]]]);
      for (const o of organs) {
        let m = M[net.idx[o + '_iv']] + M[net.idx[o + '_ec']];
        series[o].push(m / Vorg[o]);
      }
      series.excreted.push(M[n]);
      let tot = 0; for (let i = 0; i < n; i++) tot += M[i]; series.totalIodine.push(tot);
    }
    record(0);
    let t = 0;
    for (let st = 1; st <= steps; st++) {
      injAvg(t, t + dt);
      deriv(t, M, k1);
      for (let i = 0; i < N; i++) tmp[i] = M[i] + 0.5 * dt * k1[i];
      deriv(t + 0.5 * dt, tmp, k2);
      for (let i = 0; i < N; i++) tmp[i] = M[i] + 0.5 * dt * k2[i];
      deriv(t + 0.5 * dt, tmp, k3);
      for (let i = 0; i < N; i++) tmp[i] = M[i] + dt * k3[i];
      deriv(t + dt, tmp, k4);
      for (let i = 0; i < N; i++) M[i] += dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      t = st * dt;
      if (st % every === 0) record(t);
    }
    const totalIodine = (p.phases || []).reduce((s, ph) => s + ph.volume, 0) * p.conc; // mg
    return { series, info: { BV, CO, sV, sQ, tInjEnd, totalIodine, GFRblood, psFactor, nComp: n, nOde: N }, net };
  }

  // 系列のピーク (値と時刻)
  function peakOf(t, y) { let im = 0; for (let i = 1; i < y.length; i++) if (y[i] > y[im]) im = i; return { t: t[im], v: y[im] }; }

  const api = { STD, ORGANS, buildNetwork, estimateBV, estimateCO, simulate, peakOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BaeModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
