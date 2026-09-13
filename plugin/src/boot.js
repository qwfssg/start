/* src/boot.js —— 接线层：注册入口、会话活动探测、派活输入器、HMR 单例守卫。
 *
 * 顺序（assemble）：core → sheet → pet → bg → boot，所以这里能直接看到 CORE / SHEET / PET / BG。
 * 原则：本文件只做"连接"，不实现渲染；任何探测失败都要能降级，绝不因为
 * 联动不可用而让整个插件起不来（桌宠与背景视频是主菜，联动是调味料）。
 */
var inject = ["remote", "sessions", "slots"];

var BOOT = (function () {
  'use strict';

  var started = false;
  var disposers = [];
  var tier = { session: "off", dispatch: "off" };
  /* T1（官方通路，实测存在于宿主）：
   *   ctx.remote.$on("api-session/status", (sessionId, running) => ...)  —— 会话运行态权威信号
   *   ctx.remote.session.prompt({requestId, sessionId, mode, content})   —— 程序化派活
   * 拿不到就退回 T2（DOM 观测）与 T3（手闸），功能不塌。 */
  var services = null;
  var lastSessionId = null;
  var t1Off = [];

  function bind(ctx) {
    services = ctx && typeof ctx === "object" ? ctx : null;
  }

  function attachTierOne() {
    if (!services || !services.remote || typeof services.remote.$on !== "function") return false;
    try {
      var off = services.remote.$on("api-session/status", function (sessionId, running) {
        if (sessionId) lastSessionId = String(sessionId);
        CORE.emit("session", { phase: running ? "start" : "end", via: "t1:" + (sessionId || "?") });
      });
      if (typeof off === "function") t1Off.push(off);
      tier.session = "T1:remote.$on";
      return true;
    } catch (err) {
      console.warn(CORE.LOG + " T1 订阅失败，退回 DOM 观测：", err);
      return false;
    }
  }

  /** 最近一个有活动的会话 id；宿主没给就用 $on 里记下的。 */
  function pickSessionId() {
    if (lastSessionId) return lastSessionId;
    try {
      var snap = services.sessions && services.sessions.list && services.sessions.list.getSnapshot
        ? services.sessions.list.getSnapshot() : null;
      var byId = snap && snap.byId ? snap.byId : null;
      if (!byId) return null;
      var ids = Object.keys(byId);
      for (var i = ids.length - 1; i >= 0; i--) if (byId[ids[i]] && byId[ids[i]].running) return String(ids[i]);
      return ids.length ? String(ids[ids.length - 1]) : null;
    } catch (err) {
      return null;
    }
  }

  function add(fn) {
    if (typeof fn === "function") disposers.push(fn);
  }

  /* ── 会话活动探测 ──────────────────────────────────────────────────── */

  /* 探测阶梯（DESIGN §6）：
   *   T1 store/服务订阅（等 ctx 暴露的 face 可用时启用，见 attachTierOne）
   *   T2 DOM 观测：出现"停止"按钮 / aria-busy 即为运行中
   *   T3 手动：桌宠菜单里自己切状态（始终可用）
   * 选择器都是"存在即运行中"的正向信号，宁可漏判也不要误跳到 working。 */
  var STOP_BUTTON = ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]', 'button[title*="停止"]', 'button[data-dsh-stop="1"]', 'button[aria-label*="中断"]'];
  var BUSY_FLAG = ['[aria-busy="true" i]', '[data-streaming="true"]', '[data-running="true"]', ".dsh-streaming", '[class$="_streaming"]'];

  function anyFound(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var node = document.querySelector(selectors[i]);
        if (node && node.offsetParent !== null) return selectors[i];
      } catch (err) {
        /* 选择器不被支持就当没命中，别炸循环 */
      }
    }
    return null;
  }

  /* 真实 GUI 的"停止"按钮很可能是纯图标（只有文字或只有 title），属性选择器会漏，
   * 所以再加一轮按文字匹配；按钮数量有界，且整个 scan 已被 rAF 节流，代价可控。 */
  var RUNNING_TEXT = ["停止", "中断", "取消任务", "stop", "cancel", "interrupt"];

  function findByText() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.offsetParent === null || b.disabled) continue;
      var text = (b.textContent || b.getAttribute("title") || b.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!text || text.length > 24) continue; // 只要短标签，避免把整段会话文字当成按钮
      for (var k = 0; k < RUNNING_TEXT.length; k++) {
        if (text === RUNNING_TEXT[k] || text.indexOf(RUNNING_TEXT[k]) >= 0) return "text:" + RUNNING_TEXT[k];
      }
    }
    return null;
  }

  /** 一次扫描的信号来源；返回 null 表示当前没有任何"正在运行"的证据。 */
  function signal() {
    return anyFound(STOP_BUTTON) || findByText() || anyFound(BUSY_FLAG);
  }

  var running = false;
  var startHit = null;
  var lastHit = null;
  var quietTimer = null;
  var scanScheduled = false;

  /** 复查"当初让我进 running 的那个信号"是否已消失，而不是要求所有信号全灭：
   * 别的瞬时元素（面板按钮、菜单项）偶尔会撞上一次轮询，把结束判定无限往后拖。 */
  function startHitGone() {
    if (!startHit) return true;
    if (startHit.indexOf("text:") === 0) {
      var token = startHit.slice(5);
      var buttons = document.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        if (b.offsetParent === null || b.disabled) continue;
        var t = (b.textContent || b.getAttribute("title") || b.getAttribute("aria-label") || "").trim().toLowerCase();
        if (t && t.length <= 24 && t.indexOf(token) >= 0) return false;
      }
      return true;
    }
    if (startHit.indexOf("[") === 0 || startHit.indexOf(".") === 0) return !anyFound([startHit]);
    return !findByText();
  }

  function scan() {
    scanScheduled = false;
    if (!started) return;
    var hit = signal();
    lastHit = hit;
    var now = Boolean(hit);
    if (now && !running) {
      running = true;
      startHit = String(hit);
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      CORE.emit("session", { phase: "start", via: startHit });
    } else if (!now && running) {
      /* 收尾再等一下：节点替换/切 tab 的瞬间会短暂找不到，避免一路一停一闪 */
      if (!quietTimer) {
        quietTimer = setTimeout(function () {
          quietTimer = null;
          if (running && !signal() && startHitGone()) {
            running = false;
            startHit = null;
            CORE.emit("session", { phase: "end", via: "quiet" });
          }
        }, 450);
      }
    } else if (now && running && startHitGone() && !signal()) {
      running = false;
      startHit = null;
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    if (window.requestAnimationFrame) requestAnimationFrame(scan);
    else setTimeout(scan, 32);
  }

  var observer = null;
  var pollTimer = null;

  function attachDomWatch() {
    if (typeof MutationObserver !== "function") return false;
    observer = new MutationObserver(scheduleScan);
    var targets = [document.body, document.documentElement].filter(Boolean);
    if (!targets.length) return false;
    for (var i = 0; i < targets.length; i++) {
      observer.observe(targets[i], { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "data-streaming", "data-running", "class", "hidden", "disabled", "style"] });
    }
    /* 再加一条 700ms 兜底轮询：实测本机 Chromium 上纯 MO 会漏掉某些属性回写（隐藏停止按钮
     * 那一次没有回调，于是 running 永远停在 true，桌宠不会庆祝）。宿主是 React，整片子树
     * 随时被替换，事件驱动在这种环境里本就不该独扛；1.4Hz 的查询代价可以忽略。 */
    if (window.setInterval) pollTimer = setInterval(function () { scanScheduled = false; scan(); }, 700);
    tier.session = "T2:dom+poll";
    return true;
  }

  /* 手动兜底：桌宠菜单之外的快捷键也能强制同步一次状态 */
  function attachKeys() {
    add(
      CORE.on(document, "keydown", function (e) {
        if (!e || e.defaultPrevented) return;
        if (e.ctrlKey && e.altKey && (e.key === "P" || e.key === "p")) {
          e.preventDefault();
          BG.toggle();
        } else if (e.ctrlKey && e.altKey && (e.key === "W" || e.key === "w")) {
          e.preventDefault();
          PET.setState(PET.state() === "working" ? "idle" : "working", { force: true });
        }
      }),
    );
  }

  /* ── 派活：优先复用页面上既有的输入框，绝不自建 WebSocket ───────────── */

  var composer = null;

  function findTextBox() {
    var list = [];
    var ta = document.querySelectorAll("textarea");
    for (var i = 0; i < ta.length; i++) if (ta[i].offsetParent !== null && !ta[i].disabled) list.push(ta[i]);
    var ce = document.querySelectorAll('[contenteditable="true"]');
    for (var j = 0; j < ce.length; j++) if (ce[j].offsetParent !== null) list.push(ce[j]);
    return list.length ? list[list.length - 1] : null;
  }

  function findSendButton() {
    var sels = ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[type="submit"]', 'button[title*="发送"]'];
    for (var i = 0; i < sels.length; i++) {
      var hit = document.querySelector(sels[i]);
      if (hit && hit.offsetParent !== null && !hit.disabled) return hit;
    }
    return null;
  }

  /** React 受控 input 必须走原生 setter + input 事件，否则值会被组件状态覆盖回去。 */
  function writeInto(node, text) {
    if (node.isContentEditable) {
      node.textContent = text;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      return true;
    }
    var proto = node.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (!setter || !setter.set) return false;
    node.focus();
    setter.set.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function dispatch(text) {
    var value = String(text || "").trim();
    if (!value) return false;
    /* T1：官方派活通路。mode:"queue" 由宿主排队，比模拟回车可靠得多。 */
    var session = services && services.remote && services.remote.session;
    var sid = pickSessionId();
    if (session && typeof session.prompt === "function" && sid) {
      var rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
      try {
        var p = session.prompt({ requestId: rid, sessionId: sid, mode: "queue", content: [{ type: "text", text: value }] });
        if (p && typeof p.then === "function") {
          p.then(function (res) {
            var okp = !res || res.ok !== false;
            CORE.emit("toast", okp ? "已派活到会话 " + sid.slice(0, 8) : "派活被拒：" + JSON.stringify(res && res.error || res));
            if (okp) CORE.emit("session", { phase: "start", via: "t1:dispatch" });
          }).catch(function (err) {
            warnDispatch(err);
          });
          tier.dispatch = "T1:remote.session.prompt";
          return true;
        }
        tier.dispatch = "T1:remote.session.prompt";
        CORE.emit("toast", "已派活");
        return true;
      } catch (err) {
        warnDispatch(err);
      }
    }
    function warnDispatch(err) {
      console.warn(CORE.LOG + " T1 派活失败，退回输入框注入：", err);
      tier.dispatch = "fallback";
    }
    var box = findTextBox();
    if (!box) {
      CORE.emit("toast", "没找到可用的输入框，派活不可用（T3：只能手动）");
      tier.dispatch = "none";
      return false;
    }
    if (!writeInto(box, value)) {
      CORE.emit("toast", "写入输入框失败（受控组件拒绝赋值）");
      return false;
    }
    var btn = findSendButton();
    if (btn) {
      btn.click();
      tier.dispatch = "T2:textarea+button";
    } else {
      box.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
      box.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
      tier.dispatch = "T2:textarea+enter";
    }
    CORE.emit("session", { phase: "start", via: "dispatch" });
    CORE.emit("toast", "已投递到当前会话输入框");
    return true;
  }

  function closeComposer() {
    if (composer && composer.parentNode) composer.parentNode.removeChild(composer);
    composer = null;
  }

  function openComposer() {
    if (composer) {
      closeComposer();
      return;
    }
    var b = PET.bounds();
    var input = CORE.el("input", { type: "text", placeholder: "说点什么，回车派活…", "aria-label": "派活内容" });
    var send = CORE.el("button", { type: "button", text: "发送" });
    var cancel = CORE.el("button", { type: "button", text: "取消" });
    composer = CORE.el(
      "div",
      { id: "dsh-pet-compose", style: "left:" + Math.max(8, Math.round(b.x - 120)) + "px;bottom:" + Math.max(8, Math.round(window.innerHeight - b.y + 10)) + "px" },
      [input, CORE.el("div", { class: "dsh-pet-compose-row" }, [send, cancel])],
    );
    document.body.appendChild(composer);
    input.focus();
    function submit() {
      var value = input.value;
      closeComposer();
      if (dispatch(value)) PET.setState("wait");
    }
    add(CORE.on(send, "click", submit));
    add(CORE.on(cancel, "click", closeComposer));
    add(
      CORE.on(input, "keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeComposer();
        }
      }),
    );
    /* 派活输入框浮在桌宠之上、面板之下，所以 Esc 关闭只作用于它自身 */
    setTimeout(function () {
      if (composer) document.addEventListener("pointerdown", outside, true);
    }, 0);
    function outside(e) {
      if (!composer) return;
      if (!composer.contains(e.target)) {
        document.removeEventListener("pointerdown", outside, true);
        closeComposer();
      }
    }
  }

  /* ── 样式（boot 自己的那一槽）───────────────────────────────────────── */

  function styles() {
    CORE.css(
      "boot",
      [
        "#dsh-pet-compose{position:fixed;z-index:2147483003;width:300px;padding:10px;border-radius:12px;",
        "border:1px solid var(--dsw-alias-border-l3,#0002);background:var(--dsw-alias-bg-layer-2,#fff);",
        "box-shadow:0 10px 28px rgba(0,0,0,.18);font:13px/1.5 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;display:flex;flex-direction:column;gap:8px}",
        "#dsh-pet-compose input{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;",
        "border:1px solid var(--dsw-alias-border-l3,#0002);background:transparent;color:var(--dsw-alias-label-primary,#111);font:inherit}",
        ".dsh-pet-compose-row{display:flex;gap:6px;justify-content:flex-end}",
        "#dsh-pet-compose button{padding:4px 10px;border-radius:8px;cursor:pointer;font:inherit;",
        "border:1px solid var(--dsw-alias-border-l3,#0002);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111)}",
        "#dsh-pet-compose button:hover{filter:brightness(1.08)}",
      ].join("\n"),
    );
  }

  /* ── 生命周期 ──────────────────────────────────────────────────────── */

  function start() {
    if (started) return;
    started = true;
    CORE.load();
    styles();

    try {
      BG.start();
    } catch (err) {
      console.warn(CORE.LOG + " 背景层启动失败：", err);
    }
    try {
      PET.start();
    } catch (err) {
      console.warn(CORE.LOG + " 桌宠启动失败：", err);
    }

    /* 总线接线。注意：panel:toggle 由 bg.js 自己订阅（内聚在它那一侧），
     * 这里**不能再订一遍**——两边都调 toggle() 会把面板开完立刻又关掉。 */
    add(CORE.onBus("dispatch", openComposer));
    add(
      CORE.onBus("session", function (detail) {
        if (!detail) return;
        try {
          PET.notify(detail.phase);
        } catch (err) {
          console.warn(CORE.LOG + " 通知桌宠失败：", err);
        }
      }),
    );
    add(
      CORE.onBus("config", function () {
        BG.refresh();
        PET.refresh();
      }),
    );
    add(
      CORE.on(window, "resize", function () {
        PET.refresh();
        BG.refresh();
      }),
    );
    add(
      CORE.on(document, "visibilitychange", function () {
        if (document.hidden) return;
        /* 回到前台时以磁盘上的真身为准（多标签页时另一个页可能改过设置） */
        try {
          var raw = localStorage.getItem("dsh-pet-bg:config");
          if (raw) {
            CORE.set(JSON.parse(raw));
            BG.refresh();
            PET.refresh();
          }
        } catch (err) {
          console.warn(CORE.LOG + " 回前台同步配置失败：", err);
        }
      }),
    );

    /* 先试 T1（官方状态事件），没有才退到 T2（DOM 观测）；两条都不要同时开，
     * 否则同一个"开始"会被报两遍，桌宠的状态机就会被反复重置。 */
    if (!attachTierOne() && !attachDomWatch()) {
      tier.session = "T3:manual";
    }
    scheduleScan();
    attachKeys();
    CORE.play("hello");
    console.info(CORE.LOG + " 已启动：会话探测=" + tier.session + " 派活=" + (tier.dispatch || "按需"));
  }

  function stop() {
    if (!started) return;
    closeComposer();
    for (var i = 0; i < disposers.length; i++) {
      try {
        disposers[i]();
      } catch (err) {
        /* 一个解绑失败不影响其余 */
      }
    }
    disposers = [];
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    running = false;
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    try {
      PET.stop();
    } catch (err) {
      console.warn(CORE.LOG + " 桌宠停止失败：", err);
    }
    try {
      BG.stop();
    } catch (err) {
      console.warn(CORE.LOG + " 背景层停止失败：", err);
    }
    started = false;
  }

  function info() {
    return { started: started, tier: tier, running: running, signal: signal(), bg: BG.state ? BG.state() : null, pet: PET.state ? PET.state() : null };
  }

  return { start: start, stop: stop, info: info, bind: bind, dispatch: dispatch, signalName: function () { return signal(); } };
})();

/* HMR：同一份模块被再次执行时，先把上一份彻底拆掉，避免留下两套桌宠 */
if (window.__DSH_PET_BG_STOP__) {
  try {
    window.__DSH_PET_BG_STOP__();
  } catch (err) {
    console.warn("[dsh-pet-bg] 旧实例清理失败：", err);
  }
}
window.__DSH_PET_BG_STOP__ = BOOT.stop;
/* 诊断出口：浏览器控制台里 __DSH_PET_BG.debug() 一把看清四个模块的状态，
 * 也是 tools/verify.mjs 的探针入口。只读，不参与业务。 */
window.__DSH_PET_BG__ = {
  version: CORE.VERSION,
  info: BOOT.info,
  debug: function () {
    return { info: BOOT.info(), cfg: CORE.load(), petState: PET.state(), petSheet: PET.sheetInfo(), sheet: typeof SHEET === "object" && SHEET ? { meta: SHEET.meta && SHEET.meta.states, bytes: SHEET.dataUrl ? SHEET.dataUrl.length : 0 } : null, sheetHd: typeof SHEET_HD === "object" && SHEET_HD ? SHEET_HD : null };
  },
  PET: PET,
  BG: BG,
  BOOT: BOOT,
  CORE: CORE,
};

function apply(ctx) {
  BOOT.bind(ctx);
  BOOT.start();
  var off = [];
  /* 可选：往设置弹窗的「通用」区塞一行入口（宿主有 settings.general.item 时才生效）。
   * 拿不到 slots 也不影响主功能：桌宠右键菜单里本来就有"背景设置"。 */
  try {
    if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
      var React = null;
      try {
        React = typeof require === "function" ? require("react") : null;
      } catch (err) {
        React = null;
      }
      if (React && React.createElement) {
        off.push(
          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({ name: "settings.general.item", id: "dsh-pet-bg", order: 12 }, function () {
              return React.createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0" } },
                React.createElement("span", { style: { flex: "1" } }, "桌宠与背景视频"),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: function () {
                      BG.toggle();
                    },
                  },
                  "打开控制面板",
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: function () {
                      var c = CORE.load();
                      CORE.set({ pet: Object.assign({}, c.pet, { hidden: !c.pet.hidden }) }, true);
                      PET.refresh();
                      BG.refresh();
                    },
                  },
                  "显示/隐藏桌宠",
                ),
              );
            });
          }),
        );
      }
    }
  } catch (err) {
    console.warn(CORE.LOG + " 设置页入口注册失败（不影响桌宠与背景）：", err);
  }
  return function () {
    for (var i = 0; i < off.length; i++) {
      try {
        if (typeof off[i] === "function") off[i]();
      } catch (err) {
        /* 忽略 */
      }
    }
    BOOT.stop();
  };
}
