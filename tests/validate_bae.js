// Bae の特許 (US 5,583,902) / Radiology 1998 Part I に記載された 3 プロトコルについて、
// Bae 自身の予測値と本実装の大動脈・肝ピークを比較し、合否を返す。
//   node tests/validate_bae.js                       PS/Q = 5 で判定 (終了コード 0 = PASS)
//   node tests/validate_bae.js 2,5,10,Infinity       複数の PS/Q を一覧 (判定は最初の値)
// 合格条件: Bae の予測値との平均誤差が大動脈・肝とも 10 % 以内、ヨード質量の保存誤差 0.1 % 以内
//   Ioversol-320, 125 mL, 男性 5'8", 30 歳と仮定 (特許 FIG.13 の仮想患者が 5'8")
const B = require('../src/bae_model.js');
const HU = B.STD.HU_PER_MGI;
const protos = [
  { name: 'Biphasic-low  ', lb: 158, phases: [{ rate: 2.5, volume: 50 }, { rate: 1.0, volume: 75 }], ref: { a: 142.7, l: 53.8, ea: 163.4, el: 55.5 } },
  { name: 'Uniphasic-low ', lb: 171, phases: [{ rate: 2.5, volume: 125 }], ref: { a: 220.4, l: 63.8, ea: 205.8, el: 59.8 } },
  { name: 'Uniphasic-high', lb: 177, phases: [{ rate: 5.0, volume: 125 }], ref: { a: 321.3, l: 63.6, ea: 313.7, el: 60.8 } },
];
const psList = process.argv[2] ? process.argv[2].split(',').map(Number) : [5];
const TOL_ERR = 10, TOL_MASS = 0.1;
let pass = true;
for (const [n, ps] of psList.entries()) {
  console.log(`--- PS/Q = ${ps} ---`);
  let errA = 0, errL = 0, massErr = 0;
  for (const pr of protos) {
    const r = B.simulate({ sex: 'M', heightCm: 68 * 2.54, weightKg: pr.lb / 2.20462, age: 30,
      coMode: 'estimate', bvMode: 'estimate', psFactor: ps, conc: 320, phases: pr.phases, tEnd: 240, dt: 0.05, sample: 0.5 });
    const s = r.series;
    const pa = B.peakOf(s.t, s.aortaAbd), pl = B.peakOf(s.t, s.liver);
    const A = pa.v * HU, L = pl.v * HU;
    errA += Math.abs(A - pr.ref.a) / pr.ref.a / protos.length; errL += Math.abs(L - pr.ref.l) / pr.ref.l / protos.length;
    const lastTot = s.totalIodine[s.totalIodine.length - 1] + s.excreted[s.excreted.length - 1];
    massErr = Math.max(massErr, Math.abs(lastTot / r.info.totalIodine - 1) * 100);
    console.log(`${pr.name}  aorta ${A.toFixed(1)} HU @${pa.t}s (Bae ${pr.ref.a}, measured ${pr.ref.ea}) | liver ${L.toFixed(1)} HU @${pl.t}s (Bae ${pr.ref.l}, measured ${pr.ref.el})`);
  }
  console.log(`mean |error| vs Bae: aorta ${(errA * 100).toFixed(1)} %, liver ${(errL * 100).toFixed(1)} %; iodine mass error ${massErr.toFixed(3)} %`);
  if (n === 0) pass = errA * 100 <= TOL_ERR && errL * 100 <= TOL_ERR && massErr <= TOL_MASS;
}
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
