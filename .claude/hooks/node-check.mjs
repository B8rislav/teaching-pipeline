#!/usr/bin/env node
// node-check: записать в модель ученика результат проверки узла.
//
//   node node-check.mjs "<путь к заметке узла>" ok|fail [--misconception "текст"]...
//
// Заметка узла лежит в model/<Тема>/<Узел>.md, её frontmatter — модель ученика:
//   status        new | learning | shaky | solid
//   attempts      сколько раз узел проверяли
//   correct       сколько раз верно
//   last_checked  дата последней проверки
//   interval      дней до следующей проверки
//   next_review   дата следующей проверки (по ней Bases строит «что повторить сегодня»)
//   misconceptions — замеченные заблуждения (история, не стирается)
//
// Правило интервала: верно — интервал удваивается (первый раз 1 день, потолок 120),
// ошибка — сброс на 1 день и status: shaky. Даты считает скрипт, а не модель.

import fs from "node:fs";
import path from "node:path";

const MAX_INTERVAL = 120;

const [file, verdict, ...rest] = process.argv.slice(2);
if (!file || !["ok", "fail"].includes(verdict)) {
  console.error('Использование: node node-check.mjs "<model/Тема/Узел.md>" ok|fail [--misconception "текст"]');
  process.exit(1);
}
const misconceptions = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--misconception" && rest[i + 1]) misconceptions.push(rest[++i]);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const full = path.isAbsolute(file) ? file : path.join(root, file);
const text = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");
if (lines[0] !== "---") throw new Error(`Нет frontmatter: ${file}`);
const end = lines.indexOf("---", 1);
if (end < 0) throw new Error(`Frontmatter не закрыт: ${file}`);
const fm = lines.slice(1, end);

// ─── Чтение и запись простых ключей ─────────────────────────────────────────

const keyIdx = (k) => fm.findIndex((l) => l.startsWith(`${k}:`));
const get = (k) => {
  const i = keyIdx(k);
  return i < 0 ? undefined : fm[i].slice(k.length + 1).trim().replace(/^["']|["']$/g, "");
};
const set = (k, v) => {
  const i = keyIdx(k);
  if (i < 0) fm.push(`${k}: ${v}`);
  else fm[i] = `${k}: ${v}`;
};

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const now = new Date();
const today = ymd(now);

// ─── Обновление модели ───────────────────────────────────────────────────────

const attempts = (Number(get("attempts")) || 0) + 1;
const correct = (Number(get("correct")) || 0) + (verdict === "ok" ? 1 : 0);
const prev = Number(get("interval")) || 0;
const interval = verdict === "ok" ? (prev > 0 ? Math.min(prev * 2, MAX_INTERVAL) : 1) : 1;
const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + interval);

set("status", verdict === "ok" ? "solid" : "shaky");
set("attempts", attempts);
set("correct", correct);
set("last_checked", today);
set("interval", interval);
set("next_review", ymd(next));

// misconceptions: блочный список YAML, новые пункты дописываются в конец
if (misconceptions.length) {
  let i = keyIdx("misconceptions");
  if (i < 0) {
    fm.push("misconceptions:");
    i = fm.length - 1;
  } else {
    fm[i] = "misconceptions:"; // вдруг было `misconceptions: []`
  }
  let j = i + 1;
  const existing = [];
  while (j < fm.length && /^\s+-\s/.test(fm[j])) {
    existing.push(fm[j].replace(/^\s+-\s*/, "").replace(/^["']|["']$/g, ""));
    j++;
  }
  const add = misconceptions
    .map((m) => m.replace(/"/g, "'"))
    .filter((m) => !existing.includes(m))
    .map((m) => `  - "${m}"`);
  fm.splice(j, 0, ...add);
}

const out = ["---", ...fm, ...lines.slice(end)].join("\n");
fs.writeFileSync(full, out, "utf8");
const rate = Math.round((100 * correct) / attempts);
console.log(
  `${path.basename(full, ".md")}: ${verdict === "ok" ? "верно" : "ошибка"} → status ${verdict === "ok" ? "solid" : "shaky"}, ` +
    `${correct}/${attempts} (${rate}%), следующая проверка ${ymd(next)} (через ${interval} дн.)`,
);
