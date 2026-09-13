//#region lib/index.js
/**
 * Host 侧入口。运行时行为全在浏览器（lib/client.js），这里做三件服务端的事：
 *
 * 1) 提示词段（需求第六条）。考证结论：浏览器半没有 prompt/prompts 服务，
 *    提示词段只能由宿主半注册（服务 systemPrompt，方法 section({name,order,text})）。
 *    默认**不注册**——给每个会话硬塞一段文字是不该由插件擅自做的事；
 *    要开，在 profile 的 cordis.patch.yml 里给这一行加 config：
 *      - insert:
 *          - id: dsh-pet-bg
 *            name: dsh-pet-bg
 *            config: { promptSection: true }
 *
 * 2) /pet-assets 静态路由（第二阶段：319 帧高清图集外挂）。默认就注册。
 *    客户端优先取它，取不到就静默回退到 lib/client.js 里内嵌的 162 帧图集，
 *    所以"路由还没生效（宿主未重启）"这段时间桌宠照常工作。见下方安全须知。
 *
 * 3) 除此之外不碰端口、不读写用户文件、不注册任何工具，卸载只需删登记行。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

var SECTION_NAME = "dsh-pet-bg";
var SECTION_TEXT = [
  "本会话界面装了浏览器插件 dsh-pet-bg：右下角有一只桌宠（Canvas 精灵动画），",
  "并能叠加一层背景视频。插件会订阅 api-session/status 事件——即会话进入 running 时桌宠转为工作状态、",
  "结束时播放庆祝动画；它不参与推理，也不会替用户确认任何操作。用户提到“桌宠”“背景视频”“面板调不出来”时，",
  "可提示其使用右键菜单或 Ctrl+Alt+P（开控制面板）、Ctrl+Alt+W（手动切工作状态）。",
].join("");

/* ── /pet-assets：高清图集外挂路由 ─────────────────────────────────────
 * ★安全须知★ 核心不对具名路由做鉴权：dsh-host-webserver\lib\index.js:176-183 只是把
 *   {kind,path,handler} 塞进路由表，:321-328 用最长前缀匹配挑一条，任何同源请求都会直接
 *   打到 handler。⇒ 这条路由是**同源无鉴权**的，下面的白名单是唯一防线：
 *     · 只认两个文件名，且是 path.basename 之后的**严格全等**比较（绝不用前缀/包含/正则）；
 *     · 绝不允许改成"服务整个 assets 目录"的通配静态服务器；
 *     · 白名单外（含 .. %2e 反斜杠 绝对路径 未知文件名）一律 404，且不抛错。
 * 为什么要自己注册路由：/plugins 只服务内存 map 里预组合的 bundle URL
 *   （dsh-client-modules\lib\index.js:480-484 绑定 serveBundle、:845-857 未命中即裸 404，
 *   全程不读文件系统），插件 assets 用任何 URL 组合都是 404（8 种候选实测全 404）。
 * 插件自注册路由的先例：官方 dsh-webhook-github\lib\index.js:190、
 *   第三方 dsh-workbench\lib\index.js:27,184。 */
var PET_ASSET_PREFIX = "/pet-assets";
/* 客户端用 ?v=<图集内容 sha256 前 16 位> 请求，所以内容一变 URL 就变 ⇒ 敢发一年 immutable。
 * 千万别在这里改成不带 ?v= 也能缓存的写法，否则换素材后浏览器会永远用旧图。 */
var PET_ASSET_CACHE = "public, max-age=31536000, immutable";
var PET_ASSET_TYPES = {
  "spritesheet-hd.png": "image/png",
  "pet-hd.json": "application/json; charset=utf-8",
};
/* assets 目录的真实路径：lib/index.js 的上一级下的 assets（ESM，所以走 import.meta.url）。
 * 白名单名与它 join，名字已经是全等匹配过的常量，不存在拼接穿越的可能。 */
var PET_ASSET_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

function petAsset404(res) {
  try {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    }
    res.end("404");
  } catch (err) {
    /* 连接已断就算了，绝不往上抛（抛了宿主会记 warn 并回 400） */
  }
}

/** If-None-Match 命中判断（弱比较：W/ 前缀不算差别；支持逗号列表与 *）。 */
function etagMatches(header, etag) {
  if (typeof header !== "string" || !header) return false;
  var strong = etag.replace(/^W\//, "");
  var parts = header.split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p === "*") return true;
    if (p.replace(/^W\//, "") === strong) return true;
  }
  return false;
}

/** 前缀路由 handler：只发白名单里的两个文件，其余 404。永不抛错。 */
function petAssetHandler(req, res) {
  var name = "";
  try {
    /* 只取 pathname 的 basename：query 天然被丢掉（?v=<哈希> 是给浏览器缓存失效用的），
     * `..`/`%2e`/`%2f`/反斜杠/绝对路径经过 URL 规范化 + basename 之后必然不等于白名单常量。
     * 注意：这里刻意**不做** decodeURIComponent——解码只会给穿越多开一扇门。 */
    name = path.basename(new URL(req && req.url ? req.url : "/", "http://127.0.0.1").pathname);
  } catch (err) {
    name = "";
  }
  var type = Object.prototype.hasOwnProperty.call(PET_ASSET_TYPES, name) ? PET_ASSET_TYPES[name] : null;
  if (!type) return petAsset404(res);
  var file = path.join(PET_ASSET_DIR, name);
  /* 流式发送：高清图集 ~9MB，绝不整块读进内存。先 stat 拿 content-length + 弱 ETag，
   * 顺便把"文件不存在"变成 404（而不是 createReadStream 的 error 事件）。 */
  stat(file).then(
    function (st) {
      if (!st.isFile()) return petAsset404(res);
      /* 弱 ETag 只用 size+mtime，不读文件内容（9MB 不该为了校验和再读一遍）。
       * 客户端带 ?v=<内容哈希> 请求，正常情况下 immutable 缓存根本不会回源；
       * 这条 304 是给"硬刷新/缓存被清"兜底的，避免白传 9MB。 */
      var etag = 'W/"' + st.size.toString(16) + "-" + Math.round(st.mtimeMs).toString(36) + '"';
      var hdr = req && req.headers ? req.headers : {};
      if (etagMatches(hdr["if-none-match"], etag)) {
        try {
          res.writeHead(304, { etag: etag, "cache-control": PET_ASSET_CACHE });
          res.end();
        } catch (err) {
          /* 连接已断 */
        }
        return;
      }
      try {
        res.writeHead(200, {
          "content-type": type,
          "content-length": String(st.size),
          etag: etag,
          "last-modified": new Date(st.mtime).toUTCString(),
          /* 内容哈希做 ?v= 失效（客户端从 pet-hd.json/构建常量拿），所以可以放心 immutable */
          "cache-control": PET_ASSET_CACHE,
        });
      } catch (err) {
        return;
      }
      var stream = createReadStream(file);
      stream.on("error", function () {
        try {
          res.destroy();
        } catch (err) {
          /* 已经断了的连接 */
        }
      });
      stream.pipe(res);
    },
    function () {
      petAsset404(res); // ENOENT / 权限 / 不是文件：一律 404
    },
  );
}

function apply(ctx, config) {
  var opts = config || {};
  var offs = [];

  /* 高清图集路由：与提示词段无关，默认就注册（客户端有静默回退，注册失败也不影响桌宠）。
   * 用 ctx.effect 登记，fiber 拆卸时自动摘掉路由；宿主没有 ctx.effect 时退回手动登记。 */
  try {
    if (ctx && ctx.webServer && typeof ctx.webServer.register === "function") {
      var route = { kind: "prefix", path: PET_ASSET_PREFIX, handler: petAssetHandler };
      if (typeof ctx.effect === "function") ctx.effect(function () { return ctx.webServer.register(route); }, "dsh-pet-bg: " + PET_ASSET_PREFIX);
      else offs.push(ctx.webServer.register(route));
    } else if (ctx && ctx.logger) {
      ctx.logger.debug("[dsh-pet-bg] 宿主无 webServer 服务，跳过 " + PET_ASSET_PREFIX + "（客户端会静默回退内嵌图集）");
    }
  } catch (err) {
    if (ctx && ctx.logger) ctx.logger.warn("[dsh-pet-bg] " + PET_ASSET_PREFIX + " 注册失败（客户端会回退内嵌图集）：" + err);
  }

  if (opts.promptSection !== true) return offs.length ? disposeAll(offs) : undefined; // 提示词段默认关闭
  var sp = ctx && ctx.systemPrompt;
  if (!sp || typeof sp.section !== "function") {
    if (ctx && typeof ctx.logger !== "undefined" && ctx.logger) ctx.logger.debug("[dsh-pet-bg] 宿主无 systemPrompt 服务，跳过提示词段");
    return offs.length ? disposeAll(offs) : undefined;
  }
  var off = sp.section({ name: SECTION_NAME, order: Number(opts.promptOrder) || 90, text: SECTION_TEXT });
  if (typeof off === "function") offs.push(off);
  return offs.length ? disposeAll(offs) : undefined;
}

function disposeAll(list) {
  return function () {
    for (var i = 0; i < list.length; i++) {
      try {
        list[i]();
      } catch (err) {
        /* 会话已在销毁中，忽略 */
      }
    }
  };
}

/* 宿主插件需要 webServer 先就位（cordis 用模块级 inject 决定 apply 的启动时机；
 * 官方先例 dsh-webhook-github\lib\index.js:162）。 */
var inject = ["webServer"];
//#endregion

/* petAssetHandler / PET_ASSET_TYPES 一并导出只为让 tmp\pet-smoke.mjs 能用假 req/res 直接单测；
 * cordis 只读 apply / inject / name / Config，多余导出被忽略（见 cordis\lib\index.js:1618-1634）。 */
export { PET_ASSET_TYPES, apply, inject, petAssetHandler };
