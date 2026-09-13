#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
key_green.py —— 绿幕抠图主工具（提纯合并自实战脚本 cutall.py + cut2.py + fixcode.py）
====================================================================================
用法：
    python key_green.py --src <素材目录> --out <输出目录> [开关...]
    python key_green.py --src D:\\dsh\\qanimal --only 待机眨眼 --limit 3 --dry   # 只测量不落盘
    python key_green.py --src frames --out keyed --preset presets.json           # 按组处方批量

素材目录两种布局都支持：
    A) 组子目录布局：src/待机眨眼/f0001.png, src/敲代码/f0001.png ...（子目录名=组名）
    B) 平铺布局：src/f0001.png ...（整目录算一组，组名=目录名，可用 --group-name 改）

抠图判据（每条的"现象/根因/修法/实测数字"见 docs/02-抠图.md）：
 1) 逐张图自己定背景色：取四边 6px 边框内像素的众数色（量化到 8 的倍数再投票，抗压缩噪点）。
    同一批素材里出现过 rgb(120,184,88)/rgb(160,200,88)/rgb(175,235,105) 多种绿，固定参数必有一批抠不净。
 2) 容差自动选档：ladder 40→70→110→160→220→300，取第一个"背景覆盖率 ≥50%"的档（--tol N 可固定）。
 3) 边框泛洪：只删与画面边框连通的近似背景像素；绝不用全图颜色距离（会吃掉眼白/高光/浅色衣服）。
 4) 补洞 --fill-pockets（默认开）：泛洪到不了"被角色封闭的背景"（两脚之间/手臂与身体/床铺夹角），
    泛洪之后再把"内部的、更紧阈值 tol×0.5 仍像背景的、面积 ≥30px"的封闭区一并删掉。
    眼白是白色、与绿底相差很远，不会误删。实测：庆祝完成组平均补掉 977px/帧（最多 1721px）。
 5) 阴影键控 --shadow：阴影是"同色相、更低亮度"的绿，绝对色差超过 tol 所以漏网。
    HSV 判据 |ΔH|≤14 且 |ΔS|≤45 且 V≤bgV+6 ⇒ 算背景。实测：修bug组边缘绿 64.1%→36.8%。
 6) 严格模式=只留最大连通域；--keep-near N 放宽=保留 bbox 贴着主体框（外扩 N×主体尺寸）的小域，
    救纸屑/白问号/zzz/被子。实测：庆祝完成 0.25 救回 30.8 域/帧，敲代码 0.35 救回 10.7 域/帧。
 7) --kill-static br:0.45：静态叠加层（AI 水印）扣除。keep-near 会把水印一起救回来（副作用）。
    两遍处理：第一遍把各帧"被 keep-near 救回的 extra 掩码"在全部帧上累加，出现率 ≥--thresh(默认50%)
    的像素=烧录静态层；但纯静态判据会误杀（AI 生成的白问号本身也静止，实测 93% extra 每帧同位），
    必须再叠加用户指认区域（br:0.45 = x>0.45W 且 y>0.45H）。水印还会帧间轻微漂移，所以最终规则是
    "该区域内、该帧自己的所有 extra 小域一律扣"（实测扣除量 2349→4453 px/帧后全部帧干净，
    只扣累加掩码时只有前 21/47 帧干净）。
 8) 羽化 alpha = clip(gauss3×1.35−0.05, 0, 1)；despill 去溢色：g>max(r,b) 时 g=mx+(g−mx)×0.2（蓝幕同理）。
 9) 输出保留原始画布尺寸、只改 alpha、不裁剪 ⇒ 同组帧几何天然一致，后续统一裁剪框不会忽大忽小。

诊断（核心设计原则：制作者可能看不见图，每一步必须输出可核对的数字指标）：
 每帧打印 背景色/选用容差/背景覆盖率/主体像素数/连通域数/丢弃数/附带保留数/补洞px/内容框/边缘绿占比，
 全部写进 <out>/report.txt；每组另生成棋盘格底 contact-<组名>.png（缩略图 150px）供人整体检查。
 注意：边缘绿占比是在 despill 之前量的，会系统性夸大（抗锯齿边缘本来就是角色与绿底的混合色），
 只用于帧间/参数间横向比较，不要当绝对值看。
"""
import argparse
import fnmatch
import json
import os
import sys

for _s in (sys.stdout, sys.stderr):          # cp936 控制台防崩溃：编码错误一律替换
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("[X] 缺少 OpenCV：pip install opencv-python numpy")

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
LOG = []


def log(m=""):
    print(m)
    LOG.append(str(m))


# ── 中文路径安全读写（cv2.imread/imwrite 在 Windows 遇到中文路径会静默失败）──
def imread_u(p):
    try:
        d = np.fromfile(p, dtype=np.uint8)
        return cv2.imdecode(d, cv2.IMREAD_COLOR)
    except Exception:
        return None


def imwrite_u(p, img):
    dn = os.path.dirname(p)
    if dn:
        os.makedirs(dn, exist_ok=True)
    ok, buf = cv2.imencode(os.path.splitext(p)[1] or ".png", img)
    if not ok:
        return False
    buf.tofile(p)
    return True


def list_images(d, exclude=()):
    if not os.path.isdir(d):
        return []
    out = []
    for f in sorted(os.listdir(d)):
        if not f.lower().endswith(IMG_EXT):
            continue
        if any(fnmatch.fnmatch(f, pat) for pat in exclude):
            continue
        out.append(os.path.join(d, f))
    return out


def natural_key(p):
    """1.png/2.png/…/10.png 按数字排（字符串排会让 10 排在 2 前面，帧序错乱）。"""
    b = os.path.splitext(os.path.basename(p))[0]
    dig = "".join(c for c in b if c.isdigit())
    return (int(dig) if dig else 10 ** 9, b)


def border_modal(bgr, width=6, quant=8):
    """四边 width px 边框内像素的众数色（量化到 quant 的倍数再投票，抗压缩噪点）。返回 BGR。"""
    h, w = bgr.shape[:2]
    m = np.zeros((h, w), bool)
    m[:width, :] = True
    m[-width:, :] = True
    m[:, :width] = True
    m[:, -width:] = True
    px = bgr[m].astype(np.int32)
    px = px[:: max(1, len(px) // 30000)]
    q = (px // quant) * quant
    packed = (q[:, 0] << 16) | (q[:, 1] << 8) | q[:, 2]
    vals, cnts = np.unique(packed, return_counts=True)
    v = int(vals[np.argmax(cnts)])
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]      # BGR


def hsv1(bgr):
    px = np.array([[bgr]], np.uint8)
    return cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0, 0].astype(np.int32)


def key(bgr, tol, bg, keep_near=0.0, erode=0, shadow=False, fill_pockets=True):
    """核心键控：边框泛洪 + 补洞 + (可选)阴影键控 + 最大连通域 + (可选)贴身小域 + 腐蚀 + 羽化。
    返回 (alpha float32 0~1, info dict)。info 里的 rim_green 在 despill 之前量（见文件头说明）。"""
    h, w = bgr.shape[:2]
    b = bgr.astype(np.int32)
    diff = np.abs(b - np.array(bg, np.int32)).sum(axis=2)
    cand = diff <= tol                                    # 松阈值：像背景
    if shadow:                                            # 阴影=同色相、更低亮度的绿
        hv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
        bh, bs, bv = hsv1(bg)
        dh = np.abs(hv[:, :, 0] - bh)
        dh = np.minimum(dh, 180 - dh)                     # 色相是环形的
        ds = np.abs(hv[:, :, 1] - bs)
        cand = cand | ((dh <= 14) & (ds <= 45) & (hv[:, :, 2] <= bv + 6))
    cand = cand.astype(np.uint8)
    _, lab = cv2.connectedComponents(cand, connectivity=8)
    # 只把"与画面边框连通"的候选域算背景 —— 这是不吃眼白的关键
    edge = (set(lab[0, :].tolist()) | set(lab[-1, :].tolist()) |
            set(lab[:, 0].tolist()) | set(lab[:, -1].tolist()))
    edge.discard(0)
    bgmask = np.isin(lab, list(edge)) if edge else np.zeros((h, w), bool)

    # 补洞：内部的、更紧阈值(tol×0.5)下仍像背景、面积 ≥30px 的封闭区（两脚之间那块绿）
    pocket_px = 0
    if fill_pockets:
        tight = (diff <= max(12, int(tol * 0.5))).astype(np.uint8)
        tight[bgmask] = 0                                 # 已算背景的不再判
        np2, lb2 = cv2.connectedComponents(tight, connectivity=8)
        if np2 > 1:
            ar = np.bincount(lb2.ravel().astype(np.intp))
            ar[0] = 0
            for L in range(1, np2):
                if ar[L] >= 30:
                    bgmask |= (lb2 == L)
                    pocket_px += int(ar[L])
    fg = (~bgmask).astype(np.uint8)
    ratio = float(bgmask.mean())

    n, fl = cv2.connectedComponents(fg, connectivity=8)
    if n <= 1:
        return np.zeros((h, w), np.float32), {"area": 0, "comps": 0, "dropped": 0, "extra": 0,
                                              "ratio": ratio, "bbox": None, "rim_green": 0.0,
                                              "pocket": pocket_px}
    areas = np.bincount(fl.ravel().astype(np.intp))
    areas[0] = 0
    main = int(np.argmax(areas))
    keep = np.zeros((h, w), np.uint8)
    keep[fl == main] = 1
    ys, xs = np.where(fl == main)
    mb = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    dropped = extra = 0
    if keep_near > 0:                                     # 贴身小域：救纸屑/问号/zzz/被子
        pad = max(8, int(max(mb[2] - mb[0], mb[3] - mb[1]) * keep_near))
        for L in range(1, n):
            if L == main or areas[L] < 40:
                continue
            cy, cx = np.where(fl == L)
            bb = [int(cx.min()), int(cy.min()), int(cx.max()), int(cy.max())]
            if bb[0] - pad < mb[2] and bb[2] + pad > mb[0] and bb[1] - pad < mb[3] and bb[3] + pad > mb[1]:
                keep[fl == L] = 1
                extra += 1
            else:
                dropped += 1
    else:
        dropped = max(0, n - 2)
    if erode > 0:                                         # 顽固绿边：先腐蚀再羽化（吃发丝细节）
        keep2 = cv2.erode(keep, np.ones((2 * erode + 1, 2 * erode + 1), np.uint8), iterations=1)
        if keep2.max() == 0:
            log("        [!] 腐蚀 %dpx 后主体没了，回退到不腐蚀" % erode)
        else:
            keep = keep2
    blur = cv2.GaussianBlur(keep.astype(np.float32), (3, 3), 0)
    alpha = np.clip(blur * 1.35 - 0.05, 0, 1) * (keep > 0)

    # 边缘绿占比：最外圈 1~2px 里"绿明显高于红蓝"的比例（despill 前量，系统性夸大，只做横向比较）
    solid = (keep > 0).astype(np.uint8)
    inner = cv2.erode(solid, np.ones((3, 3), np.uint8), iterations=1)
    rim = (solid > 0) & (inner == 0)
    rim_green = 0.0
    if rim.sum() > 0:
        g = bgr[:, :, 1].astype(np.int32)
        gr = (g > bgr[:, :, 0].astype(np.int32) + 20) & (g > bgr[:, :, 2].astype(np.int32) + 20)
        rim_green = float(gr[rim].mean()) * 100
    return alpha.astype(np.float32), {"area": int(areas[main]), "comps": n - 1, "dropped": dropped,
                                      "extra": extra, "ratio": ratio, "bbox": mb,
                                      "rim_green": rim_green, "pocket": pocket_px}


def auto_tol(bgr, bg, keep_near=0.0, shadow=False, fill_pockets=True,
             ladder=(40, 70, 110, 160, 220, 300)):
    """容差自动选档：取第一个"背景覆盖率 ≥50% 且抠到东西"的档。"""
    for t in ladder:
        _, info = key(bgr, t, bg, keep_near, 0, shadow, fill_pockets)
        if info["ratio"] >= 0.5 and info["area"] > 0:
            return t, info
    return ladder[-1], key(bgr, ladder[-1], bg, keep_near, 0, shadow, fill_pockets)[1]


def despill(rgb, bg):
    """去溢色：绿幕时 g>max(r,b) ⇒ g=mx+(g−mx)×0.2；蓝幕同理压 b。"""
    out = rgb.astype(np.int32).copy()
    if bg[1] > bg[0] + 25 and bg[1] > bg[2] + 25:                       # 绿幕
        mx = np.maximum(out[:, :, 0], out[:, :, 2])
        g = out[:, :, 1]
        out[:, :, 1] = np.where(g > mx, mx + ((g - mx) * 0.2).astype(np.int32), g)
    elif bg[2] > bg[0] + 25 and bg[2] > bg[1] + 25:                     # 蓝幕
        mx = np.maximum(out[:, :, 0], out[:, :, 1])
        bb = out[:, :, 2]
        out[:, :, 2] = np.where(bb > mx, mx + ((bb - mx) * 0.2).astype(np.int32), bb)
    return np.clip(out, 0, 255).astype(np.uint8)


def checker(h, w, cell=8):
    """棋盘格底（RGB）：透明区垫上它，残留和毛刺一眼可见。"""
    y, x = np.mgrid[0:h, 0:w]
    c = ((x // cell) + (y // cell)) % 2
    base = np.zeros((h, w, 3), np.uint8)
    base[c == 0] = (232, 232, 232)
    base[c == 1] = (178, 178, 178)
    return base


def contact(rows_rgb, cols, tw=150):
    """每组一张缩略图矩阵（棋盘格底、帧号烧在图上），供人整体检查。"""
    n = len(rows_rgb)
    rows = int(np.ceil(n / float(cols)))
    th = None
    thumbs = []
    for b in rows_rgb:
        h, w = b.shape[:2]
        th = int(round(tw * h / float(w)))
        thumbs.append(cv2.resize(b, (tw, th)))
    sheet = np.zeros((rows * (th + 4) + 4, cols * (tw + 4) + 4, 3), np.uint8)
    sheet[:] = (250, 250, 250)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        y, x = 4 + r * (th + 4), 4 + c * (tw + 4)
        sheet[y:y + th, x:x + tw] = t
        cv2.putText(sheet, str(i + 1), (x + 2, y + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 255), 2)
    return sheet


def parse_region(spec, H, W):
    """解析 --kill-static 的区域：br:0.45 = 右下角 x>0.45W 且 y>0.45H。支持 br/bl/tr/tl。"""
    try:
        corner, frac = spec.split(":")
        frac = float(frac)
    except Exception:
        raise ValueError("区域格式应为 <br|bl|tr|tl>:<0~1 小数>，收到：%s" % spec)
    cx, cy = int(W * frac), int(H * frac)
    reg = np.zeros((H, W), bool)
    if corner == "br":
        reg[cy:, cx:] = True
    elif corner == "bl":
        reg[cy:, :W - cx] = True
    elif corner == "tr":
        reg[:H - cy, cx:] = True
    elif corner == "tl":
        reg[:H - cy, :W - cx] = True
    else:
        raise ValueError("未知角：%s（支持 br/bl/tr/tl）" % corner)
    return reg, cx, cy


def load_preset(path):
    if not path:
        return {}
    if not os.path.isfile(path):
        raise ValueError("处方文件不存在：%s" % path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("groups", data) or {}


def resolve_recipe(name, preset_groups, a):
    """处方优先级：内置默认 < presets.json 的 defaults < presets.json 的组条目 < 命令行显式参数。"""
    r = {"tol": 0, "keep_near": 0.0, "erode": 0, "shadow": False,
         "fill_pockets": True, "despill": True, "kill_static": None, "thresh": a.thresh,
         "why": "无处方：严格模式（只留最大连通域）+ 补洞"}
    d = preset_groups.get("defaults")
    if isinstance(preset_groups, dict):
        pass
    # defaults 可能放在 json 顶层（load_preset 取的是 groups 子表，这里再读一次原文件结构）
    g = preset_groups.get(name) if isinstance(preset_groups, dict) else None
    for src in (d, g):
        if isinstance(src, dict):
            for k in ("tol", "keep_near", "erode", "shadow", "fill_pockets",
                      "despill", "kill_static", "thresh", "why"):
                if k in src:
                    r[k] = src[k]
    # 命令行显式给的值最优先（argparse 默认 None = 用户没给）
    if a.tol is not None:
        r["tol"] = a.tol
    if a.keep_near is not None:
        r["keep_near"] = a.keep_near
    if a.erode is not None:
        r["erode"] = a.erode
    if a.shadow:
        r["shadow"] = True
    if a.fill_pockets is not None:
        r["fill_pockets"] = a.fill_pockets
    if a.despill is not None:
        r["despill"] = a.despill
    if a.kill_static is not None:
        r["kill_static"] = a.kill_static
    return r


def scan(src, exclude):
    log("=" * 78)
    log("扫描 %s" % src)
    total = 0
    loose = list_images(src, exclude)
    if loose:
        log("  [根目录散图] %d 张" % len(loose))
        total += len(loose)
    for d in sorted(os.listdir(src)):
        p = os.path.join(src, d)
        if not os.path.isdir(p):
            continue
        imgs = list_images(p, exclude)
        if not imgs:
            continue
        total += len(imgs)
        dims = {}
        for f in imgs:
            im = imread_u(f)
            if im is None:
                continue
            k = "%dx%d" % (im.shape[1], im.shape[0])
            dims[k] = dims.get(k, 0) + 1
        log("  %-14s %3d 张  尺寸{%s}" %
            (d, len(imgs), ", ".join("%s:%d" % kv for kv in sorted(dims.items(), key=lambda x: -x[1]))))
        im = imread_u(imgs[0])
        if im is not None:
            bg = border_modal(im)
            log("      样例 %s → 边框背景色 rgb(%d,%d,%d)" % (os.path.basename(imgs[0]), bg[2], bg[1], bg[0]))
    log("  合计 %d 张" % total)
    return total


def find_groups(src, exclude, group_name):
    """返回 [(组名, 路径, [图片...])]：根目录散图一组 + 每个含图子目录一组。"""
    groups = []
    loose = sorted(list_images(src, exclude), key=natural_key)
    if loose:
        groups.append((group_name or os.path.basename(os.path.abspath(src)), src, loose))
    for d in sorted(os.listdir(src)):
        p = os.path.join(src, d)
        if os.path.isdir(p):
            imgs = sorted(list_images(p, exclude), key=natural_key)
            if imgs:
                groups.append((d, p, imgs))
    return groups


def process_group(name, imgs, r, a):
    """处理一组。kill_static 时走两遍（第一遍累加 extra 找静态层，第二遍扣除+落盘）。"""
    kn, sh, fill = float(r["keep_near"]), bool(r["shadow"]), bool(r["fill_pockets"])
    log("-" * 88)
    log("[%s] %d 张  tol=%s keep_near=%.2f shadow=%s fill_pockets=%s erode=%d despill=%s kill_static=%s"
        % (name, len(imgs), "auto" if not r["tol"] else r["tol"], kn, "开" if sh else "关",
           "开" if fill else "关", r["erode"], "开" if r["despill"] else "关", r["kill_static"] or "关"))
    log("    处方理由：%s" % r["why"])
    if a.limit > 0:
        imgs = imgs[:a.limit]
        log("    [--limit %d] 只处理前 %d 张" % (a.limit, len(imgs)))

    stats = []          # (fname, info, tol, bg)
    thumbs = []
    ks_frames = []      # kill-static 第一遍缓存
    acc = None
    H = W = 0

    for f in imgs:
        bgr = imread_u(f)
        if bgr is None:
            log("  %s [X] 读不出，跳过" % os.path.basename(f))
            stats.append((os.path.basename(f), None, 0, None))
            continue
        if acc is None and r["kill_static"]:
            H, W = bgr.shape[:2]
            acc = np.zeros((H, W), np.float32)
        bg = border_modal(bgr)
        if r["tol"]:
            tol = int(r["tol"])
            alpha, info = key(bgr, tol, bg, kn, 0 if r["kill_static"] else r["erode"], sh, fill)
        else:
            tol, _ = auto_tol(bgr, bg, kn, sh, fill)
            alpha, info = key(bgr, tol, bg, kn, 0 if r["kill_static"] else r["erode"], sh, fill)
        if info["area"] == 0:
            log("  %-22s [!] 没抠到东西（bg=rgb(%d,%d,%d) tol=%d 覆盖=%.1f%%）"
                % (os.path.basename(f)[:22], bg[2], bg[1], bg[0], tol, info["ratio"] * 100))
            stats.append((os.path.basename(f), info, tol, bg))
            continue

        if r["kill_static"]:
            # 第一遍：extra = keep-near 版前景 − 严格版前景；全帧累加找静态层
            a_strict, _ = key(bgr, tol, bg, 0.0, 0, sh, fill)
            extra = (alpha > 0) & (a_strict == 0)
            acc += extra
            ks_frames.append((f, os.path.basename(f), bg, tol, (alpha * 255).astype(np.uint8), extra))
            stats.append((os.path.basename(f), info, tol, bg))
            if len(ks_frames) <= 2:
                log("  %-22s bg=rgb(%3d,%3d,%3d) tol=%3d 覆盖=%5.1f%% 主体=%7dpx 域=%3d extra=%dpx（kill-static 第一遍）"
                    % (os.path.basename(f)[:22], bg[2], bg[1], bg[0], tol, info["ratio"] * 100,
                       info["area"], info["comps"], int(extra.sum())))
            continue

        # 常规路径：despill → 落盘 → 棋盘格缩略图
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        if r["despill"]:
            rgb = despill(rgb, [bg[2], bg[1], bg[0]])
        _emit(a, r, name, f, bgr, rgb, alpha, info, bg, tol, stats, thumbs)

    if r["kill_static"]:
        _kill_static_pass2(a, r, name, ks_frames, acc, stats, thumbs)

    ok = [s for s in stats if s[1] and s[1]["area"] > 0]
    bad = len(stats) - len(ok)
    if ok:
        n = len(ok)
        pockets = sum(s[1].get("pocket", 0) for s in ok)
        extras = sum(s[1]["extra"] for s in ok)
        gmax = max(s[1]["rim_green"] for s in ok)
        hs = [s[1]["bbox"][3] - s[1]["bbox"][1] for s in ok if s[1]["bbox"]]
        ws = [s[1]["bbox"][2] - s[1]["bbox"][0] for s in ok if s[1]["bbox"]]
        log("  → 合计 %d 张（异常 %d）：补洞 %d px（平均 %.0f/帧），附带保留 %d 域（平均 %.1f/帧），边缘绿最高 %.1f%%"
            % (n, bad, pockets, pockets / float(n), extras, extras / float(n), gmax))
        if hs:
            log("  → 内容高 %d~%d，宽 %d~%d" % (min(hs), max(hs), min(ws), max(ws)))
    if thumbs and not a.dry:
        ct = contact(thumbs, min(a.thumb_cols, max(1, len(thumbs))))
        imwrite_u(os.path.join(a.out, "contact-%s.png" % name), ct)
        log("  → 缩略图 contact-%s.png（%d 格，棋盘格底）" % (name, len(thumbs)))
    return len(ok), bad


def _emit(a, r, name, f, bgr, rgb, alpha, info, bg, tol, stats, thumbs):
    """despill 后落盘 RGBA（保留原始画布尺寸，只改 alpha，不裁剪）+ 生成棋盘格缩略图。"""
    stats.append((os.path.basename(f), info, tol, bg))
    log("  %-22s bg=rgb(%3d,%3d,%3d) tol=%3d 覆盖=%5.1f%% 主体=%7dpx 域=%3d 丢=%3d 附=%2d 补洞=%6dpx 边缘绿=%4.1f%% 框=%s%s"
        % (os.path.basename(f)[:22], bg[2], bg[1], bg[0], tol, info["ratio"] * 100, info["area"],
           info["comps"], info["dropped"], info["extra"], info.get("pocket", 0), info["rim_green"],
           info["bbox"], "  [!]边缘偏绿" if info["rim_green"] > 8 else ""))
    if a.dry:
        return
    rgba = np.dstack([rgb, (alpha * 255).astype(np.uint8)])
    op = os.path.join(a.out, "" if name == os.path.basename(os.path.abspath(a.src)) else name,
                      os.path.splitext(os.path.basename(f))[0] + ".png")
    imwrite_u(op, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    al = alpha[:, :, None]
    prev = (rgb.astype(np.float32) * al + checker(*bgr.shape[:2]).astype(np.float32) * (1 - al)).astype(np.uint8)
    thumbs.append(cv2.cvtColor(prev, cv2.COLOR_RGB2BGR))


def _kill_static_pass2(a, r, name, ks_frames, acc, stats, thumbs):
    """kill-static 第二遍：静态层 = 累加出现率 ≥ thresh；再限定用户指认区域；
    最终规则 = 区域内该帧自己的所有 extra 小域一律扣（水印会帧间漂移，只扣累加掩码清不干净）。"""
    n = len(ks_frames)
    if n == 0 or acc is None:
        log("  [!] kill-static：没有可用帧")
        return
    static_all = acc >= (float(r["thresh"]) * n)
    H, W = acc.shape
    # extra 的 4×4 分布：客观定位残留在哪一格，不靠猜
    gh, gw = H // 4, W // 4
    log("  extra 静态层 4x4 分布（px，行=上→下，列=左→右）：")
    for rr in range(4):
        log("    " + " ".join("%7d" % int(static_all[rr * gh:(rr + 1) * gh, c * gw:(c + 1) * gw].sum())
                              for c in range(4)))
    reg, cx, cy = parse_region(r["kill_static"], H, W)
    static = static_all & reg
    log("  全画面静态层 %d px；限定区域 %s（x%s%d, y%s%d）后 %d px ← 只有这部分会被扣"
        % (int(static_all.sum()), r["kill_static"], ">" if r["kill_static"].startswith(("br", "tr")) else "<",
           cx, ">" if r["kill_static"].startswith(("br", "bl")) else "<", cy, int(static.sum())))
    if int(static.sum()) == 0:
        log("  [!] 区域内没检出静态叠加层：试试 --thresh 0.35，或确认水印是否真在该角")
    removed = []
    for (f, fname, bg, tol, a_full_u8, extra) in ks_frames:
        a_full = a_full_u8.astype(np.float32) / 255.0
        a_new = a_full.copy()
        a_new[static | (reg & extra)] = 0.0               # 区域内该帧自己的 extra 一律扣
        removed.append(int(((a_full > 0) & (a_new == 0)).sum()))
        if a.dry:
            continue
        bgr = imread_u(f)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        if r["despill"]:
            rgb = despill(rgb, [bg[2], bg[1], bg[0]])
        if r["erode"] > 0:
            kmask = (a_new > 0).astype(np.uint8)
            kmask = cv2.erode(kmask, np.ones((2 * r["erode"] + 1, 2 * r["erode"] + 1), np.uint8))
            a_new = a_new * kmask
        rgba = np.dstack([rgb, (a_new * 255).astype(np.uint8)])
        op = os.path.join(a.out, name, os.path.splitext(fname)[0] + ".png")
        imwrite_u(op, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        al = a_new[:, :, None]
        prev = (rgb.astype(np.float32) * al + checker(H, W).astype(np.float32) * (1 - al)).astype(np.uint8)
        thumbs.append(cv2.cvtColor(prev, cv2.COLOR_RGB2BGR))
    if removed:
        log("  → kill-static 扣除 %d~%d px/帧（平均 %.0f）%s"
            % (min(removed), max(removed), sum(removed) / float(len(removed)),
               "（--dry，未落盘）" if a.dry else ""))


def build_argparser():
    ap = argparse.ArgumentParser(
        description="绿幕抠图主工具：逐张定背景色 + 容差自动选档 + 边框泛洪 + 补洞 + 阴影键控 + keep-near + kill-static",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--src", required=True, help="素材目录（组子目录布局或平铺布局）")
    ap.add_argument("--out", default=None, help="输出目录（镜像结构透明 PNG + contact sheet + report.txt）")
    ap.add_argument("--preset", default=None, help="按组处方 presets.json（见 examples/presets.json）")
    ap.add_argument("--only", default=None, help="只处理指定组名（逗号分隔）")
    ap.add_argument("--group-name", default=None, help="平铺布局时的组名（默认=目录名）")
    ap.add_argument("--tol", type=int, default=None, help="固定容差；0=自动选档（默认）")
    ap.add_argument("--keep-near", type=float, default=None,
                    help=">0 额外保留贴着主体框（外扩 N×主体尺寸）的小域；0=严格只留最大连通域（默认）")
    ap.add_argument("--fill-pockets", dest="fill_pockets", action="store_true", default=None,
                    help="开补洞（默认开）")
    ap.add_argument("--no-fill-pockets", dest="fill_pockets", action="store_false", help="关补洞")
    ap.add_argument("--shadow", action="store_true", default=None, help="开阴影键控（HSV 同色相低亮度）")
    ap.add_argument("--erode", type=int, default=None, help="额外腐蚀 N px 再羽化，治顽固绿边（默认 0）")
    ap.add_argument("--kill-static", default=None,
                    help="静态叠加层（水印）扣除区域，如 br:0.45 = x>0.45W 且 y>0.45H；需要组内多帧")
    ap.add_argument("--thresh", type=float, default=0.5, help="kill-static 静态判定的出现率阈值")
    ap.add_argument("--despill", dest="despill", action="store_true", default=None, help="开去溢色（默认开）")
    ap.add_argument("--no-despill", dest="despill", action="store_false", help="关去溢色")
    ap.add_argument("--exclude", default="contact-*,cmp*", help="文件名排除模式（逗号分隔）")
    ap.add_argument("--limit", type=int, default=0, help="每组只处理前 N 张（0=全部，测试用）")
    ap.add_argument("--thumb-cols", type=int, default=10, help="contact sheet 每行几格")
    ap.add_argument("--scan", action="store_true", help="只扫目录结构（张数/尺寸/边框背景色），不抠图")
    ap.add_argument("--dry", action="store_true", help="只测量打印指标，不落盘")
    return ap


def main():
    a = build_argparser().parse_args()
    exclude = tuple(p.strip() for p in a.exclude.split(",") if p.strip())
    if not os.path.isdir(a.src):
        print("[X] 源目录不存在：%s" % a.src)
        sys.exit(2)
    if a.scan:
        scan(a.src, exclude)
        return
    if not a.out and not a.dry:
        print("[X] 非 --dry 必须给 --out")
        sys.exit(2)

    groups = find_groups(a.src, exclude, a.group_name)
    if a.only:
        want = [x.strip() for x in a.only.split(",") if x.strip()]
        groups = [g for g in groups if g[0] in want]
        if not groups:
            print("[X] --only 没匹配到组：%s" % a.only)
            sys.exit(2)
    if not groups:
        print("[X] 没找到图片：%s" % a.src)
        sys.exit(2)
    try:
        preset_groups = load_preset(a.preset)
    except ValueError as e:
        print("[X] %s" % e)
        sys.exit(2)
    # presets.json 顶层的 defaults 也合并进来（load_preset 只取了 groups 子表）
    if a.preset and os.path.isfile(a.preset):
        with open(a.preset, encoding="utf-8") as f:
            top = json.load(f)
        if isinstance(top.get("defaults"), dict):
            preset_groups = dict(preset_groups)
            preset_groups["defaults"] = top["defaults"]

    if not a.dry:
        os.makedirs(a.out, exist_ok=True)
    log("=" * 88)
    log("key_green：%s → %s%s" % (a.src, a.out or "(dry)", "  [--dry 只测量不落盘]" if a.dry else ""))
    grand_ok = grand_bad = 0
    for name, path, imgs in groups:
        r = resolve_recipe(name, preset_groups, a)
        ok, bad = process_group(name, imgs, r, a)
        grand_ok += ok
        grand_bad += bad
    log("=" * 88)
    log("合计 %d 张%s，%d 张异常（没抠到东西/读不出）" %
        (grand_ok, "（--dry，未落盘）" if a.dry else " → " + a.out, grand_bad))
    if not a.dry:
        rp = os.path.join(a.out, "report.txt")
        with open(rp, "w", encoding="utf-8") as fh:
            fh.write("\n".join(LOG) + "\n")
        print("[OK] 日志：%s" % rp)
    if grand_ok == 0:
        print("[X] 全部帧都没抠到东西：检查素材是不是绿幕、或调 --tol/--shadow")
        sys.exit(3)


if __name__ == "__main__":
    main()
