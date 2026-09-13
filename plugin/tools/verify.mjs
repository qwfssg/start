/* tools/verify.mjs —— 浏览器验收页生成器（不依赖任何测试框架）。
 *
 * 为什么要有它：本插件全部行为都在运行时 DOM 上，单测假 DOM 覆盖不到层叠上下文、
 * elementFromPoint、backdrop-filter 这些真实效果。生成的页面刻意复刻了宿主结构，
 * 包含那个把 dsh-bg 坑暴露出来的构造：设置弹窗(z-index:1000) 挂在 _sidebarCol
 * (overflow:hidden) 里，而对话区有一条 position:sticky;z-index:5 的顶栏。
 * → 只要插件敢给宿主容器造层叠上下文或洗透明，这些断言就会红。
 *
 * 用法：node tools/verify.mjs            # 只生成 verify.html
 *      node tools/verify.mjs --run      # 生成后顺手用 headless Edge 跑一遍并打印 JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(ROOT, 'lib', 'client.js');
const OUT = path.join(ROOT, 'verify.html');

if (!fs.existsSync(BUNDLE)) {
  console.error('先跑 node tools/assemble.mjs 生成 lib/client.js');
  process.exit(1);
}
const bundle = fs.readFileSync(BUNDLE, 'utf8');

const shell = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>pending</title><style>
:root{--dsw-alias-bg-layer-2:#ffffff;--dsw-alias-bg-mask-1:rgba(0,0,0,.24);--dsw-mask-blur:blur(2px);
--dsw-alias-label-primary:#111111;--dsw-alias-border-l3:rgba(0,0,0,.14)}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#f4f5f7;font:14px/1.6 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:#111}
.pI_x6G_frame{position:relative;display:flex;height:100%}
.pI_x6G_sidebarCol{width:280px;overflow:hidden;border-right:1px solid #ddd;background:#fafafa;position:relative}
.pI_x6G_centerCol{flex:1;position:relative}
.pI_x6G_overlayLayer{position:absolute;inset:0;z-index:20;pointer-events:none}
.bar{position:sticky;top:0;z-index:5;height:40px;background:#eef0f3;border-bottom:1px solid #ddd}
.card{height:120px;margin:12px;padding:12px;background:#fff;border:1px solid #e3e3e3;border-radius:8px}
.VOzbGW_overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}
.VOzbGW_mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.VOzbGW_panel{position:relative;width:640px;max-width:80vw;height:420px;background:var(--dsw-alias-bg-layer-2);
border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:16px;box-shadow:0 24px 64px rgba(0,0,0,.24)}
#toggle-modal{position:absolute;left:12px;top:52px;z-index:30}
</style></head><body>
<div class="pI_x6G_frame">
  <div class="pI_x6G_sidebarCol" id="sidebar">设置区
    <button id="toggle-modal" type="button">打开设置</button>
    <div class="VOzbGW_overlay" id="modal" hidden><div class="VOzbGW_mask"></div>
      <div class="VOzbGW_panel"><h3>设置</h3><input id="modal-input" type="text" value="可编辑"></div></div>
  </div>
  <div class="pI_x6G_centerCol"><div class="bar">会话顶栏（sticky, z=5）</div>
    <div class="card" id="card-a">消息 A</div><div class="card">消息 B</div>
    <div class="pI_x6G_overlayLayer"></div>
    <button id="stop-btn" hidden aria-label="停止当前任务">停止</button>
  </div>
</div>
<pre id="out">pending</pre>
<script>
/* 先装错误钩子，再加载插件本体，否则启动期的 console.error 会漏采 */
window.__errs = [];
var oe = console.error;
console.error = function () { window.__errs.push("console.error: " + Array.prototype.join.call(arguments, " ")); oe.apply(console, arguments); };
/* 未捕获异常不走 console.error：setInterval/rAF 里抛错会被静默吞掉，
 * 表现就是"兜底轮询好像根本没跑"。必须一并采上来。 */
window.addEventListener("error", function (e) { window.__errs.push("uncaught: " + (e.message || e.error) + " @" + (e.filename || "") + ":" + (e.lineno || 0)); });
window.addEventListener("unhandledrejection", function (e) { window.__errs.push("rejection: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason))); });
</script>
<script>${bundle}</script>
<script>
(function () {
  var R = { pass: [], fail: [], notes: [], consoleErrors: [] };
  function ok(name, cond, extra) { (cond ? R.pass : R.fail).push(name + (extra === undefined ? '' : ' :: ' + extra)); }
  function num(v) { return Math.round(Number(v) * 1000) / 1000; }
  var D = window.__DSH_PET_BG__;
  var dbg = function () { return D ? D.debug() : null; };

  ok('bundle 暴露了 apply/inject 并自动挂载（window.__DSH_PET_BG__ 存在）', !!D);
  if (!D) { finish(); return; }

  /* 1. 挂载位置铁律：全部浮层必须是 body 直接子节点 */
  var ids = ['dsh-pet-video', 'dsh-pet-stage', 'dsh-pet-panel'];
  ids.forEach(function (id) {
    var n = document.getElementById(id);
    ok('#' + id + ' 存在', !!n);
    if (n) ok('#' + id + ' 是 body 直接子节点（不嵌进宿主容器）', n.parentElement === document.body, n.parentElement && n.parentElement.className || 'body');
  });

  /* 2. 绝不碰宿主层级 */
  var frame = document.querySelector('.pI_x6G_frame'), col = document.querySelector('.pI_x6G_sidebarCol');
  var cs = getComputedStyle(col), fs2 = getComputedStyle(frame);
  ok('_sidebarCol 未被插件加 z-index', cs.zIndex === 'auto' || cs.zIndex === '0', cs.zIndex);
  ok('_frame 未被插件加 z-index/filter', fs2.zIndex === 'auto' && (fs2.filter === 'none'), fs2.zIndex + '/' + fs2.filter);

  /* 3. 回归项：设置弹窗必须完整可见、遮罩没被洗白、面板中心点命中的仍是弹窗 */
  var modal = document.getElementById('modal'), input = document.getElementById('modal-input');
  modal.hidden = false;
  var mask = modal.querySelector('.VOzbGW_mask'), panel = modal.querySelector('.VOzbGW_panel');
  var mbg = getComputedStyle(mask).backgroundColor;
  ok('弹窗遮罩仍是不透明压暗色（未被洗成 transparent）', /rgba\\(0, 0, 0, 0\\.2\\d\\)|rgb\\(0, 0, 0\\)/.test(mbg), mbg);
  var r = panel.getBoundingClientRect();
  var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  ok('弹窗中心命中测试落在弹窗内', hit && (panel.contains(hit) || hit === panel), hit ? (hit.id || hit.className) : 'null');
  input.focus();
  ok('弹窗内输入框可获得焦点', document.activeElement === input);
  modal.hidden = true;

  /* 4. 桌宠：画布尺寸 / 拖动 / 单击 / 滚轮缩放不漂移 */
  var canvas = document.getElementById('dsh-pet-canvas') || document.querySelector('#dsh-pet-stage canvas');
  ok('桌宠 canvas 存在', !!canvas);
  if (canvas) {
    var rect = canvas.getBoundingClientRect();
    ok('canvas 有非零尺寸', rect.width > 20 && rect.height > 20, Math.round(rect.width) + 'x' + Math.round(rect.height));
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height * 0.8;
    function pe(type, x, y, extra) {
      var init = Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }, extra || {});
      canvas.dispatchEvent(new PointerEvent(type, init));
    }
    var before = JSON.parse(JSON.stringify(D.CORE.load().pet));
    pe('pointerdown', cx, cy); pe('pointermove', cx - 60, cy); pe('pointermove', cx - 120, cy); pe('pointerup', cx - 120, cy);
    var dragged = D.CORE.load().pet;
    ok('拖动能改位置（x 比例变小）', dragged.x < before.x - 0.001, num(before.x) + ' -> ' + num(dragged.x));
    var sx = dragged.x, sy = dragged.y;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    var zoomed = D.CORE.load().pet;
    ok('滚轮放大 scale', zoomed.scale > sx === false ? zoomed.scale > before.scale : zoomed.scale > before.scale, num(before.scale) + ' -> ' + num(zoomed.scale));
    ok('缩放不漂移（x/y 不变）', zoomed.x === sx && zoomed.y === sy, num(zoomed.x) + ',' + num(zoomed.y));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    var st0 = D.PET.state();
    pe('pointerdown', cx - 120, cy); pe('pointerup', cx - 120, cy);
    ok('单击触发 react', D.PET.state() === 'react' || st0 === 'react', D.PET.state());
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    var menu = document.getElementById('dsh-pet-menu');
    ok('右键菜单出现', !!menu);
    if (menu) {
      var items = menu.querySelectorAll('button, [role="menuitem"], .dsh-pet-menu-item');
      ok('菜单项 >= 22', items.length >= 22, 'got ' + items.length);
      var labels = Array.prototype.map.call(items, function (b) { return (b.textContent || '').trim(); });
      R.notes.push('菜单项: ' + labels.join(' | '));
      /* 模式条目用素材文件夹名（待机眨眼/修bug/加载等待/敲代码/庆祝完成/睡觉休息/报错装死/监工模式）；
          速度组（加速/减速/速度 N×）与素材状态项（素材：高清外挂 319帧 / 素材：内嵌 162帧（待重启））
          都是动态标签 → 一律按子串匹配，别精确匹配。旧标签「待机/行走/工作/睡眠」已废；探针必须跟着 UI 改，否则是假失败。 */
      ['待机眨眼', '修bug', '加载等待', '敲代码', '庆祝完成', '睡觉休息', '报错装死', '监工模式', '锁定', '背景设置', '放大', '缩小', '加速', '减速', '速度', '派活', '重置', '素材'].forEach(function (k) {
        ok('菜单含「' + k + '」', labels.some(function (t) { return t.indexOf(k) >= 0; }));
      });
      var bgItem = Array.prototype.find.call(items, function (b) { return (b.textContent || '').indexOf('背景设置') >= 0; });
      if (bgItem) {
        /* 三段定位：先确认 BG 自己能开，再确认总线通，最后才是菜单项有没有把事件发出去 */
        D.BG.open(false);
        ok('诊断：BG.open(true) 直接可用', (function () { D.BG.open(true); var p = document.getElementById('dsh-pet-panel'); var d = p && getComputedStyle(p).display; D.BG.open(false); return d !== 'none'; })());
        CORE_bus: {
          D.CORE.emit('panel:toggle');
          var p2 = document.getElementById('dsh-pet-panel');
          ok('诊断：总线 panel:toggle 能开面板', p2 && getComputedStyle(p2).display !== 'none', p2 ? getComputedStyle(p2).display : 'null');
          D.BG.open(false);
        }
        bgItem.click();
        var pn = document.getElementById('dsh-pet-panel');
        ok('菜单「背景设置」能打开面板', pn && !/none/.test(getComputedStyle(pn).display), pn ? getComputedStyle(pn).display : 'null');
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      ok('Esc 关闭菜单', !document.getElementById('dsh-pet-menu') || getComputedStyle(document.getElementById('dsh-pet-menu')).display === 'none');
    }
  }

  /* 5. 会话联动 —— 生产路径是 T1（ctx.remote.$on("api-session/status")），所以驱动它 */
  D.PET.setState('idle', { force: true });
  var trace = [];
  var tStart = Date.now();
  D.CORE.onBus("session", function (d) { trace.push("evt:" + d.phase + "@" + (Date.now() - tStart)); });
  var poll = setInterval(function () { trace.push(D.PET.state() + "@" + (Date.now() - tStart)); }, 150);
  ok("T1 事件通路已挂上（订阅者存在）", window.__t1("sess-probe", true) > 0);
  setTimeout(function () {
    var s1 = D.PET.state();
    ok("T1 running=true → wait（1.5s 内）", s1 === "wait", s1 + " / 档位 " + JSON.stringify(D.BOOT.info().tier));
    var s2 = D.PET.state();
    R.notes.push("700ms 时状态: " + s2 + "（1.5s 前不该就变 working）");
  }, 700);
  setTimeout(function () {
    ok("T1 满 1.6s 后为 working", D.PET.state() === "working", D.PET.state());
    window.__t1("sess-probe", false);
  }, 1700);
  setTimeout(function () {
    clearInterval(poll);
    var s3 = D.PET.state();
    R.notes.push("时间线: " + trace.join(" "));
    ok("T1 running=false → react（庆祝）", s3 === "react", s3);
    ok("派活走 T1：session.prompt 被调用且带 requestId/sessionId", (function () {
      D.BOOT.dispatch("桌宠自检消息");
      var r = window.__lastPrompt;
      return !!(r && r.requestId && r.sessionId && r.content && r.content[0].text === "桌宠自检消息");
    })(), JSON.stringify(window.__lastPrompt && { id: window.__lastPrompt.sessionId, mode: window.__lastPrompt.mode }));
    checkBg();
  }, 2350);

  function checkBg() {
    /* 6. 背景视频层：参数真的落到元素上 */
    D.CORE.set({ bg: { enabled: true, kind: 'url', url: 'about:blank', blur: 8, brightness: 1.4, speed: 1.5, volume: 0.3, muted: false, loop: true, playing: false, fit: 'contain', opacity: 0.8 } }, true);
    D.BG.refresh();
    var layer = document.getElementById('dsh-pet-video'), vid = document.getElementById('dsh-pet-video-clip') || (layer && layer.querySelector('video'));
    if (!vid) { ok('video 元素存在', false); return finish(); }
    ok('video 元素存在', true);
    var f = getComputedStyle(vid).filter;
    ok('filter 含 blur(8px)', /blur\\(8px\\)/.test(f), f);
    ok('filter 含 brightness(1.4)', /brightness\\(1\\.4/.test(f), f);
    ok('inset 随 blur 外扩（避免四周空隙）', getComputedStyle(layer).inset.indexOf('-') === 0, getComputedStyle(layer).inset);
    ok('object-fit = contain', getComputedStyle(vid).objectFit === 'contain', getComputedStyle(vid).objectFit);
    ok('opacity = 0.8', num(getComputedStyle(vid).opacity) === 0.8, getComputedStyle(vid).opacity);
    ok('loop 属性同步', vid.loop === true);
    ok('muted 同步（用户显式取消静音后 video.muted=false）', vid.muted === false);
    var st = D.BG.state();
    R.notes.push('BG.state(): ' + JSON.stringify(st));
    /* 7. 面板控件与配置一一对应 */
    var panel = document.getElementById('dsh-pet-panel');
    var ranges = panel ? panel.querySelectorAll('input[type=range]') : [];
    ok('面板有 >= 4 个滑块', ranges.length >= 4, 'got ' + ranges.length);
    var fileInput = panel ? panel.querySelector('input[type=file]') : null;
    ok('面板有文件上传控件', !!fileInput, fileInput ? fileInput.accept : 'null');
    ok('面板有 URL 输入', !!(panel && panel.querySelector('input[type=url],input[type=text]')));
    var btns = panel ? Array.prototype.map.call(panel.querySelectorAll('button'), function (b) { return (b.textContent || '').trim(); }) : [];
    R.notes.push('面板按钮: ' + btns.join(' | '));
    ['0.5x', '1x', '1.5x', '2x'].forEach(function (p) { ok('速度预设 ' + p, btns.some(function (t) { return t.replace(/\\s/g, '') === p; })); });
    /* 8. 持久化：localStorage 只有小参数，不含大 base64/二进制 */
    var raw = localStorage.getItem('dsh-pet-bg:config') || '';
    ok('localStorage 配置体积 < 2000B', raw.length < 2000, raw.length + 'B');
    ok('localStorage 不含 data: URL', raw.indexOf('data:') < 0);
    ok('落盘值可读回且含 blur=8', JSON.parse(raw || '{}').bg && JSON.parse(raw || '{}').bg.blur === 8);
    /* 9. 关掉背景后层隐藏但 src 保留 */
    D.CORE.set({ bg: { enabled: false } }, true); D.BG.refresh();
    ok('enabled=false 后层 display:none', getComputedStyle(layer).display === 'none', getComputedStyle(layer).display);
    /* 10. 拆干净：stop 之后不留浮层、再 start 不重复 */
    D.BOOT.stop();
    ok('stop() 移除全部浮层', !document.getElementById('dsh-pet-stage') && !document.getElementById('dsh-pet-panel'));
    D.BOOT.start();
    ok('重复 start 不叠加（stage 只有一个）', document.querySelectorAll('#dsh-pet-stage').length === 1);
    D.BOOT.stop();
    finish();
  }

  function finish() {
    R.consoleErrors = (window.__errs || []);
    R.summary = R.pass.length + ' PASS / ' + R.fail.length + ' FAIL';
    document.getElementById('out').textContent = 'PROBE ' + JSON.stringify(R, null, 1);
    document.title = 'PROBE ' + JSON.stringify({ summary: R.summary, fail: R.fail });
  }
})();
</script>
</body></html>`;

/* ModuleLoader 桩：真实宿主是 fetch 后执行；这里用 <script> 直接内联，
 * 只要 factory 契约一致就等价（插件不依赖 require 的任何共享模块时更是如此）。 */
const loaderStub = `<script>
window.__ModuleLoader__ = {
  load: function (mod) {
    var handlers = [];
    var remote = {
      $on: function (name, fn) { handlers.push({ name: name, fn: fn }); return function () { handlers = handlers.filter(function (h) { return h.fn !== fn; }); }; },
      session: { prompt: function (req) { window.__lastPrompt = req; return Promise.resolve({ accepted: true }); } },
    };
    window.__t1 = function (sessionId, running) { handlers.forEach(function (h) { if (h.name === 'api-session/status') h.fn(sessionId, running); }); return handlers.length; };
    var shared = { react: window.React || null, remote: remote, sessions: { list: { getSnapshot: function () { return { byId: { 'sess-1': { running: true } } }; } } } };
    var out = mod.factory(function (name) {
      if (name in shared) return shared[name];
      throw new Error('共享模块不可用: ' + name);
    });
    if (out && typeof out.apply === 'function') { try { out.apply({ slots: null, remote: remote, sessions: shared.sessions }); } catch (e) { console.error('apply 抛错', e); } }
  }
};
</script>`;

fs.writeFileSync(OUT, shell.replace('<script>', loaderStub + '\n<script>'), 'utf8');
console.log(`verify.html  ${Buffer.byteLength(fs.readFileSync(OUT, 'utf8'))} B`);
console.log('跑法：msedge --headless=new --user-data-dir=<tmp> --virtual-time-budget=12000 --window-size=1440,900 --dump-dom file:///' + OUT.replace(/\\/g, '/'));

if (process.argv.includes('--run')) {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!fs.existsSync(edge)) { console.error('没找到 Edge：' + edge); process.exit(2); }
  const dump = path.join(ROOT, 'verify-dump.html');
  const log = path.join(ROOT, 'verify-edge.log');
  /* Edge 的 --user-data-dir 落在沙箱重定向的 C:\Temp 下会建不起来（status 1，且无任何提示），
   * 所以固定用工作区里的目录；stderr 也留档，失败时能看到真正的原因。 */
  const profile = path.join(ROOT, '.edge-profile');
  /* 走 .cmd 文件而不是把整串命令塞进 execFileSync 的 argv：Node 为 cmd.exe 重排引号，
   * 内层带空格的路径会被转义成字面量引号，Edge 直接以 status 1 退出且没有任何提示。 */
  const runner = path.join(ROOT, 'verify-run.cmd');
  fs.writeFileSync(runner, `@echo off\r\n"${edge}" --headless=new --user-data-dir="${profile}" --virtual-time-budget=20000 --window-size=1440,900 --dump-dom "file:///${OUT.replace(/\\/g, '/')}" > "${dump}" 2>"${log}"\r\n`, 'ascii');
  execFileSync('cmd', ['/c', runner], { stdio: 'ignore' });
  const html = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
  /* 必须锚在 <pre id="out"> 上：document.title 里也有 "PROBE {...}"，
   * 用宽松的 /PROBE (\{...\})</pre>/ 会从 title 一路吃到 pre，JSON.parse 直接炸。 */
  const m = html.match(/id="out"[^>]*>PROBE ([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error(`页面没产出 PROBE（加载即抛错？）。dump ${html.length} B，见 ${dump}`);
    if (fs.existsSync(log)) console.error('Edge stderr:\n' + fs.readFileSync(log, 'utf8').slice(0, 1200));
    process.exit(1);
  }
  const report = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  console.log('\n' + report.summary);
  report.pass.forEach((p) => console.log('  PASS  ' + p));
  report.fail.forEach((f) => console.log('  FAIL  ' + f));
  (report.notes || []).forEach((n) => console.log('  note  ' + n));
  if ((report.consoleErrors || []).length) { console.log('  console.error:'); report.consoleErrors.forEach((e) => console.log('    ' + e)); }
  process.exit(report.fail.length ? 1 : 0);
}
