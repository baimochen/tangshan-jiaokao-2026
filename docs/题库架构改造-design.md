# 题库架构改造 · 设计文档

日期：2026-09-12
目标：唐山工业职业技术大学 2026 年选聘（教育类岗）笔试，2026-09-27。

---

## 一、为什么要改

现状是**一个 56.6 万字符的单文件 HTML**（`考点体系.html`），其中：

| 组成 | 字符数 | 占比 |
|---|---:|---:|
| 内嵌题库 JSON | 380,790 | 67.3% |
| 全部知识正文（14 个分类） | 184,763 | 32.7% |
| **合计** | **565,553** | |

三个问题：

1. **改一个字要读 1MB。** 想改教育学笔记里的一处笔误，得把整个文件拖进上下文。
2. **题库和正文搅在一起。** 题目是数据，笔记是文档，两者的编辑节奏完全不同。
3. **错题本淹没在刷题页里。** 它是学习的核心反馈，却只是刷题页的一个筛选条件。

改造后的目标状态：

- 题库进 SQLite，**结构完整**（正确答案、解析、分类、题型、来源全部入库）。
- 按导航栏拆成 15 个内容页 + 1 个首页壳，**每页只装自己那部分**。
- 错题本独立成页。
- 题库从 1000 题扩到 2000 题，覆盖常见公基题型。

### 非目标（明确不做）

- **不做防作弊。** 这是自学工具，答案和解析直接下发，不设权限、不藏答案。
- **不做多用户。** 服务端只有你一个人用，没有登录、没有账号。
- **不做部署上云。** 只在本机跑。
- **不使用 `大纲/唐山师范学院*` 作为出题依据。** 那是另一所学校的材料；本项目的母本是《河北省省直事业单位公开招聘（统一招聘）教育类专业科目考试大纲（试行）》，见 `出题范围.md` 第一节。

---

## 二、架构

```
bank.db  (SQLite，唯一真相源)
   │
   ├── server.py ──HTTP──▶ 浏览器
   │      GET  /api/*   读题库 / 作答记录 / 错题本 / 模考
   │      POST /api/*   写作答 / 错题 / 模考状态
   │      静态服务      web/ 下的 HTML/CSS/JS
   │
   └── export.py ──▶ 题库.json（备份、给外部工具用）
```

**关键转变：状态的归属从浏览器搬到服务端。**

现在作答记录和错题本存在 `localStorage`。拆页之后这变成隐患——`file://` 下各浏览器对 localStorage 的隔离粒度不一致（Chrome 按 `file://` 整体共享，Safari 可能按文件路径隔离），跨页共享随时会断。

既然选了服务端，就把**作答记录、错题本、模考进度全部放进 SQLite**。附带结果：手机上答的题，电脑上打开就在。

`server.py` 绑 `0.0.0.0`，手机连同一 WiFi 访问 `http://<Mac的IP>:8000` 即可。

**服务端只读数据库、不缓存**——导入脚本改了库，刷新页面就是新的。知识页（`edu.html` 等）是静态文件，直接编辑。

---

## 三、数据模型

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE questions (
  id          TEXT PRIMARY KEY,        -- 'e101' / 'p16' / 'f175'
  n           INTEGER NOT NULL UNIQUE, -- 稳定序号，仅用于显示题号
  section     TEXT NOT NULL,           -- 'edu'/'pub'/'local'/…  决定归哪个页面
  module      TEXT NOT NULL,           -- '教育学'…  配比表/成绩单按它分组
  type        TEXT NOT NULL CHECK (type IN ('single','judge','multi')),
  stem        TEXT NOT NULL,
  options     TEXT NOT NULL,           -- JSON 数组；判断题固定 ["正确","错误"]
  answer      TEXT NOT NULL,           -- 'B' / 'A' / 'ABD'（升序、无分隔）
  explanation TEXT NOT NULL,
  source      TEXT,                    -- 本地/时政题必填：核实来源
  tags        TEXT,                    -- 考点标签，逗号分隔
  difficulty  INTEGER CHECK (difficulty BETWEEN 1 AND 3),
  batch       INTEGER NOT NULL DEFAULT 1  -- 第几批入库，便于回滚
);
CREATE INDEX idx_q_section ON questions(section);
CREATE INDEX idx_q_module  ON questions(module);
CREATE INDEX idx_q_type    ON questions(type);

CREATE TABLE attempts (              -- 作答记录（每题的最终状态）
  qid     TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen  TEXT NOT NULL,
  correct INTEGER NOT NULL,          -- 判分时算好存下来，统计查询快
  at      TEXT NOT NULL
);

CREATE TABLE wrong (                 -- 错题本，独立成表
  qid         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen      TEXT,                  -- 最后一次的错误选择
  wrong_count INTEGER NOT NULL DEFAULT 1,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0   -- 后来做对了置 1，保留历史
);

CREATE TABLE mock_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  submitted_at TEXT,
  state        TEXT NOT NULL         -- JSON：题号序列 + 答案 + 分部分结构 + 是否含多选判断
);

CREATE TABLE sprint (                -- 冲刺进度（原 localStorage 的 jiaokao-sprint-2026）
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL
);
```

**设计取舍**：选项不单独建表。它从不被独立查询（永远跟着题目一起取），存 JSON 列更简单，导入导出也不用处理关联。**多选题的答案就是 `'ABD'` 这样一个字符串**——全库不再假设「答案是一个字母」。

---

## 四、服务端 API

纯 Python 标准库（`http.server` + `sqlite3` + `json`），**零依赖，不用 pip install**。每请求开一个连接，不共享连接对象。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/questions?section=&module=&type=&limit=&offset=` | 取题（刷题用） |
| GET | `/api/questions/<id>` | 取单题 |
| GET | `/api/attempts` | 全部作答记录 |
| POST | `/api/attempts` | `{qid, chosen}` → 判分、写 attempts、维护 wrong |
| DELETE | `/api/attempts` | 清空作答记录 |
| GET | `/api/wrong` | 错题本（**连题目一起返回**，一次请求够渲染） |
| POST | `/api/wrong/<qid>/resolve` | 标记已订正 |
| DELETE | `/api/wrong` | 清空错题本 |
| GET | `/api/stats` | 总题量、已做、正确率、分模块正确率 |
| GET | `/api/mock` | 当前模考状态 |
| POST | `/api/mock/start` | `{withTypes:bool}` → 抽题建卷 |
| POST | `/api/mock/answer` | `{runId, qid, chosen}` |
| POST | `/api/mock/submit` | 判分、合并进 attempts、返回成绩单 |
| GET | `/api/sprint` | 冲刺进度 |
| POST | `/api/sprint` | `{key, value}` |
| POST | `/api/migrate/legacy` | 一次性：接收旧 localStorage 数据 |

**`GET /api/questions` 连 `answer` 和 `explanation` 一起返回。** 这是自学工具，不设防作弊（见第一节非目标）——一次请求拿全，页面不用为看解析再跑一趟。

**判分函数 `grade(q, chosen)` 只有一份实现**，被 `POST /api/attempts`（刷题，即时判）和 `POST /api/mock/submit`（交卷，批量判）共用。模考答题期间**只存不判**——因为考试中不显示对错，`/api/mock/answer` 只写进 run 的 state，不碰 `attempts`，也不进错题本。交卷那一刻才批量判分并合并。

**`attempts` 每题一行，存的是最终状态。** 重做同一题会覆盖这一行，同时把 `wrong.resolved` 置 1（做对了）或累加 `wrong_count`（又错了）。历史轨迹不留，错题本要的是「现在还没掌握的有哪些」。

---

## 五、页面结构

```
web/
  index.html                       首页壳：导航 + 总览 + 冲刺进度
  direction.html  compare.html     ┐
  edu.html  pub.html  news.html    │ 15 个内容页
  local.html  school.html          │
  counselor.html  quiz.html        │
  mock.html  mnemonic.html         │
  interview.html  sprint.html      │
  material.html                    ┘
  wrong.html                       ← 新增，错题本独立成页
  assets/
    app.css      三态主题（现有 :root / media / [data-theme] 三块原样搬）
    nav.js       导航 + 主题切换 + 当前页高亮（加页面只改这一处列表）
    bank.js      取数封装（fetch + 错误处理）
    quiz.js  mock.js  wrong.js
```

每页 5KB～2 万字符。改教育学笔记只需读 `edu.html`。

**导航由 `nav.js` 注入**，页面本身不重复写导航 HTML——加一页只改 `nav.js` 里的一个数组。

**旧记录迁移**：`web/index.html` 放一个「导入旧版记录」按钮，读 `localStorage['jiaokao-answers-2026']` 和 `['jiaokao-wrong-2026']`，POST 到 `/api/migrate/legacy`。用完即弃，迁移完就删按钮。

---

## 六、题型扩展规格

这是本次改动**影响面最大**的部分。

### 6.1 判断题 `type='judge'`

- `options` 固定 `["正确","错误"]`，`answer` 为 `'A'`（正确）或 `'B'`（错误）。
- 界面**不显示 A/B 字母**，直接给「正确 / 错误」两个按钮。
- **禁止乱序。** 对/错的先后有语义，打乱会让解析里的「A 项」指错。`shuffledOpts()` 必须对 `judge` 直接返回原序。
- 解析中一般不出现字母指代，但仍走 `remapExplain`（恒等映射，安全）。

### 6.2 多选题 `type='multi'`

- `options` 2–5 项（常见 4 项）。
- `answer` 是**升序字母串**，如 `'ABD'`。入库校验强制：无重复字母、升序、每个字母都在选项范围内。
- **判分：全对才算对。** 少选、多选、错选一律记为错误 → 进错题本。口径与单选一致，不引入部分分。（若以后要「少选得半分」，只改 `grade()` 一个函数。）
- **交互：勾选 + 「确认作答」。** 不能在第一次点击时就判分。确认后锁定，与单选一致。
- **乱序照旧**，答案字母随显示位置重映射。

### 6.3 影响面清单

| 位置 | 现在 | 改成 |
|---|---|---|
| 存储 | `answers[qid] = 'B'` | `'ABD'`；比较从 `!==` 变集合相等 |
| 判分 | 单字母相等 | `grade(q, chosen)` 分派三题型 |
| 乱序 | 四项一律打乱 | `judge` 返回原序；`single`/`multi` 照乱 |
| 交互 | 点一下即判 | `multi` 需确认按钮 |
| 解析重映射 | 只认单个 `[ABCD]` | 还要认 `ABD`、`A、C 两项`、`AC 两项` |
| 错题本 | 派生自单字母 | 认 type，多选显示「你选 AC，正确 ABD」 |
| 模考配比 | 模块 → 题量 | 模块 → 题量 → 题型 |

### 6.4 解析字母重映射的扩展（有风险，要单独验）

现有 `isOptRef(pre, post)` 规则表只处理**单个字母**指代。多选引入三种新写法：

- `故选 ABD` / `应选 AC`
- `A、C 两项` / `A 和 C`
- `AB 两项` / `ACD 三项`

**改法**：正则从 `[ABCD]` 改为 `[ABCD]{1,4}` 整体匹配，命中的连续字母串**逐字母重映射**后原样拼回。

**风险**：`ABC 理论`（理性情绪疗法，A 是诱发事件、B 是信念、C 是情绪）这类**必须继续排除**。现有 10 个例外（p16/p228 的 ABC 理论、s123 的 `（B档）` 等）在改动后要**逐条重跑确认**。

**验证方法沿用现有做法**：`remap_probe.js` 不比对输入输出文本（原始字母恰好还排原位时，换了和没换长得一样），而是**在重映射过程中直接记录每个字母的判定结果**，再分「判为指代」（必须已换）和「判为非指代」（逐条人工确认）两类核对。

### 6.5 模考开关

配比表旁加一个开关「含多选/判断（练兵）」，**默认关闭**。

- 关闭：120 题全单选，与现在完全一致，配比不变。
- 打开：`MK_PARTS` 从「模块 → 题量」升级为「模块 → 题量 → 各题型题量」，模考卷掺入判断/多选。

**理由**：真实大纲只规定了考什么内容，没规定题型；全单选是你目前唯一有把握的考情。练兵版用来见题型，不污染模拟真实考场的那份手感。

开关状态存进 `mock_runs.state`，成绩单上标明本场是哪种版本。

---

## 七、内容扩充规格

新增 **1000 题**，题库总量到 2000。

**题型配比**：单选 600 / 判断 200 / 多选 200。

**模块配比**：按 `出题范围.md` 第二节现有 13 模块等比扩展，重点补大纲点名但现有题库偏弱的：

| 补齐方向 | 现状 | 说明 |
|---|---|---|
| 公共管理 | 混在「经济、管理与常识」里，仅 5 道 | 大纲单独点名 |
| 国情 | 无独立模块 | 大纲单独点名 |
| 职业道德 | 58 道，多集中在教师职业道德 | 公基的职业道德是另一回事 |
| 公文写作 | 67 道 | 河北高频，性价比高，可再扩 |
| 政治（含时政） | 时政仅 5 道 | 时政需考前一周重新核实 |

**id 段规划**：现有第一批 1xx、第二批 2xx。新增的第三批统一用 **3xx 段**（如 `e301–`、`p301–`），按模块分段，避免与现有 id 冲突。

**生产流程**：子代理并行生成，每模块一个代理，产出 JSON → `import_batch.py` **先校验后入库**。

**入库校验（不通过则整体拒绝，不部分写入）**：

1. `id` 全局唯一、不撞已有
2. `type` ∈ {single, judge, multi}，与 `options` 项数自洽（judge 恒 2 项）
3. `answer` 合法：单选 1 个字母、判断 `A`/`B`、多选长度 ≥2 且**升序无重复**
4. `answer` 的每个字母都在 `options` 范围内
5. `explanation` 非空，且解析里「故选 X」的 X 与 `answer` 自洽
6. `module` 与 `section` 在允许清单内
7. 本地题 / 时政题必须有 `source`
8. 同模块内题干不重复（相似度检测，防批量生成撞车）

---

## 八、测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| Python | `tests/test_schema.py` | 约束、索引、级联删除 |
| Python | `tests/test_grade.py` | `grade()` 三题型 × 对/错/少选/多选/错选 |
| Python | `tests/test_import.py` | 上面 8 条校验，每条**构造一份坏数据证明它真的拒绝** |
| Python | `tests/test_migrate.py` | **旧 1000 题 → SQLite → 导出，与 `题库.json` 逐字段比对，必须 0 差异** |
| Node | `tests/smoke.js` | 沿用现有 DOM 桩，改为针对拆页后的 quiz / mock / wrong 三个引擎 |

**回归基准**：第 2 步（拆页 + 服务）完成后，页面行为必须与现在**完全等价**。用现有 99 条冒烟断言兜底——它们现在全绿，拆完之后必须仍然全绿，一条都不许少。

**突变验证照旧**：每条新断言都要注入一个突变证明它**真的会红**，然后还原。测不出红的断言不算数。

---

## 九、分四步实施，每步都保持可用

| 步 | 内容 | 完成标志 |
|---|---|---|
| 1 | **数据层**：schema + 导入校验 + 现有 1000 题入库 | `题库.json` 与 DB 逐字段一致；页面**不动**，你照常学习 |
| 2 | **拆页 + 服务**：server.py、15 页 + 首页壳、共享资源、旧记录迁移 | 现有 99 条冒烟断言全绿；行为等价 |
| 3 | **题型扩展 + 错题本页**：judge/multi 引擎、错题本独立页、模考开关 | 三题型判分与乱序测试通过；突变验证通过 |
| 4 | **扩充题库**：生成 1000 题、校验、入库 | 2000 题入库；抽查题目质量 |

第 2 步风险最高（一次性搬动整个页面结构），所以它的验收标准是「行为完全等价」，靠回归测试兜底。第 3 步放在拆页之后，改的就是小文件了。

---

## 十、风险与取舍

1. **手机使用依赖 Mac 开机 + 同一 WiFi。** 这是选「本地起服务」的直接代价。已确认接受。若某天需要离线，`export.py` 可以再补一个「导出成自包含单页」的出口，不影响现有结构。

2. **新增 1000 题的答案未经人工复核。** 现有 880 道扩充题就是子代理按考点生成的，只做了格式与范围校验。新增的同样。**页面上要保留醒目提示**：答案存疑时以教材和法条原文为准。

3. **多选解析字母重映射可能误伤。** 逐条例外确认 + 突变验证，不靠肉眼看。

4. **拆页后回归风险集中在第 2 步。** 用「行为等价 + 99 条断言全绿」作为硬验收。

5. **时政题时效性。** 时政答案会随新闻变。`source` 字段强制填写，考前一周统一重扫。

---

## 附：现有资产清单

| 文件 | 去向 |
|---|---|
| `考点体系.html` | 拆成 `web/` 下的 15 个内容页 + 首页壳（共 16 个文件）；题库部分进 DB。**保留原件不删**，作为回归对照 |
| `题库.json` | 导入 DB 后保留，作为导出比对基准 |
| `出题范围.md` | 更新：题型说明（不再是「全是单选」）、第三批 id 段、新增模块 |
| `tools/smoke.js` | 已入仓库；拆页后改为针对 quiz / mock / wrong 三引擎 |
| `tools/remap_probe.js` | 已入仓库；扩展支持多字母指代 |
