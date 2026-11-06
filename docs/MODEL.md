# モデルの式・パラメータと出典

`src/bae_model.js` の実装内容。出典番号は末尾の「出典」（アプリの i ダイアログと同じ）。「本アプリ」と書いた行だけがこちらの選択・仮定。数値は特許 [2] の原文（Tables 1–6、FIG. 5、FIG. 7）と照合済み。

## 式

- 心臓・血管（完全混合区画）: `V dC/dt = Q (C_in − C)`。大血管は動脈 約 20 mL・静脈 約 100 mL 刻みで直列分割（区画数は容量 / 刻みを四捨五入）
- 臓器（血管内 IV と細胞外 EC の 2 区画。細胞内 IC には入らない）:
  `V_iv dC_iv/dt = Q (C_in − C_iv) − PS (C_iv − C_ec)`, `V_ec dC_ec/dt = PS (C_iv − C_ec)`
- 臓器の ΔHU = (IV + EC のヨード質量) / (IV + EC + IC 容量) × HU 係数
- 腎排泄 = 血漿濃度 × GFR（= 血液濃度 × 0.19 × 腎血流量。血漿分率 0.6 は相殺する）
- 注入: 注入側静脈の区画に流量 q、濃度 C を加える。生食後押しは C = 0 で同じ q を続ける（本アプリ。式は同じ）
- 数値解法: RK4、Δt = 0.05 s、97 区画 + 排泄 1 = 98 本の常微分方程式（原著は 5 次 Runge–Kutta、104 本）。注入は各ステップの平均流量として与え、ヨード質量を厳密に保存する

## パラメータ

| 項目 | 値 | 出典 |
|---|---|---|
| 標準体 | 血液量 5 L（血漿 3 L）、心拍出量 6.5 L/min、全体水 40 L、細胞外液 18.9 L（iohexol の分布容積 0.27 L/kg） | [2] 本文 |
| 部位別血流 (mL/min) | 頭部 975、上肢 325、冠動脈 260、気管支 130、肝動脈 455、門脈 1430、脾・胃 430、膵・腸 1000、腎 1430、体幹・下肢 1495 | [2] Table 2（肝は肝動脈 455 + 門脈 1430 = 1885）。Sahbaee 2017 [12]、Higaki 2018 [13] の図とも整合 |
| 血管区画の容量 (mL) | 右心・左心 各 180、肺動脈 130、肺静脈 160、上行〜弓部大動脈 100、胸部下行 100、腹部（横隔膜〜腹腔動脈）100、腹部（腎動脈以下）80、下大静脈 700（腎〜肝）+ 800（肝〜右房）、門脈 100、肝静脈 100、腸骨動脈 200、腸骨静脈 1000、頸動脈 20、頸静脈 80、鎖骨下動脈 20、上肢静脈 40 × 2、肝動脈・腹腔動脈枝・腸間膜動脈・腎動脈 各 20、腎静脈 100。血管 4310 + 臓器 IV 450 = 4760 mL で、Table 1 の総血液量 5000 mL より 240 mL 少ない（特許の図のまま） | [2] FIG. 5（血管の円内の数値）、Table 4（毛細血管容量） |
| 臓器の容量 IV / EC / IC (mL) | 肺（実質）150 / 144 / 173.5、肺（非実質）5 / 144 / 173.5、頭部 37 / 484 / 581、上肢 12 / 2751 / 3304、心筋 10 / 103 / 124、肝 71 / 524 / 629、脾・胃 16 / 94.5 / 113.5、膵・腸 38 / 565 / 678、腎 54 / 89 / 106、体幹・下肢 57 / 11002 / 13217。EC : IC = 15.9 : 19.1 を全臓器共通 | [2] Table 5 の「Fluid − cap.」を EC : IC = 15.9 : 19.1 で分けたもの（FIG. 5 の EC 値と一致）。上肢 6055、体幹・下肢 24219 は本文 |
| PS/Q | 5（Bae は 2–10 を妥当、20 で障壁なしと同等とした） | 値は本アプリの選択。範囲は [2] FIG. 14 |
| 腎排泄 | GFR = 腎血漿流量の 19 % | [2] 本文 |
| 体格補正 | BV = 33.164·H^0.725·W^0.425 − 1229（男）、34.85·H^0.725·W^0.425 − 1954（女）；CO = 36.36·H^0.725·W^0.425（H: inch, W: lb）；年齢 CO × (1 − 0.008 (age − 30))。標準値との比を全容量・全流量に掛ける。年齢補正は 30 歳超のみ | [2] 本文、FIG. 7 |
| HU 係数 | 25 HU/(mgI/mL)（120 kVp, Ioversol-320, Siemens Somatom Plus 実測）。詳細設定で編集可。他の管電圧の値は与えない | [1], [2] FIG. 9 |
| 既定の患者 | 男性、170 cm、60 kg、60 歳（年齢補正で心拍出量は標準の 76 %） | 本アプリの既定値 |
| PS/Q の入力範囲 | 1〜20、∞ | [2] FIG. 7 は 2〜10 を受け付ける。1 と 20・∞ は FIG. 14 の比較用に本アプリが追加 |

## 曲線の計測点（系列キー → 区画）

| 系列 | 区画 |
|---|---|
| aortaAsc / aortaArch | 上行〜弓部大動脈の最初 / 最後の区画 |
| aortaThor | 胸部下行大動脈の最後の区画 |
| aortaAbd | 腹部大動脈（横隔膜〜腹腔動脈）の最後の区画。検証の「大動脈」はこれ |
| aortaInfra | 腹部大動脈（腎動脈以下）の最後の区画 |
| portal / hepaticVein | 門脈 / 肝静脈の最後の区画 |
| ivcInfra | 下大静脈（腎〜肝）の最初の区画 = 腎静脈合流部 |
| ivcSupra | 下大静脈（肝〜右房）の最後の区画 |
| pulmArtery / pulmVein | 肺動脈 / 肺静脈の最後の区画 |
| rightHeart / leftHeart | 右心 / 左心 |
| iliacArtery / iliacVein / renalVein | 腸骨動脈 / 腸骨静脈 / 腎静脈の最後の区画 |
| liver, kidney, splStom, pancInt, trunk, heartM, lungPar, head, upperExt, lungNon | 各臓器（IV + EC の質量 / IV + EC + IC 容量） |

## 検証（`tests/validate_bae.js`）

Bae が示した 3 プロトコル（Ioversol-320、125 mL）[1][2] の Bae 自身の予測値と本実装（男性 5'8"、30 歳、PS/Q = 5 と仮定。アプリ既定の 60 歳ではない）:

| プロトコル | 体重 | 大動脈ピーク Bae / 本実装 / 実測平均 | 肝ピーク Bae / 本実装 / 実測平均 |
|---|---|---|---|
| 2 相 2.5 mL/s × 50 + 1.0 mL/s × 75 | 158 lb | 142.7 / 154 / 163.4 HU | 53.8 / 59 / 55.5 HU |
| 1 相 2.5 mL/s × 125 | 171 lb | 220.4 / 213 / 205.8 HU | 63.8 / 61 / 59.8 HU |
| 1 相 5.0 mL/s × 125 | 177 lb | 321.3 / 340 / 313.7 HU | 63.6 / 61 / 60.8 HU |

Bae の予測値との平均誤差 大動脈 5.8 %、肝 6.0 %。ヨード質量の保存 100.00 %。

## Bae モデルに無いもの

- 追加したもの（式は変えない）: 生食後押し（上記）、ボーラストラッキング（計算した大動脈曲線に閾値を当てる撮影側の判定）、画像表示（モデルの ΔHU を臓器ラベルごとに単純 CT に加える。下記「画像」）
- 扱わないもの: 造影剤の粘度・浸透圧、血管の拍動。管電圧ごとの HU 係数、尿細管内ヨードの保持、脳の血液脳関門など出典のない拡張は置かない

## 画像（実 CT）

`data/` は TotalSegmentator dataset [14] の単純 CT 1 例（s1369、2 mm、胸〜大腿、約 9 MB）。画素値 = 単純 CT + ラベルごとのモデル ΔHU（3×3 平滑化）。「ΔHU を色で」で加えた分だけを色で表示する。ラベルと区画の対応は `tools/make_phantom.py` の `LABELS`（倍率なし。肺は組織分率 (HU + 1000) / 1000 を掛ける。骨・胆嚢・膀胱は増強なし）。臓器内は一様に増強するだけで、実際の造影 CT の見え方（腎皮髄、肝内血管、排泄など）は再現しない。作り直し方は `tools/make_phantom.py` 冒頭。

## レッスンの根拠

1. 曲線の読み方 — [7]
2. 注入速度と大動脈 — [4]、[7]
3. 総ヨード量と肝 — [8]、[7]
4. 体重と希釈 — [1]、[10]、[11]
5. 到達時間と心拍出量 — [3]、[6]、[13]
6. 部位で変わる相 — [7]

応用（詳細設定 ON）: 濃度と速度 — [7] / 体重あたり投与 + 注入時間固定 — [9]、[10] / 2 相注入 — [1]、[5] / 生食後押し（Bae に無い）— [15]、[16]

## 出典

1. Bae KT, Heiken JP, Brink JA. Aortic and hepatic contrast medium enhancement at CT. Part I. Prediction with a computer model. Radiology 1998;207:647–655. PMID 9609886.
2. Bae KT. Method of and apparatus for predicting computed tomography contrast enhancement. US Patent 5,583,902 (1996). https://patents.google.com/patent/US5583902A
3. Bae KT, Heiken JP, Brink JA. Aortic and hepatic contrast medium enhancement at CT. Part II. Effect of reduced cardiac output in a porcine model. Radiology 1998;207:657–662. PMID 9609887.
4. Bae KT, Heiken JP, Brink JA. Aortic and hepatic peak enhancement at CT: effect of contrast medium injection rate. Radiology 1998;206:455–464. PMID 9457200.
5. Bae KT, Tran HQ, Heiken JP. Multiphasic injection method for uniform prolonged vascular enhancement at CT angiography. Radiology 2000;216:872–880. PMID 10966725.
6. Bae KT. Peak contrast enhancement in CT and MR angiography: when does it occur and why? Radiology 2003;227:809–816. PMID 12702823.
7. Bae KT. Intravenous contrast medium administration and scan timing at CT: considerations and approaches. Radiology 2010;256:32–61. PMID 20574084.
8. Heiken JP, Brink JA, McClennan BL, et al. Dynamic incremental CT: effect of volume and concentration of contrast material and patient weight on hepatic enhancement. Radiology 1995;195:353–357. PMID 7724752.
9. Awai K, Hori S. Effect of contrast injection protocol with dose tailored to patient weight and fixed injection duration on aortic and hepatic enhancement at multidetector-row helical CT. Eur Radiol 2003;13:2155–2160. PMID 12736754.
10. Awai K, Hiraishi K, Hori S. Effect of contrast material injection duration and rate on aortic peak time and peak enhancement at dynamic CT involving injection protocol with dose tailored to patient weight. Radiology 2004;230:142–150. PMID 14695390.
11. Yamashita Y, Komohara Y, Takahashi M, et al. Abdominal helical CT: evaluation of optimal doses of intravenous contrast material. Radiology 2000;216:718–723. PMID 10966700.
12. Sahbaee P, Segars WP, Marin D, Nelson RC, Samei E. The effect of contrast material on radiation dose at CT: Part I. Incorporation of contrast material dynamics in anthropomorphic phantoms. Radiology 2017;283:739–748. PMID 28092496.
13. Higaki T, Nakaura T, Kidoh M, et al. Effect of contrast material injection duration on arterial enhancement at CT in patients with various cardiac indices: analysis using computer simulation. PLoS ONE 2018;13:e0191347. PMID 29474457.
14. Wasserthal J, Breit HC, Meyer MT, et al. TotalSegmentator: robust segmentation of 104 anatomic structures in CT images. Radiol Artif Intell 2023;5:e230024. PMID 37795137. Dataset (small subset v2.0.1): doi:10.5281/zenodo.10047263 (CC BY 4.0).
15. Lee CH, Goo JM, Bae KT, et al. CTA contrast enhancement of the aorta and pulmonary artery: the effect of saline chase injected at two different rates in a canine experimental model. Invest Radiol 2007;42:486–490. PMID 17568270.
16. Marin D, Nelson RC, Guerrisi A, et al. 64-section multidetector CT of the upper abdomen: optimization of a saline chaser injection protocol for improved vascular and parenchymal contrast enhancement. Eur Radiol 2011;21:1938–1947. PMID 21556911.
