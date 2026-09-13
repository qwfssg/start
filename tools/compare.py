#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compare.py —— 抠图参数人审对比图：同一帧 / 三种参数 / 品红底 / 头部或角部放大
==============================================================================
用法：
    python compare.py --src <原始帧目录> --out <输出目录> [--samples 组/帧.png,...] [--limit 3]
    python compare.py --src examples/frames --out examples/compare --samples f0097.png,f0276.png

每张对比图 3 列（对应 key_green.py 的三档参数）：
    A: strict      只留最大连通域（默认严格模式，纸屑/问号全丢）
    B: erode N     同上 + 腐蚀 N px（默认 1，治顽固绿边，发丝细节变钝）
    C: keep-near   最大域 + 贴身小域（默认 0.25，救回纸屑/被子/zzz/白问号）
上半行 = 整帧缩到 384 宽；下半行 = 头部（或右下角）区域放大到 384（约 1.5×）。

为什么要这个工具（1px 绿边在 1/8.5 的 contact sheet 缩略图上根本看不见）：
  · 垫品红底：任何绿色残留都会变成刺眼对比，比棋盘格更容易暴露绿边；
  · 放大行：绿边只有在 ≥1.5× 时才看得清；
  · 每列标签带客观数字（rim_green 边缘绿占比 / comps 连通域数），人不靠猜。
判读方法：
  品红底上角色轮廓外圈有一层绿/暗边 → 该组用 B（--erode 1）；
  A/B 都看不出绿边 → 保持严格模式（erode 会让发丝变钝，不划算）；
  C 列比 A 多出彩纸/被子/zzz/问号 → 该组用 --keep-near 0.25~0.35（副作用见 docs/02 规则 7：水印也会被救回）。
注意：rim_green 在 despill 之前量，系统性夸大（抗锯齿边缘本来就是混合色），只做列间/帧间比较。
"""
import argparse
import os
import sys

for _s in (sys.stdout, sys.stderr):          # cp936 控制台防崩溃
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import key_green as kg                       # 单一事实来源：键控逻辑全部复用 key_green

MAGENTA = np.array([255, 0, 255], np.float32)
CW = 384                                     # 每列宽


def comp(rgb, alpha, bgc=MAGENTA):
    """品红底合成：alpha 之外的地方全部垫品红。"""
    a = alpha[:, :, None]
    return (rgb.astype(np.float32) * a + bgc * (1 - a)).astype(np.uint8)


def variant(bgr, tol, bg, keep_near, erode, do_despill=True):
    alpha, info = kg.key(bgr, tol, bg, keep_near, erode, False, True)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    if do_despill:
        rgb = kg.despill(rgb, [bg[2], bg[1], bg[0]])
    return comp(rgb, alpha), alpha, info


def label_bar(w, text):
    bar = np.full((24, w, 3), 250, np.uint8)
    cv2.putText(bar, text, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (20, 20, 20), 1, cv2.LINE_AA)
    return bar


def head_crop(img, bbox, size=256):
    """头部区域：内容框顶部居中 size×size（放大行用，绿边在这里才看得清）。"""
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) // 2
    h, w = img.shape[:2]
    size = min(size, h, w)
    lx = max(0, min(cx - size // 2, w - size))
    ly = max(0, min(y0, h - size))
    return img[ly:ly + size, lx:lx + size]


def corner_crop(img, size=300):
    """右下角区域（查水印用，与 --kill-static br:0.45 对应）。"""
    h, w = img.shape[:2]
    size = min(size, h, w)
    return img[h - size:h, w - size:w]


def build_one(src_rel, src_root, out, args):
    p = os.path.join(src_root, src_rel.replace("/", os.sep))
    bgr = kg.imread_u(p)
    if bgr is None:
        print("  [!] 读不出 %s" % p)
        return False
    bg = kg.border_modal(bgr)
    tol, _ = kg.auto_tol(bgr, bg, 0.0, False, True)
    vs = [("A: strict", variant(bgr, tol, bg, 0.0, 0)),
          ("B: erode %d" % args.erode, variant(bgr, tol, bg, 0.0, args.erode)),
          ("C: keep-near %.2f" % args.keep_near, variant(bgr, tol, bg, args.keep_near, 0))]
    bbox = vs[0][1][2]["bbox"] or [0, 0, bgr.shape[1], bgr.shape[0]]
    cols_full, cols_zoom = [], []
    for lab, (img, alpha, info) in vs:
        full = cv2.resize(img, (CW, int(round(CW * img.shape[0] / img.shape[1]))))
        cols_full.append(np.vstack([label_bar(CW, lab), full]))
        z = head_crop(img, bbox) if args.zoom == "head" else corner_crop(img)
        z = cv2.resize(z, (CW, CW), interpolation=cv2.INTER_NEAREST)
        cols_zoom.append(np.vstack([label_bar(
            CW, "%s zoom rim_green=%.1f%% comps=%d" % (args.zoom, info["rim_green"], info["comps"])), z]))
        print("    %-18s rim_green=%5.1f%%  comps=%3d  area=%7dpx  extra=%d"
              % (lab, info["rim_green"], info["comps"], info["area"], info["extra"]))
    gap = np.full((cols_full[0].shape[0], 6, 3), 255, np.uint8)
    gap2 = np.full((cols_zoom[0].shape[0], 6, 3), 255, np.uint8)
    top = cols_full[0]
    for c in cols_full[1:]:
        top = np.hstack([top, gap, c])
    bot = cols_zoom[0]
    for c in cols_zoom[1:]:
        bot = np.hstack([bot, gap2, c])
    sep = np.full((8, top.shape[1], 3), 255, np.uint8)
    sheet = np.vstack([top, sep, bot])
    stem = os.path.splitext(os.path.basename(src_rel))[0]
    gpart = os.path.dirname(src_rel).replace("\\", "/")
    name = "cmp-%s-%s.png" % (gpart, stem) if gpart else "cmp-%s.png" % stem
    print("  [OK] %s  bg=rgb(%d,%d,%d) tol=%d 内容框=%s  (%dx%d)%s"
          % (name, bg[2], bg[1], bg[0], tol, bbox, sheet.shape[1], sheet.shape[0],
             "  (--dry 未落盘)" if args.dry else ""))
    if not args.dry:
        os.makedirs(out, exist_ok=True)
        kg.imwrite_u(os.path.join(out, name), sheet)
    return True


def main():
    ap = argparse.ArgumentParser(
        description="品红底三参数抠图对比图（A 严格 / B 腐蚀 / C 贴身）+ 头部或角部放大，供人审检查点",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--src", required=True, help="原始帧目录（组子目录或平铺布局）")
    ap.add_argument("--out", default=None, help="输出目录")
    ap.add_argument("--samples", default=None,
                    help="指定样例帧，逗号分隔，相对 --src（如 敲代码/f0058.png,f0097.png）；缺省=每组前 --limit 帧")
    ap.add_argument("--limit", type=int, default=3, help="未指定 --samples 时每组取前 N 帧")
    ap.add_argument("--keep-near", type=float, default=0.25, help="C 列的 keep-near 值")
    ap.add_argument("--erode", type=int, default=1, help="B 列的腐蚀 px")
    ap.add_argument("--zoom", choices=("head", "corner"), default="head",
                    help="放大行取头部还是右下角（查水印用 corner）")
    ap.add_argument("--exclude", default="contact-*,cmp*", help="文件名排除模式")
    ap.add_argument("--dry", action="store_true", help="只测量打印指标，不落盘")
    a = ap.parse_args()
    if not os.path.isdir(a.src):
        print("[X] 源目录不存在：%s" % a.src)
        sys.exit(2)
    if not a.out and not a.dry:
        print("[X] 非 --dry 必须给 --out")
        sys.exit(2)
    exclude = tuple(p.strip() for p in a.exclude.split(",") if p.strip())

    if a.samples:
        rels = [s.strip().replace("\\", "/") for s in a.samples.split(",") if s.strip()]
    else:
        rels = []
        for gname, gpath, imgs in kg.find_groups(a.src, exclude, None):
            for f in imgs[:max(1, a.limit)]:
                rels.append(os.path.relpath(f, a.src).replace("\\", "/"))
    if not rels:
        print("[X] 没有可用样例帧")
        sys.exit(2)

    print("=" * 78)
    print("三参数对比图：%s → %s   A严格 / B腐蚀%d / C贴身%.2f   zoom=%s%s"
          % (a.src, a.out or "(dry)", a.erode, a.keep_near, a.zoom, "  [--dry]" if a.dry else ""))
    ok = 0
    for rel in rels:
        print("  样例 %s" % rel)
        if build_one(rel, a.src, a.out, a):
            ok += 1
    print("=" * 78)
    print("合计 %d/%d 张对比图%s" % (ok, len(rels), "（--dry，未落盘）" if a.dry else " → " + a.out))
    if ok == 0:
        print("[X] 一张都没生成")
        sys.exit(3)


if __name__ == "__main__":
    main()
