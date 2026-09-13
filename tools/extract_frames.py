#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_frames.py —— 抽帧工具（提纯自桌面旧脚本 video2sprite.py 的"抽帧 + 场景分段 + 循环段检测"部分）
====================================================================================
职责边界：只负责 视频 → 原始帧 PNG + 测量指标；抠图交给 key_green.py，拼精灵表交给 pack_sheet.py。

用法（Windows cp936 控制台建议包一层）：
    cmd /c "chcp 65001 >nul && set PYTHONIOENCODING=utf-8 && python tools\\extract_frames.py --input 视频.mp4 --out frames --every 2 2>&1"
    python tools\\extract_frames.py --input 视频.mp4 --out frames --dry            # 只测量不落盘
    python tools\\extract_frames.py --input 视频.mp4 --out frames --detect-loops   # 循环段检测

输出契约（--out 目录下）：
    f%04d.png                          抽取的原始帧（f0001 起，1 基编号，不抠图不裁剪）
    index.txt                          每帧一行：帧号 时间(s) 边框背景色 rgb；文件头注明源视频 fps/时长/总帧数/抽帧间隔
    scenes.txt                         按边框背景色自动分段（相邻帧背景色通道差 >24 即切段），格式同 vframes/scenes.txt
    contact/contact-NN_fXXXX-fYYYY.png 缩略图矩阵（帧号烧在图上），每 --contact-every 帧一张，供人分组

提纯来源（原脚本只读，行号以当前 523 行版本为准）：
    video2sprite.py:76-85    short_path（中文/空格路径转 8.3 短路径，OpenCV 才打得开）
    video2sprite.py:102-136  extract_frames（i % every == 0 抽帧；超 max-frames 再均匀稀释）
    video2sprite.py:253-274  find_loop（首尾帧差最小的子段 = 循环候选；与段内最大相邻差比较定判定）
    边框背景色/缩略图矩阵复用同目录 key_green.py 的 border_modal / contact 思路（kg 直接 import）。

几条硬规矩（详见 docs/01-抽帧.md、docs/08-踩坑清单.md 第 15/16 条）：
  1) cv2.imread/imwrite 遇中文路径静默失败 ⇒ 一律走 kg.imread_u / kg.imwrite_u（np.fromfile+imdecode / imencode+tofile）。
  2) cp936 控制台打不出 ✔✘⚠ ⇒ 状态标记只用 [OK]/[X]/[!]，且 stdout/stderr 先 reconfigure(errors="replace")。
  3) 失败（视频不存在/打不开/一帧没抽到）非 0 退出并打印原因。
"""
import argparse
import ctypes
import math
import os
import sys

for _s in (sys.stdout, sys.stderr):          # cp936 控制台防崩溃：编码错误一律替换
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # 保证任意 cwd 都能 import 同目录 key_green

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("[X] 缺少 OpenCV：pip install opencv-python numpy")

import key_green as kg                        # 复用 imread_u/imwrite_u/border_modal/contact/natural_key

SMALL_W = 160                                 # 缩略小图宽度：contact sheet 与循环段检测共用（内存可控）
SCENE_THRESH = 24                             # 场景切段阈值：相邻帧边框背景色任一通道差 >24 即切段（同 vframes/scenes.txt 头注释）
MIN_LOOP = 3                                  # 循环候选子段最少帧数（video2sprite.py:477 --min-loop 默认值）
CONTACT_COLS = 10                             # contact sheet 每行格数（同 key_green.py:562 --thumb-cols 默认）
LOG = []


def log(m=""):
    print(m)
    LOG.append(str(m))


# ────────────────── 中文/空格路径：转 8.3 短路径再喂 VideoCapture（video2sprite.py:76-85） ──────────────────
def short_path(p):
    """Windows 下 OpenCV 打不开含中文/空格的路径，转成 8.3 短路径。"""
    if os.name != "nt":
        return p
    try:
        buf = ctypes.create_unicode_buffer(1024)
        n = ctypes.windll.kernel32.GetShortPathNameW(os.path.abspath(p), buf, 1024)
        return buf.value if n else p
    except Exception:
        return p


# ────────────────── 抽帧计划 ──────────────────
def plan_picks(total, fps, every, max_frames, start, end):
    """算出要抽取的源帧号列表（video2sprite.py:113-132 的提纯 + 秒区间扩展）。
    返回 (plan, every, lo, hi)：total<=0 时（个别容器报不出总帧数）plan=None，走流式判断。"""
    if every <= 0:
        # 自动间隔：按 --max-frames 均匀抽（video2sprite.py:113-114）
        every = max(1, total // max(1, max_frames)) if (total > 0 and max_frames > 0) else 1
    lo = 0 if start is None else max(0, int(round(start * fps)))
    hi = None if end is None else int(round(end * fps))
    if total <= 0:
        return None, every, lo, hi
    hi_c = total - 1 if hi is None else min(total - 1, hi)
    if lo > hi_c:
        return [], every, lo, hi_c
    cand = list(range(lo, hi_c + 1, every))
    if 0 < max_frames < len(cand):
        # 抽多了再均匀稀释（video2sprite.py:128-132）
        step = len(cand) / float(max_frames)
        keep = sorted(set(min(int(round(k * step)), len(cand) - 1) for k in range(max_frames)))
        cand = [cand[k] for k in keep]
    return cand, every, lo, hi_c


# ────────────────── 场景分段 ──────────────────
def split_scenes(records, thresh=SCENE_THRESH):
    """按边框背景色自动分段：相邻帧任一通道差 > thresh 即切段（判据同 vframes/scenes.txt 头注释）。
    records 元素 = (帧号, 源帧号, 时间s, bg_rgb)。段背景色取段内出现次数最多的那个（众数）。"""
    cuts = [0]
    for k in range(1, len(records)):
        a, b = records[k - 1][3], records[k][3]
        if max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2])) > thresh:
            cuts.append(k)
    segs = []
    bounds = cuts + [len(records)]
    for si in range(len(cuts)):
        s, e = bounds[si], bounds[si + 1] - 1
        votes = {}
        for k in range(s, e + 1):
            c = records[k][3]
            votes[c] = votes.get(c, 0) + 1
        rep = max(votes.items(), key=lambda kv: kv[1])[0]      # 段背景色 = 段内众数
        segs.append((s, e, rep))
    return segs


def fmt_scene_line(si, s, e, rep, records):
    """一行场景描述，格式仿 vframes/scenes.txt：段号 起止帧 (帧数, 秒区间) 背景rgb。"""
    return "段%02d  f%04d ~ f%04d  (%d 帧, %.2f~%.2fs)  背景 rgb(%d,%d,%d)" % (
        si + 1, records[s][0], records[e][0], e - s + 1,
        records[s][2], records[e][2], rep[0], rep[1], rep[2])


# ────────────────── 循环段检测（video2sprite.py:253-274 find_loop 的提纯） ──────────────────
def diff_small(a_bgr, b_bgr):
    """两张小图的平均绝对差（0~255，RGB 三通道均值）。原版 frame_diff（video2sprite.py:211-217）
    在抠图后的 alpha 掩码上比；抽帧阶段还没有 alpha，用整幅原始像素近似——段内背景静止，差异主要来自动作。"""
    d = np.abs(a_bgr.astype(np.int32) - b_bgr.astype(np.int32)).sum(axis=2) / 3.0
    return float(d.mean())


def detect_loop(smalls, min_len=MIN_LOOP):
    """在一段内找"首尾帧差最小"的子段作为循环候选，并与段内最大相邻帧差比较：
    首尾差 ≤ 相邻差水平 ⇒ 判循环；否则说明首尾并不比随便两帧相邻更像 ⇒ 不是真循环（建议 pingpong）。
    返回 (bi, bj, span, inner, verdict)，bi/bj 是段内下标。"""
    n = len(smalls)
    if n < min_len + 1:
        return 0, n - 1, 0.0, 0.0, "帧数不足，整段当循环"        # video2sprite.py:257-258 同语义
    # 全对差值矩阵 D[i][j]（video2sprite.py:259-263；这里按行向量化加速）
    D = np.zeros((n, n), np.float64)
    for i in range(n - 1):
        row = [diff_small(smalls[i], smalls[j]) for j in range(i + 1, n)]
        D[i, i + 1:] = row
        D[i + 1:, i] = row
    best, bi, bj = 1e9, 0, n - 1
    for i in range(n):
        for j in range(i + min_len, n):                        # 子段至少 min_len+1 帧（video2sprite.py:264-268）
            if D[i][j] < best:
                best, bi, bj = float(D[i][j]), i, j
    span = float(D[bi][bj])
    inner = float(max(D[k][k + 1] for k in range(bi, bj))) if bj > bi else 0.0   # 段内最大相邻差
    verdict = ("循环（首尾差 ≤ 段内相邻最大差，正向循环可信）" if span <= inner
               else "非循环（首尾差 > 段内相邻最大差，来回播 pingpong 更顺眼）")   # 判定同 video2sprite.py:271-273,419
    return bi, bj, span, inner, verdict


# ────────────────── contact sheet（帧号烧在图上） ──────────────────
def build_contact(smalls, labels, cols=CONTACT_COLS, tw=150):
    """缩略图矩阵，布局仿 key_green.py:254-271 contact，区别：烧的是全局帧号（f0001…）而不是组内序号。
    每格统一缩放到 (tw, th)，th 取本张第一帧的纵横比；同源视频帧尺寸一致，混尺寸时会有轻微拉伸（仅供人分组，可接受）。"""
    n = len(smalls)
    rows = int(math.ceil(n / float(cols)))
    th = max(1, int(round(tw * smalls[0].shape[0] / float(smalls[0].shape[1]))))
    sheet = np.zeros((rows * (th + 4) + 4, cols * (tw + 4) + 4, 3), np.uint8)
    sheet[:] = (250, 250, 250)
    for i, s in enumerate(smalls):
        t = cv2.resize(s, (tw, th))
        r, c = divmod(i, cols)
        y, x = 4 + r * (th + 4), 4 + c * (tw + 4)
        sheet[y:y + th, x:x + tw] = t
        cv2.putText(sheet, labels[i], (x + 2, y + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 255), 2)
    return sheet


# ────────────────── 主流程 ──────────────────
def build_argparser():
    ap = argparse.ArgumentParser(
        description="视频 → 原始帧 PNG + index.txt + scenes.txt + contact sheet（抠图/拼表不在本工具，见 key_green.py / pack_sheet.py）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python tools\\extract_frames.py --input v.mp4 --out frames --every 2\n"
               "  python tools\\extract_frames.py --input v.mp4 --out frames --dry\n"
               "  python tools\\extract_frames.py --input v.mp4 --out frames --every 1 --max-frames 120 --detect-loops\n")
    ap.add_argument("--input", required=True, help="输入视频路径")
    ap.add_argument("--out", default=None, help="输出目录（非 --dry 时必填）")
    ap.add_argument("--every", type=int, default=1, help="每 N 帧抽 1（默认 1；0=按 --max-frames 自动算间隔）")
    ap.add_argument("--max-frames", type=int, default=0, help="最多抽取多少帧，超了均匀稀释（默认 0=不限）")
    ap.add_argument("--start", type=float, default=None, help="起始秒（含，可选；换算成源帧号后从该帧起抽）")
    ap.add_argument("--end", type=float, default=None, help="结束秒（含，可选）")
    ap.add_argument("--contact-every", type=int, default=80, help="每张 contact sheet 覆盖多少抽取帧（默认 80）")
    ap.add_argument("--detect-loops", action="store_true",
                    help="循环段检测：每个场景段内找首尾帧差最小的子段，与段内最大相邻差比较后给判定")
    ap.add_argument("--dry", action="store_true", help="只测量：打印 fps/时长/总帧数/计划抽取数/分段计划，不落盘")
    return ap


def main():
    a = build_argparser().parse_args()

    # ── 入参与视频打开：所有失败都非 0 退出并打印原因 ──
    if not os.path.isfile(a.input):
        print("[X] 视频不存在：%s" % a.input)
        sys.exit(2)
    if not a.dry and not a.out:
        print("[X] 非 --dry 必须给 --out")
        sys.exit(2)
    if a.every < 0 or a.max_frames < 0 or a.contact_every < 1:
        print("[X] 参数非法：--every/--max-frames 不能为负，--contact-every 至少 1")
        sys.exit(2)
    if a.every == 0 and a.max_frames <= 0:
        print("[X] --every 0（自动间隔）必须搭配 --max-frames N（N>0）")
        sys.exit(2)

    cap = cv2.VideoCapture(short_path(a.input))               # 中文/空格路径先转 8.3 短路径
    if not cap.isOpened():
        print("[X] 打不开视频（格式不支持或文件损坏）：%s" % a.input)
        sys.exit(2)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0                   # 个别视频报 0，兜底 25（video2sprite.py:107 同法）
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    dur = total / max(fps, 1e-6) if total > 0 else 0.0

    plan, every, lo, hi = plan_picks(total, fps, a.every, a.max_frames, a.start, a.end)
    if plan is not None and len(plan) == 0:
        cap.release()
        print("[X] 秒区间 [--start %s --end %s] 内没有可抽的帧（总时长 %.2fs）" % (a.start, a.end, dur))
        sys.exit(2)

    log("=" * 74)
    log("extract_frames：%s → %s%s" % (a.input, a.out or "(dry)", "  [--dry 只测量不落盘]" if a.dry else ""))
    log("视频：%s  %dx%d  %.2ffps  共 %d 帧（%.2fs）" %
        (os.path.basename(a.input), W, H, fps, total, dur))
    rng = "全部" if (a.start is None and a.end is None) else "%s~%s s" % (
        "头" if a.start is None else a.start, "尾" if a.end is None else a.end)
    log("计划：每 %d 帧抽 1  区间 %s  max-frames %s → 计划抽取 %s 帧" %
        (every, rng, a.max_frames if a.max_frames > 0 else "不限",
         len(plan) if plan is not None else "≈%d（源报不出总帧数，流式抽）" % ((hi - lo) // every + 1 if hi is not None else -1)))

    write = not a.dry
    if write:
        os.makedirs(a.out, exist_ok=True)

    # ── 逐帧流式抽取：不在内存里囤原始帧（361 帧 720p 会吃掉 ~1GB），只留记录 + 小图 ──
    records = []      # (帧号1基, 源帧号, 时间s, bg_rgb)
    smalls = []       # SMALL_W 宽小图（BGR uint8）：contact sheet 与循环段检测共用
    plan_set = set(plan) if plan is not None else None
    write_fail = 0
    i = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if plan_set is not None:
            take = i in plan_set
        else:                                                 # 源报不出总帧数：流式判断
            take = (i >= lo and (hi is None or i <= hi) and (i - lo) % every == 0
                    and (a.max_frames <= 0 or len(records) < a.max_frames))
        if take and bgr is not None:
            n = len(records) + 1
            bg_bgr = kg.border_modal(bgr)                     # 四边 6px 边框众数色，量化到 8（key_green.py:110-124）
            bg_rgb = (bg_bgr[2], bg_bgr[1], bg_bgr[0])        # BGR → RGB（index.txt/scenes.txt 记录的都是 RGB）
            records.append((n, i, i / max(fps, 1e-6), bg_rgb))
            smalls.append(cv2.resize(bgr, (SMALL_W, max(1, int(round(bgr.shape[0] * SMALL_W / float(bgr.shape[1])))))))
            if write:
                if not kg.imwrite_u(os.path.join(a.out, "f%04d.png" % n), bgr):
                    write_fail += 1
        i += 1
    cap.release()

    if not records:
        print("[X] 一帧都没抽到（检查 --every/--start/--end/--max-frames 或视频是否可解码）")
        sys.exit(3)
    read_total = i
    if total > 0 and read_total != total:
        log("[!] 源声称 %d 帧，实际只读出 %d 帧（以实际为准）" % (total, read_total))

    # ── 场景分段 ──
    scenes = split_scenes(records)
    log("分段：按边框背景色切出 %d 段（相邻帧任一通道差 >%d 即切段）" % (len(scenes), SCENE_THRESH))
    for si, (s, e, rep) in enumerate(scenes):
        log("  " + fmt_scene_line(si, s, e, rep, records))

    # ── 循环段检测（--detect-loops）：逐场景段找循环候选 ──
    if a.detect_loops:
        log("循环段检测（小图 %dpx 宽上量帧差；候选=段内首尾差最小的子段，判定=首尾差与段内最大相邻差比较）：" % SMALL_W)
        for si, (s, e, rep) in enumerate(scenes):
            seg = smalls[s:e + 1]
            bi, bj, span, inner, verdict = detect_loop(seg)
            log("  段%02d f%04d~f%04d（%d 帧）→ 循环候选 f%04d~f%04d（%d 帧）  首尾差=%.2f  段内相邻最大差=%.2f  判定：%s"
                % (si + 1, records[s][0], records[e][0], e - s + 1,
                   records[s + bi][0], records[s + bj][0], bj - bi + 1, span, inner, verdict))

    # ── 落盘：index.txt / scenes.txt / contact sheet ──
    if write:
        src_line = "# 源视频: %s  %dx%d  %.2ffps  时长 %.2fs  共 %d 帧" % (
            os.path.basename(a.input), W, H, fps, dur, total if total > 0 else read_total)
        plan_line = "# 抽帧间隔: 每 %d 帧取 1（--every %d）  max-frames: %s  区间: %s  → 实际抽出 %d 帧" % (
            every, a.every, a.max_frames if a.max_frames > 0 else "不限", rng, len(records))
        idx_path = os.path.join(a.out, "index.txt")
        with open(idx_path, "w", encoding="utf-8") as f:
            f.write(src_line + "\n" + plan_line + "\n")
            f.write("# 帧号  时间(s)  边框背景色(rgb)\n")
            for (n, src_i, t, bg) in records:
                f.write("f%04d %8.3f  rgb(%d,%d,%d)\n" % (n, t, bg[0], bg[1], bg[2]))
        sc_path = os.path.join(a.out, "scenes.txt")
        with open(sc_path, "w", encoding="utf-8") as f:
            f.write("# 按边框背景色自动分段（相邻帧背景色通道差 > %d 即切段），供分组参考\n" % SCENE_THRESH)
            f.write(src_line + "\n" + plan_line + "\n")
            for si, (s, e, rep) in enumerate(scenes):
                f.write(fmt_scene_line(si, s, e, rep, records) + "\n")
        # contact sheet：每 --contact-every 帧一张，命名 contact-NN_fXXXX-fYYYY.png（同 vframes/contact/ 的命名）
        per = max(1, a.contact_every)
        n_sheets = int(math.ceil(len(records) / float(per)))
        sheet_names = []
        for si in range(n_sheets):
            s, e = si * per, min((si + 1) * per, len(records)) - 1
            name = "contact-%02d_f%04d-f%04d.png" % (si + 1, records[s][0], records[e][0])
            img = build_contact(smalls[s:e + 1], ["f%04d" % records[k][0] for k in range(s, e + 1)])
            if not kg.imwrite_u(os.path.join(a.out, "contact", name), img):
                write_fail += 1
            else:
                sheet_names.append(name)
        log("-" * 74)
        if write_fail:
            log("[!] %d 个文件写失败（路径/磁盘/编码器问题）" % write_fail)
        log("[OK] 帧：%d 张 → %s（f0001.png ~ f%04d.png，源帧号 %d~%d）" %
            (len(records), a.out, records[-1][0], records[0][1], records[-1][1]))
        log("[OK] index.txt：%d 行帧记录（含 %d 行文件头）→ %s" % (len(records), 3, idx_path))
        log("[OK] scenes.txt：%d 段 → %s" % (len(scenes), sc_path))
        log("[OK] contact sheet：%d 张 → %s" % (len(sheet_names), os.path.join(a.out, "contact")))
        if a.detect_loops:
            log("[OK] 循环段检测：见上方逐段判定")
        log("[OK] 下一步：python tools\\key_green.py --src %s --out <keyed目录>（逐张重测边框背景色，可与 index.txt 交叉核对）" % a.out)
    else:
        log("-" * 74)
        log("[OK] --dry 测量完毕：计划抽取 %d 帧 / 实际可读出 %d 帧 / 分段 %d 段，未落盘" %
            (len(plan) if plan is not None else len(records), len(records), len(scenes)))
    if write and write_fail:
        sys.exit(4)


if __name__ == "__main__":
    main()
