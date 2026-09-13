/* src/bg.js —— 背景视频层 + 毛玻璃控制面板（只依赖 core.js 的 CORE，禁止引用 PET/SHEET/BOOT）。
 * DESIGN §1 两条铁律：
 *  1) #dsh-pet-video / #dsh-pet-panel 一律是 document.body 直接子节点，固定 id + 自带 z-index；
 *     绝不给宿主容器（.gradio-container / ._frame / #root / html / body）写 position/z-index/
 *     filter/backdrop-filter —— 一造层叠上下文，宿主 z-index:1000 的设置弹窗就被压平（点不开）。
 *  2) 样式只写 #dsh-pet-* 前缀选择器，绝不写 "*:not(...)" 之类全后代透明规则；
 *     毛玻璃滤镜只加在面板自己身上，背景由独立元素承载。
 */
var BG = (function () {
  var MAX_BYTES = 240 * 1024 * 1024; // 上传视频硬上限 240MB
  var PZ = 2147483001;               // §2 挂载表：面板浮在桌宠/菜单之上；背景层 z-index:0
  var layer = null, video = null, panel = null, refs = {}, unbinds = []; // unbinds：全部解绑句柄（含拖动临时监听）
  var started = false, pinned = false, forcedMute = false, token = 0;    // token：源解析竞态令牌，只有最新异步结果可写 src
  var lastError = null, lastToast = ""; // 面板红字文案 / 同文案 toast 去重（防 refresh 循环刷屏）

  /* ── 基础小工具（一律吞异常，绝不上抛）────────────────────────────── */
  function warn(msg, e) { try { console.warn(CORE.LOG + " " + msg, e); } catch (x) { /* 没 console 就算了 */ } }
  function toast(msg) { lastToast = msg; try { CORE.emit("toast", msg); } catch (e) {} }
  function toastOnce(msg) { if (lastToast !== msg) toast(msg); }
  function track(fn) { unbinds.push(fn); return fn; }
  function setCfg(patch, immediate) { try { CORE.set(patch, immediate === true); } catch (e) { warn("写配置失败", e); } }
  function setError(msg) { lastError = msg || null; if (refs.errLine) refs.errLine.textContent = lastError || ""; }
  function fmtSize(n) { var b = Number(n) || 0; return b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
  function safeRate(c) { try { if (video) video.playbackRate = c.bg.speed; } catch (e) { /* 越界速率忽略 */ } }
  function validUrl(u) { return /^https?:\/\//i.test(u); } // 源白名单：只放 http/https，挡 javascript:/data:/blob:/空串

  /* ── 样式：全部以 #dsh-pet- 开头，不碰任何宿主选择器 ───────────────── */
  var CSS = [
    "#dsh-pet-video{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;display:none;}",
    "#dsh-pet-video-clip{width:100%;height:100%;display:block;object-fit:cover;}",
    "#dsh-pet-panel{position:fixed;left:18px;bottom:96px;z-index:" + PZ + ";width:320px;max-height:min(76vh,640px);overflow:auto;display:none;flex-direction:column;border-radius:12px;border:1px solid rgba(127,127,127,.35);box-shadow:0 12px 34px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary,#111);font:13px/1.55 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 72%, transparent);-webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2);}",
    "#dsh-pet-panel .dsh-pet-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;margin-bottom:6px;cursor:move;user-select:none;position:sticky;top:0;z-index:1;border-bottom:1px solid rgba(127,127,127,.22);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 88%, transparent);}#dsh-pet-panel .dsh-pet-head.dsh-pet-pinned{cursor:default;}#dsh-pet-panel .dsh-pet-title{font-weight:600;flex:1 1 auto;}",
    "#dsh-pet-panel .dsh-pet-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:7px;}#dsh-pet-panel .dsh-pet-row{display:flex;align-items:center;gap:8px;}#dsh-pet-panel .dsh-pet-row>.dsh-pet-label:first-child{width:64px;flex:0 0 64px;opacity:.85;}#dsh-pet-panel input[type=range]{flex:1 1 auto;min-width:0;accent-color:#2f6feb;}",
    "#dsh-pet-panel .dsh-pet-val{width:52px;flex:0 0 52px;text-align:right;font-variant-numeric:tabular-nums;opacity:.8;}#dsh-pet-panel .dsh-pet-seg{display:flex;gap:4px;}",
    "#dsh-pet-panel button{padding:3px 8px;border-radius:8px;cursor:pointer;font:inherit;color:inherit;border:1px solid rgba(127,127,127,.35);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 60%, transparent);}#dsh-pet-panel button[aria-pressed='true']{border-color:#2f6feb;color:#2f6feb;}",
    "#dsh-pet-panel .dsh-pet-url{flex:1 1 auto;min-width:0;padding:4px 7px;border-radius:8px;color:inherit;font:inherit;border:1px solid rgba(127,127,127,.35);background:transparent;}",
    "#dsh-pet-panel .dsh-pet-sec{margin:8px 0 2px;font-size:12px;opacity:.62;border-top:1px solid rgba(127,127,127,.18);padding-top:8px;}#dsh-pet-panel .dsh-pet-clips{display:flex;flex-direction:column;gap:3px;max-height:132px;overflow:auto;font-size:12px;}",
    "#dsh-pet-panel .dsh-pet-clip{display:flex;align-items:center;gap:6px;}#dsh-pet-panel .dsh-pet-clip span:first-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}#dsh-pet-panel .dsh-pet-clip em{font-style:normal;opacity:.55;}",
    "#dsh-pet-panel .dsh-pet-hint{font-size:11px;opacity:.6;margin-top:6px;line-height:1.5;}#dsh-pet-panel .dsh-pet-filter{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.65;word-break:break-all;}#dsh-pet-panel .dsh-pet-err{font-size:11px;color:#d1604c;min-height:14px;}",
    "@media (prefers-reduced-motion: reduce){#dsh-pet-panel,#dsh-pet-panel *,#dsh-pet-video{transition:none !important;animation:none !important;}}",
  ].join("\n");

  /* ── 控件工厂（监听全部登记，stop 时统一解绑）─────────────────────── */
  function check(aria, onChange) {
    var box = CORE.el("input", { type: "checkbox", "aria-label": aria });
    track(CORE.on(box, "change", function () { onChange(box.checked); }));
    return box;
  }
  function range(aria, min, max, step, onChange) {
    var input = CORE.el("input", { type: "range", min: String(min), max: String(max), step: String(step), "aria-label": aria });
    var val = CORE.el("span", { "class": "dsh-pet-val" });
    // input：即时生效 + CORE.set 的 debounce 落盘；change：CORE.set(...,true) 立即落盘
    track(CORE.on(input, "input", function () { onChange(parseFloat(input.value), false); }));
    track(CORE.on(input, "change", function () { onChange(parseFloat(input.value), true); }));
    return { row: CORE.el("div", { "class": "dsh-pet-row" }, [CORE.el("span", { "class": "dsh-pet-label", text: aria }), input, val]), input: input, val: val };
  }
  function button(text, aria, onClick, extra) {
    var a = { type: "button", text: text, "aria-label": aria };
    for (var k in extra || {}) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
    var b = CORE.el("button", a);
    track(CORE.on(b, "click", onClick)); return b;
  }

  /* ── 面板 DOM ───────────────────────────────────────────────────────── */
  function buildPanel() {
    var t = CORE;
    refs.pinBtn = button("固定", "固定面板位置", function () {
      pinned = !pinned;
      refs.pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
      refs.head.setAttribute("class", "dsh-pet-head" + (pinned ? " dsh-pet-pinned" : ""));
    }, { "aria-pressed": "false" });
    refs.head = t.el("div", { "class": "dsh-pet-head" }, [t.el("span", { "class": "dsh-pet-title", text: "背景视频" }), refs.pinBtn, button("×", "关闭面板", function () { open(false); })]);
    track(CORE.on(refs.head, "pointerdown", startDrag)); // 标题栏拖动
    refs.enabled = check("启用背景", function (v) { setCfg({ bg: { enabled: v } }, true); refresh(); });
    refs.rBlur = range("虚化", 0, 20, 1, function (v, im) { setCfg({ bg: { blur: v } }, im); refresh(); });
    refs.rBright = range("亮度", 0.3, 2, 0.05, function (v, im) { setCfg({ bg: { brightness: v } }, im); refresh(); });
    refs.rSpeed = range("播放速度", 0.25, 3, 0.05, function (v, im) { setCfg({ bg: { speed: v } }, im); refresh(); });
    refs.rVol = range("音量", 0, 1, 0.01, function (v, im) { setCfg({ bg: { volume: v } }, im); refresh(); });
    refs.rOpacity = range("不透明度", 0, 1, 0.01, function (v, im) { setCfg({ bg: { opacity: v } }, im); refresh(); });
    var presetRow = t.el("div", { "class": "dsh-pet-row" }, [t.el("span", { "class": "dsh-pet-label", text: "速度预设" })]);
    ["0.5x", "1x", "1.5x", "2x"].forEach(function (s) { // 文案必须正好是这四个串（验收按文本匹配）
      presetRow.appendChild(button(s, "速度预设 " + s, function (e) { setCfg({ bg: { speed: parseFloat(e.currentTarget.textContent) } }, true); refresh(); }));
    });
    refs.mute = check("静音", function (v) { forcedMute = false; setCfg({ bg: { muted: v } }, true); refresh(); });
    refs.loop = check("循环", function (v) { setCfg({ bg: { loop: v } }, true); refresh(); });
    refs.playBtn = button("播放", "播放或暂停视频", function () { setCfg({ bg: { playing: !(video && !video.paused) } }, true); refresh(); });
    refs.segCover = button("cover", "填充方式 cover", function () { setCfg({ bg: { fit: "cover" } }, true); refresh(); });
    refs.segContain = button("contain", "填充方式 contain", function () { setCfg({ bg: { fit: "contain" } }, true); refresh(); });
    refs.fileInput = t.el("input", { type: "file", accept: "video/mp4,video/webm,video/ogg", "aria-label": "选择视频文件", style: "display:none" });
    track(CORE.on(refs.fileInput, "change", onPick));
    refs.urlInput = t.el("input", { type: "text", "class": "dsh-pet-url", placeholder: "或粘贴视频 URL（https://…/loop.mp4）", "aria-label": "或粘贴视频 URL" });
    refs.clipBox = t.el("div", { "class": "dsh-pet-clips", "aria-label": "已存视频列表" });
    refs.filterLine = t.el("div", { "class": "dsh-pet-filter" });
    refs.errLine = t.el("div", { "class": "dsh-pet-err" });
    var body = t.el("div", { "class": "dsh-pet-body" }, [
      t.el("div", { "class": "dsh-pet-row" }, [t.el("span", { "class": "dsh-pet-label", text: "启用背景" }), refs.enabled]),
      refs.rBlur.row, refs.rBright.row, refs.rSpeed.row, presetRow, refs.rVol.row, refs.rOpacity.row,
      t.el("div", { "class": "dsh-pet-row" }, [t.el("span", { "class": "dsh-pet-label", text: "静音" }), refs.mute, refs.playBtn,
        t.el("span", { "class": "dsh-pet-label", text: "填充" }), t.el("div", { "class": "dsh-pet-seg" }, [refs.segCover, refs.segContain])]),
      t.el("div", { "class": "dsh-pet-row" }, [t.el("span", { "class": "dsh-pet-label", text: "循环" }), refs.loop]),
      t.el("div", { "class": "dsh-pet-sec", text: "视频源" }),
      t.el("div", { "class": "dsh-pet-row" }, [button("上传本地视频", "上传本地视频", function () { refs.fileInput.click(); }), refs.fileInput]),
      t.el("div", { "class": "dsh-pet-row" }, [refs.urlInput, button("应用", "应用视频 URL", applyUrl)]),
      t.el("div", { "class": "dsh-pet-sec", text: "已存视频" }), refs.clipBox,
      t.el("div", { "class": "dsh-pet-hint", text: "参数存 localStorage，视频存 IndexedDB（二进制绝不进 localStorage）。Esc 不关闭本面板。" }),
      refs.filterLine, refs.errLine,
    ]);
    return t.el("div", { id: "dsh-pet-panel", role: "dialog", "aria-label": "背景视频控制面板" }, [refs.head, body]);
  }

  /* ── 面板显隐 / 拖动 / 固定 ─────────────────────────────────────────── */
  function open(v) {
    var want = !!v;
    setCfg({ bg: { panelOpen: want } }, true); // 显隐也持久化（cfg.bg.panelOpen）
    if (started) { refresh(); if (want) loadList(); }
    return want;
  }
  function toggle() { open(!CORE.load().bg.panelOpen); }
  function startDrag(e) {
    if (pinned || e.button !== 0 || !panel || (e.target.tagName || "").toLowerCase() === "button") return;
    e.preventDefault();
    var c = CORE.load(), x0 = c.panel.x, b0 = c.panel.bottom;
    var sx = e.clientX, sy = e.clientY, moved = false, cur = { x: x0, bottom: b0 };
    var mv = CORE.on(document, "pointermove", function (ev) {
      var nc = CORE.load();
      cur.x = CORE.clamp(x0 + (ev.clientX - sx), 0, Math.max(1, window.innerWidth - 80), nc.panel.x);
      cur.bottom = CORE.clamp(b0 - (ev.clientY - sy), 8, Math.max(9, window.innerHeight - 48), nc.panel.bottom);
      moved = true;
      panel.style.left = cur.x + "px"; panel.style.bottom = cur.bottom + "px";
    });
    var up = CORE.on(document, "pointerup", function () { mv(); up(); if (moved) setCfg({ panel: { x: cur.x, bottom: cur.bottom } }, true); }); // 拖动结束立即落盘
  }

  /* ── 源：clip（IndexedDB）/ url（http/https 白名单）───────────────── */
  function applySource(c) {
    if (!video) return;
    var bg = c.bg;
    token++; // 让旧的异步解析作废
    var mine = token;
    if (bg.kind === "clip") {
      if (!bg.clipId) { clearSrc(); setError("还没选本地视频"); syncPlay(c); return; }
      CORE.objectUrl(bg.clipId).then(function (u) {
        if (mine !== token || !video) return;
        if (!u) { // 记录没了：自动停用并提示（clipId 保留，重传即恢复）
          setError("本地视频记录已丢失"); setCfg({ bg: { enabled: false } }, true);
          toastOnce("本地视频已丢失，请重新上传"); refresh(); return;
        }
        setError(null); useSrc(u, c);
      })["catch"](function (e) {
        if (mine !== token) return;
        warn("读 IndexedDB 失败（配额/被占用？）", e);
        setError("IndexedDB 读取失败"); toastOnce("读本地媒体库失败"); clearSrc();
      });
      return;
    }
    var u = String(bg.url || "").trim();
    if (!validUrl(u)) { // 不合法只提示，不把脏值写回 cfg（不污染配置）
      setError(u ? "URL 未通过协议白名单（仅 http/https）" : "还没填视频 URL");
      if (u) toastOnce("仅支持 http/https 视频直链");
      clearSrc(); syncPlay(c); return;
    }
    setError(null); useSrc(u, c);
  }
  function useSrc(u, c) {
    try { if (video.getAttribute("src") !== u) { video.setAttribute("src", u); video.load(); } } // 同 src 不重载
    catch (e) { warn("设置视频源失败", e); setError("无法设置视频源"); }
    syncPlay(c);
  }
  function clearSrc() {
    try { if (video && video.getAttribute("src")) { video.removeAttribute("src"); video.load(); } } catch (e) { warn("清除视频源失败", e); }
    syncPlay(CORE.load());
  }

  /* ── 播放控制 ───────────────────────────────────────────────────────── */
  function syncPlay(c) {
    if (!video) return;
    if (!c.bg.enabled) { try { video.pause(); } catch (e) {} updatePlayBtn(c); return; } // 停用：pause+隐藏，src/clipId 保留
    if (!video.getAttribute("src")) { updatePlayBtn(c); return; }
    if (c.bg.playing) { if (video.paused || video.ended) attemptPlay(c); }
    else if (!video.paused) { try { video.pause(); } catch (e) {} }
    updatePlayBtn(c);
  }
  function attemptPlay(c) {
    if (!video) return;
    var cc = c || CORE.load();
    video.muted = !!cc.bg.muted || forcedMute;
    var p = null;
    try { p = video.play(); } catch (e) { warn("play() 同步抛错", e); onPlayRejected(e); return; }
    if (!p || !p.then) return;
    p.then(function () { onPlayed(cc); }, onPlayRejected); // Promise 必接失败回调，绝不裸奔
  }
  /** 自动播放策略拒了：非静音就先强制静音重试一次；再失败只更新按钮状态，不抛。 */
  function onPlayRejected(e) {
    if (!video) return;
    if (!video.muted) {
      forcedMute = true; video.muted = true;
      var p2 = null;
      try { p2 = video.play(); } catch (x) { p2 = null; }
      if (p2 && p2.then) p2.then(function () { onPlayed(CORE.load()); }, function (x2) { warn("静音重试仍被拒", x2); afterReject(); });
      else afterReject();
      return;
    }
    warn("play() 被拒", e); afterReject();
  }
  function afterReject() { setError("浏览器拒绝自动播放，点一下「播放」"); updatePlayBtn(CORE.load()); }
  function onPlayed(c) { setError(null); safeRate(c); updatePlayBtn(c); }
  function updatePlayBtn(c) {
    if (refs.playBtn) refs.playBtn.textContent = c.bg.enabled && video && !video.paused ? "暂停" : "播放";
  }

  /* ── 上传 / URL 应用 / 媒体库 ──────────────────────────────────────── */
  function onPick(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = ""; // 允许连续选同一个文件
    if (!f) return;
    if (f.size > MAX_BYTES) { toast("视频超过 240MB，建议先压到 720p"); return; }
    var rec = { id: CORE.mediaId("clip", Date.now()), name: f.name || "clip", type: f.type || "video/mp4", size: f.size, createdAt: Date.now(), blob: f };
    CORE.putMedia(rec).then(function () { // Blob 只进 IndexedDB，绝不进 localStorage
      setCfg({ bg: { kind: "clip", clipId: rec.id, enabled: true, playing: true } }, true);
      toast("已存入本地媒体库：" + rec.name);
      refresh(); loadList();
    })["catch"](function (e2) { warn("写 IndexedDB 失败（多半是配额）", e2); toast("视频保存失败：浏览器存储不可用或已满"); });
  }
  function applyUrl() {
    var raw = String(refs.urlInput.value || "").trim();
    if (!validUrl(raw)) { setError("URL 未通过协议白名单（仅 http/https）"); toast("仅支持 http/https 视频直链"); return; } // 拒绝时不污染 cfg
    setError(null);
    setCfg({ bg: { kind: "url", url: raw, enabled: true, playing: true } }, true);
    refresh();
  }
  function loadList() {
    if (!refs.clipBox) return;
    refs.clipBox.textContent = "";
    CORE.allMedia().then(function (all) {
      if (!refs.clipBox) return;
      var clips = (all || []).filter(function (r) { return r && typeof r.id === "string" && r.id.indexOf("clip:") === 0; });
      clips.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      if (!clips.length) { refs.clipBox.appendChild(CORE.el("div", { "class": "dsh-pet-clip", text: "（媒体库为空）" })); return; }
      for (var i = 0; i < clips.length; i++) renderClip(clips[i]);
    })["catch"](function (e) {
      warn("列媒体库失败", e);
      if (refs.clipBox) { refs.clipBox.textContent = ""; refs.clipBox.appendChild(CORE.el("div", { "class": "dsh-pet-err", text: "（读不到 IndexedDB 媒体库）" })); }
      toastOnce("读本地媒体库失败");
    });
  }
  function renderClip(rec) {
    var nm = rec.name || rec.id;
    var use = CORE.el("button", { type: "button", text: "使用", "aria-label": "使用 " + nm });
    CORE.on(use, "click", function () { setCfg({ bg: { kind: "clip", clipId: rec.id, enabled: true, playing: true } }, true); refresh(); });
    var del = CORE.el("button", { type: "button", text: "删除", "aria-label": "删除 " + nm });
    CORE.on(del, "click", function () { delClip(rec); });
    refs.clipBox.appendChild(CORE.el("div", { "class": "dsh-pet-clip" }, [CORE.el("span", { text: nm, title: nm }), CORE.el("em", { text: fmtSize(rec.size) }), use, del]));
  }
  function delClip(rec) {
    var wasActive = CORE.load().bg.clipId === rec.id;
    CORE.revokeUrl(rec.id); // 先释放内存里的 objectURL，再删记录
    CORE.delMedia(rec.id).then(function () {
      if (wasActive) { setCfg({ bg: { enabled: false, clipId: null } }, true); toast("删的是正在用的视频，已停用背景"); }
      refresh(); loadList();
    })["catch"](function (e) { warn("删除失败", e); toast("删除失败"); });
  }

  /* ── 全量刷新：cfg → DOM（滑块改动、外部 set、resize 都走它）───────── */
  function syncRange(r, value, text) {
    if (!r) return;
    if (document.activeElement !== r.input && parseFloat(r.input.value) !== value) r.input.value = String(value); // 别打断用户拖滑块
    r.val.textContent = text;
  }
  function syncControls(c) {
    if (!refs.enabled) return;
    var bg = c.bg;
    refs.enabled.checked = !!bg.enabled;
    syncRange(refs.rBlur, bg.blur, bg.blur + "px");
    syncRange(refs.rBright, bg.brightness, bg.brightness.toFixed(2));
    syncRange(refs.rSpeed, bg.speed, bg.speed.toFixed(2) + "x");
    syncRange(refs.rVol, bg.volume, bg.volume.toFixed(2));
    if (refs.rVol) refs.rVol.input.disabled = !!bg.muted; // 静音时禁滑但保留显示值
    syncRange(refs.rOpacity, bg.opacity, bg.opacity.toFixed(2));
    refs.mute.checked = !!bg.muted; refs.loop.checked = !!bg.loop;
    refs.segCover.setAttribute("aria-pressed", bg.fit === "cover" ? "true" : "false");
    refs.segContain.setAttribute("aria-pressed", bg.fit === "contain" ? "true" : "false");
    if (document.activeElement !== refs.urlInput) refs.urlInput.value = bg.url || "";
    refs.filterLine.textContent = "生效：blur(" + bg.blur + "px) brightness(" + bg.brightness + ") · opacity " + bg.opacity;
    refs.errLine.textContent = lastError || "";
    updatePlayBtn(c);
  }
  function refresh() {
    if (!started) return;
    if (!layer || !video || !panel) { warn("背景层元素缺失，跳过刷新"); toast("背景层元素丢失"); return; }
    var c = CORE.load(), bg = c.bg;
    // blur 会啃掉画面四边：按半径把层反向外扩（四边同值），blur=0 归 0
    var bleed = bg.blur > 0 ? -Math.round(bg.blur * 1.8) : 0;
    layer.style.top = bleed + "px"; layer.style.right = bleed + "px"; layer.style.bottom = bleed + "px"; layer.style.left = bleed + "px";
    layer.style.display = bg.enabled ? "block" : "none"; // 停用只隐藏，配置与 src 都保留
    video.style.filter = "blur(" + bg.blur + "px) brightness(" + bg.brightness + ")";
    video.style.opacity = String(bg.opacity); video.style.objectFit = bg.fit;
    video.loop = !!bg.loop; video.volume = bg.volume;
    video.muted = !!bg.muted || forcedMute;
    if (bg.muted) forcedMute = false;
    safeRate(c); // 换 src 会把 rate 打回 1，这里与 canplay/loadedmetadata 各补一次
    panel.style.left = c.panel.x + "px"; panel.style.bottom = c.panel.bottom + "px";
    panel.style.display = bg.panelOpen ? "flex" : "none";
    syncControls(c);
    applySource(c);
  }

  /* ── 生命周期 ───────────────────────────────────────────────────────── */
  function start() {
    if (started) { refresh(); return; } // 幂等
    try {
      CORE.css("bg", CSS);
      video = CORE.el("video", { id: "dsh-pet-video-clip", autoplay: "autoplay", playsinline: "playsinline", preload: "auto" });
      layer = CORE.el("div", { id: "dsh-pet-video" }, [video]);
      panel = buildPanel();
      document.body.appendChild(layer); document.body.appendChild(panel); // 都是 body 直接子节点（§2）
      track(CORE.on(video, "loadedmetadata", function () { safeRate(CORE.load()); }));
      track(CORE.on(video, "canplay", function () { // 换 src 后 playbackRate 回 1，这里补设
        var c = CORE.load(); safeRate(c);
        if (c.bg.enabled && c.bg.playing && video.paused) attemptPlay(c);
      }));
      track(CORE.on(video, "error", function () {
        if (!CORE.load().bg.enabled || !video.getAttribute("src")) return;
        setError("视频源加载失败（直链失效 / 格式不支持 / 被 CORS 拦）");
        toast("背景视频加载失败，请检查源"); updatePlayBtn(CORE.load());
      }));
      track(CORE.on(video, "play", function () { updatePlayBtn(CORE.load()); }));
      track(CORE.on(video, "pause", function () { updatePlayBtn(CORE.load()); }));
      track(CORE.on(window, "resize", function () { refresh(); }));
      track(CORE.onBus("panel:toggle", function () { toggle(); })); // 桌宠菜单发来的开合
      // §5：Esc 不关面板（常驻控制台），所以刻意不绑 Esc / 点外关闭监听
      started = true; refresh();
      if (CORE.load().bg.panelOpen) loadList();
    } catch (e) {
      started = false;
      warn("背景模块启动失败", e); toast("背景模块启动失败（详见控制台）");
    }
  }
  function stop() {
    if (!started) return;
    for (var i = 0; i < unbinds.length; i++) { try { unbinds[i](); } catch (e) { /* 一个失败不拖累其它 */ } }
    unbinds = [];
    try { if (video) video.pause(); } catch (e) {}
    try { if (layer && layer.parentNode) layer.parentNode.removeChild(layer); } catch (e) {}
    try { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); } catch (e) {}
    // 故意不 revokeUrl：配置可能马上又开，重开时直接复用内存里的 objectURL
    layer = null; video = null; panel = null; refs = {};
    started = false; token++; setError(null); forcedMute = false;
  }
  function state() {
    var c = CORE.load();
    return {
      videoPresent: !!(started && video && video.getAttribute("src")), // 视频源已挂在层上
      error: lastError, srcKind: c.bg.kind, // srcKind: "clip" | "url"
      running: !!(started && video && c.bg.enabled && !video.paused && !video.ended),
    };
  }

  return { start: start, stop: stop, refresh: refresh, open: open, toggle: toggle, state: state };
})();
