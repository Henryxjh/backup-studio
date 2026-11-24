# Sub-agent 动态调度与模型选择

这是 `github-pr-lifecycle` 的正式组成部分。入口 [SKILL.md](../SKILL.md) 只判定何时派子代理；本文件规定派谁、用什么模型、如何验收。主代理始终负责 PR 的最终审批与合并决策。

## 是否启动子代理

> **每次开始新的 PR 任务，都必须重新检查本地与远程仓库状态**，重新确认 PR 当前的 Head SHA、Base SHA 与状态，再据此派工。不得沿用上一次任务的检查结果；上一轮的审查结论与派工依据不自动适用于新版本。

先按 PR 的变更范围、风险、专业领域和可分离任务判断；不要求每个 PR 都启动，但符合条件时应主动启动，不等用户逐一指定。

| 可判断的条件 | 结论与派工方向 |
| --- | --- |
| 跨两个以上可独立审查的模块，或横跨 Electron、前端、后端、数据库等领域 | 按文件范围和专业领域拆分审查职能，可并行只读审查。 |
| 改动涉及架构、安全、数据一致性、恢复或删除正确性 | 启动相应专项审查；Critical / High 至少考虑 GPT6.2sol 独立审查，并记录是否安排及理由。 |
| CI 失败难分基线故障与本 PR 回归 | 独立分派测试/CI 审查，要求对比 Base 与 Head 的证据。 |
| 主代理结论需要交叉验证，或 PR 规模使单人容易漏项 | 派与主审分离的 Independent Final Reviewer，要求独立取证。 |
| 涉及 GitHub Actions、Release、Tag、Workflow、构建或发布门禁 | 派 CI Reviewer；涉及高风险发布权限时同时考虑安全审查。 |
| 极小文档改动、单文件低风险修复，且没有可独立分配的任务 | 主代理自行审查；最终报告说明未启动原因。 |
| 子代理协调成本明显超过预计收益，或只是为了展示多代理 | 不启动；不得为了形式拆任务。 |

## 审查职能及产出边界

职能按实际 PR 选择，不固定启动全部代理。下表的 Reviewer 是审查职能，不是 runtime 内置角色。审查产出统一给出 `VERDICT: PASS` 或 `VERDICT: FAIL`、按 `C1` / `H1` / `M2` 编号的发现（严重级、`路径:行号`、可复现条件、影响、证据）、已验证项和未覆盖风险；没有证据的猜测须单列，不能当缺陷。

| 职能 | 职责边界 | 典型输入 | 典型产出重点 |
| --- | --- | --- | --- |
| Architecture Reviewer | 模块边界、契约及状态流；不代替实现 | 设计说明、`shared/` 契约、调用链、PR diff | 跨模块不变量与设计缺口。 |
| Code Reviewer | 代码逻辑、错误处理与质量；复杂逻辑归 Complex Code Reviewer | 目标代码、Base/Head diff | 具体路径及触发条件、反例。 |
| Security Reviewer | 授权边界、路径、权限、外部输入与危险操作 | IPC、文件系统及发布权限变更 | 可利用路径、影响与安全复现证据。 |
| Test Reviewer | 覆盖、基线差异和回归；不把未运行测试称作通过 | 测试文件、CI 日志、需求验收项 | 缺失用例与实测结果。 |
| UI Reviewer | 前端交互、状态、视觉和可访问性 | `src/` diff、交互路径、可用截图 | 可复现的交互/显示问题及视口条件。 |
| CI Reviewer | Actions、构建、Release/Tag/Workflow 门禁 | `.github/workflows/`、作业日志、权限 | 基线与回归区分、发布阻断/绕过路径。 |
| Documentation Reviewer | 规格、行为与文档一致性 | `docs/`、变更代码、验收记录 | 不一致的文段与对应行为证据。 |
| Independent Final Reviewer | 不依赖主审结论独立复核关键结论与修复 | 锁定 SHA、原始 diff、已编号发现及补丁 | 独立 `VERDICT`、逐项复现/关闭状态及残余风险。 |

## Runtime 角色选择

| Runtime 角色 | 正确用途 | 禁止误用 |
| --- | --- | --- |
| `explore` | 纯只读取证：定位代码、收集日志与引用；不创建或修改文件 | 不派“给出审计结论 / 判定严重级 / 判断是否削弱正确性”；此类任务会因 `ROLE_MISMATCH` 拒绝并零产出。 |
| `worker` | 有界生产性改动，须明确交付物、文件所有权、范围和验收标准 | 未授权写入、跨所有权修改、用实施产出冒充独立复审。 |
| `verifier` | 独立审查、审计与验收既有产物，不修改项目文件 | 不派项目文件修复；临时验证产物只能放在任务明确指定的临时位置。 |

**审计、复审、验收一律用 `verifier`，不要用 `explore`。** `explore` 可以先定位证据，但不能给出结论；角色选错时如实记录 `ROLE_MISMATCH` 和零产出，重新以正确角色派工，不把失败算作已完成。

## 模型库、别名与可用性

规格别名不是 runtime 可直接调用的模型标识。**每次调用前先检查平台实际支持的完整模型键，不得假设别名可用**；下表仅记录当前环境的映射，平台变化时以实时支持列表为准。仅允许从这四个规格档位中选择，不能调用库外模型。

| 规格别名 | 当前 provider 限定模型键 | 优先级与用途 | 当前可用性 |
| --- | --- | --- | --- |
| GPT6.2sol | `custom_provider:qiqi/gpt-6.2-sol` | 首选：深度代码、架构、安全、复杂诊断、独立最终审查 | 可用，调用前仍需核验。 |
| GPT6.1sol | `custom_provider:qiqi/gpt-6-sol` | 次选：对应常规专业审查能力档，测试分析、辅助实现、独立验证 | 可用；不是同名字符串映射，调用前核验。 |
| MiniMax M3.1 Flash | `minimax/MiniMax-M3.1-Flash` | 少用：仅简单辅助分析、批量低复杂度检查且速度/资源优势明确 | 可用，调用前仍需核验。 |
| Agnes 3.0 Flash | 无当前可用键 | 少用：简单专项检查、辅助信息整理 | **当前不可用**；任务要求此档时明确报告“该模型不可用”，不得虚构调用结果。 |

复杂、高风险、深入推理优先 GPT6.2sol；常规专业审查及独立验证用 GPT6.1sol 档；两种 Flash 仅在简单任务且优势明确时少量使用。不得为节省资源把高风险审查交给能力不匹配的模型；指定键不可用则报告原因和影响，不能私自以库外键或未核实别名替代。

## 职能 → Runtime 角色 → 模型键

| 任务/职能 | Runtime 角色 | 推荐模型键及调整条件 |
| --- | --- | --- |
| Architecture / Security / Complex Code / Independent Final Reviewer | `verifier` | `custom_provider:qiqi/gpt-6.2-sol`。 |
| Test / Regression Reviewer | `verifier` | `custom_provider:qiqi/gpt-6-sol`；复杂一致性或高风险回归升至 `custom_provider:qiqi/gpt-6.2-sol`。 |
| CI / GitHub Actions Reviewer | `verifier` | `custom_provider:qiqi/gpt-6-sol`；高风险发布授权可升至 GPT6.2sol 档。 |
| UI / UX Reviewer | `verifier` | `custom_provider:qiqi/gpt-6-sol`；复杂跨层交互可升至 GPT6.2sol 档。 |
| Documentation Reviewer | `verifier` | `custom_provider:qiqi/gpt-6-sol`。 |
| Simple Auxiliary Reviewer | `verifier` | `minimax/MiniMax-M3.1-Flash`；Agnes 3.0 Flash 当前不可用，只能如实报告；有实质审计判断则改用能力匹配模型。 |
| 辅助实现（明确授权落地代码修改） | `worker` | `custom_provider:qiqi/gpt-6-sol`；复杂或高风险实现升至 `custom_provider:qiqi/gpt-6.2-sol`。 |
| 纯定位与取证（不作判断） | `explore` | `minimax/MiniMax-M3.1-Flash`；须确认资源优势与可用性。 |

Critical / High 风险 PR **至少应考虑安排 GPT6.2sol 进行独立审查**；若未安排，主代理须记录具体理由和替代复核，不得默默省略。上述是推荐关系，主代理可随实际任务调整，但不能突破模型库、能力匹配和 `verifier` 审计角色限制。

## 派工单模板

每个子代理必须有明确任务说明。以下模板包含 6.5 的十项最低要素，并补足 runtime 角色、模型、所有权及验收信息；不能用 PR 分支名代替两个 SHA。开始复审前核对 Head/Base 未漂移，发生变化应更新派工单并重审受影响结论。

```text
PR 编号：#<编号>
仓库地址：https://github.com/Su-Qingmu/backup-studio
当前 PR Head SHA：<40 位 SHA，派工时核对>
当前 Base SHA：<40 位 SHA，派工时核对>
审查目标：<需要验证的不变量/风险，及 PASS 条件>
具体职责：<审查职能与精确任务；是否独立于前一轮>
文件范围：<可读/可写路径及排除范围>
是否允许修改文件：否（默认只读）；若是，列出唯一拥有的文件和验收标准
禁止操作：不得提交 GitHub Review、审批、合并、推送；不得修改未授权文件或共享契约
期望输出格式：VERDICT: PASS/FAIL；C1/H1/M2 编号；每条给路径:行号、复现、影响、证据；列出验证与未覆盖风险
Runtime 角色：verifier / worker / explore（审计必须 verifier）
模型键：<从实时支持列表核验的完整 provider 限定键>
依赖与交付：<前序结果、可并行范围、主代理验收人>
```

历史场景示例（PR #2 的历史记录，不可直接当作当前 PR 的派工单；Head/Base 必须在实际派工时重新向平台核对）：

```text
PR 编号：#2
仓库地址：https://github.com/Su-Qingmu/backup-studio
当前 PR Head SHA：0ec84fcf979c65ea93917ec52b1100820bacab87（历史示例快照）
当前 Base SHA：0dbb55a2ca3c9e292b2577d8efa289d4a4a4c6fd（历史示例基线；派工前核实实际 Base）
审查目标：复核本机隔离区还原时写闸门是否判还原目标目录；索引损坏不得伪装为空、不得覆盖旧记录；越界索引不得搬走隔离区外文件。证据充分且无未解决高风险缺陷才 PASS。
具体职责：Security Reviewer 独立只读复审隔离区恢复与路径边界；复核删/还原链路的错误传播，给出可复现结论。
文件范围：只读 electron/engine/dup/、test/dup.test.ts、shared/dup-types.ts 及相关调用；不得修改任何文件。
是否允许修改文件：否；shared/dup-types.ts 由主会话独占。
禁止操作：不得修改文件、提交正式 GitHub Review、审批、合并、推送；不得把推测写成已复现。
期望输出格式：VERDICT: PASS/FAIL；发现按 C1/H1/M2 编号，含路径:行号、触发步骤、影响、证据及缺失回归；说明未覆盖风险。
Runtime 角色：verifier
模型键：custom_provider:qiqi/gpt-6.2-sol（启动前核验实际可用键）
依赖与交付：实现完成后独立复审；主代理核对每条结论并决定修复与再审范围。
```

## 并行、所有权与轮次

- 独立且只读的架构、安全、UI、CI、测试专项可并行，明确相同 Head/Base SHA 与各自证据范围；主代理汇总冲突。
- 生产性改动只有主代理分配文件所有权后才可用 `worker`；子代理只能改分配给自己的文件，多个子代理不得同时修改同一文件。跨进程共享契约如 `shared/types.ts`、`shared/dup-types.ts` 由主会话独占，子代理只读。
- 有依赖的任务串行：审计 → 实施 → 独立只读复审 → 修复 → 收窄复审。复审不得先于其对应补丁；修复后按编号重审受影响项，必要时扩大范围。Critical / High 必须补回归用例固定。
- 主会话负责契约、所有权、产物审查、冲突处理、最终验收及提交推送；提交/推送不授权给子代理。并行评审不等于并行写共享文件。

## 主代理复核清单

1. 逐份检查子代理实际输出、执行状态及是否覆盖指定 Head/Base 与文件范围；失败或零产出不计作审查。
2. 对每条 `C1` / `H1` / `M2` 检查代码证据、路径行号和触发条件，推测与已复现分开；不得把子代理意见直接视为事实。
3. 不同结论冲突时锁定同一 SHA、同一复现条件，主代理独立重现或安排第三方 `verifier`，记录证据与裁决理由。
4. 对重要问题独立验证：例如 Critical 误删，主代理读相关删除状态机与边界，构造或检查只读探针/隔离测试中“校验后路径换版”的反例，确认未归档的新版本是否可能被删，再核对对应回归断言；不能仅凭 Review 摘要判 PASS。
5. 内部审查不是 GitHub 正式 Review，不得冒充已在 GitHub 审批；正式审批按 [审批与授权策略](./approval-policy.md) 单独执行。
6. 主代理自行决定最终审批与合并，按 [合并与门禁策略](./merge-policy.md) 检查门禁；不得外包决定。
7. 最终报告说明是否启用子代理、理由、实际角色和有效模型、各结论处理、未验证风险；未启动、启动失败或模型不可用均明确记录原因与影响范围。

## 失败与降级处理

| 状况 | 必须采取的动作 |
| --- | --- |
| 指定模型键不受支持或 Agnes 3.0 Flash 当前不可用 | 记录“该模型不可用”、平台错误及未完成审查范围；先核验允许模型键，合适时改派库内能力匹配模型，否则主代理自行复核并在最终报告披露。不得虚构调用结果。 |
| 角色选错、返回 `ROLE_MISMATCH` | 记录拒绝及零产出；纯取证用 `explore`，审计/复审/验收改用 `verifier`，修改任务用有所有权的 `worker`；重派前检查任务边界。 |
| 超出 runtime 给出的 `child_task_limit`，返回 `SUBAGENT_CONCURRENCY_LIMIT` | 按返回的并发限制分批派发；等待一批结束并验收后再派下一批，不把拒绝当作已启动。派完可从会话列表 `effective_model` 核验实际模型是否切换成功。 |
| 上游模型不稳定、连接中断 | 记录失败与未完成范围；**换模型续跑同一子会话**以保留上下文和已落盘文件，不重开任务重做。切换必须用支持的库内键并核验 `effective_model`；不能续跑时主代理降级自行复核并披露。 |

任何降级都不降低 Critical / High 的证据和回归门槛；不能完成独立核验则在最终报告列为未完成/阻断，而非“已完成”。

## 本仓库既有实践

`docs/TODO.md`“本轮专项加固”记录了隔离区、回收站事务、Release 门禁、IPC 路径授权四条工作流并行推进。以回收站事务为例：先审计删除账本与恢复不变量，实施 `planned → archived → intent-persisted → original-deleted → indexed → committed`；独立只读复审给出 `VERDICT: FAIL`，其中 C1 指出恢复按路径删除同名新版本、H1 指出异常账本状态被索引覆盖；修复并在 `test/recycle-crash.test.ts` 固定回归后，再对变更作收窄复审。后续复审仍曾判 FAIL 并发现校验到删除之间的换版窗口，主代理逐条核对证据，再派修复和下一轮收窄复审；不能把第一次修复等同最终 PASS。这里的审计/独立复审属 `verifier`，实施/修复属有所有权的 `worker`，编号贯穿每轮报告。详情以 [审查清单](./review-checklist.md) 的证据口径为准。

审批边界见 [审批与授权策略](./approval-policy.md)；门禁与合并见 [合并与门禁策略](./merge-policy.md)；入口及整体流程见 [SKILL.md](../SKILL.md)。
