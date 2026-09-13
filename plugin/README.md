# plugin/ —— 可直接安装的 DSH 客户端插件（桌宠 + 背景视频）

提纯自实战工程 `dsh-pet-bg`（快照），插件名保持 `dsh-pet-bg` 不变（cordis 注册 id、
bundle id、`window.__DSH_PET_BG_STOP__` 等诊断入口都依赖它，改名要动一堆接线，不值得）。
功能全清单见 `../docs/09-桌宠功能清单.md`，引擎/菜单机制见 `../docs/05-引擎与菜单.md`。

## 目录

```
plugin/
├─ package.json        dsh.client 配置（platform:web, inject:[slots]）+ exports["./client"]
├─ cordis.patch.yml    刻意留空的补丁文件（登记行走 profile 补丁层，由 install.ps1 写入，见文件内注释）
├─ install.ps1         安装/卸载（junction + profile package.json 登记 + cordis 补丁管理块，幂等）
├─ lib/index.js        宿主侧入口（手写，入库；只在服务启动时读一次 ⇒ 改它必须重启 dsh 服务）
├─ lib/client.js       ★ 生成物（assemble.mjs 产物，.gitignore 不入库）
├─ src/core.js         存储/sanitize/事件小内核（fpsScale 的真默认值在这里）
├─ src/pet.js          桌宠本体（状态机/菜单/漫游/拖拽/几何/预切缓存）
├─ src/bg.js           背景视频层（IndexedDB → URL.createObjectURL，#dsh-pet-video z0）
├─ src/boot.js         接线与注册（apply/inject、会话事件订阅、降级占位方块）
├─ src/sheet.js        ★ 生成物（embed-sheet.mjs 产物，.gitignore 不入库；仓库带占位说明）
├─ tools/embed-sheet.mjs  PNG→base64 内嵌 + meta 校验 + 硬限 4.0MB（限 base64 不是 PNG）
├─ tools/assemble.mjs     5 个 src 按 core→sheet→pet→bg→boot 合并成 lib/client.js + new Function 语法自检
├─ tools/copy-hd.mjs      （第二阶段）外挂高清图集常量生成：assets/pet-hd.json + spritesheet-hd.png → SHEET_HD
├─ tools/verify.mjs       在线 GUI 验收探针（需要宿主页面在跑；沙箱内 headless 不可用，见 docs/06 规则32）
└─ assets/               示例小图集 spritesheet.png + pet.json（demo：5 帧 idle，其余状态代填）
```

## 构建（克隆后必做——sheet.js 与 client.js 不入库）

```powershell
# 在仓库根目录，一条命令跑通零外部素材链路（含本插件的构建）：
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1 -Demo

# 或只构建插件（assets/ 里已有示例图集时）：
node plugin\tools\embed-sheet.mjs plugin\assets     # → plugin\src\sheet.js + assets 同步
node plugin\tools\assemble.mjs                      # → plugin\lib\client.js（语法自检）
node tools\smoke.mjs                                # 假 DOM 冒烟验收（headless 浏览器的替代门槛）
```

## 安装 / 卸载

前提：DSH Web 宿主至少启动过一次（`dsh web`，profile 目录 `%USERPROFILE%\.dsh\profiles\<profile>` 存在），
且 `lib\client.js` 已构建（见上）。安装目录在用户 profile 下（工作区外）——在受限沙箱里执行会被拒绝，
需要按宿主规矩一次性提权（这是设计好的边界，不是 bug）。

```powershell
# 安装（默认 -Source = 本目录；-Profile 默认 web）：
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 卸载（精确摘除管理块，可回滚 package.json 备份）：
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Remove
```

install.ps1 做三件幂等的事（细节见脚本头注释）：
1. profile `package.json` → `dsh.profile.bundles[]` 加 `dsh-pet-bg`、`dependencies` 加 `link:<本目录>`；
2. profile `node_modules\dsh-pet-bg` → 指向本目录的 **junction**（改 client.js 后刷新页面即生效，无需重装）；
3. profile `cordis.patch.yml` → 插入带 managed 标记的登记块（-Remove 时精确摘除）。

生效：DSH Web 页签 **Ctrl+F5**。客户端 bundle 每次请求都从磁盘读 ⇒ 客户端改动刷新即可；
**宿主侧 `lib/index.js` 只在服务启动时读一次，改它必须重启 dsh 服务**。

## 换成你自己的素材

1. 素材（绿幕帧，组子目录布局，组名建议用 8 个实战名，见 `../examples/presets.json`）跑仓库根工具链：
   `python tools\key_green.py --src <素材> --out <抠图产物> --preset examples\presets.json`
   → 人审 `python tools\compare.py ...` → `python tools\pack_sheet.py --src <抠图产物> --out <目录> --cell 112x150 --box 98x118 --baseline 134 --display 192x224 --cols 8 --rows 21`
2. `node plugin\tools\embed-sheet.mjs <目录>`（要求 `<目录>\spritesheet.png + pet.json`；
   meta 必须含 idle/wait/walk/react/working/sleep 六状态，帧坐标不越界）
3. `node plugin\tools\assemble.mjs` → Ctrl+F5。
4. **体积红线**：embed-sheet 卡 base64 ≤ 4.0MB（≈PNG 3.0MB）。超了别硬提上限——
   先看 `../docs/07-体积与架构权衡.md` 的三条路线（降格子 / 外挂 HTTP 路由 / IndexedDB 导入），
   319 格高清版（PNG 8.94MB）只能走外挂路由。
5. 换图后必跑 `node tools\smoke.mjs`（几何/坐标/菜单断言），在线环境再跑 `node plugin\tools\verify.mjs`。

## 诊断

- 浏览器控制台：`BOOT.info()`；停止开关：`window.__DSH_PET_BG_STOP__`。
- 精灵图解码失败/未内嵌 → 桌宠显示为占位方块（设计行为，见 docs/09 降级小节）。
- 菜单点了没反应的状态 → 十有八九不在 `pet.js` 的 NAMES 白名单（docs/05 规则27，五处同步改）。
