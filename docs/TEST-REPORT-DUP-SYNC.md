# 同步链路测试报告：源端重复文件 & 「实时同步」开关

> **被测仓库版本（先看这里）**
> `backup-studio` @ `2aeeb4a`（package.json `0.1.0`）· 分支 `local-sync`（相对 `origin/main` 领先 4 个提交）· 提交时间 `2026-11-20 22:50:57 +0800` · 远端 `https://github.com/Su-Qingmu/backup-studio`

## 0. 仓库版本与被测基线

| 项 | 值 |
| --- | --- |
| 仓库地址 | `https://github.com/Su-Qingmu/backup-studio` |
| 分支 | `local-sync`（`git branch -vv`：`ahead 4`） |
| 基线 commit | `2aeeb4a3aa44d760865c2d4c31807b60deaf7ee5` |
| 提交时间 | 2026-11-20 22:50:57 +0800 |
| 提交标题 | `REQ-DUP-001 按最新版 003 规格重写：三级判定、同名告警区、回收站删除、哈希黑名单、抑制清单与审计` |
| `package.json` version | `0.1.0` |
| productName / appId | Backup Studio / `com.sqm.backupstudio` |
| Electron / Node / TypeScript | `^33.0.0` / `v24.19.0` / `^5.6.3` |
| 被测界面 | 主界面 →「自动备份」面板（`src/components/AutoSync/index.tsx`）；「重复文件检测」独立页（`src/components/DuplicateFinder/index.tsx`） |
| 相关规格文档 | `docs/REQUIREMENTS-003-DUPLICATE-FINDER.md`、`docs/REQUIREMENTS-002-AUTO-SYNC.md` |
| 报告日期 / 报告人 | 2026-11-21 / Fey |
| 问题发现基线 | `2aeeb4a`（本报告 P-01/P-02/P-03 的复现环境） |
| PR 分支复验基线 | 合并上游 `origin/main` `9ac7105` 之后复验：P-01 不再复现，P-02 / P-03 复现结果与基线一致 |
| 工作区状态 | `git status` 仅新增本报告交付物（`docs/TEST-REPORT-DUP-SYNC.md/.docx`、`docs/fey-01.md/.docx`），**仓库源码零改动** |

---

## 1. 结论摘要

| 编号 | 问题 | 复现 | 严重级别 | 性质 |
| --- | --- | --- | --- | --- |
| P-01 | 「实时同步」开关点不动，一直是灰色 | 是（基线 `2aeeb4a`） | **P1** | 功能不可用；**上游 `9ac7105` 已重写该面板，合并后不再复现** |
| P-02 | 源端 5 个完全一致的文件，同步后目标端原样写 5 份，不合并 | 是（合并后复验一致） | **P2** | 与「备份=镜像」语义一致，但与用户预期不符 |
| P-03 | 查重（抑制）之后，源端删文件再同步，目标端仍是 5 个，不收敛 | 是（合并后复验一致） | **P1** | 目标端残留 + 静默漏备份 |

三者不是三个独立缺陷，而是同一条链路上的一处设计断点：
**重复文件检测（独立页）→ 抑制清单 → 备份侧排除名单 → 计划器写/删判定。**

- P-02 属于**已知且写在规格里的**边界（`REQUIREMENTS-003` §4.2 明确「与备份引擎的自动联动——不做」），缺的是界面上的预期管理。
- P-01 是**纯前端交互缺陷**：开关的可用性依赖一个用户看不见的前置条件（已保存配对）。上游 `9ac7105` 已把它改掉（见 §3.6），本 PR 不再携带该缺陷。
- P-03 是**真缺陷**：抑制名单以内容哈希为键，展开成路径时把**整组**（含"保留的那一份"）都排除了，于是这一组内容既不写入、也永不清理。**合并上游后依然复现**，是本 PR 需要跟进修复的重点。

---

## 2. 测试环境与验证方式

| 项 | 说明 |
| --- | --- |
| 系统 | Windows 10/11 x64（`win32`），Node `v24.19.0` |
| 验证手段 A | 静态代码定位（逐行读 `electron/engine/planner.ts`、`electron/engine/dup/*`、`electron/engine/aut/index.ts`、`src/components/AutoSync/index.tsx`） |
| 验证手段 B | 引擎级复现脚本：直接调用仓库自带的 `scanTree` / `buildPlan` / `DuplicateFinder`（跑在真实 `electron/engine` 源码上，非 mock），脚本放在工作区 `_work/`，**未进入仓库** |
| 验证手段 C | 仓库自带测试套件 `npm test`（`test:engine` / `test:aut` / `test:gate` / `test:transaction` / `test:dup`） |
| 未覆盖 | 图形界面真人点击录屏、真机拔盘/换盘、Linux 平台；本报告的界面结论来自代码路径推导，**P-01 的界面表现建议再做一次人工手测复核** |

### 2.1 基线测试结果（`npm test`，2026-11-21）

**问题发现基线 `2aeeb4a`：**

| 套件 | 结果 |
| --- | --- |
| `npm test` 整体 | **退出码 0，全部套件通过，0 失败** |
| `test:engine`（备份引擎） | 49 通过 / 0 失败 |
| `test:aut`（自动同步） | 10 通过 / 0 失败 |
| `test:gate`（写入闸门） | 8 通过 / 0 失败 |
| `test:transaction`（事务恢复） | 9 通过 / 0 失败（node:test，耗时约 121 s） |
| `test:dup`（重复文件检测） | 25 通过 / 0 失败 |
| **合计** | **101 通过 / 0 失败** |

**PR 分支（合并上游 `9ac7105` 之后）：**

| 套件 | 结果 |
| --- | --- |
| `npm test` 整体 | **退出码 0，全部套件通过，0 失败** |
| `test:engine`（备份引擎） | 49 通过 / 0 失败 |
| `test:aut`（自动同步） | 19 通过 / 0 失败（上游新增多配对用例） |
| `test:gate`（写入闸门） | 8 通过 / 0 失败 |
| `test:transaction`（事务恢复） | 9 通过 / 0 失败 |
| `test:dup`（重复文件检测） | 25 通过 / 0 失败 |
| **合计** | **110 通过 / 0 失败** |

合并后 `npm run typecheck`（渲染层 + 引擎 + 测试三套 tsconfig）同样零错误通过。

说明：仓库现有用例**未覆盖**本报告记录的三个问题——

- `test:engine` 覆盖的是「**同一路径**二次备份内容一致跳过」与「改名配对」，没有覆盖「源端**不同目录**下的同内容文件会写入几份」，也没有任何一条用到 `excluded` 排除名单（grep `excluded` 零命中）；
- `test:dup` 只验证查重页自身行为（抑制、撤销、回收站、互斥），没有任何用例把「抑制」与「备份计划」串起来断言。

这正是 P-02 / P-03 能长期存在的原因：出问题的接缝（查重 → 排除名单 → 计划器）正好落在两套测试的缝隙里。

---

## 3. P-01「实时同步」按钮摁不了

### 3.1 现象

主界面「自动备份」面板右上角的 **「实时同步」** 开关处于灰色禁用态，鼠标点击无任何响应，也无法通过任何界面入口开启实时同步。

### 3.2 根因

开关的禁用条件写死了一个**用户看不到的前置条件**：

`src/components/AutoSync/index.tsx:48`
```tsx
<label className="aut-switch">
  <input type="checkbox" role="switch"
    checked={!!p?.enabled}
    disabled={busy || !p || (!p.enabled && !status?.available)}
    onChange={...} />
  <span>实时同步</span>
</label>
```

其中 `p = status?.pair`（`index.tsx:31`），而 `pair` 只有在**保存过目录配对之后**才存在：

| 环节 | 代码位置 | 行为 |
| --- | --- | --- |
| 初始状态 | `electron/engine/aut/index.ts:20`（`blank()`） | `pair: null` → `status.pair` 为 `null` → `!p` 为真 → **开关禁用** |
| 后端可用性判定 | `electron/engine/aut/index.ts:83` | `available = !!pair` → 没有配对即"不可用" |
| 前端第二层禁用 | `src/components/AutoSync/index.tsx:48` | `(!p.enabled && !status?.available)`：介质不可达 / 目录不存在 / 写入闸门拒写时，开关同样不可点 |
| 即使能点也会失败 | `electron/engine/aut/index.ts:111` | `setEnabled` 在无配对时直接抛错 `请先保存目录配对` |

关键在于：**配对表单被藏在折叠区里**。`src/components/AutoSync/index.tsx:67-82` 的 `<details><summary>配对与排除规则</summary>` 默认收起，用户在面板上看到的「源目录 / 备份目录」（`index.tsx:57-60`）只是**只读展示**，不是可编辑输入框。开关灰着、界面不解释原因、唯一出路（填写配对并保存）被折叠起来 —— 用户看到的就是一个"摁不了的按钮"。

### 3.3 复现步骤

1. 启动 Backup Studio（全新配置，或删除 userData 下的 `auto-sync.json`）。
2. 主界面 → 下滑到「自动备份」面板。
3. 观察右上角「实时同步」开关：**灰色，禁用**。
4. 点击：无响应（`disabled` 生效，`onChange` 根本不会触发）。
5. 展开「配对与排除规则」→ 填写源目录、备份目录 → 点「保存配对设置」。
6. 等待状态轮询刷新（面板每 1 秒刷新一次状态，`index.tsx:13-24`）→ 开关才变为可点。

### 3.4 影响

- 新用户/新配对**无法通过界面开启实时同步**，功能等同于不可用。
- 第二层禁用（介质不可用）发生时，用户既点不动开关、也没有 tooltip 说明"为什么不能开"，只能靠面板上方的 `status.reason` 提示文字间接猜测。
- 绕行成本高：必须先展开折叠区、填两个路径、保存，再等最多 1 秒。

### 3.5 修复建议

1. **前置条件显性化**：开关未满足条件时，给出可点击的引导（例如提示「请先完成目录配对」并直接展开 `<details>`），而不是纯灰化。
2. **允许开关自身创建配对**：开关在下拉/弹层里选择源目录与备份目录，一次点击完成"配对 + 开启"，消除前置依赖。
3. **补 tooltip**：把 `disabled` 的具体原因（未配对 / 介质不可达 / 权限不足）写进 `title` 与 `aria-describedby`。
4. **兜底**：面板首次挂载时若 `pair` 为空，自动展开「配对与排除规则」。

### 3.6 上游处置情况（`origin/main` `9ac7105`）：本项已修复

上游在 `9ac7105`（`feat: add managed-delete boundary, media-side history and multi-pair auto sync`）重写了「自动备份」面板，P-01 描述的缺陷**不再存在**：

| 旧行为（`2aeeb4a`） | 上游新行为（`9ac7105`） |
| --- | --- |
| 面板顶部只有一个全局「实时同步」开关，`disabled` 依赖隐藏的"已保存配对"前置条件，无任何说明 | 改为**每个配对一个开关**，开关旁直接渲染不可用原因（`src/components/AutoSync/index.tsx` 的 `switchReason()`） |
| `disabled={busy \|\| !p \|\| (!p.enabled && !status?.available)}` | `disabled={Boolean(reason)}`，`reason` 由「操作进行中 / 引擎已阻止 / 配对当前不可用」逐条判定 |
| 配对表单折叠在 `<details>` 里 | 配对为列表项，配对本身即开关的载体（`addPair` / `updatePair` / `removePair`） |
| 无可访问性说明 | `aria-describedby` 指向可见的原因文本（`aut-switch-reason`） |
| 标签叫「实时同步」 | 标签改为「自动备份」（每个配对一个），「监听方式」里仍区分轮询/本地监听 |

上游源码注释把这条设计要求写得很直白：

> 开关不可用的原因：必须讲清楚，而不是把开关悄悄灰掉。

**结论**：P-01 属于基线版本的历史缺陷，上游已用重写面板的方式解决。本 PR 合并上游后**不携带该缺陷**，本节保留记录以说明问题来源与验证口径。P-02 / P-03 与该面板无关，合并后复现结果不变（见 §4）。

---

## 4. P-02 / P-03 源端重复文件的同步行为

### 4.1 场景 1：源端子父目录存在完全一致的 5 个文件，同步时被原样同步过去

**前置**：源目录下 5 个子目录各放 1 个 `photo.jpg`，**文件名相同、内容完全一致**（复制粘贴产生）。

**现象**：执行同步后，**5 份全部被复制到目标端**，没有任何合并或提示。

**实测输出**（引擎级复现，直接调用 `buildPlan`）：

```
=== 场景 1：源端 5 个完全一致文件 → 首次同步 ===
计划汇总: {"totalFiles":5,"copy":5,"update":0,"rename":0,"delete":0,"skip":0,"bytes":20480}
  - copy	dir5/photo.jpg	源端新增
  - copy	dir4/photo.jpg	源端新增
  - copy	dir3/photo.jpg	源端新增
  - copy	dir2/photo.jpg	源端新增
  - copy	dir1/photo.jpg	源端新增
```

**根因**：备份引擎的哈希能力只用在**源端 ↔ 目标端**的配对上，不做源端内部的内容去重。

- `electron/engine/planner.ts:211-219`：哈希只在「源端新增文件」与「目标端孤儿文件」之间做改名配对。
- `electron/engine/planner.ts:230-268`：源端 5 个文件 relPath 不同，各自生成一条 `copy` 动作，没有任何"内容相同 → 只留一份"的判定。

**规格依据**：这属于**当前设计的既定边界**，不是代码写错。`docs/REQUIREMENTS-003-DUPLICATE-FINDER.md` §4.2 非目标明确写着：

> 与备份引擎的自动联动（备份时顺带查重）｜改变备份主线的语义与性能｜**不做**

§4.1 的背景段落也写明「备份引擎只负责把源端镜像到目标端，不回答『目标端里哪一份是多余的』」。

**结论**：功能行为符合当前规格，但**不符合用户直觉**——用户看到"备份工具把 5 份一样的文件都搬了过去"，会认为备份做错了事。缺的是**预期管理与界面告知**，而不是引擎逻辑。

**建议**：在计划预览/同步结果里显式提示"本次同步写入 N 份内容完全相同的文件（可在『重复文件检测』页清理）"；或在同步前给一个可跳过的"目标端将保留重复内容"提示。

---

### 4.2 场景 2：目录查重后，源端删掉其中一个文件再同步，目标端仍是 5 个

**操作序列**：
1. 源端 5 个同内容文件 → 在「重复文件检测」页查重，命中 1 个内容重复组（5 个条目）。
2. 对该组执行「下次不提醒」（抑制）——这是页面上把查重结果与备份侧联动起来的唯一入口。
3. 再同步一次。
4. 源端删掉其中一个文件（源端剩 4 个）。
5. 再同步 → **目标端仍有 5 个文件**，源端已消失的那份副本没有被清理，目标端与源端持续不一致。

**实测输出**：

```
=== 目录查重 ===
内容重复组数: 1
  组 6896d9ea sha256=6896d9ea3f73a443… 组内条目 5 个:
    - dir1/photo.jpg  - dir2/photo.jpg  - dir3/photo.jpg  - dir4/photo.jpg  - dir5/photo.jpg

=== 抑制清单展开为备份侧排除名单（exclusionPaths） ===
排除路径数: 5
  - dir1/photo.jpg  - dir2/photo.jpg  - dir3/photo.jpg  - dir4/photo.jpg  - dir5/photo.jpg

=== 场景 2：源端删掉 dir5/photo.jpg（源端剩 4 个）→ 再同步 ===
计划汇总（含排除名单）: {"totalFiles":4,"copy":0,"update":0,"rename":0,"delete":0,"skip":4,"bytes":0}
  - skip	dir4/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir3/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir2/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir1/photo.jpg	已按重复排除规则排除，不写入目标端

=== 对照组：同样状态下不带排除名单 ===
计划汇总: {"totalFiles":4,"copy":0,"update":0,"rename":0,"delete":1,"skip":4,"bytes":0}
  - delete	dir5/photo.jpg	源端已不存在
  - skip	dir4/photo.jpg	内容一致，仅修改时间
  - skip	dir3/photo.jpg	内容一致，仅修改时间
  - skip	dir2/photo.jpg	内容一致，仅修改时间
  - skip	dir1/photo.jpg	内容一致，仅修改时间
```

**对照组是关键**：同样的源端/目标端状态，**不带排除名单时计划里确实有 1 条 `delete`**（目标端会收敛到 4 个）。所以"目标端残留 5 份"**不是同步引擎漏删**，而是**排除名单直接挡掉了删除动作**。

#### 根因链（逐环代码定位）

| 环节 | 代码位置 | 行为 |
| --- | --- | --- |
| ① 抑制写入 | `electron/engine/dup/index.ts:576-589`（`suppress`） | 对内容哈希 `sha256` 写入抑制记录 |
| ② 记录整组路径 | `electron/engine/dup/index.ts:721-750`（`writeSuppression`） | `paths = group.entries.map(entry => entry.absPath)`（:735）—— 抑制记录保存的是**整组全部条目**的绝对路径，而不是用户点的那一条、也不是"保留的那一份" |
| ③ 展开成排除名单 | `electron/engine/dup/index.ts:694-710`（`exclusionPaths`） | 把抑制记录里的绝对路径换算成相对路径集合 → 5 条全部进名单 |
| ④ 注入计划器 | `electron/engine/main.ts:265` → `electron/engine/service.ts:228-230` → `service.ts:366` | `excluded: await exclusionProvider(sourceRoot)` |
| ⑤ 排除写入 | `electron/engine/planner.ts:105-115` | 命中排除名单的源文件**不生成写入动作**（只计入源端文件数），备注"已按重复排除规则排除，不写入目标端" |
| ⑥ 排除删除 | `electron/engine/planner.ts:324-328` | 目标端成为孤儿且命中排除名单 → **不生成删除动作**，注释写明"排除表示『这份内容由规范副本代表』，不是『可以删掉』" |

**后果**（这才是真正的问题）：被抑制的这一组内容，**在备份侧被整体冻结**——

- 源端已删掉的副本，目标端永远留着（目标端比源端多，永久不一致）；
- **"保留的那一份"同样在排除名单里**（② 把整组路径都记进去了），所以这一组内容**从此既不写入、也永不清理**。

#### 追加验证：抑制后首次同步会漏备份

如果先查重抑制、再第一次同步（目标端还是空的），这 5 个文件**一份都不会被备份**：

```
抑制后、目标端为空时执行同步：
  计划汇总: {"totalFiles":5,"copy":0,"update":0,"rename":0,"delete":1,"skip":5,"bytes":0}
  - delete	other.txt	源端已不存在
  - skip	dir5/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir4/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir3/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir2/photo.jpg	已按重复排除规则排除，不写入目标端
  - skip	dir1/photo.jpg	已按重复排除规则排除，不写入目标端
  目标端最终文件数: 0（源端文件数 5）
```

计划统计里 `totalFiles:5` 照常计入，但 `copy:0`。**统计数字与实际写入不一致**，用户在结果页只看到"跳过"条目，容易误认为"已经备份过了"。

#### 影响

| 影响面 | 说明 |
| --- | --- |
| 静默漏备份 | 抑制后首次同步，目标端缺整组文件；用户无任何告警 |
| 目标端永不收敛 | 源端删除后，目标端副本永久残留，与源端不一致 |
| 排除粒度过粗 | 抑制的语义本意是"这一组内容由某一规范副本代表"，实现却是"这一组路径全部不写不删"，连规范副本本身也被排除 |
| 抑制不可见 | 排除名单不在「抑制清单」面板里以"影响备份"的形式呈现，用户看不出自己关掉了备份覆盖 |

#### 修复建议

1. **区分"被抑制的副本"与"规范副本"**：抑制记录只应覆盖**冗余副本**，规范副本必须继续参与备份对账。
2. **排除名单只作用于写入，不无条件豁免删除**：更合理的语义是"被排除的路径不写入目标端"，但当它在目标端已存在且源端已消失时，仍应按孤儿规则清理（或由用户显式选择"目标端保留副本"）。
3. **抑制时明确告知影响**：抑制确认层写明"该组 N 份文件将不再被备份到目标端（含从未备份过的副本）"。
4. **统计口径修正**：计划汇总的 `copy/skip` 与"已备份"结论要对齐，界面显式区分"已写入 / 因重复排除未写入（目标端可能没有）"。
5. 补回归用例：抑制 → 首次同步 / 抑制 → 源端删除 → 再同步，两种路径都要断言目标端最终内容。

---

## 5. 问题现状速览（给排期用）

| 问题 | 现状 | 是否符合规格 | 建议级别 | 建议归属 |
| --- | --- | --- | --- | --- |
| P-01 实时同步开关不可点 | 前端 `disabled` 条件依赖未展示的"已配对"前置条件；配对表单折叠收起 | 规格未规定交互细节 → **不符合可用性预期**；**上游 `9ac7105` 已重写面板解决** | P1 → **已修复（上游）** | 渲染层 `src/components/AutoSync/index.tsx` |
| P-02 源端重复文件全量同步 | 引擎按源端镜像复制，不做源端内部内容去重 | **符合** `REQUIREMENTS-003` §4.2「与备份引擎的自动联动——不做」 | P2（预期管理） | 界面提示 + 文档 |
| P-03 查重后目标端不收敛 / 漏备份 | 抑制记录按整组路径展开排除名单，写入与删除同时被豁免；规范副本也一并排除 | **不符合** `REQUIREMENTS-003` FR-11「每组至少保留一份」的跨端语义 | P1 | `electron/engine/dup/index.ts` + `electron/engine/planner.ts` |

---

## 6. 附录 A：复现方法

复现脚本（放在工作区 `_work/`，**未进入仓库**）：

- `_work/repro-dup-sync.ts` —— 场景 1 + 场景 2 + 对照组
- `_work/repro-dup-first-sync.ts` —— 抑制后首次同步的漏备份验证

运行方式（在仓库根目录下）：

```powershell
cd D:\Fey\Desktop\backup-studio-main\backup-studio-main
npx tsx ..\_work\repro-dup-sync.ts
npx tsx ..\_work\repro-dup-first-sync.ts
```

脚本直接调用仓库自身的 `electron/engine/scan.ts`、`electron/engine/planner.ts`、`electron/engine/dup/index.ts`，不使用任何 mock，数据目录全部落在系统临时目录，运行结束自动清理。

复现分别在两个基线上跑过，结果一致：

| 基线 | 场景 1 | 场景 2 | 抑制后首次同步 |
| --- | --- | --- | --- |
| `2aeeb4a`（问题发现） | copy=5 | copy 0 / delete 0 / skip 4 | copy=0，漏备份 |
| 合并 `9ac7105` 后（PR 分支） | copy=5 | copy 0 / delete 0 / skip 4 | copy=0，漏备份 |

对照组（同样源/目标状态、不带排除名单）在两个基线上均为 `delete=1`，说明差异来自排除名单而非同步引擎本身。

## 7. 附录 B：关键代码位置索引

| 主题 | 文件:行 |
| --- | --- |
| 「实时同步」开关及其禁用条件（**基线 `2aeeb4a`**，上游重写后已不存在） | `src/components/AutoSync/index.tsx:48`（`p` 定义在 `:31`，配对表单在 `:67-82`） |
| 上游重写后的开关与不可用原因（`9ac7105`） | `src/components/AutoSync/index.tsx:120`（`switchReason`）、`:273`（`disabled={Boolean(reason)}`）、`:283`（原因文本） |
| 后端配对为空 / 可用性判定（基线版本） | `electron/engine/aut/index.ts:20`、`:83`、`:111` |
| 排除名单注入备份计划 | `electron/engine/main.ts:265` → `electron/engine/service.ts:228-230` → `:366` |
| 排除名单的展开（含整组路径） | `electron/engine/dup/index.ts:694-710`、`:721-750`（`:735` 取整组） |
| 计划器：排除 → 不写入 | `electron/engine/planner.ts:105-115` |
| 计划器：排除 → 不删除 | `electron/engine/planner.ts:324-328` |
| 改名配对（哈希的真正用途） | `electron/engine/planner.ts:211-219`、`:230-268` |
| 「与备份引擎自动联动——不做」 | `docs/REQUIREMENTS-003-DUPLICATE-FINDER.md` §4.2 |
| 每组至少保留一份 | `docs/REQUIREMENTS-003-DUPLICATE-FINDER.md` §6 FR-11 |
