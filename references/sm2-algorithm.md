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

编程题的优势：q 大半可由客观结果决定，而非纯主观打分。判定表：

| q | 判定依据 |
|---|----------|
| 5 | 测试全部通过，且**一次提交即过**，未看示例 / 提示 |
| 4 | 测试全部通过，但**改了几次才过** |
| 3 | 测试通过，但**翻了示例 / 提示**才写对 |
| 2 | 部分用例失败，思路接近（如边界没处理） |
| 0~1 | 基本没写对 / 卡死 / 完全跑不通 |

> AI 在验证后依据上表给用户这道题定 q，再传给 `review-next`。"翻示例才过=3"这一档含少量主观，但其余档以测试结果为硬依据。
>
> **降级规则**：若 AI 无法可靠观察"一次即过 / 改了几次 / 翻没翻示例"（这些依赖对用户行为的感知），应退化为：测试全过→q=4（有明确提示依赖则 3）；部分失败→2；跑不通→0。**宁可保守判低，不要放水判高**。

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
node scripts/trainer.mjs init      --dir <exercises>            # 初始化 .progress.json
node scripts/trainer.mjs scan      --dir <exercises>            # 扫描题目与元数据，构建依赖图
node scripts/trainer.mjs enqueue   --dir <exercises> --kp <名> --source <stuck|project|system>  # 加入选题队列（三场景优先级）
node scripts/trainer.mjs pick      --dir <exercises>            # 按优先级选题（返回 kp + 变体标识）
node scripts/trainer.mjs review-list --dir <exercises> --limit 20   # 到期复习列表（按优先级）
node scripts/trainer.mjs review-next --dir <exercises> --kp <名> --q <0-5> --variant <变体标识>  # 推进 SM-2
node scripts/trainer.mjs state     --dir <exercises> --kp <名>  # 单知识点状态
node scripts/trainer.mjs mastery   --dir <exercises> --kp <名>  # 掌握度评估（含变体通过数）
node scripts/trainer.mjs graph     --dir <exercises>            # 依赖图 + 各点掌握状态 + 薄弱前置
node scripts/trainer.mjs view      --dir <exercises>            # 按 tags 分组 / difficulty 排序的视图
```

进度文件：默认 `~/.codebuddy/adaptive-coding/progress.json`（用户级、全局、跨项目共享，按 @kp 名索引），根目录可用环境变量 `ADAPTIVE_CODING_DIR` 覆盖。写入采用"临时文件 + rename"原子写，防止损坏；目录 / 文件缺失时自动创建。可用命令：`scan [--dir <项目exercises>]`（默认扫 library，汇总到全局进度）、`pick`、`review-list [--limit N]`、`review-next --kp <名> --q <0-5>`、`state --kp <名>`、`mastery --kp <名>`。`review-next` 的 `--q` 必须是 0~5 的数字，否则引擎报错不写入（防止 NaN 污染进度）。
