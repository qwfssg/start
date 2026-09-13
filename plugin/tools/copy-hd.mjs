/* tools/copy-hd.mjs —— 第二阶段：把高清图集产物搬进 assets\ 并打上内容哈希。
 *
 * 输入（缺省 ..\petwork\out-hd）：spritesheet.png + pet.json（319 帧 / cell 192×224）
 * 输出：assets\spritesheet-hd.png（逐字节复制） + assets\pet-hd.json（注入 sheetHash/sheetBytes）
 *
 * 为什么哈希在这里算、不在 sprites.mjs 里算：sprites.mjs 是 162 帧线上版共用的打包器，
 * 我承诺过"缺省参数重跑产物逐字节不变"；而缓存失效哈希是**部署**关注点，只有这里知道
 * 最终文件名（pet-hd.json / spritesheet-hd.png）。
 *
 * 为什么必须带哈希：路由发的是 cache-control: immutable,max-age=31536000，
 * 客户端用 ?v=<png 内容哈希前 16 位> 做失效；同时客户端会校验
 * 「pet-hd.json 里的 sheetHash == 实际下载到的 PNG 的 SHA-256 == 构建期写进 client.js 的常量」，
 * 三者任一不符就静默回退内嵌版 ⇒ png/json 版本错配永远不会上线。
 *
 * 用法：node tools/copy-hd.mjs [--src=..\petwork\out-hd]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = process.argv.find((a) => a.startsWith('--src='));
const SRC = path.resolve(ROOT, arg ? arg.slice(6) : path.join(ROOT, '..', 'petwork', 'out-hd'));
const ASSETS = path.join(ROOT, 'assets');

const die = (m) => { console.error(`copy-hd: ${m}`); process.exit(1); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const pngPath = path.join(SRC, 'spritesheet.png');
const jsonPath = path.join(SRC, 'pet.json');
for (const f of [pngPath, jsonPath]) if (!fs.existsSync(f)) die(`缺少输入 ${f}（先跑 petwork/tools/sprites.mjs states --precut=1 --out=...）`);

const png = fs.readFileSync(pngPath);
let meta;
try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { die(`pet.json 解析失败：${e.message}`); }
for (const k of ['cell', 'cols', 'rows', 'states', 'display']) if (!meta[k]) die(`pet.json 缺字段 ${k}`);

const pngHash = sha256(png);
meta.sheetHash = pngHash;                    // 客户端校验用：json 里的哈希必须等于实际下载的图的哈希
meta.sheetBytes = png.length;
meta.hd = true;                              // 标记：这是外挂高清版（内嵌回退版没有这个字段）

fs.mkdirSync(ASSETS, { recursive: true });
fs.writeFileSync(path.join(ASSETS, 'spritesheet-hd.png'), png);           // 逐字节，不重编码
fs.writeFileSync(path.join(ASSETS, 'pet-hd.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

const frames = Object.values(meta.states).reduce((n, s) => n + (Array.isArray(s.frames) ? s.frames.length : 0), 0);
const jsonBuf = fs.readFileSync(path.join(ASSETS, 'pet-hd.json'));
console.log(`[OK] assets\\spritesheet-hd.png  ${png.length} B  sha256=${pngHash.slice(0, 16)}…`);
console.log(`[OK] assets\\pet-hd.json         ${jsonBuf.length} B  sha256=${sha256(jsonBuf).slice(0, 16)}…`);
console.log(`     cell ${meta.cell.w}x${meta.cell.h}  ${meta.cols}x${meta.rows}=${meta.cols * meta.rows} 格  帧数 ${frames}  display ${meta.display.w}x${meta.display.h}  baselineY ${meta.baselineY}`);
console.log(`     未触碰 assets\\spritesheet.png / pet.json（线上内嵌回退版）`);
