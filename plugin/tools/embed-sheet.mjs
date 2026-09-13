/* tools/embed-sheet.mjs —— 把切帧产物变成插件可用的前端模块。
 *
 * 为什么要内嵌：客户端插件的 client.js 是唯一被浏览器执行的入口，没有配套后端路由，
 * 而"不依赖额外后端服务"是硬约束。所以精灵图走 data URL 内嵌，PNG 与 pet.json
 * 同时另存一份到 assets/ 作为降级（设置面板里可以填 URL 指向它）。
 *
 * 用法：node tools/embed-sheet.mjs [图集目录，默认 ../petwork/out]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.resolve(process.argv[2] || path.join(ROOT, '..', 'petwork', 'out'));
const ASSETS = path.join(ROOT, 'assets');
const SHEET_JS = path.join(ROOT, 'src', 'sheet.js');
const WARN_BYTES = 1.4 * 1024 * 1024;
/* 硬限原值 3.2MB：bg9 162 帧 112×150 图集 PNG 2.43MB → base64 3.24MB 恰好越线。
 * client.js 3.6MB 在本地刷新场景可用（母代理已批准提高硬限），上调至 4.0MB。
 * 素材再膨胀时先降格子（不低于 100×136）再考虑动这里。 */
const HARD_BYTES = 4.0 * 1024 * 1024;

function die(msg) {
  console.error(`embed-sheet: ${msg}`);
  process.exit(1);
}

const pngPath = path.join(SRC_DIR, 'spritesheet.png');
const jsonPath = path.join(SRC_DIR, 'pet.json');
for (const f of [pngPath, jsonPath]) if (!fs.existsSync(f)) die(`缺少输入 ${f}（先跑 petwork/tools/sprites.mjs build）`);

const png = fs.readFileSync(pngPath);
let meta;
try {
  meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (err) {
  die(`pet.json 解析失败：${err.message}`);
}

/* 基本形状校验：前端只认这几个字段，缺了就不该往下走 */
if (!meta.cell || !meta.cols || !meta.rows || !meta.states) die('pet.json 缺少 cell/cols/rows/states');
const states = Object.keys(meta.states);
const need = ['idle', 'wait', 'walk', 'react', 'working', 'sleep'];
for (const name of need) {
  if (!meta.states[name]) die(`pet.json 缺状态 ${name}`);
  const frames = meta.states[name].frames;
  if (!Array.isArray(frames) || !frames.length) die(`状态 ${name} 的 frames 为空`);
  for (const [col, row] of frames) {
    if (!(col >= 0 && col < meta.cols && row >= 0 && row < meta.rows)) die(`状态 ${name} 的帧索引 [${col},${row}] 越界`);
  }
}

const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const size = Buffer.byteLength(dataUrl, 'utf8');
if (size > HARD_BYTES) die(`base64 内嵌体积 ${(size / 1048576).toFixed(2)} MB 超过硬上限，请降低 cell 尺寸或减少帧数`);
if (size > WARN_BYTES) console.warn(`警告：base64 体积 ${(size / 1048576).toFixed(2)} MB 偏大，client.js 会随之变大（仍可运行）`);

fs.mkdirSync(ASSETS, { recursive: true });
fs.copyFileSync(pngPath, path.join(ASSETS, 'spritesheet.png'));
fs.writeFileSync(path.join(ASSETS, 'pet.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
if (fs.existsSync(path.join(SRC_DIR, 'contact-sheet.png'))) fs.copyFileSync(path.join(SRC_DIR, 'contact-sheet.png'), path.join(ASSETS, 'contact-sheet.png'));

const banner = `/* src/sheet.js —— 由 tools/embed-sheet.mjs 生成，请勿手改。
 * 来源：${path.relative(ROOT, pngPath)} (${(png.length / 1024).toFixed(1)} KB PNG) 与 pet.json
 * 内嵌后：${(size / 1024).toFixed(1)} KB 的 data URL 常量。
 * 同目录 assets/ 下保留了非内嵌副本，供"设置面板填 URL"的降级路径使用。
 * SHEET_HD 是第二阶段外挂高清图集的构建期常量（?v= 缓存失效 + 版本错配自检），
 * 由 assets/pet-hd.json + spritesheet-hd.png 算出；缺这两个文件时为 null（客户端直接走内嵌）。
 */
`;

/* ── 外挂高清图集常量（第二阶段）──────────────────────────────────────────
 * 内嵌的仍是这份 162 帧图集（4.0MB base64 硬限之下塞不进 319 帧的高清版：
 * 那张 PNG 8.94MB → base64 11.9MB）。高清版走 /pet-assets 路由外挂，
 * 这里的哈希让客户端能：1) 拼 ?v= 真正失效 immutable 缓存；2) 校验 png/json 不错配。 */
let hdBlock = 'var SHEET_HD = null;\n';
const hdPngPath = path.join(ASSETS, 'spritesheet-hd.png');
const hdJsonPath = path.join(ASSETS, 'pet-hd.json');
if (fs.existsSync(hdPngPath) && fs.existsSync(hdJsonPath)) {
  const hdPng = fs.readFileSync(hdPngPath);
  const hdJsonBuf = fs.readFileSync(hdJsonPath);
  let hdMeta;
  try { hdMeta = JSON.parse(hdJsonBuf.toString('utf8')); } catch (err) { die(`assets/pet-hd.json 解析失败：${err.message}`); }
  const hdPngHash = crypto.createHash('sha256').update(hdPng).digest('hex');
  const hdJsonHash = crypto.createHash('sha256').update(hdJsonBuf).digest('hex');
  if (hdMeta.sheetHash && String(hdMeta.sheetHash).toLowerCase() !== hdPngHash) {
    die(`assets/pet-hd.json 的 sheetHash(${String(hdMeta.sheetHash).slice(0, 12)}…) 与 spritesheet-hd.png 实算(${hdPngHash.slice(0, 12)}…) 不符——重跑 tools/copy-hd.mjs`);
  }
  const hdFrames = Object.values(hdMeta.states || {}).reduce((n, s) => n + (Array.isArray(s.frames) ? s.frames.length : 0), 0);
  hdBlock = `var SHEET_HD = ${JSON.stringify({
    base: '/pet-assets',
    json: 'pet-hd.json',
    png: 'spritesheet-hd.png',
    jsonRev: hdJsonHash.slice(0, 16),
    pngRev: hdPngHash.slice(0, 16),
    pngSha256: hdPngHash,
    pngBytes: hdPng.length,
    jsonBytes: hdJsonBuf.length,
    frames: hdFrames,
    cell: hdMeta.cell || null,
    cols: hdMeta.cols || 0,
    rows: hdMeta.rows || 0,
  })};\n`;
  console.log(`SHEET_HD          外挂高清 ${hdFrames} 帧  PNG ${(hdPng.length / 1048576).toFixed(2)} MB  ?v=${hdPngHash.slice(0, 16)}`);
} else {
  console.log('SHEET_HD          null（assets 下没有 pet-hd.json/spritesheet-hd.png，先跑 tools/copy-hd.mjs）');
}

fs.writeFileSync(SHEET_JS, `${banner}var SHEET = ${JSON.stringify({ meta, dataUrl, embedded: true, pngBytes: png.length })};\n${hdBlock}`, 'utf8');

console.log(`src/sheet.js      ${(Buffer.byteLength(fs.readFileSync(SHEET_JS, 'utf8')) / 1024).toFixed(1)} KB`);
console.log(`  PNG             ${(png.length / 1024).toFixed(1)} KB  →  data URL ${(size / 1024).toFixed(1)} KB`);
console.log(`  状态             ${states.map((s) => `${s}(${meta.states[s].frames.length})`).join(' ')}`);
console.log(`  视角             ${JSON.stringify(meta.views)}`);
console.log(`assets/           spritesheet.png + pet.json${fs.existsSync(path.join(ASSETS, 'contact-sheet.png')) ? ' + contact-sheet.png' : ''}`);
