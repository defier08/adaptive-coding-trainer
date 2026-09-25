# SM-2 掌握度算法 + 质量分 q + 变体防背题

本文件定义确定性掌握度逻辑，全部由 `scripts/trainer.mjs` 实现，AI 不口头记录进度。

## 一、每个知识点维护的状态

| 字段 | 含义 | 初始 |
|------|------|------|
| `repetition` | 连续答对的复习次数 | 0 |
| `interval` | 下次复习间隔（天） | 0（未学） |
| `easiness` (EF) | 难易系数 | 2.5 |
| `due` | 下次到期日期（ISO） | 今天（立即可练） |
| `lapses` | 答错次数（遗忘次数） | 0 |
| `passed_variants` | 已拿到 q≥3 的**不同变体**标识列表（`template.js` 或 `variants/vN/template.js`），去重 | `[]` |

## 二、质量分 q（客观为主）

编程题的优势：q 大半可由客观结果决定，而非纯主观打分。**默认档位**（由测试结果硬性决定，聊天场景下的首选）：

| q | 判定依据 |
|---|----------|
| 4 | 测试全部通过 |
| 2 | 部分用例失败，思路接近（如边界没处理） |
| 0~1 | 基本没写对 / 卡死 / 完全跑不通 |

**加分 / 减分档**（仅在能可靠观测用户行为时使用，否则别猜）：

| q | 判定依据 | 观测条件 |
|---|----------|----------|
| 5 | 一次提交即过，未看示例 / 提示 | 确认用户没翻示例 |
| 3 | 翻了示例 / 提示才写对 | 确认用户翻了示例 |

> AI 在验证后依据上表给用户这道题定 q，再传给 `review-next`。多数练习落在 q∈{4,2,0} 之间是正常的，不必刻意造出 5 和 3。
>
> **核心规则**：感知不到行为就**不要猜**，用默认三档；**宁可保守判低，不要放水判高**。

## 三、SM-2 更新公式

每次对该知识点作答后，给定 q，更新：

```
if q >= 3:
    if repetition == 0:  interval = 1
    elif repetition == 1: interval = 6
    else:                 interval = round(interval * easiness)
    repetition += 1
else:                       # 答错：重置
    repetition = 0
    interval = 1
    lapses += 1

easiness = easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
if easiness < 1.3: easiness = 1.3

due = today + interval 天
```

含义：答对逐步拉大间隔（1→6→×EF…）；答错立即归零、明天重来、并降低难易系数。记不住（q 低）EF 下降，记得住 EF 缓升。

## 四、变体防背题

- SM-2 记的是**知识点**状态，不是某道题。
- 该知识点到期复习时，引擎从它的变体集合（根 `template.js` = v1，加上 `variants/vN/`）里**优先抽一道尚未拿到 q≥3 的变体**，全部通过后再随机，保证每次练的角度尽量不同。
- **判定"真正掌握"**：需在 **≥2 个不同变体**上分别拿到 q≥3（即 `passed_variants` 数组长度 ≥ 2 且最近一次 q≥3）。只过一道题不算真会。
- **遗忘即清零**：一旦答错（q<3），`passed_variants` 清空，需重新在不同变体上证明掌握，避免"遗忘后再对一次就秒恢复掌握"。
- 一道题做对后若长期不复习，间隔到期又会重新出现，对抗遗忘。

## 五、引擎 CLI（由 trainer.mjs 提供）

```
node scripts/trainer.mjs init                                    # 初始化 progress.json
node scripts/trainer.mjs scan [--dir <附加题集合>]                 # 扫描题目与元数据（默认扫 library/，重建 meta 与 variants）
node scripts/trainer.mjs enqueue --kp <名> --source <stuck|project>  # 加入选题队列（自动先 scan）
node scripts/trainer.mjs pick                                    # 按优先级选题（队列 → 到期复习 → 拓扑推进新题）
node scripts/trainer.mjs review-list [--limit 20]                 # 到期复习列表（仅"已学过且到期"的项）
node scripts/trainer.mjs review-next --kp <名> --q <0-5> [--variant <变体标识>]  # 推进 SM-2
node scripts/trainer.mjs state --kp <名>                          # 单知识点状态
node scripts/trainer.mjs mastery --kp <名>                        # 掌握度评估（需 ≥2 个不同变体通过）
node scripts/trainer.mjs deprecate --kp <名>                      # 弃用某知识点（题质量差时退出循环，不删题文件）
node scripts/trainer.mjs undeprecate --kp <名>                    # 撤销弃用
node scripts/trainer.mjs graph                                   # 依赖图 + 各点状态 + 薄弱前置 + 缺失前置
node scripts/trainer.mjs view                                    # 按 tags 分组 / difficulty 排序的视图
```

进度文件：默认 `~/.codebuddy/adaptive-coding/progress.json`（用户级、全局、跨项目共享，按 @kp 名索引）。根目录解析优先级：环境变量 `ADAPTIVE_CODING_DIR` > `config.json` 的 `adaptive_coding_dir` > 默认路径。写入采用"临时文件 + rename"原子写，并在替换前把上一版保留为 `progress.json.bak`；主文件损坏时自动从 `.bak` 恢复，两者都损坏才重置（stderr 有提示，进度不静默丢失）。`scan` 不再删除"本次未扫到"的进度（改名 / 临时移走目录不丢掌握度），无 meta 的孤儿条目由 `pick` / `review-list` 过滤、不参与选题。目录 / 文件缺失时自动创建。`--dir` 是**可选附加**的题集合目录，不传时只扫默认 `library/`（进度始终汇总进同一份全局进度）。`review-next` 的 `--q` 必须是 0~5 的整数，否则引擎报错不写入（防止 NaN 污染进度）；`--variant` 传当前所练变体的标识（`pick` / `review-list` 已返回，为相对路径），缺省时退化为根题。命令总览见上文 CLI 一节。
