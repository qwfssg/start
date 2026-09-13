/* src/pet.js —— 桌宠引擎：渲染 / 拖动 / 单击反应 / 滚轮缩放 / 右键菜单 / 空闲漫游 / 会话联动。
 *
 * 依赖：全局 CORE（core.js —— 只用 load/set/onBus/emit/el/on/clamp/play/css/LOG）
 *      与全局 SHEET（sheet.js，可能为 null —— 对它的一切访问都容错）。
 * 铁律（DESIGN §1）：浮层全部只 append 到 document.body，用固定 #dsh-pet-* id 和自带
 *      z-index；绝不给宿主容器造层叠上下文，绝不写全后代洗透明。
 * 动画时钟（DESIGN §9）：唯一一条 requestAnimationFrame 主循环，用 performance.now()
 *      推帧，dt 钳到 100ms；document.hidden 时整条链停摆；不用 setInterval 驱动动画。
 * 风格：ES5（var/function），纯 DOM + Canvas，会被拼进 CommonJS factory 闭包。
 */
var PET = (function () {
  'use strict';

  /* ── 常量 ───────────────────────────────────────────────────────────── */
  var NAMES = { idle: 1, wait: 1, walk: 1, react: 1, working: 1, sleep: 1, supervise: 1, dead: 1 };
  var Z_STAGE = 2147483000, Z_MENU = 2147483002; // DESIGN §2（菜单必须浮在控制面板 2147483001 之上）
  var PAD = 1.25;            // 画布 = cell × scale × 1.25：给跳跃/粒子留白，脚底基线仍对齐 cfg.y
  var SCALE_MIN = 0.5, SCALE_MAX = 2.5;
  var WHEEL_STEP = 1.08;
  var MENU_STEP = 1.12;
  var CLICK_SLOP = 4;        // 位移阈值：>4px 判定为拖，否则算单击
  var IDLE_ROAM_MS = 60000;  // 60s 无输入 → 漫游
  var IDLE_SLEEP_MS = 300000;// 300s 无输入 → sleep
  var WORK_DELAY_MS = 1500;  // wait 1.5s → working（需求 2.5 的原话时长）
  var ROAM_SPEED = 34;       // px/s，只走水平线
  /* 统一播放倍率（<1 变慢）。必须同时管帧率和滑步速度：只放慢脚的动作、身体还按
     34px/s 飘，就成了"脚在跑、人在溜冰"，那比单纯快了更不自然。
     控制台可实时试：__DSH_PET_BG__.CORE.set({pet:{fpsScale:0.45}}, true) 然后刷新页面
     默认 1.4（用户反馈"不流畅"提速；真默认值在 core.js sanitize 里也同步成 1.4，
     那边才是配置里没存过 fpsScale 时实际生效的一处）。已存值优先，clamp 0.15~2 不变。 */
  var DEF_FPS_SCALE = 1.4;
  function fpsScale() {
    var p = CORE.load().pet;
    return CORE.clamp(p && typeof p.fpsScale === 'number' ? p.fpsScale : DEF_FPS_SCALE, 0.15, 2, DEF_FPS_SCALE);
  }
  var PH_W = 96, PH_H = 96;  // SHEET 缺失时的占位方块尺寸
  var SIZE_CYCLE = [0.75, 1, 1.25, 1.5];
  var DEF_X = 0.86, DEF_Y = 0.82; // 「重置位置」回到 core 默认
  var BUBBLE_DEFAULT_MS = 4000;

  /* ── 模块状态 ───────────────────────────────────────────────────────── */
  var running = false;
  var stage = null, canvas = null, ctx = null, bubbleEl = null;
  var nudge = null, menuEl = null;
  var img = null, imgOk = false, cells = null, cellCount = 0; // cells：离屏预切帧缓存
  /* 第二阶段：高清外挂图集（同源 /pet-assets）。hd 非空即表示已热切换到高清版；
   * hdPhase: init(还没试) | loading(在取) | hd(生效中) | embedded(内嵌，失败原因在 hdWhy)。
   * hdTried 保证一次页面生命周期只下载一次（HMR/重启桌宠不重复拉 9MB）；
   * blob URL 刻意不 revoke —— 它就是当前生效的图集，页面活着就要用。 */
  var hd = null, hdPhase = 'init', hdWhy = '', hdTried = false;
  var rafId = 0, lastTs = 0;
  var timers = {};           // key -> 计时器 id；stop() 全部清掉
  var unsubs = [];           // 解绑函数集合
  var menuUnsubs = [];       // 只在菜单存续期内有效
  var reducedMotion = false;
  var dpr = 1;

  var st = { name: 'idle', since: 0 }; // since 用虚拟时钟（nowMs）基准
  var pendingAfter = null;             // react 放完后回哪儿（点击打断 working → 回 working）
  var idleAt = 0;                      // 最近一次「输入」时刻：漫游/睡眠计时基准
  var roam = null;                     // { phase:'walk'|'pause', target, until }
  var roamCooldownUntil = 0;           // 漫游轮次之间的冷却；绝不动 idleAt（否则 300s 睡眠永远到不了）
  var menuAnchor = { x: 0, y: 0 };     // 菜单打开点，外部改配置时原位重绘
  var drag = null;                     // { id, sx, sy, fx0, fy0, moved, faceAtEnd }
  var shake = { until: 0, amp: 8, dur: 420 }; // notify('error') 的水平抖动
  var bubbleForever = false;           // bubble(text, 0) 常驻
  var drawWarned = false;
  var helloPlayed = false;             // 启动保持安静：hello 音效只在召唤时响（严格模式必须先声明）

  /* ── 小工具 ─────────────────────────────────────────────────────────── */
  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch (err) { /* 用 Date 兜底 */ }
    return Date.now();
  }
  function warn(msg, err) { console.warn(CORE.LOG + ' ' + msg, err); }
  function setTracked(key, fn, ms) {
    clearTracked(key);
    timers[key] = setTimeout(function () {
      delete timers[key];
      try { fn(); } catch (err) { warn('定时任务抛错：', err); }
    }, ms);
  }
  function clearTracked(key) {
    if (timers[key] !== undefined) { clearTimeout(timers[key]); delete timers[key]; }
  }
  function clearAllTimers() {
    for (var k in timers) if (Object.prototype.hasOwnProperty.call(timers, k)) clearTracked(k);
  }
  function bind(target, type, fn, opts) { // 统一登记，stop() 里一次解绑
    try { unsubs.push(CORE.on(target, type, fn, opts)); } catch (err) { warn('事件绑定失败：', err); }
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function isPos(n) { return isNum(n) && n > 0; }
  function isU0(n) { return isNum(n) && n >= 0; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function vw() { return Math.max(1, (typeof window !== 'undefined' && window.innerWidth) || 1200); }
  function vh() { return Math.max(1, (typeof window !== 'undefined' && window.innerHeight) || 800); }
  function dprVal() { return CORE.clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2, 1); } // 上限 2
  function petCfg() { return CORE.load().pet; } // 每次现取：set() 之后镜像会换引用，缓存会过期

  /* ── SHEET 读取：meta 缺什么字段都不许炸 ───────────────────────────────
   * 现在有两套素材：SHEET（client.js 内嵌的 162 帧，永远可用，是回退底座）与
   * hd（/pet-assets 外挂的 319 帧高清版，取到且校验通过才存在）。
   * sheetData() 一律返回"当前生效的那套"，所以 cellMeta/stateDef/buildCells/geometry
   * 全都不用关心来源；两套的 display 都是 192×224 ⇒ 元素恒为 240×280，切换零跳变。 */
  function embeddedSheet() {
    try { return (typeof SHEET !== 'undefined' && SHEET && typeof SHEET === 'object') ? SHEET : null; }
    catch (err) { return null; }
  }
  function sheetData() {
    if (hd && hd.meta) return hd;
    return embeddedSheet();
  }
  function hdRev() { // 构建期常量（tools/embed-sheet.mjs 写进 src/sheet.js）；老包里没有 ⇒ null
    try { return (typeof SHEET_HD !== 'undefined' && SHEET_HD && typeof SHEET_HD === 'object') ? SHEET_HD : null; }
    catch (err) { return null; }
  }
  function countFrames(s) {
    var n = 0, m = s && s.meta && s.meta.states;
    if (m) for (var k in m) {
      if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
      var f = m[k] && m[k].frames;
      if (Array.isArray(f)) n += f.length;
    }
    return n;
  }
  function sheetSource() { // 右键菜单状态项 / console 一行都用它
    if (hdPhase === 'hd') return '高清外挂 ' + countFrames(hd) + '帧';
    if (hdPhase === 'loading') return '内嵌（取高清中…）';
    var n = countFrames(embeddedSheet());
    return n ? '内嵌 ' + n + '帧' + (hdRev() ? '（待重启）' : '') : '内嵌';
  }
  function sheetTitle() {
    var s = sheetData(), m = s && s.meta;
    var t = (m && m.cell) ? '图集 ' + (m.cols * m.cell.w) + '×' + (m.rows * m.cell.h) + '，cell ' + m.cell.w + '×' + m.cell.h + '，' + countFrames(s) + ' 帧' : '无图集（占位方块）';
    t += hdPhase === 'hd' ? '，来源 /pet-assets' : '，来源 client.js 内嵌';
    if (hdPhase !== 'hd' && hdWhy) t += '。高清外挂不可用：' + hdWhy;
    return t;
  }
  function cellMeta() {
    var s = sheetData();
    var m = s && s.meta;
    var c = m && m.cell;
    if (!c || !isPos(c.w) || !isPos(c.h)) return null;
    var a = (m.anchor && typeof m.anchor === 'object') ? m.anchor : {};
    // anchor 允许两种写法：像素值，或 0..1 的 cell 内比例（真实 sheet.js 是 {x:0.5,y:1}）。
    // 判定规则：值在 [0,1] 区间即视为比例（锚在 0~1px 边缘的精灵不存在）。
    function px(v, span, fb) { return isNum(v) ? (v >= 0 && v <= 1 ? v * span : v) : fb; }
    var axPx = px(a.x, c.w, c.w / 2);
    var aySrc = isNum(m.baselineY) ? m.baselineY : px(a.y, c.h, c.h); // 脚底基线优先取 baselineY（像素行）
    // 显示尺寸补偿：图集格子变小（192x224 → 112x150）后，meta.display 声明「显示用 cell 尺寸」，
    // 元素宽高精确回到基线（240×280 含 PAD），精灵按 cell 纵横比 uniform 放大（内容高≈176 CSS px，
    // 无形变）。旧图集没有 display 字段 → 回落 cell×displayScale（缺省 1），行为与旧版完全一致。
    var dsp = (m.display && typeof m.display === 'object') ? m.display : null;
    var dsv = m.displayScale;
    var ds = (typeof dsv === 'number' && dsv > 0) ? dsv : 1;
    return {
      cw: c.w,
      ch: c.h,
      ax: CORE.clamp(axPx, 0, c.w, c.w / 2),
      ay: CORE.clamp(aySrc, 0, c.h, c.h),
      ds: ds,
      dspW: isPos(dsp && dsp.w) ? dsp.w : c.w * ds,
      dspH: isPos(dsp && dsp.h) ? dsp.h : c.h * ds,
    };
  }
  function stateDef(name) {
    var d = { fps: 6, loop: true, pingpong: false, mirrorable: false, facing: 'right', next: 'idle', frames: null };
    if (name === 'walk') { d.fps = 10; d.mirrorable = true; }
    else if (name === 'react') { d.fps = 10; d.loop = false; }
    else if (name === 'sleep') d.fps = 2;
    else if (name === 'working') d.fps = 7;
    else if (name === 'wait') d.fps = 5;
    else if (name === 'supervise') d.fps = 7;
    else if (name === 'dead') d.fps = 8;
    var s = sheetData();
    var def = s && s.meta && s.meta.states && s.meta.states[name];
    if (def && typeof def === 'object') {
      if (isPos(def.fps)) d.fps = CORE.clamp(def.fps * fpsScale(), 0.2, 60, d.fps);
      if (typeof def.loop === 'boolean') d.loop = def.loop;
      if (typeof def.pingpong === 'boolean') d.pingpong = def.pingpong;
      if (typeof def.mirrorable === 'boolean') d.mirrorable = def.mirrorable;
      if (def.facing === 'left' || def.facing === 'right') d.facing = def.facing;
      if (typeof def.next === 'string' && NAMES[def.next]) d.next = def.next;
      if (Array.isArray(def.frames) && def.frames.length) {
        var out = [];
        for (var i = 0; i < def.frames.length; i++) {
          var f = def.frames[i];
          if (Array.isArray(f) && f.length >= 2 && isU0(f[0]) && isU0(f[1])) out.push([f[0], f[1]]);
        }
        if (out.length) d.frames = out; // 全非法就留给下面的兜底
      }
    }
    if (!d.frames) d.frames = [[0, 0]]; // frames 缺失/为空：单帧占位
    return d;
  }

  /* ── 离屏预切帧缓存 ───────────────────────────────────────────────────
   * 两种做法都行，这里选预切：图集是 8×5=40 个 cell，一次性各画到一张 cell
   * 大小的小 canvas 上缓存，之后每帧只画小图。避免每帧对大图集算源矩形时
   * 非整数源坐标在不同浏览器取整不一致，造成的 1px 缩放抖动。 */
  function buildCells() {
    cells = {};
    cellCount = 0;
    if (!imgOk) return;
    var cm = cellMeta();
    var s = sheetData();
    if (!cm || !s || !s.meta) return;
    var cols = CORE.clamp(s.meta.cols, 1, 64, 8);
    var rows = CORE.clamp(s.meta.rows, 1, 64, 5);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var oc = document.createElement('canvas');
        oc.width = cm.cw;
        oc.height = cm.ch;
        var octx = oc.getContext('2d');
        if (octx) {
          try { octx.drawImage(img, c * cm.cw, r * cm.ch, cm.cw, cm.ch, 0, 0, cm.cw, cm.ch); }
          catch (err) { warn('预切 cell(' + c + ',' + r + ') 失败：', err); }
        }
        cells[c + ',' + r] = oc;
        cellCount++;
      }
    }
  }
  /* 画哪套素材由调用方指定（data: 内嵌 或 blob: 外挂都收）。onload 里补一次 layout()：
   * 热切换到高清时 cellMeta 换了引用，虽然 display 相同（元素尺寸不变），也要重排一遍才稳。 */
  function paintFrom(s) {
    if (!s || typeof s.dataUrl !== 'string') return; // 占位方块模式
    if (s.dataUrl.indexOf('data:') !== 0 && s.dataUrl.indexOf('blob:') !== 0) return;
    try {
      var im = new Image();
      im.onload = function () { img = im; imgOk = true; buildCells(); if (running) { layout(); drawFrameNow(); } };
      im.onerror = function (e) { if (img === im) { imgOk = false; cells = null; cellCount = 0; } warn('精灵图解码失败，降级为占位方块：', e); if (running) drawFrameNow(); };
      im.src = s.dataUrl;
    } catch (err) { warn('精灵图创建失败：', err); }
  }
  function loadSprite() {
    /* 先用"当前生效的那套"立刻画出来（内嵌版零延迟，绝不白屏、绝不让桌宠消失），
     * 再异步去试高清外挂，成功才热切换。宿主重启前路由是 404 ⇒ 这条回退路径是硬要求。 */
    paintFrom(sheetData());
    tryHd();
  }

  /* ── 高清外挂图集：优先 /pet-assets，任一环节失败静默回退内嵌 ─────────────
   * 失败面（全部静默，只在 console 留一行 info，不弹窗不白屏）：404 / 网络错 / 超时 /
   * JSON 解析失败 / JSON 形状不对 / sheetHash 与构建期常量不符 / PNG 摘要不符 /
   * 字节数不符 / 图像解码失败 / 解码尺寸与 meta 不符。
   * ?v= 用**内容哈希**而不是时间戳：路由发的是 immutable,max-age=31536000，
   * 只有内容哈希能真正让它失效（换素材后浏览器才不会永远用旧图）。 */
  var HD_TIMEOUT_MS = 8000;
  function hdFail(why) {
    hd = null; hdPhase = 'embedded'; hdWhy = why || '?';
    try { console.info(CORE.LOG + ' 素材：' + sheetSource() + '（高清外挂不可用：' + hdWhy + '）'); } catch (err) { /* noop */ }
    if (running && menuEl) openMenu(menuAnchor.x, menuAnchor.y); // 菜单开着就把状态项文案刷成回退
  }
  function hdCommit(meta, url, im, bytes) {
    hd = { meta: meta, dataUrl: url, embedded: false, pngBytes: bytes };
    hdPhase = 'hd'; hdWhy = '';
    img = im; imgOk = true; cells = null; cellCount = 0;
    buildCells();
    try {
      console.info(CORE.LOG + ' 素材：' + sheetSource() + ' 图集 ' + (meta.cols * meta.cell.w) + '×' + (meta.rows * meta.cell.h)
        + '（' + (bytes / 1048576).toFixed(2) + 'MB，来源 /pet-assets，预切 ' + cellCount + ' 格 ≈'
        + (cellCount * meta.cell.w * meta.cell.h * 4 / 1048576).toFixed(0) + 'MB 离屏内存）');
    } catch (err) { /* noop */ }
    if (running) { layout(); drawFrameNow(); if (menuEl) openMenu(menuAnchor.x, menuAnchor.y); }
  }
  function fetchSoft(url, ms) { // 永不 reject：超时/网络错/无 fetch 都 resolve(null)
    return new Promise(function (resolve) {
      var done = false, ac = null;
      try { if (typeof AbortController === 'function') ac = new AbortController(); } catch (err) { ac = null; }
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ac) ac.abort(); } catch (err) { /* 尽力 */ }
        resolve(null);
      }, ms);
      var p = null;
      try {
        /* 刻意**不**传 cache:'no-cache'：路由发的是 immutable,max-age=31536000，
         * 'no-cache' 会强制每次刷新都回源重传 9MB。失效靠 URL 里的 ?v=<内容哈希>，
         * 内容一变 URL 就变，所以走默认缓存模式既安全又省流量。 */
        p = (typeof fetch === 'function')
          ? fetch(url, ac ? { signal: ac.signal, credentials: 'same-origin' } : { credentials: 'same-origin' })
          : null;
      } catch (err) { p = null; }
      if (!p || typeof p.then !== 'function') { clearTimeout(t); if (!done) { done = true; resolve(null); } return; }
      p.then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
        function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  }
  function hexOf(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function hdMetaBad(m, rev) { // 返回空串=形状合格；否则返回原因
    if (!m || typeof m !== 'object') return 'meta 非对象';
    if (!m.cell || !isPos(m.cell.w) || !isPos(m.cell.h)) return 'meta.cell 缺失';
    if (!isPos(m.cols) || !isPos(m.rows)) return 'meta.cols/rows 缺失';
    if (!m.states || typeof m.states !== 'object') return 'meta.states 缺失';
    var n = 0;
    for (var k in m.states) if (Object.prototype.hasOwnProperty.call(m.states, k) && NAMES[k]) n++;
    if (!n) return 'meta.states 无白名单状态';
    if (typeof m.sheetHash !== 'string' || m.sheetHash.length < 16) return 'meta.sheetHash 缺失';
    if (rev && rev.pngSha256 && m.sheetHash.toLowerCase() !== String(rev.pngSha256).toLowerCase()) return 'sheetHash 与构建期常量不符（png/json 版本错配）';
    return '';
  }
  function hdDigestOk(buf, meta, rev) {
    if (rev && isPos(rev.pngBytes) && buf.byteLength !== rev.pngBytes) return Promise.reject(new Error('图集字节数 ' + buf.byteLength + '≠' + rev.pngBytes));
    var sub = null;
    try { if (typeof crypto !== 'undefined' && crypto && crypto.subtle && typeof crypto.subtle.digest === 'function') sub = crypto.subtle; } catch (err) { sub = null; }
    if (!sub) return Promise.resolve(false); // 非安全上下文没有 subtle：跳过摘要（仍有字节数+形状+解码尺寸三重校验）
    return sub.digest('SHA-256', buf).then(function (d) {
      var got = hexOf(d), want = String(meta.sheetHash).toLowerCase();
      if (got !== want) throw new Error('图集摘要不符 ' + got.slice(0, 8) + '≠' + want.slice(0, 8));
      return true;
    }, function () { return false; }); // 摘要本身算不出来（不太可能）就不拦
  }
  function hdDecode(meta, buf) { // blob → Image，尺寸对得上才算成功
    return new Promise(function (resolve, reject) {
      var url = '';
      try { url = URL.createObjectURL(new Blob([buf], { type: 'image/png' })); } catch (err) { return reject(new Error('blob URL 建不起来')); }
      var drop = function () { try { URL.revokeObjectURL(url); } catch (err) { /* noop */ } };
      var im;
      try { im = new Image(); } catch (err) { drop(); return reject(new Error('Image 构造失败')); }
      var settled = false;
      var guard = setTimeout(function () { if (!settled) { settled = true; drop(); reject(new Error('解码超时')); } }, HD_TIMEOUT_MS);
      im.onload = function () {
        if (settled) return;
        settled = true; clearTimeout(guard);
        var ew = meta.cols * meta.cell.w, eh = meta.rows * meta.cell.h;
        if (im.width !== ew || im.height !== eh) { drop(); return reject(new Error('解码尺寸 ' + im.width + '×' + im.height + '≠meta ' + ew + '×' + eh)); }
        hdCommit(meta, url, im, buf.byteLength);
        resolve(true);
      };
      im.onerror = function () { if (settled) return; settled = true; clearTimeout(guard); drop(); reject(new Error('图像解码失败')); };
      im.src = url;
    });
  }
  function tryHd() {
    var rev = hdRev();
    if (!rev || !rev.png || !rev.json) { if (hdPhase === 'init') { hdPhase = 'embedded'; hdWhy = '包内无外挂产物'; } return; }
    if (hdTried || hdPhase === 'hd') return;
    hdTried = true;
    hdPhase = 'loading'; hdWhy = '';
    var base = (typeof rev.base === 'string' && rev.base) ? rev.base : '/pet-assets';
    var jsonUrl = base + '/' + rev.json + '?v=' + encodeURIComponent(rev.jsonRev || '');
    var pngUrl = base + '/' + rev.png + '?v=' + encodeURIComponent(rev.pngRev || '');
    fetchSoft(jsonUrl, HD_TIMEOUT_MS).then(function (r) {
      if (!r) throw new Error('meta 请求超时/网络错');
      if (!r.ok) throw new Error('meta http ' + r.status);
      if (typeof r.json !== 'function') throw new Error('meta 响应不可解析');
      return r.json();
    }).then(function (meta) {
      var bad = hdMetaBad(meta, rev);
      if (bad) throw new Error(bad);
      return fetchSoft(pngUrl, HD_TIMEOUT_MS).then(function (r2) {
        if (!r2) throw new Error('图集请求超时/网络错');
        if (!r2.ok) throw new Error('图集 http ' + r2.status);
        if (typeof r2.arrayBuffer !== 'function') throw new Error('图集响应不可读');
        return r2.arrayBuffer();
      }).then(function (buf) {
        if (!buf || !buf.byteLength) throw new Error('图集空响应');
        return hdDigestOk(buf, meta, rev).then(function () { return hdDecode(meta, buf); });
      });
    }).then(function () { /* hdDecode 内部已提交 */ },
      function (err) { hdFail(err && err.message ? err.message : String(err)); });
  }

  /* ── 几何：锚点 = 脚底中心 ───────────────────────────────────────────── */
  function geometry(scale) {
    var m = cellMeta();
    var cw, ch, ax, ay, dspW, dspH;
    if (m) { cw = m.cw; ch = m.ch; ax = m.ax; ay = m.ay; dspW = m.dspW; dspH = m.dspH; }
    else { cw = PH_W; ch = PH_H; ax = cw / 2; ay = ch; dspW = cw; dspH = ch; } // 占位方块：底部中心即脚底
    var dh = dspH * scale;       // 绘制高 = 显示 cell 高 × 用户缩放
    var dw = dh * (cw / ch);     // 绘制宽按 cell 纵横比走：uniform 放大，绝不拉变形
    var W = dspW * scale * PAD, H = dh * PAD;
    var x0 = (W - dw) / 2, y0 = H - dh; // 25% 留白全放头顶（跳跃/粒子）
    var k = dh / ch;             // cell px → CSS px（锚点换算用同一系数，保证脚底像素级对准）
    return { cw: cw, ch: ch, ax: ax, ay: ay, dw: dw, dh: dh, W: W, H: H, x0: x0, y0: y0, bx: x0 + ax * k, by: y0 + ay * k };
  }
  function footPx() {
    var p = petCfg();
    return { x: p.x * vw(), y: p.y * vh() };
  }
  function layout() { // 按当前配置重排舞台/画布/圆点的像素位置（不写存储）
    var p = petCfg();
    var g = geometry(p.scale);
    dpr = dprVal();
    if (canvas) {
      canvas.width = Math.max(1, Math.round(g.W * dpr));  // 物理像素
      canvas.height = Math.max(1, Math.round(g.H * dpr));
      canvas.style.width = g.W + 'px';                    // CSS 尺寸 = 逻辑尺寸
      canvas.style.height = g.H + 'px';
    }
    var f = footPx();
    if (stage) {
      stage.style.width = g.W + 'px';
      stage.style.height = g.H + 'px';
      stage.style.left = Math.round(f.x - g.bx) + 'px';   // 让脚底锚点精确落在 cfg.x/y
      stage.style.top = Math.round(f.y - g.by) + 'px';
      stage.style.display = p.hidden ? 'none' : '';
    }
    if (nudge) {
      nudge.style.display = p.hidden ? '' : 'none';
      nudge.style.left = Math.round(f.x - 8) + 'px';      // 16px 圆点对准脚底
      nudge.style.top = Math.round(f.y - 8) + 'px';
    }
  }

  /* ── 状态机 ───────────────────────────────────────────────────────────
   * 优先级：react > (wait|working 由会话事件驱动) > 菜单指定 > 漫游/空闲。
   * 强制切换走 setState(name,{force:true})；单次动画播放中拒绝普通切换。 */
  function busyLocked() { return st.name === 'working' || st.name === 'wait'; }
  function enterState(name) { st.name = name; st.since = nowMs(); }
  function setState(name, opts) {
    opts = opts || {};
    if (!NAMES[name]) name = 'idle';
    var now = nowMs();
    var cur = stateDef(st.name);
    if (st.name === 'react' && !cur.loop && !opts.force && now - st.since < cur.frames.length / cur.fps * 1000) {
      return st.name; // 单次动画播放中：普通切换忽略，force 可打断
    }
    if (!opts.force && busyLocked() && (name === 'idle' || name === 'sleep' || (name === 'walk' && !drag))) {
      return st.name; // working/wait 不接受空闲漫游与 sleep 的自动抢占
    }
    if (name === 'react' && busyLocked()) pendingAfter = st.name; // 点击打断：打完回原状态
    if (name !== 'react') pendingAfter = null;
    if (name !== 'walk' && name !== 'sleep') stopRoam();
    enterState(name);
    drawFrameNow();
    return st.name;
  }
  function state() { return st.name; }
  function advanceOneShot(now, def) { // react 播完：next（缺省 idle），或被 pendingAfter 劫持
    if (now - st.since < def.frames.length / def.fps * 1000) return;
    var target = pendingAfter && NAMES[pendingAfter] ? pendingAfter : (NAMES[def.next] ? def.next : 'idle');
    pendingAfter = null;
    enterState(target);
  }
  function frameIndex(def, t) {
    var n = def.frames.length;
    if (n <= 1 || reducedMotion) return 0; // 减弱动效：静止在首帧
    var i = Math.floor((t / 1000) * def.fps);
    if (def.pingpong && n > 1) {
      var period = 2 * (n - 1);
      var m = ((i % period) + period) % period;
      return m < n - 1 ? m : period - m;   // 三角波往复
    }
    return ((i % n) + n) % n;
  }

  /* ── 会话联动（notify）───────────────────────────────────────────────── */
  function notify(phase) {
    if (!running) return;
    if (phase === 'start' || phase === 'message') {
      markActivity();
      setState('wait', { force: true });
      setTracked('work', function () { // 单一计时器：重复 notify 重置，绝不堆积
        if (st.name === 'wait') setState('working', { force: true });
      }, WORK_DELAY_MS);
    } else if (phase === 'end') {
      clearTracked('work');
      if (st.name === 'working' || st.name === 'wait') {
        pendingAfter = null; // 庆祝完回 idle，不回 working
        enterState('react');
        CORE.play('done');
        bubble('搞定 ✅', 3200);
      }
    } else if (phase === 'error') {
      shake.until = nowMs() + shake.dur; // 一小段水平偏移抖一下，不引库
      bubble('出错了 ❌ 看看日志', 4000);
    }
  }

  /* ── 气泡 ───────────────────────────────────────────────────────────── */
  function bubble(text, ms) {
    if (!bubbleEl) return;
    if (!isNum(ms)) ms = BUBBLE_DEFAULT_MS;
    clearTracked('bubble');
    if (!text) { bubbleEl.style.display = 'none'; bubbleEl.textContent = ''; bubbleForever = false; return; }
    bubbleEl.textContent = String(text); // CSS 负责换行（max-width + white-space:normal）
    bubbleEl.style.display = '';
    if (ms > 0) { bubbleForever = false; setTracked('bubble', function () { bubbleEl.style.display = 'none'; }, ms); }
    else bubbleForever = true; // 0 = 常驻，直到下一次 bubble
  }

  /* ── 输入活动：唤醒 + 漫游/睡眠计时 ─────────────────────────────────── */
  function markActivity() {
    idleAt = nowMs();
    if (st.name === 'sleep') enterState('idle'); // 任何 pointer/wheel/键盘输入立即唤醒
  }
  function stopRoam() {
    if (!roam) return;
    roam = null;
    var p = petCfg();
    if (st.name === 'walk' && !drag && !busyLocked()) enterState('idle');
    try { CORE.set({ pet: { x: p.x, facing: p.facing } }, true); } catch (err) { warn('漫游落盘失败：', err); } // 停哪儿存哪儿
  }
  function pickTarget(from) { // 随机取 0.04..0.96，至少走 40px，否则这轮不出门
    for (var i = 0; i < 6; i++) {
      var t = rand(0.04, 0.96);
      if (Math.abs(t - from) * vw() > 40) return t;
    }
    return null;
  }
  function startRoam() {
    var p = petCfg();
    var t = pickTarget(p.x);
    if (t === null) { roamCooldownUntil = nowMs() + 20000; return; } // 离边界太近：过会儿再试
    roam = { phase: 'walk', target: t, until: 0 };
    p.facing = t > p.x ? 'right' : 'left';
    enterState('walk');
  }
  function tickRoam(now, dt) {
    if (!roam) return;
    var p = petCfg();
    if (roam.phase === 'pause') {
      if (now < roam.until) return;
      if (Math.random() < 0.7) { // 到位停一停之后，可能再走一段
        var t2 = pickTarget(p.x);
        if (t2 === null) { stopRoam(); roamCooldownUntil = now + rand(15000, 45000); return; } // 绝不动 idleAt：睡眠计时以真实输入为准
        roam.target = t2;
        roam.phase = 'walk';
        p.facing = t2 > p.x ? 'right' : 'left';
        enterState('walk');
      } else {
        stopRoam();
        roamCooldownUntil = now + rand(15000, 45000); // 本轮自由行动结束；睡眠计时仍以真实输入时刻算
      }
      return;
    }
    // 只走水平：x 变 y 不变（它自己那条地面线）
    var dir = roam.target > p.x ? 1 : -1;
    var step = ROAM_SPEED * fpsScale() * Math.min(dt, 100) / 1000; // px/帧；滑步与脚步同一倍率，dt 已被钳到 100ms，不设每帧下限（60fps 下限会放大速度）
    var remain = (roam.target - p.x) * vw() * dir;                 // 剩余距离（px，恒正）
    if (remain <= step) p.x = roam.target;
    else p.x = CORE.clamp(dir > 0 ? p.x + step / vw() : p.x - step / vw(), 0, 1, p.x); // 改的是 CORE.load() 镜像，落盘在到位时做
    p.facing = dir > 0 ? 'right' : 'left';
    layout();
    if (remain <= step) {
      roam.phase = 'pause';
      roam.until = now + rand(1200, 3500); // 随机停 1.2–3.5s 播一轮 idle
      try { CORE.set({ pet: { x: p.x } }, false); } catch (err) { warn('漫游写回失败：', err); }
      enterState('idle');
    }
  }
  function shakeOffset(now) {
    if (!shake.until || now >= shake.until) return 0;
    return Math.sin(now / 18) * shake.amp * ((shake.until - now) / shake.dur);
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */
  function drawStateAt(now) {
    if (!canvas || !ctx) return;
    var p = petCfg();
    var g = geometry(p.scale);
    var def = stateDef(st.name);
    var idx = frameIndex(def, Math.max(0, now - st.since));
    dpr = dprVal();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 每帧设置，顺带抗外部重置
    ctx.clearRect(0, 0, g.W, g.H);
    var ox = shakeOffset(now);
    ctx.save();
    if (ox) ctx.translate(ox, 0);
    var drawn = false;
    if (imgOk && cells && cellCount > 0) {
      var f = def.frames[idx] || [0, 0];
      var c = cells[f[0] + ',' + f[1]];
      if (c) {
        var mirror = false; // 图集只存一个朝向时，靠 ctx.scale(-1,1) 换向（主要给 walk）
        if (def.mirrorable) mirror = def.facing === 'right' ? p.facing === 'left' : p.facing !== 'left';
        try {
          if (mirror) {
            ctx.save();
            ctx.translate(g.x0 + g.dw, g.y0);
            ctx.scale(-1, 1);
            ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, g.dw, g.dh);
            ctx.restore();
          } else {
            ctx.drawImage(c, 0, 0, c.width, c.height, g.x0, g.y0, g.dw, g.dh);
          }
          drawn = true;
        } catch (err) { if (!drawWarned) { drawWarned = true; warn('帧绘制失败：', err); } }
      }
    }
    if (!drawn) drawPlaceholder(g);
    ctx.restore();
  }
  function drawPlaceholder(g) {
    var k = g.dw / 96; // 随缩放粗调线宽/虚线/字号
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([Math.max(4, 6 * k), Math.max(3, 5 * k)]);
    ctx.lineWidth = Math.max(1, 2 * k);
    ctx.strokeStyle = 'rgba(127,127,127,.8)';
    ctx.strokeRect(g.x0 + ctx.lineWidth, g.y0 + ctx.lineWidth, Math.max(2, g.dw - 2 * ctx.lineWidth), Math.max(2, g.dh - 2 * ctx.lineWidth));
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(127,127,127,.95)';
    ctx.font = Math.max(10, Math.round(12 * k)) + 'px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try { ctx.fillText(cellMeta() ? '精灵图未就绪' : '未内嵌精灵图集', g.W / 2, g.H / 2); } catch (err) { /* 画不出字就算了，不抛 */ }
  }
  function drawFrameNow() {
    if (!running || !ctx) return;
    try { drawStateAt(nowMs()); } catch (err) { warn('绘制抛错：', err); }
  }

  /* ── 唯一主循环 ─────────────────────────────────────────────────────── */
  function frame() {
    if (!running) { rafId = 0; return; }
    rafId = requestAnimationFrame(frame);
    try { tick(nowMs()); } catch (err) { warn('主循环抛错：', err); }
  }
  function tick(now) {
    if (typeof document !== 'undefined' && document.hidden) return;
    var dt = lastTs ? CORE.clamp(now - lastTs, 0, 100, 0) : 16; // 恢复时不用巨大 dt 跳帧
    lastTs = now;
    var def = stateDef(st.name);
    if (st.name === 'react' && !def.loop) advanceOneShot(now, def);
    var p = petCfg();
    var idleFor = now - idleAt;
    if (!busyLocked() && st.name !== 'sleep') {
      if (!roam && !drag && !reducedMotion && st.name === 'idle' && p.roam && !p.locked && idleFor > IDLE_ROAM_MS && now >= roamCooldownUntil) startRoam();
      if (!reducedMotion && idleFor > IDLE_SLEEP_MS) { stopRoam(); enterState('sleep'); } // 睡觉不许顺路漫游
    }
    tickRoam(now, dt);
    drawStateAt(now);
  }
  function startRaf() {
    if (typeof document !== 'undefined' && document.hidden) return; // 舞台不可见/标签页隐藏 → 不跑
    if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(frame); }
  }
  function stopRaf() {
    if (rafId) { try { cancelAnimationFrame(rafId); } catch (err) { /* 尽力而为 */ } rafId = 0; }
  }
  function onVisibility() {
    if (!running) return;
    if (document.hidden) { stopRaf(); return; }
    startRaf();
    drawFrameNow(); // 隐藏期间的重算补一次绘制
  }

  /* ── 指针交互：拖动 / 单击 ───────────────────────────────────────────── */
  function onPointerDown(ev) {
    if (!canvas) return;
    markActivity();
    if (ev.button !== undefined && ev.button !== 0) return; // 右键走 contextmenu
    var p = petCfg();
    drag = { id: ev.pointerId, sx: ev.clientX || 0, sy: ev.clientY || 0, fx0: p.x * vw(), fy0: p.y * vh(), moved: false, faceChanged: false };
    try {
      if (ev.pointerId !== undefined && canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    } catch (err) { /* 假 DOM / 老环境：window 侧兜底监听已经绑好了 */ }
  }
  function onPointerMove(ev) {
    if (!drag || (ev.pointerId !== undefined && drag.id !== undefined && ev.pointerId !== drag.id)) return;
    markActivity();
    var dx = (ev.clientX || 0) - drag.sx;
    var dy = (ev.clientY || 0) - drag.sy;
    if (!drag.moved) {
      if (petCfg().locked) return; // 锁定：永不进拖拽（单击仍然有 react）
      if (Math.abs(dx) < CLICK_SLOP && Math.abs(dy) < CLICK_SLOP) return; // 位移超过 4px 判定为拖
      drag.moved = true;
      if (!busyLocked()) enterState('walk'); // working/wait 期间只挪位置不换状态
    }
    var nx = CORE.clamp((drag.fx0 + dx) / vw(), 0, 1, 0);
    var ny = CORE.clamp((drag.fy0 + dy) / vh(), 0, 1, 0);
    if (Math.abs(dx) > 2) { // facing 跟随水平移动方向
      var want = dx >= 0 ? 'right' : 'left';
      var cp = petCfg();
      if (cp.facing !== want) { cp.facing = want; drag.faceChanged = true; }
    }
    var q = petCfg();
    var changed = q.x !== nx || q.y !== ny;
    q.x = nx;
    q.y = ny; // 比例坐标（÷innerWidth/innerHeight）+ clamp 0..1
    layout();
    if (changed || drag.faceChanged) {
      try { CORE.set({ pet: { x: nx, y: ny, facing: petCfg().facing } }, false); } catch (err) { warn('拖拽写回失败：', err); } // 靠 set 自带的 debounce 落盘
    }
  }
  function onWinPointerMove(ev) { // 真环境 capture 后事件冒泡到 window：目标已是 canvas 就不再处理（canvas 侧刚算过）
    if (ev && ev.target === canvas) return;
    onPointerMove(ev);
  }
  function onWinPointerUp(ev) {
    if (ev && ev.target === canvas) return;
    onPointerUp(ev);
  }
  function onPointerUp(ev) {
    if (!drag || (ev.pointerId !== undefined && drag.id !== undefined && ev.pointerId !== drag.id)) return;
    var d = drag;
    drag = null;
    try { if (canvas && canvas.releasePointerCapture && d.id !== undefined && canvas.hasPointerCapture && canvas.hasPointerCapture(d.id)) canvas.releasePointerCapture(d.id); } catch (err) { /* 算了 */ }
    var p = petCfg();
    if (!d.moved) { singleClick(); return; } // 未超阈值：判定为单击
    markActivity();
    try { CORE.set({ pet: { x: p.x, y: p.y, facing: p.facing } }, true); } catch (err) { warn('拖拽收尾写盘失败：', err); } // 松手立即落盘
    if (st.name === 'walk') enterState('idle'); // 松手回 idle（working/wait 时本来就没进 walk）
    drawFrameNow();
  }
  function singleClick() {
    markActivity();
    setState('react', { force: true }); // react 可打断 working/wait，按 meta.next/pendingAfter 回去
    CORE.play('click');                 // locked 时单击不挪窝，但仍然播 react + 音效
  }

  /* ── 滚轮缩放 ─────────────────────────────────────────────────────────
   * 锚点是脚底中心：cfg.pet.x/y 记录的本来就是脚底中心的视口比例，缩放只改
   * scale，layout 始终把脚底锚点放回 cfg.x/y 对应的像素位置 ⇒ 天然不漂移。 */
  function onWheel(ev) {
    if (ev.preventDefault) ev.preventDefault();
    markActivity();
    var p = petCfg();
    var s = CORE.clamp(p.scale * (ev.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), SCALE_MIN, SCALE_MAX, p.scale);
    if (s === p.scale) return;
    p.scale = s; // 不动 x/y：见上，脚底中心为锚点，缩放零漂移
    layout();    // 画布逻辑尺寸 = cell × scale × 1.25，必须跟着重算
    drawFrameNow();
    try { CORE.set({ pet: { scale: s } }, true); } catch (err) { warn('缩放落盘失败：', err); } // 规格：缩放后立即落盘（immediate，不走 debounce）
  }

  /* ── 右键菜单 ───────────────────────────────────────────────────────── */
  function bootAvailable() {
    try { return typeof BOOT !== 'undefined' && !!BOOT; } catch (err) { return false; }
  }
  function menuItems() {
    var p = petCfg();
    var items = [];
    function sep() { items.push({ sep: true }); }
    function item(label, fn, o) {
      o = o || {};
      items.push({ label: label, fn: fn, checked: !!o.checked, disabled: !!o.disabled, title: o.title || '' });
    }
    /* 模式 = 素材文件夹名。点哪个就播哪个动作；除「待机眨眼」外都会顺手关掉漫游，
       否则空闲漫游会把你手选的动作抢回 walk/idle。会话联动不受影响：
       来消息 → 加载等待(wait)，1.5s 后 → 敲代码(working)，完成 → 庆祝完成(react)。 */
    function pickMode(name, roamOn) {
      setState(name, { force: true });
      var v = !!roamOn;
      if (petCfg().roam !== v) {
        CORE.set({ pet: { roam: v } }, true);
        if (!v) stopRoam(); else idleAt = nowMs();
      }
    }
    item('待机眨眼', function () { pickMode('idle', true); }, { checked: st.name === 'idle' });
    item('修bug', function () { pickMode('walk'); }, { checked: st.name === 'walk', title: '拖拽/漫游时也是这个动作' });
    item('加载等待', function () { pickMode('wait'); }, { checked: st.name === 'wait' });
    item('敲代码', function () { pickMode('working'); }, { checked: st.name === 'working' });
    item('庆祝完成', function () { pickMode('react'); }, { checked: st.name === 'react' });
    item('睡觉休息', function () { pickMode('sleep'); }, { checked: st.name === 'sleep' });
    item('报错装死', function () { pickMode('dead'); }, { checked: st.name === 'dead', title: '素材：bg9 dead 16 帧' });
    item('监工模式', function () { pickMode('supervise'); }, { checked: st.name === 'supervise', title: '素材：bg9 supervise 22 帧' });
    sep();
    item('锁定位置', function () {
      var v = !petCfg().locked;
      CORE.set({ pet: { locked: v } }, true);
      if (v) stopRoam(); // 锁上就把漫游叫停
      layout();
    }, { checked: p.locked });
    item(p.hidden ? '召唤桌宠' : '隐藏桌宠', function () {
      var v = !petCfg().hidden;
      CORE.set({ pet: { hidden: v } }, true);
      layout();
      if (!v) { CORE.play('hello'); bubble('我一直在 👋', 2500); }
    });
    sep();
    item('放大', function () { stepScale(MENU_STEP); });
    item('缩小', function () { stepScale(1 / MENU_STEP); });
    item('尺寸 ' + Math.round(p.scale * 100) + '%', cycleSize, { title: '点击在 75/100/125/150% 之间循环' });
    /* 速度组（fpsScale）与尺寸组（scale）互相独立、各自持久化。写入后无需刷新页面：
       stateDef() 的 fps 在每帧 tick/drawStateAt 里现算（pet.js:380/440），无缓存可失效。 */
    item('加速', function () { stepSpeed(SPEED_STEP); }, { title: '动画倍速 +0.2（0.4~2.0），漫游步速同步加快' });
    item('减速', function () { stepSpeed(-SPEED_STEP); }, { title: '动画倍速 -0.2（0.4~2.0）' });
    item('速度 ' + fpsScale().toFixed(1) + '×', resetSpeed, { title: '点击恢复默认 ' + DEF_FPS_SCALE.toFixed(1) + '×' });
    item('背景设置…', function () { CORE.emit('panel:toggle'); });
    sep();
    item('音效 ' + (p.sound ? '开' : '关'), function () { var v = !petCfg().sound; CORE.set({ pet: { sound: v } }, true); if (v) CORE.play('click'); });
    item('漫游 ' + (p.roam ? '开' : '关'), function () {
      var v = !petCfg().roam;
      CORE.set({ pet: { roam: v } }, true);
      if (!v) stopRoam(); else idleAt = nowMs();
    });
    item('派活…', function () { CORE.emit('dispatch'); }, { disabled: !bootAvailable(), title: bootAvailable() ? '' : 'boot 会话接线不可用，暂时不能派活' });
    sep();
    item('重置位置', function () { CORE.set({ pet: { x: DEF_X, y: DEF_Y } }, true); layout(); drawFrameNow(); });
    sep();
    /* 素材来源状态项（第二阶段）：disabled ⇒ openMenu 不给它绑 click，点了没反应。
       存在的意义是让用户刷新页面后一眼看清当前跑的是外挂高清还是内嵌回退，不用开控制台。
       标签带动态文字（帧数/状态），所以 tools\verify.mjs 的探针用「素材」子串匹配。 */
    item('素材：' + sheetSource(), function () { /* 状态项，不响应点击 */ }, { disabled: true, title: sheetTitle() });
    return items;
  }
  function stepScale(k) {
    var p = petCfg();
    var s = CORE.clamp(p.scale * k, SCALE_MIN, SCALE_MAX, p.scale);
    p.scale = s;
    layout();
    drawFrameNow();
    CORE.set({ pet: { scale: s } }, true);
  }
  function cycleSize() { // 75 → 100 → 125 → 150 循环
    var p = petCfg();
    var next = SIZE_CYCLE[0];
    for (var i = 0; i < SIZE_CYCLE.length; i++) if (SIZE_CYCLE[i] > p.scale + 0.01) { next = SIZE_CYCLE[i]; break; }
    stepScale(next / p.scale);
  }
  var SPEED_STEP = 0.2, SPEED_MIN = 0.4, SPEED_MAX = 2; // 菜单步进的实用钳位（core sanitize 的 0.15~2 是存储层保护，保持不动）
  function stepSpeed(d) { // 只动 fpsScale；立即生效：fps 每帧现算，这里再补一次即时重绘
    var v = Math.round(CORE.clamp(fpsScale() + d, SPEED_MIN, SPEED_MAX, fpsScale()) * 10) / 10;
    CORE.set({ pet: { fpsScale: v } }, true);
    drawFrameNow();
  }
  function resetSpeed() {
    CORE.set({ pet: { fpsScale: DEF_FPS_SCALE } }, true);
    drawFrameNow();
  }
  function openMenu(clientX, clientY) {
    closeMenu(); // 再次右键重开时先清旧节点
    if (!document.body) return;
    menuAnchor.x = clientX;
    menuAnchor.y = clientY;
    try {
      menuEl = CORE.el('div', { id: 'dsh-pet-menu', role: 'menu', 'aria-label': '桌宠菜单' });
      menuEl.style.zIndex = String(Z_MENU);
      var list = menuItems();
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it.sep) { menuEl.appendChild(CORE.el('div', { 'class': 'dsh-pet-menu-sep' })); continue; }
        (function (it2) {
          var cls = 'dsh-pet-menu-item' + (it2.disabled ? ' dsh-pet-menu-item-disabled' : '');
          var kids = [CORE.el('span', { 'class': 'dsh-pet-menu-check', text: it2.checked ? '✓' : '' })];
          kids.push(CORE.el('span', { 'class': 'dsh-pet-menu-label', text: it2.label }));
          var attrs = { 'class': cls, role: 'menuitem', 'aria-label': (it2.checked ? '已选：' : '') + it2.label };
          if (it2.title) attrs.title = it2.title;
          var row = CORE.el('div', attrs, kids);
          if (it2.checked) row.setAttribute('data-checked', '1');
          if (!it2.disabled) CORE.on(row, 'click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); it2.fn(); closeMenu(); });
          menuEl.appendChild(row);
        })(it);
      }
      document.body.appendChild(menuEl);
      var mw = menuEl.offsetWidth || 168, mh = menuEl.offsetHeight || 320;
      var mx = clientX, my = clientY;
      if (mx + mw > vw() - 8) mx = Math.max(4, clientX - mw); // 贴近视口边缘自动翻转
      if (my + mh > vh() - 8) my = Math.max(4, clientY - mh);
      menuEl.style.left = Math.round(mx) + 'px';
      menuEl.style.top = Math.round(my) + 'px';
      // 只监听 pointerdown（捕获）与 Esc：右键「外部」也是先 pointerdown 会关掉旧菜单，
      // 不能再监听 contextmenu —— 同一次右键里它在 canvas 上打开新菜单后还会冒泡回来把自己关掉。
      menuUnsubs.push(
        CORE.on(document, 'pointerdown', function (ev) { if (menuEl && ev && ev.target && menuEl.contains(ev.target)) return; closeMenu(); }, true),
        CORE.on(document, 'keydown', function (ev) { if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closeMenu(); })
      );
    } catch (err) { warn('菜单构建失败：', err); menuEl = null; }
  }
  function closeMenu() {
    while (menuUnsubs.length) { try { menuUnsubs.pop()(); } catch (err) { /* 尽力 */ } }
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }
  function onContextMenu(ev) {
    if (ev.preventDefault) ev.preventDefault();
    markActivity();
    openMenu(ev.clientX || 0, ev.clientY || 0);
  }

  /* ── 隐藏态小圆点：不让「隐藏」变成自锁 ─────────────────────────────── */
  function onNudgeDown(ev) {
    if (ev && ev.button !== undefined && ev.button !== 0) return; // 右键开菜单
    markActivity();
    CORE.set({ pet: { hidden: false } }, true);
    layout();
    enterState('idle');
    CORE.play('hello');
    bubble('我回来啦 ✨', 2500);
  }

  /* ── 样式：只出现 #dsh-pet-* 前缀，绝不碰宿主容器 ────────────────────── */
  function injectCss() {
    CORE.css('pet', [
      '#dsh-pet-stage{position:fixed;left:0;top:0;z-index:' + Z_STAGE + ';pointer-events:none}',
      '#dsh-pet-canvas{display:block;pointer-events:auto;image-rendering:auto;cursor:grab;touch-action:none}',
      '#dsh-pet-canvas:active{cursor:grabbing}',
      '#dsh-pet-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:2px;',
      ' max-width:220px;min-width:56px;padding:6px 10px;border-radius:12px;',
      ' background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);',
      ' border:1px solid var(--dsw-alias-border-color-2,rgba(0,0,0,.15));box-shadow:0 4px 14px rgba(0,0,0,.12);',
      ' font-size:13px;line-height:1.45;white-space:normal;word-break:break-word;pointer-events:none;opacity:.97}',
      '#dsh-pet-menu{position:fixed;left:0;top:0;z-index:' + Z_MENU + ';min-width:168px;padding:6px;border-radius:12px;',
      ' background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 92%, transparent);',
      ' backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);',
      ' border:1px solid var(--dsw-alias-border-color-2,rgba(0,0,0,.15));box-shadow:0 8px 28px rgba(0,0,0,.18);',
      ' color:var(--dsw-alias-label-primary,#111);font-size:13px;pointer-events:auto;user-select:none}',
      '#dsh-pet-menu .dsh-pet-menu-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer}',
      '#dsh-pet-menu .dsh-pet-menu-item:hover{background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06))}',
      '#dsh-pet-menu .dsh-pet-menu-check{width:14px;text-align:center;opacity:.9}',
      '#dsh-pet-menu .dsh-pet-menu-item-disabled{opacity:.45;cursor:not-allowed}',
      '#dsh-pet-menu .dsh-pet-menu-item-disabled:hover{background:transparent}',
      '#dsh-pet-menu .dsh-pet-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-color-2,rgba(0,0,0,.12))}',
      '#dsh-pet-nudge{position:fixed;width:16px;height:16px;border-radius:50%;cursor:pointer;',
      ' background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.4));border:1px solid var(--dsw-alias-border-color-2,rgba(128,128,128,.6));',
      ' opacity:.5;transition:all .15s ease;z-index:' + Z_STAGE + ';pointer-events:auto}',
      '#dsh-pet-nudge:hover{opacity:1;width:22px;height:22px}',
      'body[data-ds-dark-theme] #dsh-pet-menu{box-shadow:0 8px 28px rgba(0,0,0,.55)}',
      'body[data-ds-dark-theme] #dsh-pet-bubble{box-shadow:0 4px 14px rgba(0,0,0,.5)}',
    ].join(''));
  }

  /* ── 装配 / 拆卸 ─────────────────────────────────────────────────────── */
  function buildDom() {
    if (!document.body) return;
    // 上一实例残留（HMR 没走 stop）防御：同 id 浮层先清掉，body 下每样只许一份
    var staleIds = ['dsh-pet-stage', 'dsh-pet-menu', 'dsh-pet-nudge'];
    for (var s = 0; s < staleIds.length; s++) {
      var dead = document.getElementById(staleIds[s]);
      if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
    }
    stage = CORE.el('div', { id: 'dsh-pet-stage' });
    canvas = CORE.el('canvas', { id: 'dsh-pet-canvas', width: '1', height: '1' });
    bubbleEl = CORE.el('div', { id: 'dsh-pet-bubble' });
    bubbleEl.style.display = 'none';
    stage.appendChild(canvas);
    stage.appendChild(bubbleEl);
    document.body.appendChild(stage);
    nudge = CORE.el('div', { id: 'dsh-pet-nudge', title: '桌宠已隐藏：左键召唤，右键菜单', role: 'button', 'aria-label': '召唤桌宠' });
    nudge.style.display = 'none';
    document.body.appendChild(nudge);
    try { ctx = canvas.getContext('2d'); } catch (err) { ctx = null; warn('canvas 2d 上下文拿不到：', err); }
    // 拖拽的移动/收尾监听一次性绑好（canvas + window 双份）：真环境 capture 后事件
    // 重定向到 canvas 并冒泡到 window，window 侧用 ev.target 判重；假 DOM 直派发，单份。
    bind(canvas, 'pointerdown', onPointerDown);
    bind(canvas, 'pointermove', onPointerMove);
    bind(canvas, 'pointerup', onPointerUp);
    bind(canvas, 'pointercancel', onPointerUp); // capture 生效时 pointercancel 重定向到 canvas，不再冒泡回 window 的判重口
    bind(window, 'pointermove', onWinPointerMove);
    bind(window, 'pointerup', onWinPointerUp);
    bind(window, 'pointercancel', onWinPointerUp);
    bind(canvas, 'wheel', onWheel, { passive: false });
    bind(canvas, 'contextmenu', onContextMenu);
    bind(nudge, 'contextmenu', onContextMenu);
    bind(nudge, 'click', onNudgeDown);
    bind(document, 'visibilitychange', onVisibility);
    bind(window, 'keydown', markActivity); // 任何键盘输入立即唤醒
    bind(window, 'resize', function () { markActivity(); layout(); drawFrameNow(); });
  }
  function removeDom() {
    closeMenu();
    var nodes = [stage, nudge];
    for (var i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    stage = null;
    canvas = null;
    bubbleEl = null;
    nudge = null;
    ctx = null;
  }
  function applyExternal() { // 外部（面板）改了配置后的重画
    if (!running) return;
    layout();
    if (menuEl) openMenu(menuAnchor.x, menuAnchor.y); // 菜单开着就原位重绘（勾选/文案跟着新配置）
    drawFrameNow();
  }

  function start() {
    if (running) { stop(); } // 幂等：HMR 重载不叠加，先拆旧装配
    running = true;
    try {
      CORE.load();
      injectCss();
      var mq = null;
      try { mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (err) { mq = null; }
      if (mq) {
        reducedMotion = !!mq.matches;
        var mqn = function (e) { reducedMotion = !!(e && e.matches); drawFrameNow(); };
        try { unsubs.push(CORE.on(mq, 'change', mqn)); } catch (err) { if (mq.addListener) { mq.addListener(mqn); unsubs.push(function () { try { mq.removeListener(mqn); } catch (e2) { /* noop */ } }); } }
      }
      imgOk = false;
      cells = null;
      cellCount = 0;
      st.name = 'idle';
      st.since = nowMs();
      idleAt = nowMs();
      roam = null;
      drag = null;
      shake.until = 0;
      pendingAfter = null;
      buildDom();
      loadSprite();
      layout();
      if (petCfg().hidden) bubble('我躲起来了，点左下角小圆点找我', 3000);
      unsubs.push(CORE.onBus('config', function () { setTracked('external', applyExternal, 0); })); // 异步一拍：让 set() 先完成，避免重入，也保证 stop() 能清掉
      startRaf();
      drawFrameNow();
      if (!helloPlayed) { helloPlayed = true; } // hello 只在召唤时响，启动不吵
    } catch (err) {
      warn('start 失败：', err);
      try { stop(); } catch (err2) { /* noop */ }
    }
    return api;
  }
  function stop() {
    if (!running) return;
    running = false;
    closeMenu();
    stopRaf();
    clearAllTimers();
    while (unsubs.length) { try { unsubs.pop()(); } catch (err) { /* 尽力解绑 */ } }
    removeDom();
    try { CORE.persistNow(); } catch (err) { warn('stop 落盘失败：', err); } // 别把没写完的配置丢了
    imgOk = false;
    cells = null;
    cellCount = 0;
    img = null;
  }

  /* ── 对外接口（仅这些）────────────────────────────────────────────────── */
  var api = {
    start: start,
    stop: stop,
    state: state,
    setState: setState,
    notify: notify,
    bubble: bubble,
    refresh: applyExternal,
    bounds: bounds,
    sheetInfo: sheetInfo,
  };
  /* 只读诊断：当前生效的是哪套素材、预切了多少格、上屏内容多大（CSS px）。
   * 浏览器控制台 __DSH_PET_BG__.PET.sheetInfo() 可查，冒烟测试也断言它。
   * contentCssH/W = 内容盒换算到屏幕的高度/宽度：cellBox × (display.h / cell.h)，
   * 这个数在两套素材间必须一致（146×176），否则桌宠会悄悄变大变小。 */
  function sheetInfo() {
    var s = sheetData(), m = s && s.meta;
    var g = null;
    try { g = geometry(1); } catch (err) { g = null; }
    var boxH = (m && m.source && m.source.cellBox && isPos(m.source.cellBox.h)) ? m.source.cellBox.h : null;
    var boxW = (m && m.source && m.source.cellBox && isPos(m.source.cellBox.w)) ? m.source.cellBox.w : null;
    var cm = cellMeta();
    var k = (cm && isPos(cm.ch)) ? (cm.dspH / cm.ch) : 1;
    return {
      source: hdPhase === 'hd' ? 'hd' : 'embedded',
      phase: hdPhase,
      why: hdWhy,
      label: sheetSource(),
      cells: cellCount,
      imgOk: imgOk,
      frames: countFrames(s),
      cellW: m && m.cell ? m.cell.w : 0,
      cellH: m && m.cell ? m.cell.h : 0,
      cols: m ? m.cols : 0,
      rows: m ? m.rows : 0,
      sheetW: m && m.cell ? m.cols * m.cell.w : 0,
      sheetH: m && m.cell ? m.rows * m.cell.h : 0,
      elementW: g ? g.W : 0,
      elementH: g ? g.H : 0,
      contentCssW: boxW === null ? 0 : boxW * k,
      contentCssH: boxH === null ? 0 : boxH * k,
      cellMemMB: cellCount && m && m.cell ? cellCount * m.cell.w * m.cell.h * 4 / 1048576 : 0,
    };
  }
  function bounds() { // 视口坐标，菜单元定位用
    var p = petCfg();
    var g = geometry(p.scale);
    var f = footPx();
    return { x: f.x - g.bx, y: f.y - g.by, w: g.W, h: g.H };
  }
  return api;
})();
