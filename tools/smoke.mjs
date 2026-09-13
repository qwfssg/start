/* tools/smoke.mjs —— 桌宠制作流水线：假 DOM 冒烟验收（正式工具，提纯自 dsh-pet-bg/tmp/pet-smoke.mjs）
 *
 * 为什么存在：headless 浏览器验收在沙箱里跑不了（禁止子进程开命名管道 ⇒ msedge FATAL
 * mojo platform_channel.cc:183 Check failed (0x5)，或进程级 status 0x80000003、stdout 全 null，
 * 两个独立会话均复现）。替代门槛 = node + 手写 document/canvas/Image stub 直接跑引擎逻辑，
 * 断言几何数值 / 状态机 / 菜单 / 帧率语义。零外部依赖，node 22 直接跑。
 *
 * 用法：
 *   node tools/smoke.mjs [--src <引擎src目录>] [--meta <pet.json>] [--sheet <png 可选>] [--help]
 *   --src    引擎源码目录（须含 core.js 与 pet.js）。默认 <tools>/../plugin/src；
 *            默认目录尚未装配时打印明确错误并以退出码 2 结束（也可显式传旧工程 src 验证）。
 *   --meta   图集 meta（pet.json）。默认 <tools>/../plugin/assets/pet.json；缺失同样报错退出 2。
 *   --sheet  可选，精灵图集 PNG。提供时按 IHDR 校验尺寸 == cols*cell.w × rows*cell.h。
 *
 * 提纯原则（相对原版 tmp/pet-smoke.mjs，实战 104 PASS）：
 *   - 保留 stub 架构：虚拟时钟 + 假 DOM + canvas 调用记录 + Image/localStorage/indexedDB stub；
 *   - 引擎常量（PAD/DEF_FPS_SCALE/NAMES/CFG_KEY/各时长阈值）从源码正则解析，带兜底默认，
 *     常量微调不再打断言；
 *   - 一切几何期望从传入 meta 推导（display/anchor/baselineY/cellBox），去掉对具体 162 格
 *     生产图集的硬编码；生产基线 240×280 仅在 meta.display==192×224 时作为条件锚点断言；
 *   - sheet.js（3.4MB base64 内嵌产物）绝不读取：globalThis.SHEET 由本工具注入 {meta,dataUrl}，
 *     Image stub 按 dataUrl 前缀同步触发 onload/onerror，等效拦截内嵌图集；
 *   - 控制台可能是 cp936：输出只用 [OK]/[X]/[!]，诊断串经过 GBK 安全过滤（emoji/勾叉符号等替换为 ?）。
 *
 * 输出末行：smoke: N PASS / M FAIL；M>0 逐条打印 FAIL 原因并 exit(1)；全过 exit(0)；
 * 用法/路径错误 exit(2)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── CLI ───────────────────────────────────────────────────────────────── */
const HELP = [
  '用法: node tools/smoke.mjs [--src <引擎src目录>] [--meta <pet.json>] [--sheet <png>]',
  '',
  '  --src    引擎源码目录(含 core.js/pet.js)。默认 <tools>/../plugin/src',
  '  --meta   图集 meta(pet.json)。默认 <tools>/../plugin/assets/pet.json',
  '  --sheet  可选: 精灵图集 PNG, 校验 IHDR 尺寸 == cols*cell.w x rows*cell.h',
  '  --help   打印本帮助',
  '',
  '假 DOM + 虚拟时钟冒烟验收(headless 浏览器在沙箱不可用的替代门槛)。',
  '末行输出 smoke: N PASS / M FAIL; M>0 时 exit(1), 全过 exit(0), 用法/路径错误 exit(2)。',
].join('\n');

function die(msg) { // 明确报错 + 非 0 退出（用法/环境错误，与断言 FAIL 区分开）
  console.error('[X] ' + msg);
  process.exit(2);
}
const argv = process.argv.slice(2);
let argSrc = null, argMeta = null, argSheet = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  else if (a === '--src') argSrc = argv[++i];
  else if (a === '--meta') argMeta = argv[++i];
  else if (a === '--sheet') argSheet = argv[++i];
  else die('未知参数: ' + a + '（--help 看用法）');
}
if (argSrc !== null && !argSrc) die('--src 缺少取值');
if (argMeta !== null && !argMeta) die('--meta 缺少取值');
if (argSheet !== null && !argSheet) die('--sheet 缺少取值');

const SRC_DIR = path.resolve(argSrc || path.join(HERE, '..', 'plugin', 'src'));
const META_PATH = path.resolve(argMeta || path.join(HERE, '..', 'plugin', 'assets', 'pet.json'));
const SHEET_PATH = argSheet ? path.resolve(argSheet) : null;

const corePath = path.join(SRC_DIR, 'core.js');
const petPath = path.join(SRC_DIR, 'pet.js');
if (!fs.existsSync(corePath) || !fs.existsSync(petPath)) {
  console.error('[X] 引擎源码未就位: ' + SRC_DIR + ' 缺少 ' +
    [!fs.existsSync(corePath) && 'core.js', !fs.existsSync(petPath) && 'pet.js'].filter(Boolean).join(' / '));
  console.error('[!] 默认 --src 指向 <tools>/../plugin/src；该目录尚未装配时请显式传 --src <引擎src目录>');
  process.exit(2);
}
if (!fs.existsSync(META_PATH)) {
  console.error('[X] meta 不存在: ' + META_PATH);
  console.error('[!] 默认 --meta 指向 <tools>/../plugin/assets/pet.json；未装配时请显式传 --meta <pet.json>');
  process.exit(2);
}
if (SHEET_PATH && !fs.existsSync(SHEET_PATH)) die('--sheet 文件不存在: ' + SHEET_PATH);

let META = null;
try { META = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
catch (e) { die('meta 不是合法 JSON: ' + META_PATH + ' -- ' + e.message); }

const coreSrc = fs.readFileSync(corePath, 'utf8');
const petSrc = fs.readFileSync(petPath, 'utf8');
// 注意：绝不读取 src/sheet.js —— 那是 3.4MB base64 内嵌产物，SHEET 由本工具注入 stub 拦截。

/* ── 引擎常量：从源码解析（正则失配则用当前引擎的已知默认值兜底）──────────── */
function grabNum(srcText, re, fb) { const m = srcText.match(re); return m ? parseFloat(m[1]) : fb; }
const PAD = grabNum(petSrc, /var PAD = ([\d.]+)/, 1.25);                 // 画布留白系数：元素 = display × scale × PAD
const DEF_FPS_SCALE = grabNum(petSrc, /var DEF_FPS_SCALE = ([\d.]+)/, 1.4);
const WHEEL_STEP = grabNum(petSrc, /var WHEEL_STEP = ([\d.]+)/, 1.08);
const CLICK_SLOP = grabNum(petSrc, /var CLICK_SLOP = (\d+)/, 4);
const IDLE_ROAM_MS = grabNum(petSrc, /var IDLE_ROAM_MS = (\d+)/, 60000);
const IDLE_SLEEP_MS = grabNum(petSrc, /var IDLE_SLEEP_MS = (\d+)/, 300000);
const WORK_DELAY_MS = grabNum(petSrc, /var WORK_DELAY_MS = (\d+)/, 1500);
const ROAM_SPEED = grabNum(petSrc, /var ROAM_SPEED = (\d+)/, 34);
const PH_W = grabNum(petSrc, /var PH_W = (\d+)/, 96);
const BUBBLE_DEFAULT_MS = grabNum(petSrc, /var BUBBLE_DEFAULT_MS = (\d+)/, 4000);
const SCALE_MIN = grabNum(petSrc, /var SCALE_MIN = ([\d.]+)/, 0.5);
const SCALE_MAX = grabNum(petSrc, /var SCALE_MAX = ([\d.]+)/, 2.5);
const mSpd = petSrc.match(/var SPEED_STEP = ([\d.]+), SPEED_MIN = ([\d.]+), SPEED_MAX = ([\d.]+)/);
const SPEED_STEP = mSpd ? parseFloat(mSpd[1]) : 0.2;
const SPEED_MIN = mSpd ? parseFloat(mSpd[2]) : 0.4;
const SPEED_MAX = mSpd ? parseFloat(mSpd[3]) : 2;
const CFG_KEY = (coreSrc.match(/CFG_KEY = "([^"]+)"/) || [, 'dsh-pet-bg:config'])[1];
let NAMES_WHITELIST = ['idle', 'wait', 'walk', 'react', 'working', 'sleep', 'supervise', 'dead'];
{ // NAMES 白名单以 pet.js 为准（菜单模式项/状态机可达性都锚定它）
  const mN = petSrc.match(/var NAMES = \{([^}]+)\}/);
  if (mN) NAMES_WHITELIST = mN[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
}

/* ── 断言工具 ───────────────────────────────────────────────────────────── */
function sane(s) { // cp936 控制台安全：GBK 常见区（ASCII/拉丁补充/中文/全角/常用标点/≈≤≥）之外一律替换为 ?
  return String(s).replace(/[^\u0020-\u007E\u00A1-\u00FF\u2018\u2019\u201C\u201D\u2026\u2014\u2248\u2264\u2265\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/g, '?');
}
let pass = 0, fail = 0;
const fails = [];
function say(s) { console.log(s); }
function A(name, cond, detail) { // cond 可为布尔或函数；抛错按 FAIL 记（带异常信息）
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (err) { ok = false; detail = (detail ? detail + ' | ' : '') + '异常:' + ((err && err.message) || err); }
  const d = detail ? ' -- ' + sane(detail) : '';
  if (ok) { pass++; say('[OK] ' + name); }
  else { fail++; fails.push(name + (detail ? ' -- ' + sane(detail) : '')); say('[X] ' + name + d); }
  return ok;
}
function SKIP(name, why) { say('[!] 跳过 ' + name + ': ' + sane(why)); }
function close(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-4 : eps); }
function banner(t) { say('[!] ==== ' + t + ' ===='); }
function phase(title, fn) { // 每个相位兜底：意外抛错记 FAIL 并尝试 stop，后续相位继续
  banner(title);
  try { fn(); }
  catch (err) {
    A(title + ' 相位意外抛错', false, (err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : String(err)));
    try { PET.stop(); } catch { /* noop */ }
  }
}

/* ── 虚拟时钟 ──────────────────────────────────────────────────────────────
 * 为什么：引擎只有一条 rAF 主循环、用 performance.now() 推帧（DESIGN §9），动画时长/
 * 漫游/睡眠/帧间隔断言若靠真实时钟就不可复现。setTimeout/clearTimeout/performance.now/
 * requestAnimationFrame 全部虚拟时钟化，advance(ms) 以 16ms 步长手动推时间。 */
let T = 1000;
const clock = { now: () => T };
try { Object.defineProperty(globalThis, 'performance', { value: clock, configurable: true, writable: true }); }
catch { globalThis.performance = clock; }

const vTimers = [];
let vtid = 1;
globalThis.setTimeout = (fn, ms) => { const id = vtid++; vTimers.push({ id, due: T + (ms || 0), fn }); return id; };
globalThis.clearTimeout = (id) => { const i = vTimers.findIndex((t) => t.id === id); if (i >= 0) vTimers.splice(i, 1); };
const vRaf = new Map();
let vrid = 1;
globalThis.requestAnimationFrame = (fn) => { const id = vrid++; vRaf.set(id, fn); return id; };
globalThis.cancelAnimationFrame = (id) => { vRaf.delete(id); };

function stepOnce() { // 推 16ms：先清空到期定时器（含级联），再跑一轮 rAF
  T += 16;
  let fired = true;
  while (fired) {
    fired = false;
    const due = vTimers.filter((t) => t.due <= T).sort((a, b) => a.due - b.due);
    for (const t of due) {
      const i = vTimers.findIndex((x) => x.id === t.id);
      if (i >= 0) { vTimers.splice(i, 1); fired = true; t.fn(); }
    }
  }
  const cbs = [...vRaf.values()];
  vRaf.clear();
  for (const fn of cbs) fn(T);
}
function advance(ms) { const end = T + ms; let guard = 0; while (T < end && guard++ < 40000) stepOnce(); }

/* ── 假 DOM ────────────────────────────────────────────────────────────────
 * 为什么：引擎是纯 DOM + Canvas 实现（铁律：浮层只 append 到 document.body），沙箱里
 * 没有浏览器，这里手写最小可用节点树。每个 stub 只为引擎真实用到的 API 存在：
 *   FN 元素       —— createElement/appendChild/removeChild/setAttribute/getAttribute/
 *                    style/addEventListener/contains/getContext/offsetWidth/pointerCapture；
 *   canvas 2D ctx —— 记录调用序列（drawImage 携带预切 cell 的 cid），镜像(-1 缩放)、
 *                    uniform 绘制几何、帧间隔测量全部从调用记录读，不做真渲染；
 *   document      —— body/head/hidden/getElementById/createElement/addEventListener；
 *   window        —— innerWidth/innerHeight/devicePixelRatio/matchMedia + 窗口级事件；
 *   localStorage  —— 配置真身（CFG_KEY 持久化断言直接读底层 Map）；
 *   indexedDB     —— open 返回空对象：请求 Promise 永不 settle ⇒ CORE.play 的查库分支
 *                    静默挂起（沙箱无 WebAudio，也绝不真播声音）；
 *   Image         —— dataUrl 前缀决定同步 onload/onerror，拦截内嵌图集加载路径。 */
const VW = 1200, VH = 800, DPR = 2; // 视口/像素比 stub 常量：几何期望都从这里推
let canvasCreated = 0;
function makeCtx(node) {
  const calls = [];
  return {
    canvas: node, calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); }, scale(x, y) { calls.push(['scale', x, y]); },
    setTransform(a, b, c, d, e, f) { calls.push(['setTransform', a, b, c, d, e, f]); },
    clearRect() { calls.push(['clearRect']); }, fillRect() { calls.push(['fillRect']); },
    strokeRect() { calls.push(['strokeRect']); },
    fillText(t) { calls.push(['fillText', String(t)]); },
    // drawImage 记录：['drawImage', 参数个数, 源类型('cell'=预切离屏画布/'img'), sx,sy,sw,sh,dx,dy,dw,dh, 源cid]
    drawImage(img, ...rest) {
      calls.push(['drawImage', rest.length + 1, img && img.tagName === 'canvas' ? 'cell' : 'img']
        .concat(rest)
        .concat([img && img.tagName === 'canvas' ? 'cid' + img._cid : '']));
    },
    setLineDash(a) { calls.push(['setLineDash', JSON.stringify(a)]); },
    measureText(s) { return { width: String(s).length * 7 }; }, // 引擎只用来估文本宽，7px/字符足够
  };
}
class FN {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase(); this.childNodes = []; this.parentNode = null;
    this._attrs = {}; this.style = {}; this._ls = {}; this.textContent = '';
    this._cap = null; this.offsetWidth = 0; this.offsetHeight = 0;
    if (this.tagName === 'canvas') { canvasCreated++; this._cid = canvasCreated; this._ctx = null; }
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  addEventListener(t, f) { (this._ls[t] || (this._ls[t] = [])).push(f); }
  removeEventListener(t, f) { const l = this._ls[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  setPointerCapture(id) { this._cap = id; }
  releasePointerCapture() { this._cap = null; }
  hasPointerCapture(id) { return this._cap === id; }
}
function fire(node, type, props) { // 直派发：沙箱假 DOM 不模拟冒泡/捕获，事件只送到本节点监听器
  const ev = Object.assign({
    type, target: node, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {},
  }, props || {});
  for (const f of (node._ls[type] || []).slice()) f(ev);
  return ev;
}
const body = new FN('body');
const head = new FN('head');
function findById(root, id) {
  if (root.getAttribute && root.getAttribute('id') === id) return root;
  for (const c of root.childNodes) { const r = findById(c, id); if (r) return r; }
  return null;
}
const documentStub = {
  body, head, hidden: false, // document.hidden=false：主循环不因页面隐藏停摆
  _ls: {},
  createElement: (t) => new FN(t),
  getElementById: (id) => findById(body, id) || findById(head, id),
  addEventListener(t, f) { (documentStub._ls[t] || (documentStub._ls[t] = [])).push(f); },
  removeEventListener(t, f) { const l = documentStub._ls[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
};
const windowObj = new FN('window'); // 引擎 bind(window,…) 的窗口级监听 + 视口尺寸来源
windowObj.innerWidth = VW; windowObj.innerHeight = VH; windowObj.devicePixelRatio = DPR;
windowObj.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); // prefers-reduced-motion=false：动画全开
const store = new Map(); // localStorage 底层：持久化断言直接读它
globalThis.window = windowObj;
globalThis.document = documentStub;
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.indexedDB = { open: () => ({}) }; // 永不 settle ⇒ CORE.play 的查库/播放分支静默挂起（无 WebAudio）
globalThis.Image = class { // dataUrl 前缀决定成败：'data:bad' ⇒ onerror（解码失败降级路径），其余 ⇒ onload
  constructor() {}
  set src(v) {
    if (String(v).indexOf('data:bad') === 0) { if (this.onerror) this.onerror(new Error('decode fail')); }
    else {
      // 解码尺寸对齐当前注入的 meta（内嵌路径引擎不校验尺寸，这里保持语义真实）
      const m = globalThis.SHEET && globalThis.SHEET.meta;
      this.width = m && m.cell ? m.cols * m.cell.w : 768;
      this.height = m && m.cell ? m.rows * m.cell.h : 600;
      if (this.onload) this.onload();
    }
  }
};
globalThis.SHEET = null; // 内嵌图集替身：{meta,dataUrl} 由本工具按相位注入（替代 3.4MB 的 sheet.js）
// 不设 globalThis.SHEET_HD / BOOT：高清外挂路径 hdRev()=null 直接短路；BOOT 在菜单相位再注入

/* ── 装载引擎（模拟 assemble 的拼接闭包：core.js + pet.js 顺序拼接）──────── */
let CORE = null, PET = null;
try {
  const bundled = coreSrc + '\n' + petSrc + '\nreturn { CORE: CORE, PET: PET };';
  ({ CORE, PET } = new Function(bundled)());
} catch (err) {
  A('LOAD 引擎装载(core.js+pet.js 拼接闭包)', false, String((err && err.stack) || err).split('\n').slice(0, 3).join(' | '));
  finish();
}
if (!CORE || !PET || typeof PET.start !== 'function') {
  A('LOAD 引擎导出 CORE/PET 形状', false, 'CORE=' + typeof CORE + ' PET=' + typeof PET);
  finish();
}
const plays = []; // CORE.play 包装：记录音效名（click/done/hello），不发声
{
  const origPlay = CORE.play;
  CORE.play = function (n, v) { plays.push(n); return origPlay.call(CORE, n, v); };
}
const busSeen = {}; // 内部总线监听：菜单项 emit 的断言口
CORE.onBus('panel:toggle', () => { busSeen.panel = (busSeen.panel || 0) + 1; });
CORE.onBus('dispatch', () => { busSeen.dispatch = (busSeen.dispatch || 0) + 1; });

say('[!] smoke 目标: src=' + SRC_DIR + ' meta=' + META_PATH + (SHEET_PATH ? ' sheet=' + SHEET_PATH : ' sheet=(未提供)'));
say('[!] 解析引擎常量: PAD=' + PAD + ' DEF_FPS_SCALE=' + DEF_FPS_SCALE + ' NAMES=' + NAMES_WHITELIST.join('/') + ' CFG_KEY=' + CFG_KEY);

/* ── 几何期望：按规格公式从 meta 推导（用于对照引擎 geometry()/cellMeta() 的实际输出）──
 * 规格（DESIGN/display 补偿语义）：
 *   dsp = meta.display（缺失回落 cell × displayScale，缺省 1）
 *   dh = dsp.h × scale；dw = dh × cell.w/cell.h（uniform，绝不按轴拉伸）
 *   W = dsp.w × scale × PAD；H = dh × PAD；x0=(W-dw)/2；y0=H-dh（25% 留白全放头顶）
 *   k = dh/cell.h（cell px → 屏幕 CSS px 的唯一系数，宽高共用）
 *   锚点=脚底中心：ax=anchor.x（0..1 视为比例），ay=baselineY（像素行）优先于 anchor.y */
function anchorPx(meta) {
  const a = (meta.anchor && typeof meta.anchor === 'object') ? meta.anchor : {};
  const cw = meta.cell.w, ch = meta.cell.h;
  const px = (v, span, fb) => (typeof v === 'number' && isFinite(v)) ? ((v >= 0 && v <= 1) ? v * span : v) : fb;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ayAlt = clamp(px(a.y, ch, ch), 0, ch); // 无 baselineY 时的回落路径（差分断言用）
  const aySrc = (typeof meta.baselineY === 'number' && isFinite(meta.baselineY)) ? meta.baselineY : px(a.y, ch, ch);
  return { ax: clamp(px(a.x, cw, cw / 2), 0, cw), ay: clamp(aySrc, 0, ch), ayAlt };
}
function geomExp(meta, scale) {
  const cw = meta.cell.w, ch = meta.cell.h;
  const dsv = (typeof meta.displayScale === 'number' && meta.displayScale > 0) ? meta.displayScale : 1;
  const dsp = (meta.display && meta.display.w > 0 && meta.display.h > 0) ? meta.display : { w: cw * dsv, h: ch * dsv };
  const dh = dsp.h * scale, dw = dh * (cw / ch);
  const W = dsp.w * scale * PAD, H = dh * PAD;
  const x0 = (W - dw) / 2, y0 = H - dh, k = dh / ch;
  const a = anchorPx(meta);
  return { cw, ch, dspW: dsp.w, dspH: dsp.h, dh, dw, W, H, x0, y0, k, ax: a.ax, ay: a.ay, ayAlt: a.ayAlt, bx: x0 + a.ax * k, by: y0 + a.ay * k, byAlt: y0 + a.ayAlt * k };
}

/* ── 菜单读取助手（菜单重开后是全新节点：必须每次现查，闭包旧引用会读到已脱离 DOM 的旧行）── */
function menuRows() {
  const m = documentStub.getElementById('dsh-pet-menu');
  return m ? m.childNodes.filter((n) => (n.getAttribute('class') || '').indexOf('dsh-pet-menu-item') === 0) : [];
}
function labelOf(row) {
  return (row.childNodes.find((c) => (c.getAttribute('class') || '').indexOf('dsh-pet-menu-label') >= 0) || { textContent: '' }).textContent;
}
function menuLabels() { return menuRows().map(labelOf); }
function findRow(text) { return menuRows().find((r) => labelOf(r) === text); }
function visCanvas() { return documentStub.getElementById('dsh-pet-canvas'); }
function clog(el) { return (el && el._ctx ? el._ctx.calls : []).map((c) => c.join('|')).join('\n'); }
function lastCellDraw(el) { return (el && el._ctx ? el._ctx.calls : []).filter((c) => c[0] === 'drawImage' && c[1] === 9 && c[2] === 'cell').pop() || null; }

/* 帧间隔实测：可见画布上预切 cell 的 cid 变化间隔（16ms 步长量化）。
 * 这是"每帧现算 fps"的证据口：fps 若在 setState 时被缓存，改 fpsScale 后间隔不会立刻变。 */
function measureGaps(stateName, ms) {
  if (stateName) { PET.setState(stateName, { force: true }); advance(16); }
  const cvs = visCanvas();
  cvs._ctx.calls.length = 0;
  let lastCid = null, lastT = 0; const gaps = [];
  const end = T + ms; let guard = 0;
  while (T < end && guard++ < 5000) {
    stepOnce();
    for (const c of cvs._ctx.calls) {
      if (c[0] === 'drawImage' && c[1] === 9 && c[2] === 'cell') {
        const cid = c[c.length - 1];
        if (lastCid !== null && cid !== lastCid) gaps.push(T - lastT);
        if (cid !== lastCid) { lastCid = cid; lastT = T; }
      }
    }
    cvs._ctx.calls.length = 0;
  }
  return { mean: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : Infinity, n: gaps.length };
}
/* ══ 相位 META：meta 静态校验（清单 a/d 静态侧；全部从传入 meta 推导，无生产图集硬编码）══ */
phase('META 静态校验', () => {
  const cell = META.cell || {};
  const shapeOk = META && typeof META === 'object'
    && Number.isInteger(cell.w) && cell.w > 0 && Number.isInteger(cell.h) && cell.h > 0
    && Number.isInteger(META.cols) && META.cols >= 1 && META.cols <= 64
    && Number.isInteger(META.rows) && META.rows >= 1 && META.rows <= 64; // buildCells 对 cols/rows 的 clamp 域
  A('META-01 基本形状: cell{w,h}>0 整数, cols/rows 为 1..64 整数', shapeOk,
    'cell=' + JSON.stringify(cell) + ' cols=' + META.cols + ' rows=' + META.rows);
  const states = META.states;
  A('META-02 states 为非空对象', !!states && typeof states === 'object' && Object.keys(states).length > 0);
  if (!shapeOk || !states) return; // 形状坏到没法继续推导：后续静态断言无意义（引擎相位照跑）
  const sKeys = Object.keys(states);
  const unknown = sKeys.filter((k) => !NAMES_WHITELIST.includes(k));
  A('META-03 状态名全部在引擎 NAMES 白名单内', unknown.length === 0, unknown.length ? '未知状态: ' + unknown.join(',') : '');
  const missing = NAMES_WHITELIST.filter((k) => !states[k]);
  if (missing.length) say('[!] 提示: meta 缺少白名单状态 ' + missing.join(',') + '（引擎会回落单帧占位，菜单模式项动画无效）');

  // 清单 a)：每个状态 frames 全部是 [col,row] 整数坐标对且 0<=col<=cols-1、0<=row<=rows-1
  for (const name of sKeys) {
    const st = states[name] || {};
    const f = st.frames;
    let why = '';
    if (!Array.isArray(f) || !f.length) why = 'frames 缺失或为空';
    else {
      const bad = [];
      f.forEach((cr, i) => {
        if (!Array.isArray(cr) || cr.length < 2 || !Number.isInteger(cr[0]) || !Number.isInteger(cr[1]))
          bad.push('#' + i + '=' + JSON.stringify(cr) + ' 非整数坐标对');
        else if (cr[0] < 0 || cr[0] > META.cols - 1 || cr[1] < 0 || cr[1] > META.rows - 1)
          bad.push('#' + i + '=[' + cr[0] + ',' + cr[1] + '] 越界(合法 0..' + (META.cols - 1) + '/0..' + (META.rows - 1) + ')');
      });
      if (bad.length) why = bad.slice(0, 4).join('; ') + (bad.length > 4 ? ' …共' + bad.length + '处' : '');
    }
    A('META-04 状态 ' + name + ' frames 坐标对全部在界内(' + (Array.isArray(f) ? f.length : 0) + '帧)', why === '', why);
  }
  A('META-05 各状态 fps 均为正有限数', sKeys.every((k) => typeof states[k].fps === 'number' && isFinite(states[k].fps) && states[k].fps > 0),
    sKeys.map((k) => k + '=' + states[k].fps).join('/'));
  A('META-06 loop/pingpong/mirrorable 出现即布尔', sKeys.every((k) => ['loop', 'pingpong', 'mirrorable'].every((p) => states[k][p] === undefined || typeof states[k][p] === 'boolean')));
  A('META-07 react 为单次动画(loop=false)', !states.react || states.react.loop === false,
    states.react ? 'loop=' + states.react.loop : 'meta 无 react 状态');
  // 清单 d) 静态侧：锚点=脚底中心（anchor.x 归一化后 == cell 宽中线）；baselineY（像素行）在 0..cell.h
  const ap = anchorPx(META);
  A('META-08 anchor.x 即脚底水平中心(ax==cell.w/2)', close(ap.ax, cell.w / 2, 1), 'ax=' + ap.ax + ' cell.w/2=' + cell.w / 2);
  if (typeof META.baselineY === 'number') {
    A('META-09 baselineY(像素行) 在 0..cell.h', META.baselineY >= 0 && META.baselineY <= cell.h, 'baselineY=' + META.baselineY + ' cell.h=' + cell.h);
  } else say('[!] 提示: meta 无 baselineY，引擎回落 anchor.y（清单 d 的差分断言按回落值评估）');
  // 清单 b) 静态侧：display 语义（缺失时引擎回落 cell×displayScale）——只做形状校验，数值断言在引擎相位
  if (META.display) {
    A('META-10 display{w,h} 为正数', META.display.w > 0 && META.display.h > 0, JSON.stringify(META.display));
  } else say('[!] 提示: meta 无 display 字段，元素尺寸回落 cell×displayScale(缺省1)×PAD');
  if (META.views && typeof META.views === 'object') {
    // views 是给工具链看的信息位（引擎不读）；打包器允许某视角缺省（值为 null），
    // 只有"声明了视角对象"时才要求 cell 是界内整数坐标对。
    const vBad = Object.entries(META.views).filter(([, v]) => v != null && !(Array.isArray(v.cell) && v.cell.length >= 2
      && Number.isInteger(v.cell[0]) && Number.isInteger(v.cell[1])
      && v.cell[0] >= 0 && v.cell[0] < META.cols && v.cell[1] >= 0 && v.cell[1] < META.rows));
    A('META-11 views.* 非空项的 cell 坐标在界内', vBad.length === 0, vBad.map(([n, v]) => n + '=' + JSON.stringify(v && v.cell)).join(','));
  }
  if (META.source && META.source.cellBox) {
    const cb = META.source.cellBox;
    A('META-12 source.cellBox 内容盒不超过 cell', cb.w > 0 && cb.h > 0 && cb.w <= cell.w && cb.h <= cell.h,
      'cellBox=' + cb.w + 'x' + cb.h + ' cell=' + cell.w + 'x' + cell.h);
  }
  const totalFrames = sKeys.reduce((n, k) => n + (Array.isArray(states[k].frames) ? states[k].frames.length : 0), 0);
  const g1 = geomExp(META, 1);
  say('[!] meta 概览: cell ' + cell.w + 'x' + cell.h + ' | ' + META.cols + 'x' + META.rows + ' | display ' + g1.dspW + 'x' + g1.dspH
    + ' | baselineY ' + META.baselineY + ' | 状态 ' + sKeys.length + ' 个共 ' + totalFrames + ' 帧');
  say('[!] scale=1 推导: k=dsp.h/cell.h=' + g1.k.toFixed(4) + ' 元素=' + (g1.W).toFixed(1) + 'x' + (g1.H).toFixed(1)
    + ' 绘制=' + g1.dw.toFixed(1) + 'x' + g1.dh.toFixed(1));
  say('[!] 锚点推导: bx=' + g1.bx.toFixed(2) + '(应=W/2=' + (g1.W / 2).toFixed(2) + ') by=' + g1.by.toFixed(2)
    + (META.source && META.source.cellBox ? ' 内容盒 ' + META.source.cellBox.w + 'x' + META.source.cellBox.h
      + ' => 上屏 ' + (META.source.cellBox.w * g1.k).toFixed(1) + 'x' + (META.source.cellBox.h * g1.k).toFixed(1) + ' CSS px' : ''));
});

/* ══ 相位 SHEET：可选 PNG 图集校验（只读 IHDR，不解码）══ */
if (SHEET_PATH) {
  phase('SHEET PNG 校验', () => {
    const fd = fs.openSync(SHEET_PATH, 'r');
    const buf = Buffer.alloc(33);
    fs.readSync(fd, buf, 0, 33, 0);
    fs.closeSync(fd);
    const sigOk = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    A('SHEET-01 PNG 签名有效', sigOk, SHEET_PATH);
    if (!sigOk) return;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const ew = META.cols * META.cell.w, eh = META.rows * META.cell.h;
    A('SHEET-02 IHDR 尺寸 == cols*cell.w x rows*cell.h (' + ew + 'x' + eh + ')', w === ew && h === eh, '实际 ' + w + 'x' + h);
  });
} else {
  say('[!] ==== SHEET PNG 校验 ====');
  SKIP('SHEET-01/02', '未提供 --sheet');
}

/* ══ 相位 PH：SHEET=null 占位模式全行为（与 meta 无关的引擎契约）══════════════
 * 覆盖：start/DOM 结构/占位绘制/rAF 主循环/单击 react/微移不算拖/拖拽阈值与比例写回/
 * 立即落盘/滚轮缩放零漂移/notify 会话联动/气泡时序/60s 漫游/300s 睡眠/隐藏圆点/
 * 右键菜单开合与翻转/BOOT 门控/总线 emit/尺寸循环/scale 钳位/stop 清场。 */
phase('PH 占位模式行为', () => {
  let threw = null;
  try { PET.start(); } catch (e) { threw = e; }
  A('PH-01 SHEET=null 时 start 不抛错', !threw, threw && threw.message);
  const stageEl = documentStub.getElementById('dsh-pet-stage');
  const canvasEl = documentStub.getElementById('dsh-pet-canvas');
  A('PH-02 start 建了 #dsh-pet-stage', !!stageEl);
  A('PH-03 canvas 挂在 stage 里(pointer-events 归 CSS)', !!canvasEl && canvasEl.parentNode === stageEl);
  advance(32);
  A('PH-04 占位方块画了「未内嵌精灵图集」', clog(canvasEl).includes('未内嵌精灵图集'));
  A('PH-05 主循环已上 rAF(恰好一条)', vRaf.size === 1, 'vRaf.size=' + vRaf.size);
  const b0 = PET.bounds();
  A('PH-06 bounds 返回有限视口坐标', [b0.x, b0.y, b0.w, b0.h].every(Number.isFinite));

  // 单击 → react + click 音效；占位 react 兜底 1 帧 @10fps=100ms 自动回 idle
  fire(canvasEl, 'pointerdown', { button: 0, pointerId: 1, clientX: 1000, clientY: 600 });
  fire(canvasEl, 'pointerup', { button: 0, pointerId: 1, clientX: 1000, clientY: 600 });
  A('PH-07 单击进 react', PET.state() === 'react', 'state=' + PET.state());
  A('PH-08 单击播了 click 音效', plays.includes('click'));
  advance(150);
  A('PH-09 react 单次自动回 idle', PET.state() === 'idle', 'state=' + PET.state());

  // ≤slop 微移仍算单击：位置不动
  const x0 = CORE.load().pet.x, y0 = CORE.load().pet.y;
  fire(canvasEl, 'pointerdown', { button: 0, pointerId: 2, clientX: 1000, clientY: 600 });
  fire(canvasEl, 'pointermove', { pointerId: 2, clientX: 1000 + (CLICK_SLOP - 2), clientY: 600 });
  fire(canvasEl, 'pointerup', { button: 0, pointerId: 2, clientX: 1000 + (CLICK_SLOP - 2), clientY: 600 });
  A('PH-10 位移<' + CLICK_SLOP + 'px 仍算单击(位置不变)', CORE.load().pet.x === x0 && CORE.load().pet.y === y0);
  advance(150);

  // 拖拽：>slop 判拖 → walk；位置按视口比例写回；朝向跟随；松手回 idle 且立即落盘
  fire(canvasEl, 'pointerdown', { button: 0, pointerId: 3, clientX: 1000, clientY: 600 });
  fire(canvasEl, 'pointermove', { pointerId: 3, clientX: 1000 + (CLICK_SLOP + 1), clientY: 600 });
  A('PH-11 拖过 ' + CLICK_SLOP + 'px 阈值即进 walk', PET.state() === 'walk', 'state=' + PET.state());
  fire(canvasEl, 'pointermove', { pointerId: 3, clientX: 1040, clientY: 620 });
  fire(canvasEl, 'pointerup', { button: 0, pointerId: 3, clientX: 1040, clientY: 620 });
  A('PH-12 松手回 idle', PET.state() === 'idle', 'state=' + PET.state());
  A('PH-13 位置按视口比例写回(+40px/+20px)', close(CORE.load().pet.x, x0 + 40 / VW) && close(CORE.load().pet.y, y0 + 20 / VH),
    'x=' + CORE.load().pet.x + ' y=' + CORE.load().pet.y);
  A('PH-14 拖向右边时 facing=right', CORE.load().pet.facing === 'right');
  const persisted = JSON.parse(store.get(CFG_KEY) || 'null');
  A('PH-15 松手立即落盘(immediate 持久化)', !!persisted && close(persisted.pet.x, CORE.load().pet.x, 1e-6));

  // 滚轮缩放：scale×WHEEL_STEP、x/y 零漂移（脚底锚点）、画布物理尺寸按占位几何重算
  const s1 = CORE.load().pet.scale;
  const xe = CORE.load().pet.x, ye = CORE.load().pet.y;
  const wEv = fire(canvasEl, 'wheel', { deltaY: -100 });
  A('PH-16 wheel preventDefault 生效', wEv.defaultPrevented);
  A('PH-17 滚轮放大 scale×' + WHEEL_STEP, close(CORE.load().pet.scale, s1 * WHEEL_STEP, 1e-3), 'scale=' + CORE.load().pet.scale);
  A('PH-18 缩放不改 x/y(脚底锚点零漂移)', CORE.load().pet.x === xe && CORE.load().pet.y === ye);
  const cwBefore = canvasEl.width;
  fire(canvasEl, 'wheel', { deltaY: 100 });
  // 占位几何：W = PH_W × scale × PAD；物理宽 = round(W × dpr)
  A('PH-19 缩放重算画布物理尺寸(dpr=' + DPR + ')', cwBefore !== canvasEl.width
    && canvasEl.width === Math.max(1, Math.round(PH_W * CORE.load().pet.scale * PAD * DPR)),
    'width=' + canvasEl.width);

  // notify 会话联动：start→wait，WORK_DELAY_MS 后→working；message 重置计时；end→庆祝
  PET.notify('start');
  A('PH-20 notify(start) 立刻 wait', PET.state() === 'wait', 'state=' + PET.state());
  advance(WORK_DELAY_MS - 100);
  A('PH-21 ' + (WORK_DELAY_MS - 100) + 'ms 仍是 wait', PET.state() === 'wait', 'state=' + PET.state());
  advance(200);
  A('PH-22 ' + WORK_DELAY_MS + 'ms 后自动转 working', PET.state() === 'working', 'state=' + PET.state());
  PET.notify('message');
  A('PH-23 notify(message) 重回 wait 并重置计时', PET.state() === 'wait', 'state=' + PET.state());
  advance(WORK_DELAY_MS - 100);
  A('PH-24 重置后未到时长仍 wait', PET.state() === 'wait', 'state=' + PET.state());
  advance(200);
  A('PH-25 重置后到时长转 working', PET.state() === 'working', 'state=' + PET.state());
  fire(canvasEl, 'pointerdown', { button: 0, pointerId: 4, clientX: 300, clientY: 300 });
  fire(canvasEl, 'pointerup', { button: 0, pointerId: 4, clientX: 300, clientY: 300 }); // 单击打断
  A('PH-26 working 中单击可打断进 react', PET.state() === 'react', 'state=' + PET.state());
  advance(150);
  A('PH-27 react 打完回 working(pendingAfter)', PET.state() === 'working', 'state=' + PET.state());
  const bubbleEl = documentStub.getElementById('dsh-pet-bubble');
  PET.notify('end');
  A('PH-28 notify(end) 在 working → react 庆祝', PET.state() === 'react', 'state=' + PET.state());
  A('PH-29 notify(end) 冒泡「搞定」文案', !!bubbleEl && bubbleEl.textContent === '\u641e\u5b9a \u2705',
    bubbleEl ? 'text=' + bubbleEl.textContent : '无气泡节点'); // 期望值含 emoji，仅内存比较，诊断输出经 sane() 过滤
  A('PH-30 notify(end) 播 done 音效', plays.includes('done'));
  advance(200);
  A('PH-31 庆祝完回 idle(不再回 working)', PET.state() === 'idle', 'state=' + PET.state());

  // 气泡时序：默认 BUBBLE_DEFAULT_MS 自收、0 常驻、'' 立即清除
  PET.bubble('默认四秒');
  advance(BUBBLE_DEFAULT_MS + 100);
  A('PH-32 bubble 默认 ' + BUBBLE_DEFAULT_MS + 'ms 后自动收起', bubbleEl.style.display === 'none');
  PET.bubble('常驻', 0);
  advance(9000);
  A('PH-33 bubble(...,0) 常驻不收', bubbleEl.textContent === '常驻' && bubbleEl.style.display === '');
  PET.bubble('');
  A('PH-34 bubble("") 立即清除', bubbleEl.style.display === 'none');

  // 60s 空闲漫游（Math.random 钉死 0.2 ⇒ 目标 0.224，距离足够）；300s 睡眠；任意键唤醒
  CORE.set({ pet: { roam: true, locked: false } }, true);
  fire(windowObj, 'keydown', { key: 'x' }); // 对齐空闲计时起点
  const rx0 = CORE.load().pet.x, ry0 = CORE.load().pet.y;
  const realRandom = Math.random;
  Math.random = () => 0.2;
  advance(IDLE_ROAM_MS + 600);
  A('PH-35 ' + IDLE_ROAM_MS / 1000 + 's 无输入进入漫游(walk)', PET.state() === 'walk', 'state=' + PET.state());
  advance(300);
  { // 已走距离 = ROAM_SPEED × fpsScale × 实际行走时长。行走时长 ∈ [300ms, ~900ms]：
    // 漫游在前一窗口(idleFor 刚过阈值)内就已起步，最多提前 ~600ms，加上这里显式推的 300ms。
    // 窗口取 E×[0.8, 3.2]（E=300ms 理论距离），量化 ±16ms 留余量；y 必须纹丝不动（只走水平线）。
    const rx1 = CORE.load().pet.x;
    const fsNow = CORE.load().pet.fpsScale;
    const E = ROAM_SPEED * fsNow * 0.3;
    const walked = Math.abs(rx0 - rx1) * VW;
    A('PH-36 漫游只改 x 不改 y, 速度≈' + ROAM_SPEED + 'px/s×fpsScale', CORE.load().pet.y === ry0 && walked > E * 0.8 && walked < E * 3.2,
      'walked=' + walked.toFixed(1) + 'px 期望窗口(' + (E * 0.8).toFixed(1) + ',' + (E * 3.2).toFixed(1) + ')');
  }
  advance(IDLE_SLEEP_MS - IDLE_ROAM_MS - 300 + 5000);
  A('PH-37 ' + IDLE_SLEEP_MS / 1000 + 's 无输入进 sleep', PET.state() === 'sleep', 'state=' + PET.state());
  fire(windowObj, 'keydown', { key: 'q' });
  A('PH-38 键盘输入立即唤醒回 idle', PET.state() === 'idle', 'state=' + PET.state());
  Math.random = realRandom;
  CORE.set({ pet: { roam: false } }, true);
  const rx2 = CORE.load().pet.x;
  advance(64000);
  A('PH-39 roam=false 时不再自动漫游', PET.state() === 'idle' && CORE.load().pet.x === rx2, 'state=' + PET.state());

  // 隐藏 → nudge 圆点；左键点圆点即召唤
  CORE.set({ pet: { hidden: true } }, true);
  advance(48); // config 总线 → tracked external(0ms) → applyExternal 需要推一拍
  const nudgeEl = documentStub.getElementById('dsh-pet-nudge');
  A('PH-40 hidden 时 stage 隐藏、nudge 出现', stageEl.style.display === 'none' && !!nudgeEl && nudgeEl.style.display === '');
  fire(nudgeEl, 'click', { button: 0 });
  A('PH-41 左键点 nudge 即召唤', CORE.load().pet.hidden === false && stageEl.style.display === '');

  // 右键菜单：开合/勾选/BOOT 门控/贴边翻转/去重/Esc
  const cm = fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  A('PH-42 右键打开 #dsh-pet-menu 且 preventDefault', !!documentStub.getElementById('dsh-pet-menu') && cm.defaultPrevented);
  A('PH-43 菜单含 >=12 个菜单项', menuRows().length >= 12, 'n=' + menuRows().length);
  const idleRow = menuRows().find((r) => labelOf(r) === '待机眨眼');
  A('PH-44 当前状态「待机眨眼」项带勾选', !!idleRow && (idleRow.childNodes[0].textContent === '\u2713' || idleRow.getAttribute('data-checked') === '1'));
  const dispatchRow = findRow('派活…');
  A('PH-45 BOOT 缺失时「派活…」置灰带说明', !!dispatchRow
    && (dispatchRow.getAttribute('class') || '').indexOf('disabled') >= 0
    && !!(dispatchRow.getAttribute('title') || '').length);
  fire(documentStub, 'pointerdown', { target: body });
  A('PH-46 点菜单外任意处关闭', !documentStub.getElementById('dsh-pet-menu'));
  fire(canvasEl, 'contextmenu', { clientX: VW - 10, clientY: VH - 10 });
  const m2 = documentStub.getElementById('dsh-pet-menu');
  A('PH-47 贴边自动上/左翻转', !!m2 && parseFloat(m2.style.left) < VW - 10 && parseFloat(m2.style.top) < VH - 10,
    m2 ? 'left=' + m2.style.left + ' top=' + m2.style.top : '菜单未开');
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  A('PH-48 重开时旧节点被清(body 下只一份菜单)', body.childNodes.filter((n) => n.getAttribute && n.getAttribute('id') === 'dsh-pet-menu').length === 1);
  fire(documentStub, 'keydown', { key: 'Escape' });
  A('PH-49 Esc 关闭菜单', !documentStub.getElementById('dsh-pet-menu'));
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  globalThis.BOOT = { fake: true }; // BOOT 可用后解禁
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  const disp2 = findRow('派活…');
  A('PH-50 BOOT 可用后「派活…」解禁', !!disp2 && (disp2.getAttribute('class') || '').indexOf('disabled') < 0);
  fire(findRow('背景设置…'), 'click', {});
  A('PH-51 「背景设置…」emit panel:toggle 并关菜单', busSeen.panel === 1 && !documentStub.getElementById('dsh-pet-menu'));
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  fire(findRow('派活…'), 'click', {});
  A('PH-52 「派活…」emit dispatch', busSeen.dispatch === 1);
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  const sizeRow = menuRows().find((r) => labelOf(r).indexOf('尺寸') === 0); // 动态数字标签：前缀匹配
  const sc0 = CORE.load().pet.scale;
  const scExp = [0.75, 1, 1.25, 1.5].find((v) => v > sc0 + 0.01) || 0.75;
  fire(sizeRow, 'click', {});
  A('PH-53 「尺寸」项按 75→100→125→150 循环', close(CORE.load().pet.scale, scExp, 1e-3),
    'sc0=' + sc0 + ' 期望=' + scExp + ' 实际=' + CORE.load().pet.scale);
  fire(canvasEl, 'contextmenu', { clientX: 300, clientY: 200 });
  fire(findRow('睡觉休息'), 'click', {});
  A('PH-54 菜单指定「睡觉休息」生效', PET.state() === 'sleep', 'state=' + PET.state());
  PET.setState('idle', { force: true });

  // scale 钳位
  for (let i = 0; i < 40; i++) fire(canvasEl, 'wheel', { deltaY: -100 });
  A('PH-55 放大钳在 ' + SCALE_MAX, CORE.load().pet.scale <= SCALE_MAX, 'scale=' + CORE.load().pet.scale);
  for (let i = 0; i < 80; i++) fire(canvasEl, 'wheel', { deltaY: 100 });
  A('PH-56 缩小钳在 ' + SCALE_MIN, CORE.load().pet.scale >= SCALE_MIN, 'scale=' + CORE.load().pet.scale);

  // stop：彻底清场
  PET.stop();
  A('PH-57 stop 拆掉 stage/nudge/menu', !documentStub.getElementById('dsh-pet-stage')
    && !documentStub.getElementById('dsh-pet-nudge') && !documentStub.getElementById('dsh-pet-menu'));
  A('PH-58 stop 后 rAF/定时器归零', vRaf.size === 0 && vTimers.length === 0, 'raf=' + vRaf.size + ' timers=' + vTimers.length);
  const callsAfter = canvasEl._ctx.calls.length;
  advance(3000);
  A('PH-59 stop 后手动 tick 无任何副作用', canvasEl._ctx.calls.length === callsAfter && vRaf.size === 0);
});

/* ══ 相位 IDEM：重复 start 幂等 ══ */
phase('IDEM 幂等 start', () => {
  let threw = null;
  try { PET.start(); PET.start(); } catch (e) { threw = e; }
  A('IDEM-01 重复 start 幂等(body 下 stage 只一份、不抛错)', !threw
    && body.childNodes.filter((n) => n.getAttribute && n.getAttribute('id') === 'dsh-pet-stage').length === 1, threw && threw.message);
  PET.stop();
});
/* ══ 相位 BADIMG：meta 齐但图解码失败 → 降级「精灵图未就绪」，不抛错不消失 ══ */
phase('BADIMG 解码失败降级', () => {
  globalThis.SHEET = { meta: META, dataUrl: 'data:bad://' }; // Image stub 见 'data:bad' 前缀同步 onerror
  CORE.set({ pet: { scale: 1, x: 0.86, y: 0.82, facing: 'right', hidden: false } }, true);
  let threw = null;
  try { PET.start(); advance(32); } catch (e) { threw = e; }
  const cvs = visCanvas();
  A('BADIMG-01 图解码失败不抛错、占位文案转「精灵图未就绪」', !threw && clog(cvs).includes('精灵图未就绪'), threw && threw.message);
  PET.stop();
});

/* ══ 相位 RA：合成小 meta（像素锚点 + 无 display 字段）走完整渲染路径 ══════
 * 这是工具内置夹具（非生产图集）：专门覆盖 cellMeta() 的另一半归一化规则 ——
 * anchor 用像素值（>1 即像素）、无 display ⇒ dsp 回落 cell×displayScale(1)。
 * 生产 pet.json 只走「归一化 anchor + display 补偿」路径（RB/RUN 覆盖）。 */
const SYN1 = {
  cell: { w: 96, h: 120 }, cols: 8, rows: 5, anchor: { x: 48, y: 118 }, baselineY: 118,
  states: {
    idle: { fps: 6, loop: true, frames: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    wait: { fps: 5, loop: true, frames: [[4, 0], [5, 0]] },
    walk: { fps: 10, loop: true, pingpong: false, mirrorable: true, facing: 'right', frames: [[0, 1], [1, 1], [2, 1], [3, 1]] },
    react: { fps: 12, loop: false, next: 'idle', frames: [[4, 1], [5, 1], [6, 1], [7, 1], [0, 2], [1, 2]] },
    working: { fps: 7, loop: true, frames: [[2, 2], [3, 2]] },
    sleep: { fps: 2, loop: true, frames: [[4, 2], [5, 2]] },
  },
};
phase('RA 合成meta渲染路径', () => {
  globalThis.SHEET = { meta: SYN1, dataUrl: 'data:image/png;base64,AAAA' };
  CORE.set({ pet: { scale: 1, x: 0.86, y: 0.82, facing: 'right', hidden: false, locked: false, roam: false, fpsScale: 1 } }, true);
  canvasCreated = 0;
  PET.start();
  advance(32);
  const g = geomExp(SYN1, 1); // W=120 H=150 dh=120 dw=96 x0=12 y0=30 k=1
  A('RA-01 离屏预切 cols*rows 格 + 1 舞台画布(=' + (SYN1.cols * SYN1.rows + 1) + ')', canvasCreated === SYN1.cols * SYN1.rows + 1,
    'created=' + canvasCreated);
  const sc = visCanvas();
  A('RA-02 无 display 回落: 元素 CSS = cell×scale×PAD = ' + g.W + 'x' + g.H,
    close(parseFloat(sc.style.width), g.W, 1) && close(parseFloat(sc.style.height), g.H, 1),
    sc.style.width + ' ' + sc.style.height);
  A('RA-03 物理画布 = 元素×dpr' + DPR + ' = ' + Math.round(g.W * DPR) + 'x' + Math.round(g.H * DPR),
    sc.width === Math.round(g.W * DPR) && sc.height === Math.round(g.H * DPR), sc.width + 'x' + sc.height);
  // 镜像：mirrorable 状态 + facing=left → ctx.scale(-1,1)
  sc._ctx.calls.length = 0;
  PET.setState('walk', { force: true });
  CORE.set({ pet: { facing: 'left' } }, true);
  advance(32);
  A('RA-04 mirrorable+facing=left → ctx.scale(-1,1) 镜像', sc._ctx.calls.some((c) => c[0] === 'scale' && c[1] === -1));
  sc._ctx.calls.length = 0;
  CORE.set({ pet: { facing: 'right' } }, true);
  advance(32);
  const dc = lastCellDraw(sc);
  A('RA-05 facing=right 不镜像且画预切小图', !sc._ctx.calls.some((c) => c[0] === 'scale' && c[1] === -1) && !!dc);
  A('RA-06 uniform 绘制: dh=' + g.dh + ' dw=' + g.dw.toFixed(2) + ' dx=' + g.x0.toFixed(2) + ' dy=' + g.y0,
    dc && close(dc[10], g.dh, 0.01) && close(dc[9], g.dw, 0.01) && close(dc[8], g.y0, 0.01) && close(dc[7], g.x0, 0.01),
    dc ? JSON.stringify(dc.slice(7, 11).map((v) => +(+v).toFixed(2))) : '无 cell 绘制');
  // 像素锚点：bx = x0+ax*k = W/2；by = y0+baselineY*k
  const bb = PET.bounds();
  A('RA-07 像素锚点 bounds: bx=W/2=' + g.bx + ' by=y0+baselineY*k=' + g.by.toFixed(3),
    close(0.86 * VW - bb.x, g.bx, 0.5) && close(0.82 * VH - bb.y, g.by, 0.5),
    'bx=' + (0.86 * VW - bb.x).toFixed(2) + ' by=' + (0.82 * VH - bb.y).toFixed(2));
  // react 单次时长 = frames/fps（fpsScale 钉 1 隔离 sanitize 默认值）：6帧@12fps=500ms
  PET.setState('idle', { force: true });
  CORE.set({ pet: { fpsScale: 1 } }, true);
  fire(sc, 'pointerdown', { button: 0, pointerId: 9, clientX: 300, clientY: 300 });
  fire(sc, 'pointerup', { button: 0, pointerId: 9, clientX: 300, clientY: 300 });
  advance(470);
  A('RA-08 react(6帧@12fps=500ms) 470ms 时仍在播', PET.state() === 'react', 'state=' + PET.state());
  advance(60);
  A('RA-09 播完按 meta.next 回 idle', PET.state() === 'idle', 'state=' + PET.state());
  PET.stop();
});

/* ══ 相位 RB：归一化 anchor{x:0.5,y:1} + baselineY 差分（清单 d 运行时侧）══════
 * 夹具刻意令 anchor.y(→150px) 与 baselineY(134px) 不同：引擎若错用 anchor.y，
 * by 会得 280 而非 256.1 —— 差分断言抓"baselineY 像素行优先于 anchor.y"。 */
const SYN2 = {
  cell: { w: 112, h: 150 }, cols: 8, rows: 2, display: { w: 192, h: 224 },
  anchor: { x: 0.5, y: 1 }, baselineY: 134,
  states: {
    idle: { fps: 7, loop: true, pingpong: true, mirrorable: false, frames: [[0, 0], [1, 0], [2, 0]] },
    wait: { fps: 5, loop: true, pingpong: true, mirrorable: false, frames: [[3, 0]] },
    walk: { fps: 8, loop: true, pingpong: true, mirrorable: true, frames: [[4, 0], [5, 0], [6, 0]] },
    react: { fps: 9, loop: false, pingpong: true, mirrorable: false, frames: [[7, 0]] },
    working: { fps: 8, loop: true, pingpong: true, mirrorable: false, frames: [[0, 1]] },
    sleep: { fps: 4, loop: true, pingpong: true, mirrorable: false, frames: [[1, 1]] },
    supervise: { fps: 7, loop: true, pingpong: true, mirrorable: false, frames: [[2, 1]] },
    dead: { fps: 8, loop: true, pingpong: true, mirrorable: false, frames: [[3, 1]] },
  },
  views: {},
};
phase('RB display补偿+锚点差分', () => {
  globalThis.SHEET = { meta: SYN2, dataUrl: 'data:image/png;base64,AAAA' };
  CORE.set({ pet: { scale: 1, x: 0.86, y: 0.82, facing: 'right', hidden: false, locked: false, roam: false, fpsScale: 1 } }, true);
  PET.start();
  advance(32);
  const g = geomExp(SYN2, 1); // W=240 H=280 dh=224 dw=167.25 x0=36.37 y0=56 k=1.4933 bx=120 by=256.107
  const sc = visCanvas();
  A('RB-01 display 补偿: 元素 CSS 精确回基线 ' + g.W + 'x' + g.H,
    sc.style.width === g.W + 'px' && sc.style.height === g.H + 'px', sc.style.width + ' ' + sc.style.height);
  A('RB-02 物理画布 = 元素×dpr' + DPR + ' = ' + g.W * DPR + 'x' + g.H * DPR,
    sc.width === g.W * DPR && sc.height === g.H * DPR, sc.width + 'x' + sc.height);
  const bb = PET.bounds();
  A('RB-03 归一化 anchor.x=0.5 ⇒ bx=W/2=' + g.bx, close(0.86 * VW - bb.x, g.bx, 0.01),
    'bx=' + (0.86 * VW - bb.x).toFixed(3));
  A('RB-04 baselineY 定 by = y0+baselineY*k = ' + g.by.toFixed(3), close(0.82 * VH - bb.y, g.by, 0.01),
    'by=' + (0.82 * VH - bb.y).toFixed(3));
  // 差分：若引擎错用 anchor.y(=1 → cell.h=150px) 则 by=y0+dh=H=280，与 256.1 差 23.9px
  if (Math.abs(g.ay - g.ayAlt) > 1) {
    A('RB-05 baselineY 优先于 anchor.y(差分 ' + Math.abs(g.by - g.byAlt).toFixed(1) + 'px)',
      Math.abs((0.82 * VH - bb.y) - g.byAlt) > 5, 'by=' + (0.82 * VH - bb.y).toFixed(3) + ' 误用anchor.y会得 ' + g.byAlt.toFixed(3));
  } else SKIP('RB-05 baselineY/anchor.y 差分', '两者换算后相同，无差分可判');
  const dc = lastCellDraw(sc);
  A('RB-06 uniform 无形变: dh=' + g.dh + ' dw=dh×cell.w/cell.h=' + g.dw.toFixed(2) + ' dx=' + g.x0.toFixed(2) + ' dy=' + g.y0.toFixed(2),
    dc && close(dc[10], g.dh, 0.01) && close(dc[9], g.dw, 0.01) && close(dc[8], g.y0, 0.01) && close(dc[7], g.x0, 0.01),
    dc ? JSON.stringify(dc.slice(7, 11).map((v) => +(+v).toFixed(2))) : '无 cell 绘制');
  PET.stop();
});
/* ══ 相位 RUN：真实 meta 跑引擎 —— 预切/元素尺寸/状态可达/菜单集合(清单 e)/锚点(清单 d)/内容容量(清单 b,c) ══ */
phase('RUN 真实meta引擎', () => {
  globalThis.SHEET = { meta: META, dataUrl: 'data:image/png;base64,AAAA' };
  CORE.set({ pet: { scale: 1, x: 0.86, y: 0.82, facing: 'right', hidden: false, locked: false, roam: false, fpsScale: 1 } }, true);
  const cc0 = canvasCreated;
  PET.start(); // start 会重置 idleAt：本相位离 300s 睡眠线很远
  advance(32);
  const g = geomExp(META, 1);
  const sc = visCanvas();
  A('RUN-E01 buildCells 预切 ' + META.cols + 'x' + META.rows + '=' + (META.cols * META.rows) + ' 格(+1 可见画布)',
    canvasCreated - cc0 === META.cols * META.rows + 1, 'created=' + (canvasCreated - cc0));
  const wPx = parseFloat(sc.style.width), hPx = parseFloat(sc.style.height);
  // 清单 b)：元素尺寸 = display{w,h} × scale × PAD —— 期望全部从 meta 推导
  A('RUN-E02 元素 CSS 尺寸 = display×scale×PAD = ' + g.W.toFixed(1) + 'x' + g.H.toFixed(1) + ' (±1px)',
    close(wPx, g.W, 1) && close(hPx, g.H, 1), sc.style.width + ' ' + sc.style.height);
  if (g.dspW === 192 && g.dspH === 224) { // 生产基线条件锚点：display 192×224 ⇒ 必得 240×280
    A('RUN-E03 生产 display 192x224 ⇒ 基线 240x280 (±1px)', close(wPx, 240, 1) && close(hPx, 280, 1),
      sc.style.width + ' ' + sc.style.height);
  } else say('[!] RUN-E03 条件锚点未触发(display=' + g.dspW + 'x' + g.dspH + '≠192x224)，跳过生产基线 240x280');
  A('RUN-E04 物理画布 = 元素×dpr' + DPR + ' = ' + Math.round(g.W * DPR) + 'x' + Math.round(g.H * DPR),
    sc.width === Math.max(1, Math.round(g.W * DPR)) && sc.height === Math.max(1, Math.round(g.H * DPR)), sc.width + 'x' + sc.height);
  // 8 个引擎状态全部可达（setState force）
  for (const nm of NAMES_WHITELIST) {
    PET.setState(nm, { force: true }); advance(20);
    A('RUN-E05.' + nm + ' setState 可达', PET.state() === nm, 'got ' + PET.state());
  }
  PET.setState('idle', { force: true }); advance(20);

  /* 清单 e)：菜单标签集合与 pet.js menuItems 一致 ——
   * 8 个模式标签 + 固定标签精确匹配；带动态数字的标签（尺寸/速度/音效/漫游/素材）只用前缀匹配。 */
  const MODE_LABELS = ['待机眨眼', '修bug', '加载等待', '敲代码', '庆祝完成', '睡觉休息', '报错装死', '监工模式'];
  const FIXED_LABELS = ['锁定位置', '放大', '缩小', '加速', '减速', '背景设置…', '派活…', '重置位置',
    CORE.load().pet.hidden ? '召唤桌宠' : '隐藏桌宠'];
  const PREFIX_LABELS = ['尺寸 ', '速度 ', '音效 ', '漫游 ', '素材：'];
  fire(sc, 'contextmenu', { clientX: 300, clientY: 200 }); // 开菜单（顺带 markActivity 刷新空闲计时）
  const labels = menuLabels();
  MODE_LABELS.forEach((t, i) => {
    A('RUN-M0' + (i + 1) + ' 模式标签「' + t + '」在菜单', labels.includes(t), labels.join('|'));
  });
  const fixedMissing = FIXED_LABELS.filter((t) => !labels.includes(t));
  A('RUN-M09 固定标签齐全(' + FIXED_LABELS.length + '项)', fixedMissing.length === 0, '缺: ' + fixedMissing.join(','));
  const prefixMissing = PREFIX_LABELS.filter((p) => !labels.some((l) => l.indexOf(p) === 0));
  A('RUN-M10 动态数字标签按前缀命中(尺寸/速度/音效/漫游/素材)', prefixMissing.length === 0, '缺前缀: ' + prefixMissing.join(','));
  const total = MODE_LABELS.length + FIXED_LABELS.length + PREFIX_LABELS.length;
  A('RUN-M11 标签集合与 menuItems 完全一致(共' + total + '项, 无未知项)',
    labels.length === total && labels.every((l) => MODE_LABELS.includes(l) || FIXED_LABELS.includes(l) || PREFIX_LABELS.some((p) => l.indexOf(p) === 0)),
    'n=' + labels.length + ': ' + labels.join('|'));
  A('RUN-M12 前 8 项即模式区且顺序固定', JSON.stringify(labels.slice(0, 8)) === JSON.stringify(MODE_LABELS), labels.slice(0, 8).join('|'));
  // 菜单→状态接线 + dead/supervise 不被空闲漫游抢走
  const rowSup = findRow('监工模式');
  if (rowSup) fire(rowSup, 'click', {});
  A('RUN-E13 点「监工模式」→ supervise 且关漫游', !!rowSup && PET.state() === 'supervise' && CORE.load().pet.roam === false,
    'state=' + PET.state() + ' roam=' + CORE.load().pet.roam);
  fire(sc, 'contextmenu', { clientX: 300, clientY: 200 });
  const rowDead = findRow('报错装死');
  if (rowDead) fire(rowDead, 'click', {});
  A('RUN-E14 点「报错装死」→ dead', !!rowDead && PET.state() === 'dead', 'state=' + PET.state());
  advance(IDLE_ROAM_MS);
  A('RUN-E15 dead/supervise 不被空闲漫游抢走(' + IDLE_ROAM_MS / 1000 + 's 后仍 dead)', PET.state() === 'dead', 'state=' + PET.state());
  // 清单 d) 运行时：锚点 = 脚底中心；bx=W/2、by=y0+baselineY×k；stage 落点 = footPx - 锚点
  const bb = PET.bounds();
  A('RUN-E16 锚点 bx = 脚底水平中心 W/2 = ' + (g.W / 2).toFixed(2), close(0.86 * VW - bb.x, g.W / 2, 0.01),
    'bx=' + (0.86 * VW - bb.x).toFixed(3));
  A('RUN-E17 by = y0 + baselineY×k = ' + g.by.toFixed(3) + ' (k=' + g.k.toFixed(4) + ')', close(0.82 * VH - bb.y, g.by, 0.01),
    'by=' + (0.82 * VH - bb.y).toFixed(3));
  if (Math.abs(g.ay - g.ayAlt) > 1) {
    A('RUN-E18 baselineY(像素行)优先于 anchor.y(差分 ' + Math.abs(g.by - g.byAlt).toFixed(1) + 'px)',
      Math.abs((0.82 * VH - bb.y) - g.byAlt) > 5, 'by=' + (0.82 * VH - bb.y).toFixed(3) + ' 误用anchor.y会得 ' + g.byAlt.toFixed(3));
  } else SKIP('RUN-E18 baselineY 差分', 'baselineY 与 anchor.y 换算后相同，无差分可判');
  const stageNow = documentStub.getElementById('dsh-pet-stage');
  A('RUN-E19 stage 落点 = round(footPx - 锚点) = (' + Math.round(0.86 * VW - g.bx) + ',' + Math.round(0.82 * VH - g.by) + ')',
    !!stageNow && close(parseFloat(stageNow.style.left), Math.round(0.86 * VW - g.bx), 1)
    && close(parseFloat(stageNow.style.top), Math.round(0.82 * VH - g.by), 1),
    stageNow ? stageNow.style.left + ' ' + stageNow.style.top : '无 stage');
  // 清单 b/c)：uniform 无形变 + 内容屏幕 CSS px（k=dh/cell.h 反算内容盒，排除按 cell 等比的 168×200 教训）
  const dc = lastCellDraw(sc);
  A('RUN-E20 uniform 绘制: dh=dsp.h×scale=' + g.dh.toFixed(2) + ' dw=dh×cell.w/cell.h=' + g.dw.toFixed(2)
    + ' dx=(W-dw)/2=' + g.x0.toFixed(2) + ' dy=y0=' + g.y0.toFixed(2),
    dc && close(dc[10], g.dh, 0.01) && close(dc[9], g.dw, 0.01) && close(dc[8], g.y0, 0.01) && close(dc[7], g.x0, 0.01),
    dc ? JSON.stringify(dc.slice(7, 11).map((v) => +(+v).toFixed(2))) : '无 cell 绘制');
  const cb = META.source && META.source.cellBox;
  if (cb && cb.w > 0 && cb.h > 0) {
    const kEng = dc ? dc[10] / META.cell.h : g.k;      // 以实绘 dh 反推引擎真实 k（cell px → CSS px）
    const cW = cb.w * kEng, cH = cb.h * kEng;           // 内容上屏 CSS px（scale=1 语义）
    const wrongK = g.dspW / g.cw;                       // 错误路线：按 display.w/cell.w 逐轴等比
    const prodAnchor = (g.dspW === 192 && g.dspH === 224 && g.cw === 112 && g.ch === 150); // 生产 cellBox 98×118 ⇒ 146×176
    A('RUN-E21 内容屏幕 CSS px 宽 = cellBox.w×k = ' + cW.toFixed(1) + (prodAnchor ? ' (生产基线 146)' : ''),
      close(cW, cb.w * g.k, 0.5) && (!prodAnchor || Math.round(cW) === 146), 'cW=' + cW.toFixed(2));
    A('RUN-E22 内容屏幕 CSS px 高 = cellBox.h×k = ' + cH.toFixed(1) + (prodAnchor ? ' (生产基线 176; 118×224/150=176.2)' : ''),
      close(cH, cb.h * g.k, 1.5) && (!prodAnchor || Math.round(cH) === 176), 'cH=' + cH.toFixed(2));
    if (Math.abs(wrongK - g.k) > 0.01) { // 差分守卫：只断言元素尺寸抓不出内容盒取错的 bug
      A('RUN-E23 内容宽排除按 cell 等比误取(错误值 ' + (cb.w * wrongK).toFixed(1) + ')', Math.abs(cW - cb.w * wrongK) > 5,
        'cW=' + cW.toFixed(1) + ' vs 错误 ' + (cb.w * wrongK).toFixed(1));
      A('RUN-E24 内容高排除按 cell 等比误取(错误值 ' + (cb.h * wrongK).toFixed(1) + ', 偏大约13.6%的教训)',
        Math.abs(cH - cb.h * wrongK) > 5, 'cH=' + cH.toFixed(1) + ' vs 错误 ' + (cb.h * wrongK).toFixed(1));
    } else SKIP('RUN-E23/24 内容盒差分', 'display.w/cell.w ≈ display.h/cell.h，两种 k 无差分');
    say('[!] 内容容量: k=' + kEng.toFixed(4) + ' 内容盒 ' + cb.w + 'x' + cb.h + ' ⇒ 上屏 ' + cW.toFixed(1) + 'x' + cH.toFixed(1)
      + ' CSS px（若按 cell 等比会误取 ' + (cb.w * wrongK).toFixed(1) + 'x' + (cb.h * wrongK).toFixed(1) + '）');
  } else SKIP('RUN-E21..E24 内容屏幕 CSS px', 'meta 无 source.cellBox，内容盒不可推导');
});

/* ══ 相位 FPS：每帧现算 fps 语义（清单 f）—— 改 fpsScale 后帧间隔立刻变化，无 reload ══
 * 间隔理论值 = 1000/(meta.fps×fpsScale)，从 meta 推导；16ms 步长量化 ⇒ 容差 max(20ms, 18%)。
 * 生产 meta 参照值：idle 141→117ms(1→1.2)、walk 124→89ms(1→1.4)。 */
phase('FPS 每帧现算帧率', () => {
  fire(windowObj, 'keydown', { key: 'Shift' }); // 刷新 idleAt：测量窗远离 300s 睡眠线
  const stIdle = META.states && META.states.idle;
  const stWalk = META.states && META.states.walk;
  const canMeasure = (s) => s && Array.isArray(s.frames) && s.frames.length >= 2 && s.fps > 0;
  if (!canMeasure(stIdle) || !canMeasure(stWalk)) {
    SKIP('FPS-01..05 帧间隔实测', 'idle/walk 帧数<2 或 fps 缺失：cid 不变化，无法测间隔');
    return;
  }
  const tol = (fps) => Math.max(20, (1000 / fps) * 0.18);
  CORE.set({ pet: { fpsScale: 1 } }, true);
  const idleA = measureGaps('idle', 2400);
  const theoA = 1000 / stIdle.fps;
  A('FPS-01 idle fpsScale=1 帧间隔 ≈ ' + theoA.toFixed(1) + 'ms (=1000/meta.fps)',
    Math.abs(idleA.mean - theoA) <= tol(stIdle.fps) && idleA.n >= 5, idleA.mean.toFixed(1) + 'ms n=' + idleA.n);
  fire(visCanvas(), 'contextmenu', { clientX: 300, clientY: 200 });
  const rowUp = findRow('加速');
  if (rowUp) fire(rowUp, 'click', {}); // 菜单点击写 fpsScale，不重进状态、不 reload
  const upVal = Math.round((1 + SPEED_STEP) * 10) / 10;
  A('FPS-02 点「加速」写入 fpsScale 1→' + upVal, !!rowUp && close(CORE.load().pet.fpsScale, upVal, 0.001),
    'got ' + CORE.load().pet.fpsScale);
  const idleB = measureGaps(null, 2400);
  const theoB = 1000 / (stIdle.fps * upVal);
  // 0.92 系数：16ms 步长量化下的"立刻变小"判据（生产参照 141→117ms）
  A('FPS-03 idle 帧间隔点击后立即变小: ' + idleA.mean.toFixed(0) + '→' + idleB.mean.toFixed(1) + 'ms (理论 ' + theoB.toFixed(1) + ')',
    idleB.mean < idleA.mean * 0.92 && idleB.n > 5 && Math.abs(idleB.mean - theoB) <= tol(stIdle.fps * upVal),
    idleA.mean.toFixed(1) + '→' + idleB.mean.toFixed(1) + 'ms n=' + idleB.n);
  CORE.set({ pet: { fpsScale: 1 } }, true);
  const walkA = measureGaps('walk', 2400);
  A('FPS-04 walk fpsScale=1 帧间隔 ≈ ' + (1000 / stWalk.fps).toFixed(1) + 'ms',
    Math.abs(walkA.mean - 1000 / stWalk.fps) <= tol(stWalk.fps) && walkA.n >= 5, walkA.mean.toFixed(1) + 'ms n=' + walkA.n);
  CORE.set({ pet: { fpsScale: 1.4 } }, true);
  const walkB = measureGaps(null, 2400);
  // 0.82 系数：1→1.4 的理论比 1/1.4=0.714 + 量化余量（生产参照 124→89ms）
  A('FPS-05 walk fpsScale 1→1.4 帧间隔立即按比例变小: ' + walkA.mean.toFixed(0) + '→' + walkB.mean.toFixed(1) + 'ms (理论 ' + (1000 / (stWalk.fps * 1.4)).toFixed(1) + ')',
    walkB.mean < walkA.mean * 0.82 && walkB.n > 5 && Math.abs(walkB.mean - 1000 / (stWalk.fps * 1.4)) <= tol(stWalk.fps * 1.4),
    walkA.mean.toFixed(1) + '→' + walkB.mean.toFixed(1) + 'ms n=' + walkB.n);
  say('[!] 帧间隔实测: idle ' + idleA.mean.toFixed(1) + '→' + idleB.mean.toFixed(1) + 'ms (1→' + upVal + ', 菜单点击)  walk '
    + walkA.mean.toFixed(1) + '→' + walkB.mean.toFixed(1) + 'ms (1→1.4)  步长量化±16ms');
});

/* ══ 相位 SPD：速度组操作 —— 标签读实时配置 / 步进 / 钳位 / 点标签复位 / 与尺寸组互不串味 ══ */
phase('SPD 速度组操作', () => {
  CORE.set({ pet: { fpsScale: 1.5 } }, true);
  fire(visCanvas(), 'contextmenu', { clientX: 300, clientY: 200 });
  A('SPD-01 标签读实时配置: 存过 1.5 → 「速度 1.5×」', !!findRow('速度 1.5×'),
    menuLabels().filter((t) => t.indexOf('速度') === 0).join('|'));
  const r1 = findRow('加速');
  if (r1) fire(r1, 'click', {});
  A('SPD-02 加速步进 +' + SPEED_STEP + ' → ' + (Math.round(1.7 * 10) / 10), close(CORE.load().pet.fpsScale, 1.7, 0.001),
    'got ' + CORE.load().pet.fpsScale);
  CORE.set({ pet: { fpsScale: SPEED_MAX - 0.1 } }, true);
  fire(visCanvas(), 'contextmenu', { clientX: 300, clientY: 200 });
  const r2 = findRow('加速');
  if (r2) fire(r2, 'click', {});
  A('SPD-03 加速上限钳 ' + SPEED_MAX, CORE.load().pet.fpsScale === SPEED_MAX, 'got ' + CORE.load().pet.fpsScale);
  CORE.set({ pet: { fpsScale: SPEED_MIN + 0.1 } }, true);
  fire(visCanvas(), 'contextmenu', { clientX: 300, clientY: 200 });
  const r3 = findRow('减速');
  if (r3) fire(r3, 'click', {});
  A('SPD-04 减速下限钳 ' + SPEED_MIN, close(CORE.load().pet.fpsScale, SPEED_MIN, 0.001), 'got ' + CORE.load().pet.fpsScale);
  fire(visCanvas(), 'contextmenu', { clientX: 300, clientY: 200 });
  const minLabel = '速度 ' + SPEED_MIN.toFixed(1) + '×';
  A('SPD-05 此时标签「' + minLabel + '」', !!findRow(minLabel), menuLabels().filter((t) => t.indexOf('速度') === 0).join('|'));
  const r4 = findRow(minLabel);
  if (r4) fire(r4, 'click', {}); // 点速度标签 = 复位默认倍率
  A('SPD-06 点速度标签 → 恢复默认 ' + DEF_FPS_SCALE, close(CORE.load().pet.fpsScale, DEF_FPS_SCALE, 0.001),
    'got ' + CORE.load().pet.fpsScale);
  A('SPD-07 速度组与尺寸组互不串味(scale 仍=1)', CORE.load().pet.scale === 1, 'got ' + CORE.load().pet.scale);
  PET.stop();
});

/* ══ 相位 END：收尾清场 ══ */
phase('END 收尾', () => {
  PET.stop();
  A('END-01 最终 stop 清场: 浮层全拆、rAF/定时器归零',
    !documentStub.getElementById('dsh-pet-stage') && !documentStub.getElementById('dsh-pet-menu')
    && !documentStub.getElementById('dsh-pet-nudge') && vRaf.size === 0 && vTimers.length === 0,
    'raf=' + vRaf.size + ' timers=' + vTimers.length);
});

finish();

/* ── 汇总：FAIL 逐条原因 + 末行固定格式；M>0 → exit(1)，全过 → exit(0) ── */
function finish() {
  if (fail > 0) {
    say('[!] ==== FAIL 明细 (' + fail + ' 条) ====');
    fails.forEach((f, i) => say('  ' + (i + 1) + ') ' + f));
  }
  say('smoke: ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}