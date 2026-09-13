#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pack_sheet.py —— fit-to-box 归一化打包 → spritesheet.png + pet.json（含回读独立复测）
====================================================================================
用法：
    python pack_sheet.py --src <抠图产物目录(组子目录或平铺)> --out <输出目录> [开关...]
    python pack_sheet.py --src examples/keyed --out examples --map demo=idle \
        --cell 96x112 --box 84x88 --baseline 100 --display 192x224 --cols 5 \
        --sheet-name demo-sheet.png --meta-name demo-pet.json
    python pack_sheet.py --dry ...        # 只测量不落盘

归一化语义（与 petwork/tools/sprites.mjs 的 cmdStatesPrecut、qanimal/pack162.py 等价，
证据与实测数字见 docs/03-归一化与图集.md）：
 1) 每组各自 fit-to-box：s = min(BOX_W/组并集宽, BOX_H/组并集高)，组内所有帧共用这一个 s，
    并且用【组并集框】裁切（绝不是逐帧紧裁）⇒ 组内放置抖动 = 0；
    底边对齐 baselineY + 水平居中（px=round((CELL_W-dw)/2)，py=BASELINE-dh）。
 2) 内容判定阈值 alpha>8（与素材侧测量口径一致）；缩小一律面积平均（INTER_AREA）：
    ≥2× 缩小时双线性只采 2×2、丢 97% 信息，帧间会闪烁。
 3) 归一化基准是常量（BOX/cell/baseline 全部来自命令行/默认值），绝不是 max() over data；
    异规格大图（内容 w 或 h > --max-content，默认 400px）先隔离跳过并如实报告——
    真实事故：一张 1088×2176（内容高 1971）的离群图曾把基准拖垮，所有帧被缩到 0.4632 倍。
 4) 尺寸不变量：显示尺寸的不变量是【屏幕 CSS px】不是 cell 内 px。k = display/cell；
    本工具打印 k 与"内容上屏 CSS px"（内容盒容量 = BOX_W×kw, BOX_H×kh），
    换 cell 必须配 --display 补偿，否则桌宠跟着缩小（192×224→112×150 会小 42%）。
 5) meta.frames 是 [[col,row],...] 坐标对，不是扁平索引；states 顺序 idle,wait,walk,react,
    working,sleep,supervise,dead；fps 缺省 walk8/react9(loop=false)/idle7/working8/wait5/
    sleep4/supervise7/dead8，clamp 2~24；pingpong 全 true；mirrorable 仅 walk。
    组名→状态名缺省按实战映射（pet.js:749-756 菜单）：待机眨眼=idle 加载等待=wait
    修bug=walk 敲代码=working 庆祝完成=react 睡觉休息=sleep 报错装死=dead 监工模式=supervise。
 6) 打包完必须回读成品 PNG 独立复测（不信打包器自述）：每组脚底 y 跨度（验收 0px，react 允许
    1px 真位移，门槛 ≤3px）、质心 x 跨度、内容触边=0（硬门槛）、空 cell 残留=0（硬门槛）、
    最小占用 px 下限（默认 1200）。脚底跨度同时给 alpha>8 与 alpha>128 两个口径——
    两者差 1~2px 是阈值伪影，不是抖动。

失败非 0 退出并打印原因；--dry 只测量。所有指标同时打印到 stdout（--out 下另写 pack-report.txt）。
"""
import argparse
import datetime
import json
import math
import os
import sys

for _s in (sys.stdout, sys.stderr):          # cp936 控制台防崩溃
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("[X] 缺少 OpenCV：pip install opencv-python numpy")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import key_green as kg                        # 复用 imread/imwrite/natural_key/list_images/contact

# 引擎状态白名单（dsh-pet-bg/src/pet.js:15）——不在里面的状态菜单点了没反应
NAMES = ("idle", "wait", "walk", "react", "working", "sleep", "supervise", "dead")
ORDER = ("idle", "wait", "walk", "react", "working", "sleep", "supervise", "dead")
# 组名(素材文件夹名) → 状态名，实战映射（pet.js:749-756 右键菜单）
DEFAULT_MAP = {"待机眨眼": "idle", "加载等待": "wait", "修bug": "walk", "敲代码": "working",
               "庆祝完成": "react", "睡觉休息": "sleep", "报错装死": "dead", "监工模式": "supervise"}
FPS_DEF = {"idle": 7, "wait": 5, "walk": 8, "react": 9, "working": 8, "sleep": 4,
           "supervise": 7, "dead": 8}
LOOP_FALSE = {"react"}                        # react 单次播放 + pingpong
MIRROR = {"walk"}
LOG = []


def log(m=""):
    print(m)
    LOG.append(str(m))


def die(msg, code=2):
    print("[X] %s" % msg)
    LOG.append("[X] %s" % msg)
    sys.exit(code)


def read4(p):
    """读成 BGRA（中文路径安全）。"""
    im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_UNCHANGED)
    if im is None:
        return None
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    elif im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    return im


def parse_wh(txt, what):
    try:
        w, h = txt.lower().replace("×", "x").split("x")
        return int(w), int(h)
    except Exception:
        die("%s 格式应为 WxH（如 112x150），收到：%s" % (what, txt))


def content_bbox(im, thr):
    """alpha>thr 的内容框 [x0,y0,x1,y1]（含端点）与像素数；全透明返回 (None,0)。"""
    a = im[:, :, 3]
    ys, xs = np.where(a > thr)
    if not len(xs):
        return None, 0
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())], int(len(xs))


def main():
    ap = argparse.ArgumentParser(
        description="fit-to-box 归一化打包 → spritesheet.png + pet.json（含回读独立复测）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--src", required=True, help="抠图产物目录（组子目录或平铺）")
    ap.add_argument("--out", default=None, help="输出目录（非 --dry 必填）")
    ap.add_argument("--cell", default="112x150", help="格子 WxH")
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--rows", type=int, default=0, help="0=自动 ceil(帧数/cols)")
    ap.add_argument("--box", default="98x118", help="格内内容盒 WxH（fit-to-box 的目标）")
    ap.add_argument("--baseline", type=int, default=134, help="baselineY：内容底边对齐的像素行")
    ap.add_argument("--display", default="192x224", help="显示尺寸 WxH（CSS px 不变量的补偿项）")
    ap.add_argument("--display-scale", type=float, default=0,
                    help="meta.displayScale；0=自动 display.h/cell.h（旧引擎补丁用）")
    ap.add_argument("--map", default=None, help="组名=状态名 覆盖，逗号分隔（如 demo=idle,bonus=walk）")
    ap.add_argument("--fps", default=None, help="状态=fps 覆盖，逗号分隔（如 idle=9）")
    ap.add_argument("--fill-from-idle", default=None,
                    help="逗号分隔状态列表：缺素材时用 idle 帧序列代填（demo/示例用；"
                         "embed-sheet 要求 idle/wait/walk/react/working/sleep 六态齐全）。会打 [!] 并写进 meta.source.note")
    ap.add_argument("--fps-scale", type=float, default=1.0, help="所有缺省 fps 的乘数")
    ap.add_argument("--max-content", type=int, default=0,
                    help="异规格隔离：内容 w 或 h 超过该值的帧跳过并报告；0=不隔离（默认）。"
                         "阈值按素材尺度定：网图批次事故用 400（1088×2176 离群图曾把 max() 基准拖垮，"
                         "全部帧被缩到 0.4632 倍）；视频帧内容普遍 ~650px，勿用 400")
    ap.add_argument("--thr", type=int, default=8, help="内容判定 alpha 阈值")
    ap.add_argument("--min-cnt", type=int, default=1200, help="回读复测：每帧最少非透明 px 下限")
    ap.add_argument("--sheet-name", default="spritesheet.png")
    ap.add_argument("--meta-name", default="pet.json")
    ap.add_argument("--group-name", default=None, help="平铺布局时的组名（默认=目录名）")
    ap.add_argument("--frames", default=None,
                    help="只打包匹配的帧（逗号分隔 fnmatch 模式，如 f03*.png；缺省=全部）")
    ap.add_argument("--exclude", default="contact-*,cmp*", help="文件名排除模式")
    ap.add_argument("--no-verify", action="store_true", help="跳过回读复测（不建议）")
    ap.add_argument("--dry", action="store_true", help="只测量不落盘（复测在内存中进行）")
    a = ap.parse_args()

    CELL_W, CELL_H = parse_wh(a.cell, "--cell")
    BOX_W, BOX_H = parse_wh(a.box, "--box")
    DISP_W, DISP_H = parse_wh(a.display, "--display")
    BASE = a.baseline
    COLS = a.cols
    if not os.path.isdir(a.src):
        die("源目录不存在：%s" % a.src)
    if not a.out and not a.dry:
        die("非 --dry 必须给 --out")

    gmap = dict(DEFAULT_MAP)
    if a.map:
        for kv in a.map.split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                gmap[k.strip()] = v.strip()
    fps_ov = {}
    if a.fps:
        for kv in a.fps.split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                fps_ov[k.strip()] = int(v)

    # ── 发现组 ──────────────────────────────────────────────────────────────
    exclude = tuple(p.strip() for p in a.exclude.split(",") if p.strip())
    found = kg.find_groups(a.src, exclude, a.group_name)
    if not found:
        die("没找到图片：%s" % a.src)

    log("=" * 92)
    log("pack_sheet：cell %dx%d  cols=%d  box %dx%d  baselineY=%d  display %dx%d  thr=%d%s"
        % (CELL_W, CELL_H, COLS, BOX_W, BOX_H, BASE, DISP_W, DISP_H, a.thr,
           "  [--dry]" if a.dry else ""))
    kw, kh = DISP_W / float(CELL_W), DISP_H / float(CELL_H)
    log("尺寸不变量：k=display/cell = %.4f x %.4f；元素尺寸=display×PAD(1.25)=%.0fx%.0f CSS px；"
        % (kw, kh, DISP_W * 1.25, DISP_H * 1.25))
    log("    内容盒容量上屏 = %.1f x %.1f CSS px（box %dx%d × k）；改 cell 不改 display 桌宠就会缩/涨"
        % (BOX_W * kw, BOX_H * kh, BOX_W, BOX_H))

    # ── pass 1：逐帧内容框 → 组并集框 → fit-to-box ─────────────────────────
    groups = []
    quarantined = []
    total = 0
    for gname, gpath, imgs in found:
        state = gmap.get(gname, gname)
        if state not in NAMES:
            log("  [!] 组 %s → 状态 %s 不在引擎 NAMES 白名单（pet.js:15），菜单将不可达；用 --map 覆盖"
                % (gname, state))
        frames = []
        u = None
        if a.frames:
            import fnmatch as _fm
            pats = [p.strip() for p in a.frames.split(",") if p.strip()]
            imgs = [f for f in imgs if any(_fm.fnmatch(os.path.basename(f), p) for p in pats)]
            log("  [i] %s：--frames 过滤后 %d 帧" % (gname, len(imgs)))
        for f in imgs:
            im = read4(f)
            if im is None:
                log("  [!] %s 读不出，跳过" % os.path.basename(f))
                continue
            bb, cnt = content_bbox(im, a.thr)
            if bb is None:
                log("  [!] %s 全透明，跳过" % os.path.basename(f))
                continue
            bw_, bh_ = bb[2] - bb[0] + 1, bb[3] - bb[1] + 1
            if a.max_content and max(bw_, bh_) > a.max_content:
                quarantined.append({"file": os.path.relpath(f, a.src).replace("\\", "/"),
                                    "contentWH": [bw_, bh_],
                                    "reason": "内容超过 --max-content %d（异规格隔离，规则15：基准必须是常量，不能被离群大图拖垮）" % a.max_content})
                log("  [!] 隔离异规格帧 %s：内容 %dx%d > %d（不进图集；见 docs/03 规则15）"
                    % (os.path.basename(f), bw_, bh_, a.max_content))
                continue
            fill = cnt / float(bw_ * bh_)
            frames.append({"file": os.path.basename(f), "path": f, "bbox": bb, "area": cnt, "fill": fill})
            u = bb if u is None else [min(u[0], bb[0]), min(u[1], bb[1]), max(u[2], bb[2]), max(u[3], bb[3])]
        if not frames:
            log("  [!] %s 无有效帧，跳过" % gname)
            continue
        uw, uh = u[2] - u[0] + 1, u[3] - u[1] + 1
        s = min(BOX_W / float(uw), BOX_H / float(uh))          # 每组一个缩放（fit-to-box）
        dw, dh = max(1, int(round(uw * s))), max(1, int(round(uh * s)))
        px, py = int(round((CELL_W - dw) / 2.0)), BASE - dh    # 底边对齐 BASELINE + 水平居中
        if px < 1 or py < 1 or px + dw > CELL_W - 1 or py + dh > CELL_H - 1:
            die("%s 内容盒越出安全区 px=%d py=%d %dx%d（cell %dx%d box %dx%d baseline %d）——"
                "调 --box/--baseline/--cell" % (state, px, py, dw, dh, CELL_W, CELL_H, BOX_W, BOX_H, BASE))
        lowfill = [f for f in frames if f["fill"] < 0.05]
        if lowfill:
            log("  [!] %s 填充率极低帧（碎点/全透明边缘？）：%s"
                % (state, ", ".join("%s=%.3f" % (f["file"], f["fill"]) for f in lowfill)))
        groups.append({"group": gname, "state": state, "frames": frames, "u": u, "uw": uw, "uh": uh,
                       "s": s, "dw": dw, "dh": dh, "px": px, "py": py})
        total += len(frames)
        log("  %-9s(%s) %2d 帧  并集框=%s (%dx%d)  s=%.4f  内容=%dx%d  贴于(%d,%d)  脚底y=%d"
            % (gname, state, len(frames), u, uw, uh, s, dw, dh, px, py, py + dh))
    if not groups or total == 0:
        die("没有可用帧")

    ROWS = a.rows if a.rows > 0 else int(math.ceil(total / float(COLS)))
    if total > COLS * ROWS:
        die("帧数 %d 超出 %d 格（cols=%d rows=%d）" % (total, COLS * ROWS, COLS, ROWS))

    # ── pass 2：裁并集框 → 组统一缩放（面积平均）→ 贴进 sheet ──────────────
    SH_W, SH_H = CELL_W * COLS, CELL_H * ROWS
    sheet = np.zeros((SH_H, SH_W, 4), np.uint8)
    idx = 0
    for g in groups:
        cells = []
        u = g["u"]
        for fr in g["frames"]:
            im = read4(fr["path"])
            sub = im[u[1]:u[3] + 1, u[0]:u[2] + 1]
            # 缩小 ≥2× 必须面积平均（INTER_AREA）；pack162 全程 INTER_AREA，与 sprites.mjs
            # resizeRGBA(≥2× 面积平均) 在关键档位同语义
            dst = cv2.resize(sub, (g["dw"], g["dh"]), interpolation=cv2.INTER_AREA)
            c, r = idx % COLS, idx // COLS
            ry, rx = r * CELL_H + g["py"], c * CELL_W + g["px"]
            sheet[ry:ry + g["dh"], rx:rx + g["dw"]] = dst      # 直接落位（与 sprites.mjs 的 set 同语义）
            fr["cell"] = [c, r]
            cells.append([c, r])
            idx += 1
        g["cells"] = cells
    log("-" * 92)
    log("  格数 %d/%d（%d 列 x %d 行），富余 %d 格；隔离 %d 帧"
        % (idx, COLS * ROWS, COLS, ROWS, COLS * ROWS - idx, len(quarantined)))

    # ── meta（frames=[[col,row],...] 坐标对）───────────────────────────────
    def fps_for(k):
        v = fps_ov.get(k, FPS_DEF.get(k, 6) * a.fps_scale)
        return max(2, min(24, int(round(v))))

    by_state = {}
    for g in sorted(groups, key=lambda x: ORDER.index(x["state"]) if x["state"] in ORDER else 99):
        d = {"fps": fps_for(g["state"]), "loop": g["state"] not in LOOP_FALSE,
             "mirrorable": g["state"] in MIRROR, "frames": g["cells"]}
        d["pingpong"] = True
        # 键序与生产 meta 一致：fps,loop,pingpong,mirrorable,frames
        by_state[g["state"]] = {"fps": d["fps"], "loop": d["loop"], "pingpong": True,
                                "mirrorable": d["mirrorable"], "frames": d["frames"], "_g": g}
    states = {}
    for k in ORDER:
        if k in by_state:
            states[k] = {kk: vv for kk, vv in by_state[k].items() if kk != "_g"}
    for k in by_state:                                            # 非白名单状态也写入（带警告）
        if k not in states:
            states[k] = {kk: vv for kk, vv in by_state[k].items() if kk != "_g"}
    if "wait" not in states and "idle" in states:                 # 与 sprites.mjs 同：wait 缺省用 idle 隔帧
        states["wait"] = {"fps": fps_for("wait"), "loop": True, "pingpong": True, "mirrorable": False,
                          "frames": states["idle"]["frames"][::2]}
        log("  [i] wait 未提供素材：用 idle 隔帧代用（%d 帧）" % len(states["wait"]["frames"]))
    filled = []
    if a.fill_from_idle and "idle" in states:
        for k in [x.strip() for x in a.fill_from_idle.split(",") if x.strip()]:
            if k in states:
                continue
            states[k] = {"fps": fps_for(k), "loop": k not in LOOP_FALSE, "pingpong": True,
                         "mirrorable": k in MIRROR, "frames": states["idle"]["frames"]}
            filled.append(k)
            log("  [!] %s 无素材：用 idle 帧序列代填（%d 帧）——demo 用途，正式制作请给真实素材"
                % (k, len(states["idle"]["frames"])))
    if filled:                                                    # 保持 ORDER 键序
        states = {k: states[k] for k in list(ORDER) + [x for x in states if x not in ORDER]
                  if k in states}

    ds = a.display_scale if a.display_scale > 0 else DISP_H / float(CELL_H)
    idle0 = by_state.get("idle", {}).get("_g")
    walk0 = by_state.get("walk", {}).get("_g")
    views = {
        "front": ({"cell": idle0["cells"][0], "file": idle0["frames"][0]["file"],
                  "bbox": [idle0["px"], idle0["py"], idle0["dw"], idle0["dh"]]} if idle0 else None),
        "back": ({"cell": walk0["cells"][0], "file": walk0["frames"][0]["file"],
                 "bbox": [walk0["px"], walk0["py"], walk0["dw"], walk0["dh"]]} if walk0 else None),
    }
    png_bytes = 0
    meta = {"version": 1, "sheet": a.sheet_name,
            "cell": {"w": CELL_W, "h": CELL_H}, "cols": COLS, "rows": ROWS,
            "display": {"w": DISP_W, "h": DISP_H},
            "displayScale": round(ds, 6),
            "anchor": {"x": 0.5, "y": 1}, "baselineY": BASE,
            "states": states, "views": views,
            "source": {"dir": os.path.abspath(a.src), "files": idx,
                       "generator": "pack_sheet.py (per-group fit-to-box, 与 sprites.mjs states --precut 同语义)",
                       "cellBox": {"w": BOX_W, "h": BOX_H}, "baseline": BASE,
                       "groups": {g["state"]: {"frames": len(g["frames"]), "unionBBox": g["u"],
                                               "scale": round(g["s"], 5), "contentWH": [g["dw"], g["dh"]]}
                                  for g in groups},
                       "quarantined": quarantined,
                       "note": "每组各自 fit-to-box，组内共用一个裁切框+缩放+落点（零放置抖动）；底边对齐 baselineY、水平居中；脚底/质心跨度=真实动作幅度"
                               + ("；fill-from-idle 代填状态：%s（demo 复用 idle 帧序列，非真实动作素材）" % ",".join(filled) if filled else ""),
                       "generatedAt": datetime.datetime.now().isoformat()}}

    # ── 落盘（或 dry 内存编码估体积）───────────────────────────────────────
    ok, buf = cv2.imencode(".png", sheet)
    if not ok:
        die("PNG 编码失败")
    png_bytes = len(buf)
    if not a.dry:
        os.makedirs(a.out, exist_ok=True)
        buf.tofile(os.path.join(a.out, a.sheet_name))
        with open(os.path.join(a.out, a.meta_name), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=1)
    b64 = 22 + 4 * int(math.ceil(png_bytes / 3.0))
    log("-" * 92)
    log("  sheet %dx%d  PNG %dB (%.2fMB)  base64≈%.2fMB  %s"
        % (SH_W, SH_H, png_bytes, png_bytes / 1048576.0, b64 / 1048576.0,
           "[OK] 在 embed-sheet 4.0MB 硬限内（限的是 base64 不是 PNG）" if b64 < 4.0 * 1048576
           else "[X] 超 embed-sheet 硬限：降格子或提硬限，见 docs/07"))

    # ── 回读独立复测（规则19：不信打包器自述；dry 时对内存编码结果复测）────
    gate_fail = 0
    if not a.no_verify:
        bk = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)             # 回读成品（dry 也复测同一份字节）
        used = set()
        for st in states.values():
            for c, r in st["frames"]:
                used.add((c, r))
        log("  回读复测（阈值 alpha>%d；括号内为 alpha>128 口径，差 1~2px 属阈值伪影）：" % a.thr)
        for g in groups:
            feet, feet128, cxs, ws, hs = [], [], [], [], []
            touch, min_cnt = 0, 10 ** 9
            for fr in g["frames"]:
                c, r = fr["cell"]
                cell = bk[r * CELL_H:(r + 1) * CELL_H, c * CELL_W:(c + 1) * CELL_W, 3]
                ys, xs = np.where(cell > a.thr)
                ys2, _ = np.where(cell > 128)
                if not len(xs):
                    log("  [X] %s cell(%d,%d) 空" % (fr["file"], c, r))
                    gate_fail += 1
                    continue
                cnt = int(len(xs))
                sx = float(xs.sum())
                touch += int(((xs == 0) | (xs == CELL_W - 1) | (ys == 0) | (ys == CELL_H - 1)).sum())
                feet.append(int(ys.max()) + 1)
                feet128.append(int(ys2.max()) + 1 if len(ys2) else 0)
                cxs.append(sx / cnt)
                ws.append(int(xs.max() - xs.min() + 1))
                hs.append(int(ys.max() - ys.min() + 1))
                min_cnt = min(min_cnt, cnt)
            fy = (max(feet) - min(feet)) if len(feet) > 1 else 0
            fy128 = (max(feet128) - min(feet128)) if len(feet128) > 1 else 0
            cx = (max(cxs) - min(cxs)) if len(cxs) > 1 else 0.0
            ok_g = touch == 0 and min_cnt > a.min_cnt and fy <= 3
            if not ok_g:
                gate_fail += 1
            log("  [%s] %-9s %2d 帧  脚底y跨度=%dpx(128口径=%d)  质心x跨度=%.1fpx  触边=%d  占用≤%dx%d(盒%dx%d)  最少非透明=%dpx%s"
                % ("OK" if ok_g else "X", g["state"], len(g["frames"]), fy, fy128, cx, touch,
                   max(ws) if ws else 0, max(hs) if hs else 0, BOX_W, BOX_H,
                   min_cnt if min_cnt < 10 ** 9 else -1,
                   "" if ok_g else "  ← 门槛：触边=0 且 最少非透明>%d 且 脚底跨度≤3" % a.min_cnt))
            if fy > 1 and g["state"] != "react":
                log("       [!] 脚底跨度 %dpx>1（react 的 1px 是跳跃真位移；其他组应查素材或阈值伪影）" % fy)
        # 空 cell 残留 = 0（未被任何状态引用的格子必须全透明）
        residue = 0
        for r in range(ROWS):
            for c in range(COLS):
                if (c, r) in used:
                    continue
                cell = bk[r * CELL_H:(r + 1) * CELL_H, c * CELL_W:(c + 1) * CELL_W, 3]
                residue += int((cell > a.thr).sum())
        if residue:
            gate_fail += 1
        log("  [%s] 空 cell 残留 = %d px（门槛=0）" % ("X" if residue else "OK", residue))

    # ── 汇总行（与 sprites.mjs 同款式，方便对照）───────────────────────────
    fps_txt = " ".join("%s%d" % (k, v["fps"]) for k, v in states.items())
    cnt_txt = "/".join(str(len(v["frames"])) for v in states.values())
    log("=" * 92)
    log("PACK %s — %d/%d 格  sheet %dx%d  PNG %dB  base64≈%.2fMB  states=%d(%s)  fps=[%s]  k=%.4fx%.4f  gate=%s%s"
        % ("OK" if gate_fail == 0 else "FAIL", idx, COLS * ROWS, SH_W, SH_H, png_bytes,
           b64 / 1048576.0, len(states), cnt_txt, fps_txt, kw, kh,
           "全过" if gate_fail == 0 else "%d FAIL" % gate_fail, "  [--dry 未落盘]" if a.dry else ""))
    if not a.dry and a.out:
        with open(os.path.join(a.out, "pack-report.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(LOG) + "\n")
        print("[OK] 报告：%s" % os.path.join(a.out, "pack-report.txt"))
    if gate_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
