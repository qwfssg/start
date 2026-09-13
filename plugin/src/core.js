/* src/core.js —— 共享内核：配置 / 持久化 / IndexedDB 媒体 / 音频 / DOM 工具 / 内部总线。
 *
 * 装配方式：tools/assemble.mjs 把 src/*.js 依次拼进 lib/client.js 的
 * `window.__ModuleLoader__.load({ id, factory })` 闭包里，所以这里的顶层 `var`
 * 就是后续模块能看到的名字。约定：本文件只提供下面 CORE 里列出的能力，
 * 业务模块（pet.js / bg.js / boot.js）不得往 CORE 上加东西。
 */
var CORE = (function () {
  'use strict';

  var VERSION = 1;
  var CFG_KEY = "dsh-pet-bg:config";
  var DB_NAME = "dsh-pet-bg";
  var DB_STORE = "media";
  var LOG = "[dsh-pet-bg]";

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  function clamp(n, lo, hi, fallback) {
    var v = Number(n);
    if (!Number.isFinite(v)) v = Number(fallback);
    if (!Number.isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    var a = attrs || {};
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      if (k === "text") node.textContent = String(a[k]);
      else if (k === "html") node.innerHTML = String(a[k]);
      else if (k === "style") node.setAttribute("style", a[k]);
      else node.setAttribute(k, String(a[k]));
    }
    var list = kids || [];
    for (var i = 0; i < list.length; i++) if (list[i]) node.appendChild(list[i]);
    return node;
  }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts || false);
    return function () {
      target.removeEventListener(type, fn, opts || false);
    };
  }

  /* ── 内部总线（模块间唯一耦合点）────────────────────────────────────── */

  var handlers = {};

  function onBus(name, fn) {
    (handlers[name] || (handlers[name] = [])).push(fn);
    return function () {
      var list = handlers[name] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function emit(name, detail) {
    var list = (handlers[name] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](detail);
      } catch (err) {
        console.error(LOG + " 总线 " + name + " 回调抛错：", err);
      }
    }
  }

  /* ── 配置：真身在 localStorage，内存里始终有一份可直接读的镜像 ───────── */

  function defaults() {
    return {
      version: VERSION,
      pet: { x: 0.86, y: 0.82, scale: 1, facing: "right", locked: false, hidden: false, roam: true, sound: true, volume: 0.35 },
      bg: { enabled: false, kind: "clip", clipId: null, url: "", blur: 0, brightness: 1, speed: 1, volume: 0, muted: true, loop: true, playing: true, fit: "cover", opacity: 1, panelOpen: false },
      panel: { x: 18, bottom: 96 },
    };
  }

  function sanitize(raw) {
    var d = defaults();
    var src = raw && typeof raw === "object" ? raw : {};
    var pet = src.pet && typeof src.pet === "object" ? src.pet : {};
    var bg = src.bg && typeof src.bg === "object" ? src.bg : {};
    var pn = src.panel && typeof src.panel === "object" ? src.panel : {};
    return {
      version: VERSION,
      pet: {
        x: clamp(pet.x, 0, 1, d.pet.x),
        y: clamp(pet.y, 0, 1, d.pet.y),
        scale: clamp(pet.scale, 0.5, 2.5, d.pet.scale),
        facing: pet.facing === "left" ? "left" : "right",
        locked: pet.locked === true,
        hidden: pet.hidden === true,
        /* 播放倍率：白名单里必须有这一条，否则 CORE.set({pet:{fpsScale}}) 会被 sanitize 丢掉。
           缺省 1.4：配置里从未存过 fpsScale 时，这里才是真实生效的默认值（用户反馈"不流畅"后由 0.6 提速；已存值优先） */
        fpsScale: typeof pet.fpsScale === "number" && isFinite(pet.fpsScale) ? clamp(pet.fpsScale, 0.15, 2, 1.4) : 1.4,
        roam: pet.roam !== false,
        sound: pet.sound !== false,
        volume: clamp(pet.volume, 0, 1, d.pet.volume),
      },
      bg: {
        enabled: bg.enabled === true,
        kind: bg.kind === "url" ? "url" : "clip",
        clipId: typeof bg.clipId === "string" && bg.clipId ? bg.clipId : null,
        url: typeof bg.url === "string" ? bg.url.slice(0, 2000) : "",
        blur: clamp(bg.blur, 0, 20, 0),
        brightness: clamp(bg.brightness, 0.3, 2, 1),
        speed: clamp(bg.speed, 0.25, 3, 1),
        volume: clamp(bg.volume, 0, 1, 0),
        muted: bg.muted !== false,
        loop: bg.loop !== false,
        playing: bg.playing !== false,
        fit: bg.fit === "contain" ? "contain" : "cover",
        opacity: clamp(bg.opacity, 0, 1, 1),
        panelOpen: bg.panelOpen === true,
      },
      panel: { x: clamp(pn.x, 0, 4000, pn.x === undefined ? 18 : pn.x), bottom: clamp(pn.bottom, 8, 4000, pn.bottom === undefined ? 96 : pn.bottom) },
    };
  }

  var cfg = null;
  var saveTimer = null;
  var storageBroken = false;

  function load() {
    if (cfg) return cfg;
    var parsed = null;
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (err) {
      storageBroken = true;
      console.warn(LOG + " 读配置失败，用默认值：", err);
    }
    cfg = sanitize(parsed);
    return cfg;
  }

  function persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!cfg) return;
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
      if (storageBroken) {
        storageBroken = false;
        emit("toast", "存储恢复正常");
      }
    } catch (err) {
      storageBroken = true;
      console.warn(LOG + " 写配置失败（配额？）：", err);
      emit("toast", "localStorage 写入失败，本次改动只活在内存里");
    }
  }

  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  }

  /** 改配置的唯一入口：patch 是 {pet:{x:..}} 这样的局部对象，深两路合并。 */
  function set(patch, immediate) {
    var c = load();
    for (var group in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, group)) continue;
      var vals = patch[group];
      if (vals && typeof vals === "object" && c[group] && typeof c[group] === "object") {
        for (var key in vals) if (Object.prototype.hasOwnProperty.call(vals, key)) c[group][key] = vals[key];
      } else {
        c[group] = vals;
      }
    }
    cfg = sanitize(c);
    if (immediate === true) persistNow();
    else persist();
    emit("config", cfg);
    return cfg;
  }

  /* ── IndexedDB：只放媒体二进制（localStorage 装不下，也不该装）──────── */

  var dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var database = req.result;
        if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("IndexedDB 打不开"));
      };
      req.onblocked = function () {
        reject(new Error("IndexedDB 被其它标签页占用"));
      };
    }).catch(function (err) {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  function tx(mode, run) {
    return db().then(function (database) {
      return new Promise(function (resolve, reject) {
        var t = database.transaction(DB_STORE, mode);
        var req = run(t.objectStore(DB_STORE));
        t.oncomplete = function () {
          resolve(req && "result" in req ? req.result : null);
        };
        t.onerror = t.onabort = function () {
          reject(t.error || new Error("事务中止"));
        };
      });
    });
  }

  function putMedia(record) {
    return tx("readwrite", function (store) {
      return store.put(record);
    }).then(function () {
      return record;
    });
  }

  function getMedia(id) {
    return tx("readonly", function (store) {
      return store.get(id);
    });
  }

  function delMedia(id) {
    return tx("readwrite", function (store) {
      return store.delete(id);
    });
  }

  function allMedia() {
    return tx("readonly", function (store) {
      return store.getAll();
    });
  }

  /* objectURL 缓存：同一 id 复用同一个 URL，替换/删除时才 revoke */
  var urls = {};

  function objectUrl(id) {
    if (!id) return Promise.resolve(null);
    if (urls[id]) return Promise.resolve(urls[id]);
    return getMedia(id).then(function (record) {
      if (!record || !record.blob) return null;
      var url = URL.createObjectURL(record.blob);
      urls[id] = url;
      return url;
    });
  }

  function revokeUrl(id) {
    if (urls[id]) {
      try {
        URL.revokeObjectURL(urls[id]);
      } catch (err) {
        /* 已被回收就算了 */
      }
      delete urls[id];
    }
  }

  /* ── 音频：用户替换优先，否则用 WebAudio 现场合成（所以包里不带任何二进制）── */

  var audioCache = {};
  var actx = null;

  function ctxAudio() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === "suspended") actx.resume().catch(function () {});
    return actx;
  }

  function blip(freq, start, dur, gainPeak, type) {
    var ac = ctxAudio();
    if (!ac) return;
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type || "triangle";
    osc.frequency.setValueAtTime(freq, ac.currentTime + start);
    gain.gain.setValueAtTime(0.0001, ac.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainPeak), ac.currentTime + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(ac.currentTime + start);
    osc.stop(ac.currentTime + start + dur + 0.02);
  }

  /** name: "click" | "done" | "hello"；有用户音频就用用户的，没有就合成。 */
  function play(name, volume) {
    var c = load();
    if (!c.pet.sound) return;
    var vol = clamp(volume === undefined ? c.pet.volume : volume, 0, 1, 0.35);
    if (vol <= 0) return;
    var id = "sound:" + name;
    var cached = audioCache[id];
    if (cached === undefined) {
      audioCache[id] = null;
      getMedia(id).then(function (record) {
        if (record && record.blob) {
          var node = new Audio(URL.createObjectURL(record.blob));
          node.preload = "auto";
          audioCache[id] = node;
          fire(name, vol);
        } else {
          audioCache[id] = false;
          fire(name, vol);
        }
      }).catch(function () {
        audioCache[id] = false;
        fire(name, vol);
      });
      return;
    }
    fire(name, vol);

    function fire(kind, level) {
      var node = audioCache[id];
      if (node) {
        try {
          node.volume = level;
          node.currentTime = 0;
          var p = node.play();
          if (p && p.catch) p.catch(function () {});
        } catch (err) {
          console.warn(LOG + " 播放自定义音效失败：", err);
        }
        return;
      }
      if (node === null) return; // 还在查库
      if (kind === "click") blip(880, 0, 0.07, level * 0.22, "triangle");
      else if (kind === "done") {
        blip(659.25, 0, 0.1, level * 0.2, "sine");
        blip(987.77, 0.09, 0.16, level * 0.2, "sine");
      } else if (kind === "hello") blip(523.25, 0, 0.12, level * 0.16, "sine");
    }
  }

  /* ── 样式：只允许注入带 #dsh-pet-* 前缀的选择器 ─────────────────────── */

  var styleEl = null;
  /** 按 owner 分槽存样式：pet / bg / boot 各写各的，拼成一份样式表，互不抹掉。 */
  var styleSlots = {};

  function paintStyle() {
    var keys = Object.keys(styleSlots);
    var text = "";
    for (var i = 0; i < keys.length; i++) text += "/* " + keys[i] + " */\n" + styleSlots[keys[i]] + "\n";
    styleEl.textContent = text;
  }

  function css(owner, text) {
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.getElementById("dsh-pet-style");
      if (!styleEl) {
        styleEl = el("style", { id: "dsh-pet-style", "data-plugin": "dsh-pet-bg" });
        document.head.appendChild(styleEl);
      }
    }
    styleSlots[owner] = text;
    paintStyle();
  }

  return {
    VERSION: VERSION,
    LOG: LOG,
    CORE_NAME: "core",
    clamp: clamp,
    el: el,
    on: on,
    emit: emit,
    onBus: onBus,
    defaults: defaults,
    load: load,
    set: set,
    persist: persist,
    persistNow: persistNow,
    isStorageBroken: function () {
      return storageBroken;
    },
    putMedia: putMedia,
    getMedia: getMedia,
    delMedia: delMedia,
    allMedia: allMedia,
    objectUrl: objectUrl,
    revokeUrl: revokeUrl,
    play: play,
    /** 用户换了音效文件后调用：丢掉缓存节点，下一次 play 重新读库。 */
    invalidateSound: function (name) {
      if (name) delete audioCache["sound:" + name];
      else Object.keys(audioCache).forEach(function (k) {
        delete audioCache[k];
      });
    },
    css: css,
    mediaId: function (kind, key) {
      return kind + ":" + key;
    },
  };
})();
