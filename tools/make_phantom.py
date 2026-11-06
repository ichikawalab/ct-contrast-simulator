#!/usr/bin/env python
"""
公開データセット (TotalSegmentator dataset, CC BY 4.0) の単純 CT 1 例から、本アプリ用の画像データを作る。

  python tools/make_phantom.py <datasetDir> --scan             候補症例を一覧（胸〜骨盤をカバーし、非造影らしいもの）
  python tools/make_phantom.py <datasetDir> <caseId> [--mm 2]  data/phantom_ct.bin.gz, data/phantom_lab.bin.gz, data/phantom.json を出力
      （既定で肺尖 + 40 mm より上＝頭頸部は切り落とす。--keep-head で残す）
  python tools/make_phantom.py --synthetic                     データセット無しで動作確認するための合成ボリュームを出力

出力:
  data/phantom_ct.bin.gz   int16 HU（LPS 向き、[z][y][x] の順、体の外接直方体でクロップ）
  data/phantom_lab.bin.gz  uint8 ラベル（同じ格子）
  data/phantom.json        dims / spacing / 出典 / ラベル表
依存: numpy, scipy（nibabel は不要。NIfTI-1 は最小限の読み込みを内蔵）
注意: データセットは匿名化済みだが、取り込んだ画像に焼き込み文字が無いかビューアで目視確認すること。
      年齢・性別などのメタ情報は出力に含めない。
手順: Zenodo の小規模サブセット（約 3.2 GB）を展開 → --scan で非造影（大動脈 < 60 HU）の症例を選ぶ → <caseId> --mm 2 で出力
      （体外は -1000 HU に置換して外接直方体で切り出す）→ 3 断面を確認してから公開する。
"""
import sys, os, io, json, gzip, struct, csv
import numpy as np

try:
    from scipy import ndimage
except ImportError:  # pragma: no cover
    ndimage = None

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, '..', 'data')
SOURCE = {
    'dataset': 'TotalSegmentator dataset (Wasserthal J, et al. Radiol Artif Intell 2023;5:e230024)',
    'license': 'CC BY 4.0',
    'doi': '10.5281/zenodo.10047263',
    'note': 'one unenhanced CT; HU values are the original data, contrast enhancement is added by the simulator',
}

# ---- 本アプリのラベル定義 ----------------------------------------------------
# series: app.js の系列キー（配列なら平均）= Bae の区画にそのまま対応させ、倍率は掛けない。
# Bae に区画の無い組織（脂肪・副腎・甲状腺・食道・前立腺など）は「体幹・下肢（その他組織）」区画 trunk に入れる。
# 胆汁・尿への排泄はモデルに無いので胆嚢・膀胱は増強しない。骨は区画が無いので増強しない。
# tissueFrac: ボクセルの CT 値から組織分率 (HU+1000)/1000 を掛ける（肺。含気分だけ薄まる）。base: 合成データで使う典型 CT 値
LABELS = [
    dict(id=0, key='air', ja='空気', en='air', base=-1000),
    dict(id=1, key='fat', ja='脂肪', en='fat', base=-100, series='trunk'),
    dict(id=2, key='soft', ja='軟部組織', en='soft tissue', base=40, series='trunk'),
    dict(id=3, key='muscle', ja='筋', en='muscle', base=50, series='trunk'),
    dict(id=4, key='bone', ja='骨', en='bone', base=400),
    dict(id=5, key='cord', ja='脊柱管', en='spinal canal', base=30, series='trunk'),
    dict(id=6, key='lung', ja='肺', en='lung', base=-800, series='lungPar', tissueFrac=True),
    dict(id=7, key='airway', ja='気道', en='airway', base=-1000),
    dict(id=8, key='heart', ja='心臓（血液プール）', en='heart (blood pool)', base=40, series=['leftHeart', 'rightHeart']),
    dict(id=9, key='aortaAsc', ja='上行大動脈', en='ascending aorta', base=40, series='aortaAsc'),
    dict(id=10, key='aortaThor', ja='胸部下行大動脈', en='descending thoracic aorta', base=40, series='aortaThor'),
    dict(id=11, key='aortaAbd', ja='腹部大動脈', en='abdominal aorta', base=40, series='aortaAbd'),
    dict(id=12, key='aortaInfra', ja='大動脈（腎下）', en='infrarenal aorta', base=40, series='aortaInfra'),
    dict(id=13, key='pulmVein', ja='肺静脈', en='pulmonary vein', base=40, series='pulmVein'),
    dict(id=14, key='svc', ja='上大静脈・腕頭静脈', en='SVC / brachiocephalic veins', base=40, series='rightHeart'),
    dict(id=15, key='archArt', ja='弓部分枝動脈', en='arch branch arteries', base=40, series='aortaArch'),
    dict(id=16, key='ivcSupra', ja='下大静脈（肝部）', en='IVC (hepatic)', base=40, series='ivcSupra'),
    dict(id=17, key='ivcInfra', ja='下大静脈（腎下）', en='IVC (infrarenal)', base=40, series='ivcInfra'),
    dict(id=18, key='portal', ja='門脈・脾静脈', en='portal / splenic vein', base=40, series='portal'),
    dict(id=19, key='iliacArtery', ja='腸骨動脈', en='iliac artery', base=40, series='iliacArtery'),
    dict(id=20, key='iliacVein', ja='腸骨静脈', en='iliac vein', base=40, series='iliacVein'),
    dict(id=21, key='liver', ja='肝', en='liver', base=55, series='liver'),
    dict(id=22, key='spleen', ja='脾', en='spleen', base=45, series='splStom'),
    dict(id=23, key='stomach', ja='胃', en='stomach', base=35, series='splStom'),
    dict(id=24, key='pancreas', ja='膵', en='pancreas', base=40, series='pancInt'),
    dict(id=25, key='smallBowel', ja='小腸', en='small bowel', base=30, series='pancInt'),
    dict(id=26, key='colon', ja='結腸', en='colon', base=30, series='pancInt'),
    dict(id=27, key='kidney', ja='腎', en='kidney', base=30, series='kidney'),
    dict(id=28, key='bladder', ja='膀胱', en='bladder', base=10),
    dict(id=29, key='gallbladder', ja='胆嚢', en='gallbladder', base=10),
    dict(id=30, key='esophagus', ja='食道', en='esophagus', base=40, series='trunk'),
    dict(id=31, key='adrenal', ja='副腎', en='adrenal', base=40, series='trunk'),
    dict(id=32, key='thyroid', ja='甲状腺', en='thyroid', base=80, series='trunk'),
    dict(id=33, key='prostate', ja='前立腺', en='prostate', base=40, series='trunk'),
]
L = {l['key']: l['id'] for l in LABELS}

# TotalSegmentator (v2) クラス名 → ラベル。順序 = 上書きの優先度（後が勝つ）
MAP = [
    (['autochthon_left', 'autochthon_right', 'iliopsoas_left', 'iliopsoas_right', 'gluteus_maximus_left', 'gluteus_maximus_right',
      'gluteus_medius_left', 'gluteus_medius_right', 'gluteus_minimus_left', 'gluteus_minimus_right'], 'muscle'),
    (['esophagus'], 'esophagus'), (['stomach'], 'stomach'), (['small_bowel', 'duodenum'], 'smallBowel'), (['colon'], 'colon'),
    (['lung_upper_lobe_left', 'lung_lower_lobe_left', 'lung_upper_lobe_right', 'lung_middle_lobe_right', 'lung_lower_lobe_right'], 'lung'),
    (['trachea'], 'airway'), (['liver'], 'liver'), (['spleen'], 'spleen'), (['pancreas'], 'pancreas'), (['kidney_left', 'kidney_right'], 'kidney'),
    (['adrenal_gland_left', 'adrenal_gland_right'], 'adrenal'), (['gallbladder'], 'gallbladder'), (['urinary_bladder'], 'bladder'),
    (['prostate'], 'prostate'), (['thyroid_gland'], 'thyroid'),
    (['heart', 'atrial_appendage_left'], 'heart'), (['pulmonary_vein'], 'pulmVein'),
    (['superior_vena_cava', 'brachiocephalic_vein_left', 'brachiocephalic_vein_right'], 'svc'),
    (['brachiocephalic_trunk', 'subclavian_artery_left', 'subclavian_artery_right', 'common_carotid_artery_left', 'common_carotid_artery_right'], 'archArt'),
    (['inferior_vena_cava'], 'ivcInfra'), (['portal_vein_and_splenic_vein'], 'portal'),
    (['iliac_artery_left', 'iliac_artery_right'], 'iliacArtery'), (['iliac_vena_left', 'iliac_vena_right'], 'iliacVein'),
    (['aorta'], 'aortaAbd'),
    (['sacrum', 'hip_left', 'hip_right', 'femur_left', 'femur_right', 'humerus_left', 'humerus_right', 'scapula_left', 'scapula_right',
      'clavicula_left', 'clavicula_right', 'sternum', 'costal_cartilages', 'skull'], 'bone'),
    (['spinal_cord'], 'cord'),
]
VERT = ['vertebrae_' + v for v in ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'L1', 'L2', 'L3', 'L4', 'L5', 'S1']]
RIBS = ['rib_%s_%d' % (s, i) for s in ('left', 'right') for i in range(1, 13)]
MAP.append((VERT + RIBS, 'bone'))

# 胸〜骨盤のカバー判定に使うクラス
KEY_CLASSES = ['lung_upper_lobe_right', 'liver', 'kidney_left', 'iliac_artery_left', 'femur_left', 'heart', 'aorta']


# ---- NIfTI-1 の最小限の読み込み（.nii / .nii.gz, 単一ファイル） -----------------------
_DT = {2: 'u1', 4: 'i2', 8: 'i4', 16: 'f4', 64: 'f8', 256: 'i1', 512: 'u2', 768: 'u4'}


def read_nifti(path):
    """returns (vol[z,y,x] float32 or raw, affine 4x4 (RAS, voxel→mm), pixdim[3])"""
    raw = gzip.open(path, 'rb').read() if path.endswith('.gz') else open(path, 'rb').read()
    e = '<' if struct.unpack('<i', raw[:4])[0] == 348 else '>'
    dim = struct.unpack(e + '8h', raw[40:56])
    datatype = struct.unpack(e + 'h', raw[70:72])[0]
    pixdim = struct.unpack(e + '8f', raw[76:108])
    vox_offset, slope, inter = struct.unpack(e + '3f', raw[108:120])
    qform_code, sform_code = struct.unpack(e + '2h', raw[252:256])
    quat = struct.unpack(e + '6f', raw[256:280])
    srow = np.array(struct.unpack(e + '12f', raw[280:328]), dtype=np.float64).reshape(3, 4)
    if datatype not in _DT:
        raise ValueError('unsupported NIfTI datatype %d in %s' % (datatype, path))
    nx, ny, nz = dim[1], dim[2], max(1, dim[3])
    data = np.frombuffer(raw, dtype=np.dtype(e + _DT[datatype]), count=nx * ny * nz, offset=int(round(vox_offset)))
    vol = data.reshape(nz, ny, nx)  # NIfTI は x が最も速く変化 → [z][y][x]
    if slope not in (0, 1) or inter != 0:
        vol = vol.astype(np.float32) * (slope if slope else 1) + inter
    A = np.eye(4)
    if sform_code > 0:
        A[:3, :] = srow
    elif qform_code > 0:
        b, c, d, qx, qy, qz = quat
        a = np.sqrt(max(0.0, 1 - b * b - c * c - d * d))
        R = np.array([[a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
                      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
                      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c]])
        qfac = -1.0 if pixdim[0] < 0 else 1.0
        A[:3, :3] = R * np.array([pixdim[1], pixdim[2], qfac * pixdim[3]])
        A[:3, 3] = [qx, qy, qz]
    else:
        A[:3, :3] = np.diag([pixdim[1], pixdim[2], pixdim[3]])
    return vol, A, [abs(pixdim[1]), abs(pixdim[2]), abs(pixdim[3])]


# ---- 向きの統一（LPS: x→患者左, y→後, z→上） -----------------------------------------
def to_lps(vol_zyx, A):
    """vol[z,y,x]（NIfTI の k,j,i）を LPS 向きの [Z,Y,X] に並べ替える。spacing も返す"""
    want = [-1, -1, 1]  # RAS 座標での符号: L = -x, P = -y, S = +z
    src, flip, sp = [0, 0, 0], [False, False, False], [0, 0, 0]
    used = set()
    for c in range(3):  # 入力軸 c (i,j,k) の主方向
        col = A[:3, c]
        o = int(np.argmax(np.abs(col)))
        if o in used:  # 退化した affine への保険
            o = [k for k in range(3) if k not in used][0]
        used.add(o)
        src[o] = c
        flip[o] = (np.sign(col[o]) != want[o])
        sp[o] = float(np.linalg.norm(col))
    ijk = np.transpose(vol_zyx, (2, 1, 0))  # [i,j,k]
    out = np.transpose(ijk, (src[0], src[1], src[2]))  # [X,Y,Z]
    for o in range(3):
        if flip[o]:
            out = np.flip(out, axis=o)
    return np.ascontiguousarray(np.transpose(out, (2, 1, 0))), sp  # [Z,Y,X]


def resample(vol_zyx, sp, mm, order):
    f = [sp[2] / mm, sp[1] / mm, sp[0] / mm]  # z,y,x
    if all(abs(x - 1) < 1e-3 for x in f):
        return vol_zyx
    return ndimage.zoom(vol_zyx, f, order=order, mode='nearest', prefilter=False)


# ---- 症例一覧 -----------------------------------------------------------------
def read_meta(d):
    p = os.path.join(d, 'meta.csv')
    rows = {}
    if not os.path.exists(p):
        return rows
    with io.open(p, encoding='utf-8-sig', errors='replace') as f:
        head = f.readline()
        sep = ';' if head.count(';') > head.count(',') else ','
        f.seek(0)
        for r in csv.DictReader(f, delimiter=sep):
            rows[r.get('image_id', '')] = r
    return rows


def mask_count(path):
    try:
        v, _, _ = read_nifti(path)
        return int(np.count_nonzero(v))
    except Exception:
        return 0


def scan(d):
    cases = sorted(c for c in os.listdir(d) if os.path.isdir(os.path.join(d, c, 'segmentations')))
    meta = read_meta(d)
    print('%d case folders; checking coverage (%s) ...' % (len(cases), ', '.join(KEY_CLASSES)))
    rows = []
    for c in cases:
        seg = os.path.join(d, c, 'segmentations')
        counts = {k: mask_count(os.path.join(seg, k + '.nii.gz')) for k in KEY_CLASSES}
        if min(counts.values()) == 0:
            continue
        rows.append((c, counts))
    rows.sort(key=lambda r: -min(r[1].values()))
    print('%d cases contain all key classes. Measuring aortic HU of the best 30 (non-contrast if < ~60 HU) ...' % len(rows))
    print('%-8s %-12s %-16s %-8s %-10s %s' % ('case', 'study_type', 'dims', 'mm', 'aortaHU', 'minKeyVox'))
    for c, counts in rows[:30]:
        base = os.path.join(d, c)
        try:
            ct, A, pix = read_nifti(os.path.join(base, 'ct.nii.gz'))
            ao, _, _ = read_nifti(os.path.join(base, 'segmentations', 'aorta.nii.gz'))
            hu = float(np.mean(ct[ao > 0].astype(np.float32))) if ao.shape == ct.shape else float('nan')
            dims = 'x'.join(str(s) for s in ct.shape[::-1])
            mm = '%.1f' % max(pix)
        except Exception as ex:  # pragma: no cover
            hu, dims, mm = float('nan'), '?', '?'
        st = (meta.get(c) or {}).get('study_type', '?')
        flag = '' if hu < 60 else '  (enhanced?)'
        print('%-8s %-12s %-16s %-8s %-10.0f %d%s' % (c, st, dims, mm, hu, min(counts.values()), flag))
    print('\nPick a case with study_type like "ct abdomen" / "ct thorax-abdomen-pelvis" and aortaHU < 60, then run:')
    print('  python tools/make_phantom.py %s <caseId>' % d)


# ---- 本処理 -------------------------------------------------------------------
def body_mask(hu):
    """体の領域: -500 HU 以上の最大連結成分を取り、axial ごとに穴（肺・腸管ガス）を埋める。寝台は別成分として落ちる"""
    m = hu > -500
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    for z in range(m.shape[0]):
        m[z] = ndimage.binary_fill_holes(m[z])
    return m


def build(d, case, mm, keep_head=False):
    if ndimage is None:
        sys.exit('scipy is required (conda install scipy)')
    base = os.path.join(d, case)
    seg_dir = os.path.join(base, 'segmentations')
    print('reading', base)
    ct_raw, A, pix = read_nifti(os.path.join(base, 'ct.nii.gz'))
    print('dims (x,y,z)', ct_raw.shape[::-1], 'pixdim', [round(p, 2) for p in pix])
    ct, sp = to_lps(ct_raw.astype(np.float32), A)
    print('LPS dims (x,y,z)', ct.shape[::-1], 'spacing', [round(s, 2) for s in sp])
    if mm is None:
        mm = round(max(sp), 2)
    # --- ラベル体積（元解像度） ---
    body = body_mask(ct)
    lab = np.zeros(ct.shape, np.uint8)
    lab[body] = np.where(ct[body] < -30, L['fat'], L['soft']).astype(np.uint8)
    missing = []
    for classes, key in MAP:
        for cls in classes:
            f = os.path.join(seg_dir, cls + '.nii.gz')
            if not os.path.exists(f):
                missing.append(cls)
                continue
            m_raw, Am, _ = read_nifti(f)
            m, _ = to_lps(m_raw, Am)
            if m.shape != lab.shape:
                print('shape mismatch, skipping', cls)
                continue
            lab[m > 0] = L[key]
    if missing:
        print('missing classes:', ', '.join(missing))
    # --- 大動脈・下大静脈を高さで分割（z: 上向き, y: 後向き） ---
    def zrange(idv):
        zz = np.nonzero(np.any(lab == idv, axis=(1, 2)))[0]
        return (int(zz.min()), int(zz.max())) if zz.size else None
    liver, kidney = zrange(L['liver']), zrange(L['kidney'])
    heart_y = None
    hz = np.nonzero(lab == L['heart'])
    if hz[0].size:
        heart_y = float(hz[1].mean())
    zi = np.arange(lab.shape[0])[:, None, None]
    yi = np.arange(lab.shape[1])[None, :, None]
    ao = lab == L['aortaAbd']
    if liver:
        above = ao & (zi > liver[1])
        lab[above] = L['aortaThor']
        # 上行大動脈: 各スライスで、大動脈の後縁（下行大動脈）から 40 mm 以上前方にある部分
        dy = int(round(40.0 / sp[1]))
        for z in range(liver[1] + 1, lab.shape[0]):
            ys = np.nonzero(np.any(above[z], axis=1))[0]
            if ys.size and ys.max() - ys.min() > dy:
                sl = above[z] & (yi[0] < ys.max() - dy)
                lab[z][sl] = L['aortaAsc']
    if kidney:
        kmid = (kidney[0] + kidney[1]) / 2
        lab[ao & (zi <= kmid)] = L['aortaInfra']
        lab[(lab == L['ivcInfra']) & (zi > kidney[1])] = L['ivcSupra']
    # --- 頭部の除去（既定）: 肺の上端 + 40 mm より上は捨てる（顔を含めない） ---
    lung = zrange(L['lung'])
    if lung and not keep_head:
        ztop = min(lab.shape[0], lung[1] + int(round(40.0 / sp[2])) + 1)
        if ztop < lab.shape[0]:
            print('cropping above z=%d (lung apex + 40 mm): head/neck removed' % ztop)
            ct, lab, body = ct[:ztop], lab[:ztop], body[:ztop]
    # --- 体の外接直方体でクロップ ---
    zz, yy, xx = np.nonzero(body)
    pad = 2
    z0, z1 = max(0, zz.min() - pad), min(body.shape[0], zz.max() + pad + 1)
    y0, y1 = max(0, yy.min() - pad), min(body.shape[1], yy.max() + pad + 1)
    x0, x1 = max(0, xx.min() - pad), min(body.shape[2], xx.max() + pad + 1)
    ct = ct[z0:z1, y0:y1, x0:x1]
    lab = lab[z0:z1, y0:y1, x0:x1]
    body = body[z0:z1, y0:y1, x0:x1]
    ct = np.where(body, ct, -1000).astype(np.float32)  # 体外（寝台など）は空気に
    # --- リサンプル ---
    ct_o = resample(ct, sp, mm, order=1)
    lab_o = resample(lab, sp, mm, order=0)
    write_outputs(ct_o, lab_o, mm, dict(SOURCE, case=case, native_spacing_mm=[round(s, 2) for s in sp]))


def write_outputs(ct, lab, mm, source, synthetic=False):
    ct = np.clip(np.rint(ct), -1024, 3071).astype('<i2')
    lab = lab.astype(np.uint8)
    nz, ny, nx = ct.shape
    os.makedirs(OUT_DIR, exist_ok=True)
    with gzip.open(os.path.join(OUT_DIR, 'phantom_ct.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(np.ascontiguousarray(ct).tobytes())
    with gzip.open(os.path.join(OUT_DIR, 'phantom_lab.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(np.ascontiguousarray(lab).tobytes())
    meta = dict(dims=[nx, ny, nz], spacing=[mm, mm, mm], orientation='LPS', order='zyx',
                files=dict(ct='phantom_ct.bin.gz', lab='phantom_lab.bin.gz'), ct_dtype='int16', lab_dtype='uint8',
                synthetic=bool(synthetic), source=source, labels=LABELS)
    with io.open(os.path.join(OUT_DIR, 'phantom.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
    counts = np.bincount(lab.ravel(), minlength=len(LABELS))
    for l in LABELS:
        if counts[l['id']]:
            print('%2d %-12s %6.0f mL' % (l['id'], l['key'], counts[l['id']] * mm ** 3 / 1000))
    for n in ('phantom_ct.bin.gz', 'phantom_lab.bin.gz'):
        print('wrote data/%s  %.2f MB' % (n, os.path.getsize(os.path.join(OUT_DIR, n)) / 1e6))
    print('dims (x,y,z)', [nx, ny, nz], 'spacing', mm, 'mm')
    if not synthetic:
        print('NOTE: open the viewer and check every plane for burned-in text before publishing data/.')


# ---- 合成ボリューム（動作確認用。解剖学的に正確ではない） -------------------------------
def synthetic(mm=2.0):
    nx, ny, nz = 128, 96, 176  # 256 × 192 × 352 mm
    X = (np.arange(nx) - nx / 2 + 0.5) * mm  # L+
    Y = (np.arange(ny) - ny / 2 + 0.5) * mm  # P+
    Z = (np.arange(nz) + 0.5) * mm  # S+
    z, y, x = np.meshgrid(Z, Y, X, indexing='ij')
    lab = np.zeros((nz, ny, nx), np.uint8)

    def ell(cx, cy, cz, rx, ry, rz):
        return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1

    def cyl(cx, cy, r, z0, z1, dx=0.0, dy=0.0):  # z 方向の円柱（dx, dy で傾き mm/mm）
        return (((x - cx - dx * (z - z0)) / r) ** 2 + ((y - cy - dy * (z - z0)) / r) ** 2 <= 1) & (z >= z0) & (z <= z1)

    def tube_x(cy, cz, r, x0, x1, dy=0.0):  # x 方向の管
        return (((y - cy - dy * (x - x0)) / r) ** 2 + ((z - cz) / r) ** 2 <= 1) & (x >= min(x0, x1)) & (x <= max(x0, x1))

    taper = 1 - 0.12 * np.clip((Z[:, None, None] - 200) / 150, 0, 1)  # 胸郭は少し広い
    body = ((x / (118 * taper)) ** 2 + (y / (85 * taper)) ** 2) <= 1
    skin = ((x / (118 * taper - 14)) ** 2 + (y / (85 * taper - 14)) ** 2) <= 1
    lab[body] = L['fat']
    lab[skin] = L['soft']
    # 筋（傍脊柱・腹直筋・大腿）
    lab[ell(-32, 55, 176, 24, 20, 400) & skin] = L['muscle']
    lab[ell(32, 55, 176, 24, 20, 400) & skin] = L['muscle']
    lab[(np.abs(x) < 50) & (np.abs(y + 66) < 6) & (z < 230) & skin] = L['muscle']
    lab[ell(-60, 0, 20, 36, 40, 50) & skin] = L['muscle']
    lab[ell(60, 0, 20, 36, 40, 50) & skin] = L['muscle']
    # 骨（脊椎・骨盤・大腿骨頭）、脊柱管
    lab[cyl(0, 52, 18, 0, 352)] = L['bone']
    lab[cyl(0, 38, 6, 0, 352)] = L['cord']
    lab[ell(-62, 20, 60, 28, 18, 45) & skin] = L['bone']
    lab[ell(62, 20, 60, 28, 18, 45) & skin] = L['bone']
    lab[ell(-72, 5, 20, 16, 16, 22)] = L['bone']
    lab[ell(72, 5, 20, 16, 16, 22)] = L['bone']
    # 肺・気道・心臓・胸部血管
    lab[ell(-62, 8, 290, 48, 60, 62) & skin] = L['lung']
    lab[ell(60, 10, 290, 46, 58, 62) & skin] = L['lung']
    lab[cyl(0, 20, 8, 300, 352)] = L['airway']
    lab[ell(18, -16, 262, 42, 36, 38)] = L['heart']
    lab[ell(-8, 24, 232, 16, 12, 12)] = L['ivcSupra']
    lab[cyl(-8, -20, 15, 250, 300, dx=-0.15)] = L['aortaAsc']
    lab[tube_x(-10, 305, 12, -18, 10, dy=0.8)] = L['aortaAsc']
    lab[cyl(10, 32, 12, 190, 320)] = L['aortaThor']
    lab[cyl(-30, 18, 9, 280, 330)] = L['svc']
    lab[cyl(0, -5, 6, 330, 352)] = L['archArt']
    # 腹部臓器
    lab[ell(-52, 2, 185, 62, 60, 48) & skin] = L['liver']
    lab[ell(-28, -28, 160, 12, 10, 18)] = L['gallbladder']
    lab[ell(82, 24, 190, 20, 30, 28) & skin] = L['spleen']
    lab[ell(40, -22, 196, 34, 24, 26)] = L['stomach']
    lab[ell(10, 10, 170, 42, 10, 9)] = L['pancreas']
    lab[ell(-52, 32, 150, 20, 26, 34)] = L['kidney']
    lab[ell(54, 32, 152, 20, 26, 34)] = L['kidney']
    lab[ell(-46, 20, 190, 10, 8, 10)] = L['adrenal']
    lab[ell(48, 22, 192, 10, 8, 10)] = L['adrenal']
    lab[ell(0, -14, 108, 66, 36, 44) & skin] = L['smallBowel']
    lab[cyl(-70, -10, 14, 70, 170)] = L['colon']
    lab[cyl(70, -10, 14, 70, 170)] = L['colon']
    lab[tube_x(-26, 168, 12, -70, 70)] = L['colon']
    lab[ell(0, -24, 38, 30, 24, 22)] = L['bladder']
    lab[ell(0, 6, 12, 16, 14, 12)] = L['prostate']
    # 腹部・骨盤血管
    lab[cyl(6, 30, 11, 140, 190)] = L['aortaAbd']
    lab[cyl(6, 30, 10, 95, 140)] = L['aortaInfra']
    lab[cyl(-14, 30, 11, 95, 232)] = L['ivcInfra']
    lab[(lab == L['ivcInfra']) & (z > 170)] = L['ivcSupra']
    lab[tube_x(14, 176, 7, -40, 70, dy=0.1)] = L['portal']
    lab[cyl(-18, 26, 7, 30, 95, dx=-0.3)] = L['iliacArtery']
    lab[cyl(30, 26, 7, 30, 95, dx=0.3)] = L['iliacArtery']
    lab[cyl(-38, 40, 8, 30, 95, dx=-0.3)] = L['iliacVein']
    lab[cyl(10, 40, 8, 30, 95, dx=0.3)] = L['iliacVein']
    lab[~body] = L['air']
    # CT 値: ラベル典型値 + 緩やかな不均一 + ノイズ
    base = np.array([l['base'] for l in LABELS], np.float32)
    rng = np.random.default_rng(7)
    ct = base[lab]
    ct += ndimage.gaussian_filter(rng.normal(0, 60, ct.shape).astype(np.float32), 4) * (lab > 1)  # 臓器内のムラ
    ct += rng.normal(0, 14, ct.shape).astype(np.float32)
    ct = ndimage.gaussian_filter(ct, 0.6)
    ct[lab == 0] = -1000
    write_outputs(ct, lab, mm, dict(dataset='synthetic test volume (geometric shapes)', license='MIT (part of this repository)', note='not a real CT; for development only'), synthetic=True)


def main(argv):
    if '--synthetic' in argv:
        if ndimage is None:
            sys.exit('scipy is required')
        return synthetic()
    args = [a for a in argv if not a.startswith('--')]
    if not args:
        print(__doc__)
        return 1
    d = args[0]
    mm = None
    if '--mm' in argv:
        mm = float(argv[argv.index('--mm') + 1])
    if '--scan' in argv:
        return scan(d)
    if len(args) < 2:
        print(__doc__)
        return 1
    return build(d, args[1], mm, keep_head='--keep-head' in argv)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]) or 0)
