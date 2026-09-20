# 单张纸直线裁切试排工具（Sheet Layout）

面向小型印刷店的**单张纸试排 / 批量排产 / 多纸型成本排产**网页：输入纸张尺寸、纹向、刀缝宽度和多种成品（宽 × 高 × 数量 × 纹向要求 × **订单号**），
自动生成**断头台式（guillotine）直线裁切布局**——既可试排一张纸，也可设定用纸上限逐张排完整批需求，
还可在 2～8 种候选纸张之间按**单位已排成品面积成本**逐轮择优、混合用纸完成整批生产；
勾选**「每张纸仅排一个订单」**后进入**订单隔离排产**：每张纸只服务一个订单，并按订单汇总进度与受阻诊断。

## 裁切规则

- 每一刀都沿直线**切透当前矩形区域，将其一分为二**；
- 成品允许旋转 90°（图中以 `⟳90°` 标注，放置尺寸与规格互换），但**受纹向约束**（见下节）；
- **刀缝按实际宽度占位，切割不侵占任何成品**（刀缝带与成品只共边、不重叠）；
- 排不下的件数按成品规格单独列出，并标明是**尺寸不足**还是**纹向受限**；
- 输出 SVG：成品块（名称、规格、旋转状态、纹向匹配、件号）、带序号的裁切中心线（序号即下刀顺序）、
  余料区，以及已排面积占比、刀缝面积、余料面积、总刀数等统计。

排样采用“大件优先 + 最佳适配（BSSF 变体）+ 较短余料优先切分”的贪心断头台启发式算法，
属快速试排工具，不保证全局最优。

## 纹向约束（grain direction）

纸张与成品都可携带纹向，排样**只采用两者纹向平行的朝向**：

- **纸张纹向** `paperGrain`（单张/批量）或纸型的 `grain`（多纸型）：
  `along-width`（沿宽，缺省）/ `along-height`（沿高）；
- **成品纹向要求** `grain`：
  `any`（不限，缺省）/ `along-width`（沿自身宽）/ `along-height`（沿自身高）。

朝向判定（未旋转时成品宽 ∥ 纸张宽，旋转 90° 后成品宽 ∥ 纸张高）：

| 成品要求 \ 纸张纹向 | 沿宽 | 沿高 |
| --- | --- | --- |
| 不限 | 两种朝向均可 | 两种朝向均可 |
| 沿自身宽 | 仅不旋转 | 仅旋转 90° |
| 沿自身高 | 仅旋转 90° | 仅不旋转 |

该规则**统一作用于单张、批量和多纸型成本排产**：

- 单张/批量：纹向不允许的朝向直接从候选中剔除，余件逐张扣减时纹向要求随件保留；
- 多纸型：纹向导致排不进任何余件的纸型**不参与当轮可行候选排名**；
  若所有有库存纸型都因尺寸或纹向放不下余件，返回 `no-progress` 且**不扣库存**。

结果中每件成品标明实际朝向（`rotated`）与纹向匹配状态（`grain` 要求、`grainOk` 是否满足——
排样保证已排成品恒为满足）；未排件在 `unplaced`/`remaining` 中标注纹向要求与
`grainBlocked`（几何上能放下但纹向不允许时为 `true`，纯尺寸不足为 `false`）。
缺省值（纸沿宽、成品不限）与旧版请求完全兼容。

## 批量排产

在「排产模式」中选择**批量排产**并设置**最多用纸张数**后，服务端按同一套断头台规则**逐张排样**：
每排完一张纸，就从剩余需求中扣除该张已排数量，再排下一张，直到满足任一终止条件：

| 终止原因 `stopReason` | 含义 |
| --- | --- |
| `completed` | 全部成品排完 |
| `max-sheets` | 已用完设置的最多纸张数，仍有剩余 |
| `no-progress` | 某张纸一件成品都排不进（尺寸或纹向限制），**立即止损**（该空白纸不计入结果，绝不输出空白纸、不会死循环） |

接口返回每张纸各自完整的布局（`sheets`）、剩余件数（`remaining`），
以及汇总（`summary`）：用纸数、完成率、总刀数、已排/总件数。
前端可点击「第 N 张」标签逐张查看布局与下刀顺序，并显示终止原因横幅。

## 多纸型成本排产

在「排产模式」中选择**多纸型成本排产**后，录入 **2～8 种候选纸张**：
名称（可留空，自动命名为「纸型 N」）、宽、高、**纹向（沿宽/沿高）**、**单价（元/张，必须 > 0）**、
**可用张数（0～500 的整数，0 表示该纸型暂无库存）**。

服务端每轮对所有「仍有库存 **且** 能放入至少一件余件」的纸型调用现有单张排样
（含各自纹向约束，纹向不可行的纸型不进入可行候选），按以下顺序选出下一张纸：

1. **单位已排成品面积成本最低**：`单价 / 本张已排成品面积`（元/mm²，接口以 元/m² 返回 `costPerM2`）；
2. 同分时**本张已排件数多**者优先；
3. 再同分按**录入顺序**靠前者优先。

选中后扣减该纸型库存 1 张、按该张布局扣减剩余需求，进入下一轮，直到满足任一终止条件：

| 终止原因 `stopReason` | 含义 |
| --- | --- |
| `completed` | 全部成品排完 |
| `stock-exhausted` | 所有纸型库存均已耗尽，仍有剩余 |
| `no-progress` | 仍有库存的纸型**全部**排不进任何剩余成品（尺寸或纹向限制），立即止损（不扣库存、不生成空白纸） |

> **空白纸绝不计入结果**：某纸型本轮一件都排不进时不参与选择、不扣库存；
> 只有确实排入成品的纸才会出现在 `sheets` 中。循环上界为各纸型库存之和（≤ 8×500），
> 每张至少排入一件，算法必然终止。

接口 `POST /api/layout/cost` 返回：

- `stopReason`：终止原因（上表三种之一）；
- `sheets`：**逐张**结果，每张含轮次 `round`、纸型（`paperId`/`paperName`/`paperWidth`/`paperHeight`）、
  单价 `price`、本张布局 `layout`（结构同 `/api/layout`），以及选择指标
  `piecesPlaced`、`placedArea`（mm²）、`costPerM2`（元/m²），
  `selection.ranked` 列出本轮**全部可行候选**的同名指标与 `selected` 标记；
- `usage`：**各纸型用量**——库存、已用张数、剩余库存、已排面积、小计成本；
- `summary`：总轮次/用纸数、用纸种类 `paperKindsUsed`、已排/总件数、完成率、总刀数、
  **总成本 `totalCost`（元）**、已排成品总面积（mm² 与 m²）、综合单位成本 `effectiveCostPerM2`；
- `remaining`：仍未排入的成品（含原始需求 `total`、已排 `placed`、剩余 `quantity`）。

前端提供：纸型录入表格、每张纸上的**混合用纸标签**（颜色与纸型对应）、
**各纸型用量与成本汇总表**、每轮候选纸型的指标对比表，以及终止原因横幅与剩余件数表。

## 订单隔离排产（每张纸仅排一个订单）

成品行可填写**订单号**（可留空），并在排产模式区勾选
**「每张纸仅排一个订单」**（请求字段 `isolateOrders: true`，批量/多纸型两种模式均支持）：

- **未勾选时行为完全不变**：一张纸可混排所有成品；填写了订单号也不影响排样，
  仅在结果中随件透传 `orderNo`。
- 勾选后，每个**不同订单号**各自成组（订单号按**首次录入顺序**排列）；
  **未填订单号的成品归入“无订单”组**，该组内部仍可混排，但不会与任何有订单号的成品同纸。
- **一张纸只排一个订单的成品**；每轮（每张纸）安排如下：

### 批量排产（固定纸型）下的选单规则

每轮分别对各未完成订单用当前固定纸型试排一张，按以下顺序选出本张所属订单：

1. **本张已排成品面积大**者优先；
2. 同分时**本张已排件数多**者优先；
3. 再同分按**订单录入顺序**靠前者优先。

选中后只扣减该订单的剩余需求，其他订单需求原样保留。

### 多纸型成本排产下的联合比较

每轮联合比较所有 **「未完成订单 × 仍有库存纸型」** 候选（纹向/尺寸放不下余件的候选直接剔除）：

1. **单位已排成品面积成本最低**：`单价 / 本张已排成品面积`；
2. 同分时**本张已排件数多**者优先；
3. 再同分按**录入顺序**：先比**订单录入顺序**，再比**纸型录入顺序**。

选中后**只扣减该订单的剩余需求与该纸型库存**（不影响其他订单与纸型）。
`selection.ranked` 列出本轮**全部可行的「订单 × 纸型」候选**及其订单号、指标与 `selected` 标记。

### 结果汇总与受阻止损

- 逐张结果标明订单号：批量返回 `sheets[*].orderNo`（隔离时每张为
  `{ round, orderNo, piecesPlaced, placedArea, selection, layout }` 包装结构），
  成本返回 `sheets[*].orderNo`；SVG 成品块与标签也显示订单号。
- 顶层 `orders` **按订单汇总**：需求 `piecesTotal`、已排 `piecesPlaced`、
  剩余 `piecesRemaining`、完成率 `completionRate`（无订单号组以空串 `""` 表示，前端显示「（无订单号）」）。
- **受阻止损**：若任一剩余订单在**所有可用纸型**（批量模式即固定纸型；多纸型模式为所有仍有库存纸型）
  上试排都一件都排不下，立即返回 `stopReason: 'no-progress'` 与 **`blockedOrders`**
  （受阻订单号、需求/已排/剩余/完成率，及受阻成品明细与纹向/尺寸原因）：
  **不生成空白纸、不扣减任何库存或订单需求**；其余订单的剩余需求原样保留在 `remaining` 中。
  多纸型模式下若仅是**库存全部耗尽**（几何上仍可继续），终止原因为 `stock-exhausted`，
  `blockedOrders` 为空。
- 顶层与各纸型用量、成本、完成率等汇总口径与非隔离模式一致；
  未开启隔离时不返回 `orders`/`blockedOrders`，旧客户端与旧请求完全兼容。

## 单条命令启动（需要 Docker + Docker Compose）

```bash
docker compose up -d --build
```

启动后浏览器访问： **http://localhost:3000**

停止：

```bash
docker compose down
```

镜像构建时会通过 `npm ci` 自动备齐全部依赖（仅 Express），**无需任何外部服务或数据库**。

### 必要配置

| 配置 | 方式 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 宿主机访问端口 | 环境变量 `PORT` | `3000` | 如 `PORT=8080 docker compose up -d --build`，则访问 http://localhost:8080 |

容器内固定监听 3000 端口，不挂载卷、不依赖外部存储。

## 本地直接运行（不用 Docker）

要求 Node.js ≥ 18。

```bash
npm install
npm start          # 默认 http://localhost:3000，可用 PORT=8080 npm start 改端口
```

## 使用说明

1. 填写纸张宽、高（mm）、刀缝宽度（mm，可为 0）和**纸张纹向**（沿宽/沿高），也可从“常用纸度”下拉选择 A3/A2/A1、正度/大度全张；
2. 选择排产模式：
   - **单张试排**（默认）；
   - **批量排产**（需设置最多用纸张数，1–500）；
   - **多纸型成本排产**（在纸型表格中录入 2～8 种候选纸张的名称、宽高、纹向、单价和可用张数）；
   - 需要时勾选**「每张纸仅排一个订单」**开启订单隔离排产；
3. 在成品清单中逐行填写名称（可留空）、**订单号（可留空）**、宽、高、数量、
   **纹向要求**（不限/沿自身宽/沿自身高），可随时增删行；
4. 点击「生成裁切方案 / 生成排产方案 / 生成成本排产方案」：
   - 左侧/下方 SVG 显示纸面布局（顶部标注纸张纹向）；红色虚线带圆形序号即裁切中心线，按序号顺序逐刀切割；
     有纹向要求的成品块标注 `纹✓`（排样保证纹向平行）；
   - 批量模式下点击「第 N 张」标签切换查看每张纸的布局，顶部横幅显示终止原因与汇总；
   - 成本模式下标签显示每张纸的轮次与纸型名称（颜色与混合用纸标签一致），
     页面展示成本汇总、各纸型用量表（含纹向）与本轮候选指标对比表；
   - 开启订单隔离后，标签与页面标明每张纸的**订单号**，页面展示
     **订单汇总表**（需求/已排/剩余/完成率）与**受阻订单**横幅及明细表，
     成本模式的候选对比表按「订单 × 纸型」列出；
   - 「下刀顺序」表列出每一刀的方向（竖切/横切）、被切区域和切线长度；
   - 「排不下的成品 / 未排完的成品」表列出每种规格的纹向要求、已排/需求数量和剩余件数，
     并标明受阻原因（纹向受限 / 尺寸不足）。

## HTTP 接口

- `GET /api/health` — 健康检查，返回 `{"ok":true}`
- `POST /api/layout` — 单张排样
- `POST /api/layout/batch` — 批量排产（在单张入参基础上增加 `maxSheets`，可选 `isolateOrders`）
- `POST /api/layout/cost` — 多纸型成本排产（入参为 `kerf`、`papers`、`products`，可选 `isolateOrders`）

成品对象在原有字段上增加可选 **`orderNo`**（字符串，≤64 字符；缺省/空白表示无订单号）；
顶层可选布尔 **`isolateOrders`**（缺省 `false`）。非法 `orderNo`/`isolateOrders` 返回 HTTP 400。

单张请求示例（含纹向）：

```json
{
  "paperW": 889,
  "paperH": 1194,
  "paperGrain": "along-height",
  "kerf": 3,
  "products": [
    { "name": "封面", "width": 210, "height": 285, "quantity": 12, "grain": "along-height" },
    { "name": "名片", "width": 90, "height": 54, "quantity": 80, "grain": "any" }
  ]
}
```

返回包含 `paper`（含 `grain` 纸张纹向）、`stats`（含 `areaRatio` 已排面积占比 0–1）、
`items`（成品摆放坐标、旋转状态 `rotated`、纹向要求 `grain` 与匹配状态 `grainOk`）、
`cuts`（刀序、方向、被切区域、刀缝带、切线长）、`frees`（余料矩形）、
`unplaced`（排不下的件数，含 `grain` 与受阻原因 `grainBlocked`）。
非法输入（含非法纹向取值）返回 HTTP 400 与错误信息。

批量请求示例：

```json
{
  "paperW": 889,
  "paperH": 1194,
  "paperGrain": "along-height",
  "kerf": 3,
  "maxSheets": 10,
  "products": [
    { "name": "封面", "width": 210, "height": 285, "quantity": 40, "grain": "along-height" },
    { "name": "名片", "width": 90, "height": 54, "quantity": 300 }
  ]
}
```

返回包含 `paper`、`stopReason`（`completed` / `max-sheets` / `no-progress`）、
`summary`（`sheetsUsed` 用纸数、`piecesPlaced`/`piecesTotal`、`completionRate` 完成率 0–1、`cutsTotal` 总刀数）、
`sheets`（每张纸各自完整的单张排样结果，结构同 `/api/layout` 返回）、
`remaining`（仍未排入的成品，结构同 `unplaced`）。

多纸型成本排产请求示例：

```json
{
  "kerf": 3,
  "papers": [
    { "name": "大度全张", "width": 889, "height": 1194, "grain": "along-height", "price": 3.5, "stock": 10 },
    { "name": "A3", "width": 297, "height": 420, "grain": "along-width", "price": 0.4, "stock": 50 }
  ],
  "products": [
    { "name": "封面", "width": 210, "height": 285, "quantity": 40, "grain": "along-height" },
    { "name": "名片", "width": 90, "height": 54, "quantity": 300 }
  ]
}
```

返回包含 `stopReason`（`completed` / `stock-exhausted` / `no-progress`）、
`sheets`（逐张：`round`、纸型信息（含 `paperGrain`）、`price`、`piecesPlaced`、`placedArea`、`costPerM2`、
`selection.ranked` 本轮全部可行候选指标（纹向不可行的纸型不在其中）、`layout` 完整单张布局）、
`usage`（各纸型 `grain`/`stock`/`used`/`remainingStock`/`placedArea`/`cost`）、
`summary`（`sheetsUsed`、`paperKindsUsed`、件数与完成率、`cutsTotal`、
`totalCost` 总成本、`totalPlacedAreaM2`、`effectiveCostPerM2` 综合单位成本）、
`remaining`（剩余成品，含 `grain` 与 `grainBlocked`）。
非法输入（纸型少于 2 种/多于 8 种、单价 ≤ 0、张数越界、纹向取值非法等）返回 HTTP 400。

订单隔离排产请求示例（多纸型；批量模式同形，另带 `maxSheets`）：

```json
{
  "kerf": 3,
  "isolateOrders": true,
  "papers": [
    { "name": "大度全张", "width": 889, "height": 1194, "grain": "along-height", "price": 3.5, "stock": 10 },
    { "name": "A3", "width": 297, "height": 420, "grain": "along-width", "price": 0.4, "stock": 50 }
  ],
  "products": [
    { "name": "封面", "width": 210, "height": 285, "quantity": 40, "grain": "along-height", "orderNo": "SO-001" },
    { "name": "名片", "width": 90, "height": 54, "quantity": 300, "orderNo": "SO-002" },
    { "name": "赠品", "width": 80, "height": 80, "quantity": 20 }
  ]
}
```

隔离模式返回在上述结构上增加/变化：

- `isolateOrders: true`；
- `sheets[*].orderNo`：本张所属订单号（无订单号组为 `""`）；
  批量模式的 `sheets[*]` 为 `{ round, orderNo, piecesPlaced, placedArea,
  selection:{ranked:[{orderNo,piecesPlaced,placedArea,selected}]}, layout }` 包装结构；
  成本模式的 `selection.ranked[*]` 额外带 `orderNo`（「订单 × 纸型」联合候选）；
- `orders`：按订单汇总 `{ orderNo, piecesTotal, piecesPlaced, piecesRemaining, completionRate }`；
- `blockedOrders`：在所有可用纸型上均无进展的订单
  `{ orderNo, piecesTotal, piecesPlaced, piecesRemaining, completionRate, remaining[] }`
  （`remaining` 为受阻成品明细，含 `grainBlocked`），无受阻时为 `[]`；
- `items[*].orderNo` 与 `remaining[*].orderNo` 标明每件/每类余件所属订单。

## 项目结构

```
.
├── server.js            # Express 入口：静态页面 + /api/layout + /api/layout/batch + /api/layout/cost
├── src/packer.js        # 断头台二分排样核心算法（单张 layout + 固定纸型批量 layoutBatch[含订单隔离]，纹向/订单号）
├── src/cost.js          # 多纸型成本排产（逐轮试排候选、单位面积成本择优、库存与成本核算；含「订单×纸型」隔离排产）
├── public/
│   ├── index.html       # 单页界面（单张/批量/多纸型成本三种模式，纹向录入、订单号与隔离开关）
│   ├── style.css
│   └── app.js           # 表单交互 + SVG 渲染 + 逐张查看 + 成本汇总 + 订单汇总/受阻订单（原生 JS）
├── test/smoke.test.js   # 单张/固定纸型批量算法不变量测试（node:test，无额外依赖）
├── test/cost.test.js    # 多纸型成本排产测试：择优规则、同分顺序、库存、终止原因、校验
├── test/grain.test.js   # 纹向约束测试：朝向规则、三种模式贯通、受阻诊断、校验
├── test/order.test.js   # 订单隔离排产测试：选单/联合候选决胜、逐张标单、订单汇总、受阻止损、兼容性
├── Dockerfile
└── docker-compose.yml
```

## 测试

```bash
npm test
```

覆盖：成品不重叠且在纸面内、刀缝不侵占成品、旋转放置、二分区域几何一致、
面积守恒（成品 + 刀缝 + 余料 = 纸面）、未排件确实放不进任何余料区、非法输入校验，
以及批量排产的逐张扣减、上限停止、无进展止损（不产生空白纸）、空需求与参数校验等。

纹向约束另覆盖：朝向允许规则（平行才可采用）、两种朝向几何都可行时只采用平行朝向、
纹向阻止唯一可行朝向时排不进并标记 `grainBlocked`、缺省值兼容旧行为、非法纹向校验、
批量逐张扣减时纹向随件保留、多纸型中纹向不可行纸型被排除出可行候选排名、
全部有库存纸型因纹向放不下时 `no-progress` 且不扣库存、不同纹向纸型混合用纸。

多纸型成本排产另覆盖：单位面积成本低者优先（与单价高低无关）、
同分时已排件数多者优先、再同分按录入顺序、逐轮库存/需求扣减、
库存耗尽终止、全部无进展止损且不扣库存、零库存纸型不可选、
每轮入选者指标确为最小、用量与总成本汇总守恒、空需求、以及
纸型数量（2～8）、单价（>0）、张数（0～500 整数）等参数校验。

订单隔离排产另覆盖：每张纸只含同一订单成品且逐张标明订单号、
批量选单按已排面积→件数→订单录入顺序、成本模式「订单×纸型」联合候选按
单位面积成本→件数→订单顺序→纸型顺序、入选后只扣该订单与该纸型库存/需求、
按订单汇总需求/已排/剩余/完成率、任一订单在所有可用纸型无进展时 `no-progress`
（返回受阻订单、不生成空白纸、不扣库存/需求、其余订单需求保留）、
纹向受阻诊断随受阻订单返回、无订单号成品归入“无订单”组、空需求、
开关与订单号校验，以及未开启隔离/未填订单号时的旧行为与返回结构兼容。
