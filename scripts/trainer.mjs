#!/usr/bin/env node
// adaptive-coding-trainer 确定性引擎（Node 零依赖）
// 负责：扫描题目元数据、按优先级选题、SM-2 掌握度推进、到期复习列表、掌握度评估。
// 所有跨会话副作用（进度、间隔）都落在这里，AI 不口头记录。
//
// 存储架构（三类归属）：
//   ① Skill 本体        ~/.codebuddy/skills/adaptive-coding-trainer/  （指令 + 引擎）
//   ② 用户级学习数据    ~/.codebuddy/adaptive-coding/
//        progress.json  —— 全局掌握度，按 @kp 名索引（跨项目统一）
//        library/       —— 全部题目题库（通用主题 + 从项目 / 卡点挖的题，统一存放，不进项目目录）
//        modules/       —— 通用模块实现级讲解（登录 / 权限 … 可复用）
//   ③ 项目 / 卡点只作"知识点来源"，绝不往项目目录写任何题文件
//        （所有题都进 ② 的 library，进度汇总进 progress.json，按 @kp 名关联，不按路径）

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// 学习数据根目录解析优先级：环境变量 ADAPTIVE_CODING_DIR > config.json > 默认 ~/.codebuddy/adaptive-coding
function resolveDataDir() {
  const env = process.env.ADAPTIVE_CODING_DIR;
  if (env && env.trim()) return env.trim();
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, ""));
    const dir = cfg && cfg.adaptive_coding_dir;
    if (typeof dir === "string" && dir.trim()) return dir.trim();
  } catch {
    // config.json 缺失或损坏：回退到默认
  }
  return join(homedir(), ".codebuddy", "adaptive-coding");
}
const DATA_DIR = resolveDataDir();
const PROGRESS = join(DATA_DIR, "progress.json");
const LIBRARY = join(DATA_DIR, "library");
const MODULES = join(DATA_DIR, "modules");

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function emptyData() {
  return { version: 1, updated: todayISO(), knowledge: {}, meta: {}, variants: {}, queue: [] };
}
function newKnowledge() {
  return {
    repetition: 0,
    interval: 0,
    easiness: 2.5,
    due: todayISO(),
    lapses: 0,
    passed_variants: [],
    last_q: null,
    deprecated: false,
  };
}
function getQueue(data) {
  if (!data.queue) data.queue = [];
  return data.queue;
}

function loadProgress() {
  let data;
  if (!existsSync(PROGRESS)) {
    data = emptyData();
  } else {
    try {
      data = JSON.parse(readFileSync(PROGRESS, "utf8"));
    } catch {
      // 主文件损坏：尝试上一版备份，避免进度静默清零
      if (existsSync(PROGRESS + ".bak")) {
        try {
          data = JSON.parse(readFileSync(PROGRESS + ".bak", "utf8"));
          console.error("[adaptive-coding-trainer] progress.json 损坏，已从 progress.json.bak 恢复");
        } catch {
          data = emptyData();
          console.error("[adaptive-coding-trainer] progress.json 与备份均损坏，进度已重置，请检查");
        }
      } else {
        data = emptyData();
        console.error("[adaptive-coding-trainer] progress.json 损坏且无备份，进度已重置");
      }
    }
  }
  migrate(data);
  return data;
}

// 迁移旧字段：早期版本用数字 variants_passed 计数（无法还原具体变体），保守清零为列表
function migrate(data) {
  const k = data && data.knowledge;
  if (!k) return;
  for (const name of Object.keys(k)) {
    const s = k[name];
    if (s && typeof s === "object") {
      if (typeof s.variants_passed === "number" && !Array.isArray(s.passed_variants)) {
        delete s.variants_passed;
        s.passed_variants = [];
      }
      if (!Array.isArray(s.passed_variants)) s.passed_variants = [];
    }
  }
}

// 抽一道变体：优先抽尚未通过（passed_variants 之外）的；全部通过后再随机
function pickVariant(vs, passed) {
  if (!vs || !vs.length) return null;
  const passedSet = new Set(Array.isArray(passed) ? passed : []);
  const unpassed = vs.filter((v) => !passedSet.has(v));
  const pool = unpassed.length ? unpassed : vs;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 掌握判定：需在 ≥2 个不同变体上拿到 q≥3（防背题）
function isMastered(s) {
  return !!(s && Array.isArray(s.passed_variants) && s.passed_variants.length >= 2 && s.last_q >= 3);
}

// 难度排序（易 → 中 → 难；未定居中）
const DIFF_RANK = { 易: 0, 中: 1, 难: 2 };
const diffRank = (d) => (d in DIFF_RANK ? DIFF_RANK[d] : 1.5);

// 知识点状态
function statusOf(s) {
  if (!s || !s.repetition) return "未学";
  if (isMastered(s)) return "已掌握";
  if ((s.lapses || 0) > 0) return "薄弱";
  return "学习中";
}

// 前置分析：blockedBy = 有题但尚未学的前置；missing = 题库里没有的前置；weak = 学过但有过遗忘的前置
function prereqInfo(kp, data) {
  const m = data.meta[kp] || {};
  const blockedBy = [];
  const missing = [];
  const weak = [];
  for (const p of m.prereq || []) {
    if (!data.meta[p]) {
      missing.push(p);
      continue;
    }
    const ps = data.knowledge[p] || {};
    if (ps.repetition === 0) blockedBy.push(p);
    else if ((ps.lapses || 0) > 0) weak.push(p);
  }
  return { blockedBy, missing, weak };
}

function saveProgress(data) {
  mkdirSync(dirname(PROGRESS), { recursive: true }); // 确保目录存在
  const tmp = PROGRESS + ".tmp";
  data.updated = todayISO();
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  // 替换前把上一版保留为 .bak（同目录 rename 原子），再原子替换主文件
  if (existsSync(PROGRESS)) {
    try { renameSync(PROGRESS, PROGRESS + ".bak"); } catch { /* 忽略备份失败 */ }
  }
  renameSync(tmp, PROGRESS); // 原子写，防止损坏
}

function parseMeta(filePath) {
  let src;
  try {
    // 归一化行结束符：Windows CRLF 下 \r 是 JS 行终止符，会破坏逐行正则
    src = readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return {};
  }
  const block = src.match(/\/\*\*([\s\S]*?)\*\//);
  const meta = {};
  if (block) {
    for (const line of block[1].split("\n")) {
      const m = line.match(/^\s*\*\s*@(\w+)\s+(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  return meta;
}

function splitList(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// 扫描多个题目来源（默认 LIBRARY；--dir 可选附加任意题集合目录，不要指向项目源码目录）
function scan(sources) {
  const data = loadProgress();
  const prevSource = {};
  for (const k in data.meta) if (data.meta[k] && data.meta[k].source) prevSource[k] = data.meta[k].source;
  data.meta = {}; // 重建（保留已记录的来源 source）
  data.variants = {}; // 重建
  for (const dir of sources) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
      .map((e) => e.name)
      .sort();

    for (const name of entries) {
      const kpDir = join(dir, name);
      const tpl = join(kpDir, "template.js");
      if (!existsSync(tpl)) continue;
      const meta = parseMeta(tpl);
      const kp = meta.kp || name;

      const variants = [join(kpDir, "template.js")];
      const vDir = join(kpDir, "variants");
      if (existsSync(vDir)) {
        for (const v of readdirSync(vDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()) {
          const vt = join(vDir, v, "template.js");
          if (existsSync(vt)) variants.push(vt);
        }
      }

      if (!data.meta[kp]) {
        data.meta[kp] = {
          tags: splitList(meta.tags),
          difficulty: meta.difficulty || "未定",
          prereq: splitList(meta.prereq),
          source: prevSource[kp] || undefined,
        };
      }
      const existing = new Set(data.variants[kp] || []);
      // 存相对 DATA_DIR 的路径，避免换机器 / 换根目录后 passed_variants 失配
      for (const v of variants) existing.add(relative(DATA_DIR, v));
      data.variants[kp] = [...existing];

      if (!data.knowledge[kp]) {
        data.knowledge[kp] = newKnowledge();
      }
    }
  }
  // 注意：不再删除 knowledge 中"本次未扫到"的条目（改名 / 临时移走目录会导致进度被误删）。
  // 无 meta 的孤儿条目由 pick / review-list 过滤，不参与选题；改名改回后可恢复进度。
  saveProgress(data);
  return data;
}

// SM-2 推进（按变体去重记录通过情况；答错清空；防背题）
function reviewNext(kp, qRaw, variant) {
  const q = Number(qRaw);
  if (!Number.isInteger(q) || q < 0 || q > 5) {
    return { error: "--q must be an integer 0-5, got: " + qRaw };
  }
  const data = loadProgress();
  if (!data.knowledge[kp]) {
    data.knowledge[kp] = newKnowledge();
  }
  const s = data.knowledge[kp];
  if (!Array.isArray(s.passed_variants)) s.passed_variants = [];

  if (q >= 3) {
    if (s.repetition === 0) s.interval = 1;
    else if (s.repetition === 1) s.interval = 6;
    else s.interval = Math.round(s.interval * s.easiness);
    s.repetition += 1;
    // 记录本次通过的变体；未显式传 --variant 时退化为根题（第一个变体）
    const v = variant || (data.variants[kp] && data.variants[kp][0]);
    if (v && !s.passed_variants.includes(v)) s.passed_variants.push(v);
  } else {
    s.repetition = 0;
    s.interval = 1;
    s.lapses += 1;
    s.passed_variants = []; // 遗忘即清零，需重新在不同变体上证明掌握
  }
  s.easiness = s.easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (s.easiness < 1.3) s.easiness = 1.3;
  s.due = addDays(todayISO(), s.interval);
  s.last_q = q;

  saveProgress(data);
  return s;
}

function reviewList(limit = 20) {
  const data = loadProgress();
  const today = todayISO();
  return Object.entries(data.knowledge)
    .filter(([kp, s]) => s.repetition > 0 && s.due <= today && data.meta[kp] && !s.deprecated) // 只列"已学过且到期且未弃用"的复习项，未学新题不在此列
    .sort((a, b) => b[1].lapses - a[1].lapses || (a[1].due < b[1].due ? -1 : 1))
    .slice(0, limit)
    .map(([kp, s]) => {
      const vs = data.variants[kp] || [];
      return {
        kp,
        due: s.due,
        lapses: s.lapses,
        passed_variants: Array.isArray(s.passed_variants) ? s.passed_variants.length : 0,
        variant: pickVariant(vs, s.passed_variants),
      };
    });
}

// 选题：队列优先（stuck > project，选中即消费）→ 到期复习（薄弱优先）→ 未学过新题
function pick() {
  const data = scan(sources); // 先扫描，确保刚落盘的题被看见（pick 自动 scan）
  const queue = getQueue(data);
  const isActive = (kp, s) => data.meta[kp] && !s.deprecated; // 孤儿 / 弃用题不参与选题
  if (queue.length) {
    const rank = (s) => (s === "stuck" ? 0 : 1);
    queue.sort((a, b) => rank(a.source) - rank(b.source) || (a.enqueuedAt < b.enqueuedAt ? -1 : 1));
    // 跳过已弃用的队列项（弃用后不再推，除非重新 enqueue）
    let item = null;
    while (queue.length) {
      const head = queue[0];
      if (data.knowledge[head.kp] && data.knowledge[head.kp].deprecated) { queue.shift(); continue; }
      item = queue.shift();
      break;
    }
    if (item) {
      saveProgress(data); // 一并把被跳过的弃用项写盘
      const vs = data.variants[item.kp] || [];
      const s = data.knowledge[item.kp];
      return { kp: item.kp, reason: "queue-" + item.source, source: item.source, variant: pickVariant(vs, s && s.passed_variants) };
    }
    saveProgress(data); // 队列全弃用：清空后落入常规流程
  }
  const today = todayISO();
  // 到期复习：仅限已学过且未弃用的点（未学新题交给下面的拓扑分支处理）
  const due = Object.entries(data.knowledge).filter(([kp, s]) => s.repetition > 0 && s.due <= today && isActive(kp, s));
  if (due.length) {
    due.sort((a, b) => b[1].lapses - a[1].lapses);
    const [kp, s] = due[0];
    const vs = data.variants[kp] || [];
    return { kp, reason: "review-due", lapses: s.lapses, variant: pickVariant(vs, s.passed_variants) };
  }
  const unlearned = Object.entries(data.knowledge).filter(([kp, s]) => s.repetition === 0 && isActive(kp, s));
  if (unlearned.length) {
    const info = unlearned.map(([kp]) => ({
      kp,
      difficulty: (data.meta[kp] || {}).difficulty || "未定",
      ...prereqInfo(kp, data),
    }));
    // 依赖图拓扑：优先推"前置已满足"的新题；全被前置卡住时暴露 blocked_by
    const ready = info.filter((x) => x.blockedBy.length === 0);
    const pool = ready.length ? ready : info;
    pool.sort((a, b) => diffRank(a.difficulty) - diffRank(b.difficulty)); // 同批内难度由易到难
    const chosen = pool[0];
    const vs = data.variants[chosen.kp] || [];
    return {
      kp: chosen.kp,
      reason: "new",
      difficulty: chosen.difficulty,
      variant: vs[0] || null,
      ...(ready.length ? {} : { blocked_by: chosen.blockedBy }), // 无就绪新题时，暴露薄弱前置
      ...(chosen.missing.length ? { missing_prereq: chosen.missing } : {}),
    };
  }
  return { kp: null, reason: "none" };
}

function mastery(kp) {
  const s = loadProgress().knowledge[kp];
  return { kp, ...s, mastered: isMastered(s) };
}

// 依赖图：各点状态 + 边 + 薄弱前置 + 缺失前置 + 汇总
function graph() {
  const data = loadProgress();
  const nodes = Object.keys(data.meta).map((kp) => {
    const m = data.meta[kp] || {};
    const s = data.knowledge[kp] || {};
    const info = prereqInfo(kp, data);
    return {
      kp,
      tags: m.tags || [],
      difficulty: m.difficulty || "未定",
      prereq: m.prereq || [],
      status: statusOf(s),
      deprecated: !!(s.deprecated),
      repetition: s.repetition || 0,
      lapses: s.lapses || 0,
      passed_variants: Array.isArray(s.passed_variants) ? s.passed_variants.length : 0,
      blocked_by: info.blockedBy,
      missing_prereq: info.missing,
    };
  });
  const edges = [];
  for (const n of nodes) for (const p of n.prereq) edges.push([p, n.kp]);
  // 薄弱前置：被别的知识点当前置、但自身尚未掌握的点
  const weakPrereq = nodes
    .filter((n) => n.status !== "已掌握" && nodes.some((x) => x.prereq.includes(n.kp)))
    .map((n) => n.kp);
  const missingPrereq = [...new Set(nodes.flatMap((n) => n.missing_prereq))];
  return {
    summary: {
      total: nodes.length,
      mastered: nodes.filter((n) => n.status === "已掌握").length,
      learning: nodes.filter((n) => n.status === "学习中").length,
      weak: nodes.filter((n) => n.status === "薄弱").length,
      unlearned: nodes.filter((n) => n.status === "未学").length,
      blocked: nodes.filter((n) => n.status === "未学" && n.blocked_by.length > 0).length,
    },
    weak_prereq: weakPrereq,
    missing_prereq: missingPrereq,
    nodes,
    edges,
  };
}

// 视图：按 tags 分组 / 按难度排序（只换视图，不改文件）
function view() {
  const data = loadProgress();
  const items = Object.keys(data.meta).map((kp) => {
    const m = data.meta[kp] || {};
    const s = data.knowledge[kp] || {};
    return { kp, tags: m.tags || [], difficulty: m.difficulty || "未定", status: statusOf(s), deprecated: !!(s.deprecated) };
  });
  const byTag = {};
  for (const it of items) {
    for (const t of it.tags.length ? it.tags : ["未打标签"]) (byTag[t] = byTag[t] || []).push(it.kp);
  }
  const byDifficulty = [...items].sort(
    (a, b) => diffRank(a.difficulty) - diffRank(b.difficulty) || a.kp.localeCompare(b.kp)
  );
  return { by_tag: byTag, by_difficulty: byDifficulty };
}

// ---- CLI ----
const args = process.argv.slice(2);
const cmd = args[0];
function getOpt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const dirOpt = getOpt("--dir");
const sources = [LIBRARY];
if (dirOpt) sources.push(dirOpt);

let out;
switch (cmd) {
  case "init":
    saveProgress(loadProgress());
    out = { ok: true, msg: "initialized", progress: PROGRESS, library: LIBRARY, modules: MODULES };
    break;
  case "scan":
    out = scan(sources);
    break;
  case "review-next":
    out = reviewNext(getOpt("--kp"), getOpt("--q"), getOpt("--variant"));
    break;
  case "review-list":
    out = reviewList(Number(getOpt("--limit") || 20));
    break;
  case "enqueue": {
    const kp = getOpt("--kp");
    const source = getOpt("--source");
    if (!kp) { out = { error: "missing --kp" }; break; }
    if (!["project", "stuck"].includes(source)) { out = { error: "--source must be project|stuck" }; break; }
    const data = scan(sources); // 先扫描，确保刚落盘的题目已进入 meta（避免"新题 enqueue 报未知知识点"）
    if (!data.meta[kp]) { out = { error: `unknown kp '${kp}', not found in: ${sources.join(", ")}` }; break; }
    const queue = getQueue(data);
    if (!queue.find((q) => q.kp === kp && q.source === source)) {
      queue.push({ kp, source, enqueuedAt: todayISO() });
    }
    if (data.meta[kp]) data.meta[kp].source = source;
    saveProgress(data);
    out = { ok: true, enqueued: { kp, source }, queue };
    break;
  }
  case "pick":
    out = pick();
    break;
  case "state":
    out = loadProgress().knowledge[getOpt("--kp")] || null;
    break;
  case "mastery":
    out = mastery(getOpt("--kp"));
    break;
  case "deprecate":
  case "undeprecate": {
    const kp = getOpt("--kp");
    if (!kp) { out = { error: "missing --kp" }; break; }
    const data = scan(sources);
    if (!data.meta[kp]) { out = { error: `unknown kp '${kp}', not found in: ${sources.join(", ")}` }; break; }
    if (!data.knowledge[kp]) data.knowledge[kp] = newKnowledge();
    data.knowledge[kp].deprecated = cmd === "deprecate";
    saveProgress(data);
    out = { ok: true, kp, deprecated: data.knowledge[kp].deprecated };
    break;
  }
  case "graph":
    out = graph();
    break;
  case "view":
    out = view();
    break;
  default:
    out = {
      error: "unknown command",
      storage: { progress: PROGRESS, library: LIBRARY, modules: MODULES },
      usage: [
        "init",
        "scan [--dir <题集合>]",
        "enqueue --kp <名> --source project|stuck  (自动先 scan)",
        "pick",
        "review-list [--limit 20]",
        "review-next --kp <名> --q <0-5> [--variant <变体标识>]",
        "state --kp <名>",
        "mastery --kp <名>",
        "deprecate --kp <名>",
        "undeprecate --kp <名>",
        "graph",
        "view",
      ],
    };
}
console.log(JSON.stringify(out, null, 2));
