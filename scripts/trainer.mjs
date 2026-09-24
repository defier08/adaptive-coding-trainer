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
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// 学习数据根目录：默认 ~/.codebuddy/adaptive-coding，可用环境变量 ADAPTIVE_CODING_DIR 覆盖（配置项）
const DATA_DIR = process.env.ADAPTIVE_CODING_DIR
  ? process.env.ADAPTIVE_CODING_DIR
  : join(homedir(), ".codebuddy", "adaptive-coding");
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
function getQueue(data) {
  if (!data.queue) data.queue = [];
  return data.queue;
}

function loadProgress() {
  if (!existsSync(PROGRESS)) return emptyData();
  try {
    return JSON.parse(readFileSync(PROGRESS, "utf8"));
  } catch {
    return emptyData();
  }
}

function saveProgress(data) {
  mkdirSync(dirname(PROGRESS), { recursive: true }); // 确保目录存在
  const tmp = PROGRESS + ".tmp";
  data.updated = todayISO();
  writeFileSync(tmp, JSON.stringify(data, null, 2));
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
      for (const v of variants) existing.add(v);
      data.variants[kp] = [...existing];

      if (!data.knowledge[kp]) {
        data.knowledge[kp] = {
          repetition: 0,
          interval: 0,
          easiness: 2.5,
          due: todayISO(),
          lapses: 0,
          variants_passed: 0,
          last_q: null,
        };
      }
    }
  }
  // 清理：仅保留本次扫描到的有效知识点（移除脏数据 / 已删除题目的历史进度）
  const scanned = new Set(Object.keys(data.meta));
  for (const k of Object.keys(data.knowledge)) {
    if (!scanned.has(k)) delete data.knowledge[k];
  }
  saveProgress(data);
  return data;
}

// SM-2 推进
function reviewNext(kp, qRaw) {
  const data = loadProgress();
  if (!data.knowledge[kp]) {
    data.knowledge[kp] = {
      repetition: 0,
      interval: 0,
      easiness: 2.5,
      due: todayISO(),
      lapses: 0,
      variants_passed: 0,
      last_q: null,
    };
  }
  const s = data.knowledge[kp];
  const q = Number(qRaw);

  if (q >= 3) {
    if (s.repetition === 0) s.interval = 1;
    else if (s.repetition === 1) s.interval = 6;
    else s.interval = Math.round(s.interval * s.easiness);
    s.repetition += 1;
    s.variants_passed += 1;
  } else {
    s.repetition = 0;
    s.interval = 1;
    s.lapses += 1;
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
    .filter(([, s]) => s.due <= today)
    .sort((a, b) => b[1].lapses - a[1].lapses || (a[1].due < b[1].due ? -1 : 1))
    .slice(0, limit)
    .map(([kp, s]) => {
      const vs = data.variants[kp] || [];
      return {
        kp,
        due: s.due,
        lapses: s.lapses,
        variants_passed: s.variants_passed,
        variant: vs.length ? vs[Math.floor(Math.random() * vs.length)] : null,
      };
    });
}

// 选题：队列优先（stuck > project，选中即消费）→ 到期复习（薄弱优先）→ 未学过新题
function pick() {
  const data = loadProgress();
  const queue = getQueue(data);
  if (queue.length) {
    const rank = (s) => (s === "stuck" ? 0 : 1);
    queue.sort((a, b) => rank(a.source) - rank(b.source) || (a.enqueuedAt < b.enqueuedAt ? -1 : 1));
    const item = queue.shift(); // 消费：选中即出队；未完成需重新 enqueue
    saveProgress(data);
    const vs = data.variants[item.kp] || [];
    return { kp: item.kp, reason: "queue-" + item.source, source: item.source, variant: vs[Math.floor(Math.random() * vs.length)] || null };
  }
  const today = todayISO();
  const due = Object.entries(data.knowledge).filter(([, s]) => s.due <= today);
  if (due.length) {
    due.sort((a, b) => b[1].lapses - a[1].lapses);
    const [kp, s] = due[0];
    const vs = data.variants[kp] || [];
    return { kp, reason: "review-due", lapses: s.lapses, variant: vs[Math.floor(Math.random() * vs.length)] || null };
  }
  const unlearned = Object.entries(data.knowledge).filter(([, s]) => s.repetition === 0);
  if (unlearned.length) {
    const [kp] = unlearned[0];
    const vs = data.variants[kp] || [];
    return { kp, reason: "new", variant: vs[0] || null };
  }
  return { kp: null, reason: "none" };
}

function mastery(kp) {
  const s = loadProgress().knowledge[kp];
  return {
    kp,
    ...s,
    mastered: !!(s && s.variants_passed >= 2 && s.last_q >= 3),
  };
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
    out = reviewNext(getOpt("--kp"), getOpt("--q"));
    break;
  case "review-list":
    out = reviewList(Number(getOpt("--limit") || 20));
    break;
  case "enqueue": {
    const kp = getOpt("--kp");
    const source = getOpt("--source");
    if (!kp) { out = { error: "missing --kp" }; break; }
    if (!["project", "stuck"].includes(source)) { out = { error: "--source must be project|stuck" }; break; }
    const data = loadProgress();
    if (!data.meta[kp]) { out = { error: `unknown kp '${kp}', run scan first` }; break; }
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
  default:
    out = {
      error: "unknown command",
      storage: { progress: PROGRESS, library: LIBRARY, modules: MODULES },
      usage: [
        "init",
        "scan [--dir <题集合>]",
        "enqueue --kp <名> --source project|stuck",
        "pick",
        "review-list [--limit 20]",
        "review-next --kp <名> --q <0-5>",
        "state --kp <名>",
        "mastery --kp <名>",
      ],
    };
}
console.log(JSON.stringify(out, null, 2));
