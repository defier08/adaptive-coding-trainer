# 知识点层文件规范（三文件 + 头部元数据 + 变体）

知识点层负责"造零件"：把编程知识拆到可单独检验的最小单元，用三文件教与练。

## 一、目录与文件

每个知识点一个目录，平铺编号：

```
library/
└── 001-数组去重/
    ├── example.js      # 教（必有）：最小化示范 + 讲解注释
    ├── template.js     # 练（必有）：题目说明 + 函数签名 + TODO + 头部元数据
    ├── test.js         # 验（按需）：require 模板函数，轻量断言
    └── variants/       # 变体（防背题，按需）
        ├── v2/template.js (+test.js)
        └── v3/template.js (+test.js)
```

- 物理层永远平铺编号，不按类别搬家（归类交给元数据与视图层）。
- `example.js` 与 `template.js` 每题必有；`test.js` 与 `variants/` 按需。

## 二、example.js（教，必有）—— 必须"讲知识点"，不是只给能跑的代码

它承担"教学正文"职责，**最小化、以教会知识点为先**。硬性要求：
1. 用注释（或 `console.log`）把**知识点本身**讲清楚：它是什么、关键规则、最常见的坑。
2. 代码尽量短、聚焦该知识点，`node example.js` 可独立运行看效果。
3. **禁止只剩"能运行的演示壳"**：例如用 mock 手写调用中间件来跑通，却不解释中间件 / `next()` 是什么——那是让代码能跑的**手段**，不是知识点。可运行只是载体，讲解才是目的。

✅ 好的 example（讲清知识点）：
```js
// 知识点：数组去重
// 关键：用 Set 去重（自动按值唯一），再用展开运算符还原成数组；保持首次出现顺序
function unique(arr) {
  return [...new Set(arr)];
}
console.log(unique([1, 2, 2, 3])); // [1, 2, 3]
```

❌ 差的 example（只有壳，没讲知识点）：
```js
// 只写代码、无讲解；或用 mock 跑通一段调用，却不解释概念本身
function unique(arr) { return [...new Set(arr)]; }
console.log(unique([1, 2, 2, 3]));
```

## 三、template.js（练，必有）

结构自上而下：

1. **头部元数据注释块**（被 `trainer.mjs scan` 正则解析，字段见第五节）。
2. **题目要求**：题目说明 + 输入输出示例（写在文件顶部普通注释）。
3. **函数签名 + `// TODO`**：用户只在此处填实现。
4. **`module.exports`**：当有 `test.js` 时必须导出，使测试能 `require`。

```js
/**
 * @kp          数组去重
 * @tags        数组, 算法, Set
 * @difficulty  易
 * @prereq      数组遍历, 相等性判断
 */
// 题目：实现 unique(arr)，返回去重后的【新数组】。
// 要求：不可修改原数组；保持元素首次出现的顺序。
// 示例：unique([3,1,3,2,1]) => [3,1,2]
function unique(arr) {
  // TODO: 在这里实现
}
module.exports = { unique };
```

## 四、test.js（验，按需）

仅当题目有**可客观判定的输入输出**时才生成（函数题 / 算法题）。通过 `require` 引入模板函数，用 Node 内置 `assert` 做轻量断言，**覆盖正常路径 + 边界输入**，避免"只过样例即误判正确"。

```js
const { unique } = require("./template.js");
const assert = require("assert");

const cases = [
  [[1, 2, 2, 3], [1, 2, 3]],
  [[], []],
  [[1, 1, 1], [1]],
  [["a", "b", "a"], ["a", "b"]],
];
for (const [input, expected] of cases) {
  const got = unique(input.slice());
  assert.deepStrictEqual(got, expected, `unique(${JSON.stringify(input)}) => ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
}
console.log("✅ 全部通过");
```

无 `test.js` 的题（概念理解 / 读代码 / 时序题）：直接 `node template.js` 观察输出，或由用户描述预期，AI 核对关键结论点。

## 五、头部元数据格式（被引擎解析）

每个 `template.js` 顶部 `/* ... */` 块，字段：

| 字段 | 含义 | 示例 |
|------|------|------|
| `@kp` | 知识点名（SM-2 跟踪的键） | `数组去重` |
| `@tags` | 逗号分隔标签，用于视图分组 | `数组, 算法, Set` |
| `@difficulty` | 难度：`易` / `中` / `难` | `易` |
| `@prereq` | 前置知识点，逗号分隔，用于依赖图 | `数组遍历, 相等性判断` |

解析正则（在 trainer.mjs 中实现）：逐行匹配 `^\s*\*\s*@(\w+)\s+(.+)$`。

## 六、变体目录（防背题）

同一知识点的不同"角度 / 输入 / 边界"题放在 `variants/vN/`，每变体自带 `template.js`（+ `test.js`）。`v1` 即根目录的 `template.js`。复习时引擎随机抽一道变体，判定"掌握"要看多个变体是否都能拿到 q≥3（详见 `sm2-algorithm.md`）。
