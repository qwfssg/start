/* tools/assemble.mjs —— 微型装配器（不是打包器）：
 * 把 src/*.js 按固定顺序拼成 DSH 客户端插件所需的
 * `window.__ModuleLoader__.load({ id, factory })` 形态，零构建工具链。
 *
 * 顺序即依赖方向：core → sheet → pet → bg → boot（后面的能看见前面的顶层 var）。
 * src/sheet.js 由 tools/embed-sheet.mjs 从生成的图集写入；缺失时补一个 SHEET=null 桩，
 * 保证代码在任何情况下都能编译并通过语法检查。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'lib', 'client.js');
const ORDER = ['core.js', 'sheet.js', 'pet.js', 'bg.js', 'boot.js'];
const STUBS = {
  'sheet.js': '/* 占位：精灵图集尚未内嵌。跑 tools/embed-sheet.mjs 生成真实 src/sheet.js */\nvar SHEET = null;\n',
};

const parts = [];
const missing = [];
const stubbed = [];
for (const name of ORDER) {
  const file = path.join(SRC, name);
  if (fs.existsSync(file)) {
    parts.push(`//#region src/${name}\n${fs.readFileSync(file, 'utf8').replace(/\s+$/, '')}\n//#endregion`);
  } else if (STUBS[name]) {
    parts.push(`//#region src/${name} (stub)\n${STUBS[name]}//#endregion`);
    stubbed.push(name);
  } else {
    missing.push(name);
  }
}

if (missing.length) {
  console.error(`缺少源文件：${missing.join(', ')}`);
  process.exit(1);
}

const body = parts.join('\n\n');
const bundle = `/* dsh-pet-bg 客户端 bundle —— 由 tools/assemble.mjs 装配，请勿直接编辑 lib/client.js。
 * 源文件在 src/ 下：core(内核) sheet(图集) pet(桌宠) bg(背景视频与面板) boot(接线与注册)。
 * 运行时不依赖 Node、不依赖打包器、不依赖任何第三方库。 */
window.__ModuleLoader__.load({
\tid: "dsh-pet-bg",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body
  .split('\n')
  .map((line) => (line.length ? '\t\t' + line : line))
  .join('\n')}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
/* 装配完先自证语法：拼出来的东西必须能被解析，否则交给浏览器才发现就晚了。
 * new Function 只做语法分析、不执行，所以未定义的 window/require 都不影响。 */
try {
  new Function(bundle);
} catch (err) {
  console.error(`装配结果语法不通过：${err.message}`);
  process.exit(2);
}
if (stubbed.length) console.warn(`注意：${stubbed.join(', ')} 用的是占位桩（跑 tools/embed-sheet.mjs 生成真实文件）`);
console.log(`语法自检通过（new Function 解析）`);
fs.writeFileSync(OUT, bundle, 'utf8');
const bytes = Buffer.byteLength(bundle, 'utf8');
console.log(`lib/client.js  ${bytes} B  （${(bytes / 1024).toFixed(1)} KB，来自 ${ORDER.length} 个源文件）`);
for (const name of ORDER) {
  const file = path.join(SRC, name);
  const size = fs.existsSync(file) ? Buffer.byteLength(fs.readFileSync(file), 'utf8') : 0;
  console.log(`  ${name.padEnd(10)} ${String(size).padStart(8)} B`);
}
