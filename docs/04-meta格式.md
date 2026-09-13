# 04 · meta 格式：pet.json 全字段与生成/解析两端

本篇是「图集 + meta」格式契约的权威说明：每个字段的类型、语义、三份真实实例值、
生成它的 `tools/pack_sheet.py` 开关、以及解析它的引擎入口（`plugin/src/pet.js`）。
引擎侧机制的完整推导（显示补偿/锚点/预切/倍速/白名单/菜单/z-order）在 [docs/05](05-引擎与菜单.md)，
打包侧归一化与尺寸不变量的推导在 [docs/03](03-归一化与图集.md)，本篇只给格式事实与互链。

引用约定同 docs/02：本仓库文件直接写路径；旧工程文件加前缀（`dsh-pet-bg/`、`petwork/`、
`qanimal/`、`v2s-out/`），全部只读。所有 file:line 均已对照当前文件逐行核实。核实基准版本：
`petwork/out/pet.json`（888 行）、`dsh-pet-bg/assets/pet-hd.json`（1519 行）、
`examples/demo-pet.json`（300 行）、`tools/pack_sheet.py`（429 行）、`plugin/src/pet.js`
（1071 行，58,216 B）、`plugin/tools/embed-sheet.mjs`（116 行）、`examples/pack-report.txt`（24 行）。

> 行号漂移说明：本仓库 `plugin/src/pet.js` 提纯自 `dsh-pet-bg/src/pet.js`（1074 行），
> 两版内容仅 `fetchSoft` 一处不同（旧工程 :285-289 多 3 行缓存策略注释；提纯版 :285-286
> 恢复 `cache:'no-cache'` 且未保留该注释）。**旧工程 :288 以后的行号 = 本仓库 +3**；
> 历史资料里的 `pet.js:749-756`（菜单八项）对应的是本仓库这份。core.js / bg.js / boot.js
> 三个文件两版字节级相同（SHA256 实测一致）。

三份真实实例（本篇字段表逐列对照）：

| 实例 | 路径 | 规模 | 用途 |
|---|---|---|---|
| 生产内嵌版 | `petwork/out/pet.json` | 162 帧、8×21 格、cell 112×150 | base64 内嵌进 client.js 的回退底座 |
| 生产高清版 | `dsh-pet-bg/assets/pet-hd.json` | 319 帧、8×40 格、cell 192×224 | `/pet-assets` 外挂热切换 |
| demo 版 | `examples/demo-pet.json` | 5 帧、5×1 格、cell 96×112 | 零外部素材跑通链路（6 状态代填） |

---

## 1. 字段总表

顶层字段全集（√=该实例含有；行号为该实例文件内实读位置）：

| 字段 | 类型/语义 | 生产内嵌 | 高清 | demo | 谁在读 |
|---|---|---|---|---|---|
| `version` | 整数，格式版本（现恒 1） | √ :2 | √ :2 | √ :2 | **引擎不读**（留格式演进；grep 实测 0 处引用） |
| `sheet` | 图集 PNG 文件名（人读/资产管线） | √ :3 `"spritesheet.png"` | √ :3 | √ :3 `"demo-sheet.png"` | **引擎不读**：PNG 实体经内嵌 dataUrl（`embed-sheet.mjs:110`）或外挂路由（`pet.js:266`）到达 |
| `cell` | `{w,h}` 格子像素尺寸（**存储参数**） | 112×150 :4-7 | 192×224 :4-7 | 96×112 :4-7 | `cellMeta()`（pet.js:144-170）、`buildCells()`（:206-229）、`geometry()`（:374-385） |
| `cols`/`rows` | 图集列数/行数 | 8/21 :8-9 | 8/40 :8-9 | 5/1 :8-9 | `buildCells()` 预切范围（pet.js:213-214，clamp 1..64）；外挂解码尺寸校验（:334-335） |
| `display` | `{w,h}` **显示尺寸**（CSS px 补偿项，见 §4） | 192×224 :10-13 | 192×224 :10-13 | 192×224 :10-13 | `cellMeta()` :155-168 |
| `displayScale` | 数，display 缺失时的回退倍率 | **无此字段** | **无此字段** | 2.0 :14（=224/112，`pack_sheet.py:313` 自动算） | `cellMeta()` :159-160（仅 display 缺失时参与几何） |
| `anchor` | `{x,y}` 锚点；[0,1] 区间值=cell 内比例，否则=像素 | {0.5,1} :14-17 | {0.5,1} :14-17 | {0.5,1} :15-18 | `cellMeta()` :149-153（两种写法判定） |
| `baselineY` | 脚底基线**像素行**，优先于 `anchor.y` | 134 :18 | 204 :18 | 100 :19 | `cellMeta()` :154 |
| `states` | 状态字典，见 §2/§3 | 8 状态 162 帧 :19-732 | 8 状态 319 帧 :19-1360 | 8 状态 36 帧（含代填） :20-237 | `stateDef()`（pet.js:171-200） |
| `views` | 三视图登记（front/back：cell+file+bbox），素材档案用 | :733-760 | :1361-1388（back 非空） | :238-253（back=null） | **引擎不读**（`pet.json:885` source.note 原文「引擎不读 views」；grep 实测 0 处引用） |
| `source` | 打包留档（dir/files/generator/cellBox/baseline/groups/quarantined/note…） | :761-887 | :1389-1515 | :254-299 | 引擎**只读 `source.cellBox`**：`sheetInfo()` 诊断 contentCssW/H（pet.js:1039-1042, :1059-1060），验收要用（docs/05 §k） |
| `sheetHash`/`sheetBytes`/`hd` | **仅外挂高清 meta**：PNG SHA256/字节数/标记（`copy-hd.mjs` 注入） | 无 | √ :1516-1518 | 无 | `hdMetaBad()` 硬校验 sheetHash（pet.js:307-308）；`hdDigestOk()` 比对实下载摘要（:311-321） |

`states` 键顺序固定为 `idle,wait,walk,react,working,sleep,supervise,dead`
（`pack_sheet.py:63` ORDER、:288-291 按 ORDER 写键）；**但 cell 占用顺序 ≠ 键顺序**，见 §3.4。

---

## 2. 重点：frames 是 `[[col,row],...]` 坐标对，不是扁平索引

- **现象**（会踩的坑）：把 frames 当扁平索引（`[36,37,...]`）读/写，或拿
  `row*cols+col` 反推坐标，在 cols 变化（生产 8 列 vs demo 5 列）或状态复用非连续格子
  （demo 的 wait=`[[0,0],[2,0],[4,0]]` 隔帧取格，`examples/demo-pet.json:54-67`）时立刻错位。
- **根因**：扁平索引隐含「按 cols=N 行优先连续排布」的解码约定，meta 一旦跨图集/跨子集复用
  就失效；坐标对每帧自含 (col,row)，与 cols、与占用顺序都解耦。
- **修法**（三端一致，全部按坐标对实现）：
  - 生成端：`fr["cell"] = [c, r]`，`c = idx % COLS`、`r = idx // COLS`（`tools/pack_sheet.py:264-268`；
    docstring 原文「meta.frames 是 [[col,row],...] 坐标对，不是扁平索引」`:26`、段注释 `:275`）；
  - 构建门槛：`for (const [col, row] of frames)` 解构 + `col<cols && row<rows` 越界即 die
    （`plugin/tools/embed-sheet.mjs:49-51`）；
  - 引擎：`stateDef()` 只接受「长度 ≥2 的非负整数对」，非法项丢弃、全非法回落单帧 `[[0,0]]`
    （`plugin/src/pet.js:189-198`）；绘制直接按 `cells[f[0]+','+f[1]]` 取预切小图（:571-573），
    预切缓存的 key 就是 `"col,row"`（:225）。
- **实测数字**：生产 162 帧坐标全部落在 0..7 × 0..20（冒烟断言 74 硬校验，
  `dsh-pet-bg/tmp/pet-smoke.mjs:431-434`，本机复跑 156 PASS / 0 FAIL）；高清 319 帧坐标
  0..7 × 0..39、320 格恰用 319 零重复（断言 97/98，:548-551）。frames 数组内顺序 = 播放顺序
  （打包按 `natural_key` 自然数值序追加，`pack_sheet.py:201-206`、:268）。

---

## 3. states 字段语义

每个状态对象固定五个键（顺序 `fps,loop,pingpong,mirrorable,frames`，`pack_sheet.py:285-287`）：

| 键 | 类型 | 生产实例（8 状态烧入值） | 引擎语义（pet.js） |
|---|---|---|---|
| `fps` | 数 | idle7 wait5 walk8 react9 working8 sleep4 supervise7 dead8（pet.json:21,121,205,301,365,469,565,661；高清同值 pet-hd.json，冒烟断言 75/99 硬校验 :435-438,:552-556） | 每帧现算 `fps = clamp(meta.fps × fpsScale(), 0.2, 60)`（:183），机制见 docs/05 规则 25/26 |
| `loop` | bool | 仅 react=false，其余 true（pet.json:303 等；断言 76 :439-442） | `loop:false` = 单次播放（§3.2） |
| `pingpong` | bool | 8 状态全 true | A→B→A 三角波（§3.1，:449-453） |
| `mirrorable` | bool | 仅 walk=true（pet.json:208；demo 同 :73） | 绘制时 `ctx.scale(-1,1)` 水平镜像换向，图集只存一个朝向（:575-583） |
| `frames` | `[[col,row],...]` | 23/19/22/14/24/22/22/16 帧，计 162 | §2 |

可选键（生产 meta 未用，引擎支持）：`facing`（'left'|'right'，镜像基准朝向，:187）、
`next`（单次播放完回哪个状态，缺省 idle；必须在 NAMES 白名单内，:188、:441）。

### 3.1 pingpong：消除非循环帧集回到第 1 帧的跳变

- **现象**：帧序列首尾不衔接（第 n 帧与第 1 帧姿势差很远）时，正向循环播完跳回第 1 帧，
  肉眼是一次「闪跳」。
- **根因**：素材是视频抽帧的动作段，不是手绘循环图；多数动作段首尾姿势天然不同。
- **修法**：`pingpong:true` 让播放走三角波 A→B→A：`period = 2×(n−1)`，
  `m = i mod period`，`m < n−1 ? m : period−m`（`pet.js:449-453`），到末帧后倒放回首帧，
  跳变点消失。生产 8 状态全部 `pingpong:true`（打包器写死，`pack_sheet.py:287`）。
- **实测数字**：素材侧的循环段检测给这个默认值兜底——抽帧期在每个场景段内找「首尾帧差最小」
  的子段作循环候选，再用「首尾差 ≤ 段内最大相邻差」判定是否真循环
  （`tools/extract_frames.py:139-140`、判定文案 :158-159、开关 `--detect-loops` :197-198、
  逐段输出 :296；判定同源 `video2sprite.py:253-274`，:22 注明）。实测例：
  「帧 1..9（9 帧）首尾差 34.1，段内相邻最大差 66.0 → 首尾比段内更像，正向循环可信」
  （`v2s-out/report.txt:26`；另一段 帧 1..7 首尾差 34.1 vs 54.8，`v2s-out2/report.txt:28`）。
  判定为真循环的段正向 loop 也顺眼；判不出来的段靠 pingpong 兜底。**算法细节与阈值推导见
  [docs/01-抽帧.md](01-抽帧.md)，此处一段带过。**

### 3.2 loop:false：单次播放（react）

- **现象**：庆祝动作（react）如果循环播放，会一直重复庆祝不回到工作状态。
- **根因**：react 是事件驱动的「一次性反应」，语义上播一遍就该退出。
- **修法**：`loop:false`（生产 meta 仅 react，`pet.json:303`；打包器 `LOOP_FALSE={"react"}`，
  `pack_sheet.py:69`）。引擎每帧检查：`st.name==='react' && !def.loop` → `advanceOneShot()`
  （`pet.js:622-623`），播完（时长 = `frames.length / fps × 1000`，:440）回 `next`（缺省 idle）
  或被 `pendingAfter` 劫持回打断前的状态（点击打断 working → 庆祝完回 working，:431、:439-444）。
  单次播放期间普通切换被拒绝、`force:true` 才可打断（:425-427）。
- **实测数字**：react 生产 14 帧 @fps9（fpsScale=1 时时长 ≈14/9×1000≈1556ms）；
  冒烟断言 09「react 单次自动回 idle」、76「react loop=false」PASS（tmp/pet-smoke.mjs:439-442）。

### 3.3 wait 的缺省来源与 fill-from-idle 代填

- wait 未提供素材时打包器自动用 idle 隔帧代用（`frames[::2]`，`pack_sheet.py:295-298`；
  demo 实测 idle 5 帧 → wait 3 帧 `[[0,0],[2,0],[4,0]]`，`examples/pack-report.txt:11`）。
- `--fill-from-idle` 显式列出的状态用 idle 帧序列原样代填，且如实写进 `source.note`
  （`pack_sheet.py:130-132`、:299-308、:336-337）。demo 即 6/8 状态代填：
  `walk,react,working,sleep,dead,supervise`（`examples/demo-pet.json:297` note 原文
  「demo 复用 idle 帧序列，非真实动作素材」；pack-report.txt:12-17 逐条 `[!]` 留档）。
  这是 demo 属性不是格式属性——正式制作必须给真实素材（docs/02、docs/09）。

### 3.4 cell 占用顺序 ≠ states 键顺序（读图别按键序）

- **现象**：按 states 键顺序（idle 第一）去图集上找格子会找错——生产图集 [0,0] 格是 walk
  的第 1 帧，idle 从 [4,4] 才开始。
- **根因**：入格顺序 = 素材目录的**组发现顺序**（pass2 按发现顺序遍历 groups，
  `pack_sheet.py:255-269`），而 meta.states 键顺序 = 固定 ORDER（:63、:288-291）；两者本来就不一致。
- **修法**：帧→格的唯一权威映射是各状态的 `frames` 坐标；打包器逐组打印入格索引留档
  （:258-263「组 帧索引→格(col,row)」）。
- **实测数字**：生产图集各组起始格（`petwork/out/pet.json` 各状态 frames 首项）：
  walk=[0,0](:210-213)、react=[6,2](:306-309)、idle=[4,4](:26-29)、working=[3,7]、wait=[3,10]、
  sleep=[6,12]、supervise=[4,15]、dead=[2,18]——换算扁平起点 0/22/36/59/83/102/124/146，
  与帧数 22/14/23/24/19/22/22/16 逐段连续吻合（总和 162，8×21=168 格富余 6）。

---

## 4. 几何字段：cell / display / displayScale / anchor / baselineY

这五个字段共同决定「屏幕上多大、脚踩在哪」。公式与推导全在
[docs/05 规则 22/23](05-引擎与菜单.md) 与 [docs/03 §5](03-归一化与图集.md)，此处只给格式侧事实：

- `cell` 是**存储参数**（图集省体积：192×224→112×150，PNG 8.94MB→2.43MB，
  `dsh-pet-bg/README.md:149,158`），`display` 是**显示参数**。缩小 cell 必须配 display 补偿，
  否则桌宠跟着缩小 42%（宽比 112/192=0.583；docs/03 §5）。
- 元素尺寸 = `display × scale × PAD(1.25)` ⇒ 生产/demo 两套 meta 的 display 都是 192×224，
  元素恒为 240×280（`pet.js:381`；pack_sheet.py:183-187 打包时就把这个数打印出来）。
- `anchor` 双写法：值在 [0,1] 区间视为 cell 内比例，否则视为像素（`pet.js:150-153`；
  三份实例都是比例写法 `{x:0.5,y:1}`）。`baselineY`（像素行）**优先于** `anchor.y`
  （`pet.js:154`）：生产 134（脚底行，8 组实测脚底 y 全部 =134，docs/03 §1 表）、高清 204、demo 100。
- `displayScale` 只是 display 缺失时的回退（`dspW = cell.w × displayScale`，缺省 1，
  `pet.js:158-168`）；`pack_sheet.py:313` 自动写 `display.h / cell.h`（demo=2.0）。
  生产两份 meta 由旧工程 sprites.mjs 生成、无此字段——display 在场时 displayScale 不参与几何。
- 内容盒 `source.cellBox`（生产 98×118）不是几何输入，但是验收输入：
  内容上屏 CSS px = cellBox × k（k=display.h/cell.h=1.4933）= 146×176，
  引擎 `sheetInfo()` 实时换算（`pet.js:1039-1042,:1059-1060`），两种素材必须一致——
  推导见 docs/05【尺寸不变量 k=display/cell】一节。

---

## 5. 生成端：tools/pack_sheet.py 开关 → 字段对照

meta 由 `tools/pack_sheet.py` 生成（与旧工程 `petwork/tools/sprites.mjs states --precut`
同语义，`pack_sheet.py:13-14` docstring 声明；生产两份 meta 的 `source.generator` 仍是
sprites.mjs，见「待核实」#5）。开关全表（argparse 定义 :118-147）：

| 开关 | 默认 | 写进 meta 的字段 | 实现行 |
|---|---|---|---|
| `--cell WxH` | 112x150 | `cell` | :120, :324 |
| `--cols N` | 8 | `cols` | :121, :324 |
| `--rows N` | 0（=自动 `ceil(帧数/cols)`） | `rows` | :122, :247, :324 |
| `--box WxH` | 98x118 | `source.cellBox`（fit-to-box 目标内容盒） | :123, :229-234, :331 |
| `--baseline N` | 134 | `baselineY` + `source.baseline` | :124, :327, :331 |
| `--display WxH` | 192x224 | `display` | :125, :325 |
| `--display-scale F` | 0（=自动 `display.h/cell.h`） | `displayScale` | :126-127, :313, :326 |
| `--map 组=状态,...` | 内置实战映射（待机眨眼=idle 加载等待=wait 修bug=walk 敲代码=working 庆祝完成=react 睡觉休息=sleep 报错装死=dead 监工模式=supervise） | `states` 键的归属 | :128, :65-66, :160-165 |
| `--fps 状态=N,...` | FPS_DEF（idle7 wait5 walk8 react9 working8 sleep4 supervise7 dead8，clamp 2~24） | `states.*.fps` | :129, :67-68, :166-171, :276-278 |
| `--fill-from-idle 状态,...` | 无 | 代填状态 + `source.note` 如实记录 | :130-132, :299-308, :336-337 |
| `--fps-scale F` | 1.0 | 所有 fps 的乘数（round 3 位） | :133, :277 |
| `--max-content N` | 0=自动（>400px 判异规格） | `source.quarantined[]`（隔离不进图集） | :134-137, :199-211, :334 |
| `--sheet-name`/`--meta-name` | spritesheet.png / pet.json | 输出文件名 + `sheet` 字段 | :140-141, :323 |

固定写入（无开关）：`version:1`、`anchor:{x:0.5,y:1}`（:323,:327）、`loop/pingpong/mirrorable`
（react 单次、pingpong 全 true、mirrorable 仅 walk，:69-70,:285-287）、`views.front/back`
（idle/walk 第 1 帧格 + 回读 bbox；无对应素材则 null，:316-321）、`source.*` 全套留档
（:329-338；quarantined 的 reason 写明「规则15：基准必须是常量」:207-209）。
JSON 以 `indent=1` 落盘（:349）；引擎侧 assets 副本由 embed-sheet 以 indent=2 重写
（`embed-sheet.mjs:61`），两份仅排版与 `sheet` 文件名可能不同。

打包完必须回读成品 PNG 独立复测（:357-410，脚底跨度/质心跨度/触边/空格残留/最少占用 px），
全部指标写 `pack-report.txt`（:420-423）；k 与元素尺寸在落格前就打印（:183-187）。
demo 实跑留档 `examples/pack-report.txt`：脚底跨度=0px、触边=0、空格残留=0、
最少非透明 4751px、gate=全过（:19-24）。

meta → 插件的构建链（详见 docs/06 构建验收）：

1. `plugin/tools/embed-sheet.mjs`：形状门槛——`cell/cols/rows/states` 缺一即 die（:42）、
   **六状态必备** `idle/wait/walk/react/working/sleep`（:44-46，supervise/dead 可缺）、
   frames 坐标对越界即 die（:49-51）；base64 体积硬限 4.0MB（限 base64 不是 PNG，:19-22,:56）；
   产出 `plugin/src/sheet.js` 的 `var SHEET = {meta,dataUrl,embedded,pngBytes}`（:110），
   另把 PNG+meta 同步进 `plugin/assets/`（:59-61）。
2. 外挂高清 meta 另需 `sheetHash`（`copy-hd.mjs` 注入，实例 `pet-hd.json:1516-1518`），
   由 `embed-sheet.mjs:77-105` 写成 `SHEET_HD` 构建期常量（?v= 内容哈希缓存失效 + 版本错配自检）。
3. `plugin/tools/assemble.mjs`：按 `core→sheet→pet→bg→boot` 固定顺序拼进
   `lib/client.js`（:5-6,:16；sheet.js 缺失时补 `SHEET=null` 桩 :17-19），
   `new Function` 语法自检不过即 exit 2（:63-70）。

---

## 6. 解析端：引擎入口（plugin/src/pet.js，实读行号）

| 入口 | 行号 | 读什么 / 干什么 |
|---|---|---|
| `sheetData()` | :114-117 | 返回「当前生效的那套」：hd 优先、内嵌回退（两套 display 都是 192×224 ⇒ 元素恒 240×280，:105-109 注释）；meta 缺任何字段都不许炸（:105） |
| `cellMeta()` | :144-170 | 几何元数据唯一入口：cell/anchor 双写法（:149-153）/baselineY 优先（:154）/display 解析与 displayScale 回退（:155-168）；返回 `{cw,ch,ax,ay,ds,dspW,dspH}` |
| `stateDef(name)` | :171-200 | 状态定义：内置默认值（:172-179）← meta.states 覆盖（:182-196）；fps×fpsScale 现算（:183）；frames 坐标对过滤（:189-196）与 `[[0,0]]` 兜底（:198） |
| `buildCells()` | :206-229 | 按 cols×rows 预切全部格子（clamp 1..64，默认 8/5，:213-214）；机制见 docs/05 规则 24 |
| `geometry(scale)` | :374-385 | display/anchor/baselineY → 元素尺寸、绘制尺寸、锚点 px；推导见 docs/05 规则 22/23 |
| `hdMetaBad()` | :299-310 | 外挂 meta 形状校验：cell/cols/rows/states（白名单计数 :305）/sheetHash（:307-308） |
| `hdDecode()` | :322-342 | 解码尺寸必须 == `cols×cell.w × rows×cell.h`（:334-335），否则拒收回落内嵌 |
| `sheetInfo()` | :1035-1063 | 只读诊断（控制台 `__DSH_PET_BG__.PET.sheetInfo()`）：读 `source.cellBox` 换算 contentCssW/H（:1039-1042,:1059-1060），冒烟断言用它（docs/05 §k） |

引擎**不读**：`version`、`sheet`、`views`（grep `\.version|\.views|meta\.sheet` 于
plugin/src 四个源文件实测 0 命中；`pet.json:885`、`pet-hd.json:1513` note 原文自证）。

---

## 7. 样例 A：生产内嵌版（petwork/out/pet.json 精简）

> 排注：原文件 888 行（indent=2，frames 逐值一行）。下面为**节选重排**——每个状态只留
> 前 2 个坐标对，`/* …省略 */` 是本文档加的注释；**含注释的 JSON 不是合法 JSON**，
> 字段名、字段值、字段顺序与原文逐项一致（行号为原文实读位置）。

```jsonc
{
  "version": 1,                                    // :2
  "sheet": "spritesheet.png",                      // :3（引擎不读）
  "cell": { "w": 112, "h": 150 },                  // :4-7  格子（存储参数）
  "cols": 8,                                       // :8
  "rows": 21,                                      // :9    8×21=168 格，用 162 富余 6
  "display": { "w": 192, "h": 224 },               // :10-13 显示尺寸（CSS px 补偿）
  "anchor": { "x": 0.5, "y": 1 },                  // :14-17 比例写法
  "baselineY": 134,                                // :18   脚底像素行，优先于 anchor.y
  "states": {
    "idle":      { "fps": 7, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[4,4],[5,4]  /* …共23帧，:20-119 */ ] },
    "wait":      { "fps": 5, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[3,10],[4,10] /* …共19帧，:120-203 */ ] },
    "walk":      { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": true,
                   "frames": [[0,0],[1,0]  /* …共22帧，:204-299 */ ] },
    "react":     { "fps": 9, "loop": false, "pingpong": true, "mirrorable": false,
                   "frames": [[6,2],[7,2]  /* …共14帧，:300-363；loop:false=单次播放 */ ] },
    "working":   { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[3,7],[4,7]  /* …共24帧，:364-467 */ ] },
    "sleep":     { "fps": 4, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[6,12],[7,12] /* …共22帧，:468-563 */ ] },
    "supervise": { "fps": 7, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[4,15],[5,15] /* …共22帧，:564-659 */ ] },
    "dead":      { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": false,
                   "frames": [[2,18],[3,18] /* …共16帧，:660-731 */ ] }
  },
  "views": {                                       // :733-760（引擎不读）
    "front": { "cell": [4,4], "file": "idle1.png", "bbox": [7,23,98,111] },
    "back":  { "cell": [0,0], "file": "walk1.png", "bbox": [7,37,98,97] }
  },
  "source": {                                      // :761-887 打包留档
    "dir": "D:\\dsh\\demo\\demo1\\bg9",            // :762
    "files": 162,                                  // :763
    "generator": "sprites.mjs states --precut (per-group fit-to-box)", // :764
    "cellBox": { "w": 98, "h": 118 },              // :765-768 引擎唯一读的 source 字段（诊断）
    "baseline": 134,                               // :769
    "pngBytes": 2548445,                           // :770
    "groups": { "walk": { "frames": 22, "unionBBox": [304,26,1007,719],
                          "scale": 0.1392, "contentWH": [98,97] }
                /* …其余 7 组省略，实测表见 docs/03 §1（:771-884） */ },
    "note": "每组各自 fit-to-box…views.front/back 复用 idle1/walk1 格（引擎不读 views）", // :885
    "generatedAt": "2026-09-12T14:45:44.578Z"      // :886
  }
}
```

## 8. 样例 B：demo 版（examples/demo-pet.json 全文）

> 排注：原文件 300 行（`indent=1`、frames 逐值一行，`pack_sheet.py:349`）。下面为**等值紧凑
> 重排**——字段、值、顺序与原文逐项一致，未删任何字段。**注意它是 demo**：8 状态里 6 个由
> idle 帧代填（`source.note` 有说明），wait 是 idle 隔帧，仅 idle 是真实素材（5 帧）。

```json
{
 "version": 1,
 "sheet": "demo-sheet.png",
 "cell": { "w": 96, "h": 112 },
 "cols": 5,
 "rows": 1,
 "display": { "w": 192, "h": 224 },
 "displayScale": 2.0,
 "anchor": { "x": 0.5, "y": 1 },
 "baselineY": 100,
 "states": {
  "idle":      { "fps": 7, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "wait":      { "fps": 5, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[2,0],[4,0]] },
  "walk":      { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": true,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "react":     { "fps": 9, "loop": false, "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "working":   { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "sleep":     { "fps": 4, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "supervise": { "fps": 7, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] },
  "dead":      { "fps": 8, "loop": true,  "pingpong": true, "mirrorable": false,
                 "frames": [[0,0],[1,0],[2,0],[3,0],[4,0]] }
 },
 "views": {
  "front": { "cell": [0,0], "file": "f0002.png", "bbox": [10,12,77,88] },
  "back": null
 },
 "source": {
  "dir": "D:\\dsh\\demo\\demo1\\dsh-pet-kit\\examples\\keyed",
  "files": 5,
  "generator": "pack_sheet.py (per-group fit-to-box, 与 sprites.mjs states --precut 同语义)",
  "cellBox": { "w": 84, "h": 88 },
  "baseline": 100,
  "groups": {
   "idle": { "frames": 5, "unionBBox": [172,10,477,359], "scale": 0.25143, "contentWH": [77,88] }
  },
  "quarantined": [
   { "file": "demo/f0276.png", "contentWH": [1047,639],
     "reason": "内容超过 --max-content 400（异规格隔离，规则15：基准必须是常量，不能被离群大图拖垮）" },
   { "file": "demo/f0300.png", "contentWH": [524,317],
     "reason": "内容超过 --max-content 400（异规格隔离，规则15：基准必须是常量，不能被离群大图拖垮）" }
  ],
  "note": "每组各自 fit-to-box，组内共用一个裁切框+缩放+落点（零放置抖动）；底边对齐 baselineY、水平居中；脚底/质心跨度=真实动作幅度；fill-from-idle 代填状态：walk,react,working,sleep,dead,supervise（demo 复用 idle 帧序列，非真实动作素材）",
  "generatedAt": "2026-09-13T12:07:49.723398"
 }
}
```

demo 数字自洽性核对（全部实读）：`s = min(84/306, 88/350) = 0.25143`（unionBBox 306×350，
pack-report.txt:8）→ 内容 77×88（`306×0.25143≈77`）；落点 `px = round((96−77)/2) = 10`、
`py = 100−88 = 12` ⇒ `views.front.bbox = [10,12,77,88]`（demo-pet.json:245-250），与
fit-to-box 公式逐项吻合（公式见 docs/03 §1）；`displayScale = 224/112 = 2.0`
（pack_sheet.py:313）；k=2.0 ⇒ 元素 240×280、内容盒容量上屏 168×176（pack-report.txt:3-4）。
quarantined 两帧即 README 快速开始里那两张 1280×720 大画布帧（docs/03 §2 同款事故的小号重演）。

---

## 9. 待核实

1. **README 快速开始命令与 demo 成品参数不一致**：`README.md:57` 写
   `--cell 64x80 --cols 4 --display 240x280`，而 `examples/demo-pet.json` 实际是
   cell 96×112 / cols 5 / display 192×224（与 `pack_sheet.py:8-10` docstring 示例命令、
   `examples/pack-report.txt:2` 实跑参数一致）。README:70-71 自注步骤 3~5「P1 实测通过后
   更新为已验证」——README 本次只读不改，哪个是目标状态待 README 维护者定夺。
   另：demo 实跑的 `--frames` 过滤模式（7 帧取哪 7 帧）未留档（pack-report.txt:5 只有结果数）。
2. **并行编写中的文件**：`tools/smoke.mjs`（本次读取时 257 行、尚未写完）、
   `tools/extract_frames.py`、`tools/build.ps1` 与本文档并行产出，行号可能继续漂移；
   本篇只引 extract_frames.py 的判定文案行（:139-140,:158-159,:197-198,:296）与
   smoke.mjs 头注释的设计意图（:15-23），不依赖其余行号（约定同 docs/03:7-8）。
3. **互链占位**：`docs/01-抽帧.md` 尚未落地（文件名依据 `tmp-prep.py:48` 的引用）；
   `docs/06` 只有编号无文件名（`README.md:63`、`plugin/README.md:24`），本篇用文字引用。
4. **两份 pet.json 副本**：`plugin/assets/pet.json`（embed-sheet 同步副本，indent=2）在本次
   写作期间被并行构建重写过（3613B→4700B，`sheet` 字段 demo-sheet.png→spritesheet.png）；
   字段几何值与 `examples/demo-pet.json` 相同。本篇样例以 examples 那份为准。
5. **generator 归属**：生产两份 meta 的 `source.generator` 都是旧工程
   `sprites.mjs states --precut`（pet.json:764、pet-hd.json:1392），不是 pack_sheet.py；
   两者的 fps 缺省/键序/坐标对语义一致（pack_sheet.py:13-14 声明等价 + demo 产物字段实测吻合），
   但 sprites.mjs 的 fps 缺省段本次未逐行核实（只实读 :29,:851,:854）。

## 10. 证据行号速查表

| 文件 | 行号 | 用途 |
|---|---|---|
| `petwork/out/pet.json` | :2-18, :19-732, :733-760, :761-887（:763-770, :885） | 生产内嵌 meta 实例：头字段 / 8 状态 162 帧 / views / source 留档 |
| `dsh-pet-bg/assets/pet-hd.json` | :2-18, :19-1360, :1361-1388, :1389-1515, :1516-1518 | 高清外挂 meta：cell=display=192×224、baselineY 204、cellBox 146×176（:1393-1396）、sheetHash/sheetBytes/hd |
| `examples/demo-pet.json` | :2-19, :20-237, :54-67, :238-253, :254-299（:257, :297） | demo meta 全字段；wait 隔帧；back=null；generator/note |
| `examples/pack-report.txt` | :2-4, :5-8, :10-17, :19-24 | demo 打包实跑留档：参数/k/元素尺寸/fit-to-box 实测/代填与隔离/复测门槛 |
| `tools/pack_sheet.py` | :13-14, :23-30, :61-70, :118-147, :183-187, :199-211, :229-234, :247, :255-269, :275-278, :280-311, :313, :316-321, :323-338, :349, :352-355, :357-410, :420-423 | 生成端全链路：等价声明 / 不变量与坐标对 docstring / 常量表 / 开关 / k 打印 / 隔离 / 落点 / 入格与 frames 生成 / states 组装 / displayScale / views / meta 组装 / 落盘排版 / 体积 / 回读复测 / 报告 |
| `plugin/src/pet.js` | :105-117, :122-130, :144-170, :171-200, :206-229, :299-310, :322-342, :334-335, :374-385, :1035-1063 | 解析端：sheetData / countFrames / cellMeta / stateDef / buildCells / hdMetaBad / hdDecode 尺寸校验 / geometry / sheetInfo |
| `plugin/tools/embed-sheet.mjs` | :19-22, :42, :44-52, :56, :59-61, :77-105, :110 | 构建门槛：硬限 / 形状校验 / 六状态与坐标越界 / base64 检查 / assets 同步 / SHEET_HD / SHEET 写出 |
| `plugin/tools/assemble.mjs` | :5-6, :16, :17-19, :63-70 | 装配顺序 core→sheet→pet→bg→boot、sheet 桩、语法自检 |
| `tools/extract_frames.py` | :22, :139-140, :158-159, :197-198, :296 | 循环段检测（docs/01 主题，本篇一段带过） |
| `v2s-out/report.txt` / `v2s-out2/report.txt` | :26 / :28 | 循环段判定实测输出（首尾差 vs 段内相邻最大差） |
| `dsh-pet-bg/tmp/pet-smoke.mjs` | :431-434, :435-442, :548-556 | frames 坐标界内 / fps 烧入 / pingpong·loop·mirrorable / 高清坐标与零重复断言 |
| `dsh-pet-bg/README.md` | :149, :156, :158, :164-168 | 高清构建命令（--box-w=146 --box-h=176）与尺寸不变量记录 |
| `README.md` / `plugin/README.md` | :57, :63-64, :70-71 / :5, :23-24, :66-67 | 快速开始命令（待核实#1）、验收位置、docs/05·06 互链、embed-sheet 六状态要求 |
| `docs/03-归一化与图集.md` | :150-181 | 同一尺寸不变量在打包侧的完整推导（§5） |
| `docs/08-踩坑清单.md` | :15 | 「报错装死不可达」白名单事故（五处清单） |
