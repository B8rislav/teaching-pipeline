#!/usr/bin/env node
// sr-due: какие карточки плагина Obsidian Spaced Repetition пора повторить.
//
// Читает все .md с тегом #flashcards (кроме sessions/ и скрытых папок),
// находит в них карточки и разбирает комментарии расписания, которые пишет плагин:
//   SM-2-OSR: <!--SR:!2026-10-25,3,250-->              (срок, интервал, ease)
//   FSRS:     <!--SR:!fsrs,<ISO-срок>,интервал,stability,difficulty,state,reps,lapses,steps,<ISO>-->
// У карточки «туда-обратно» и у пропусков несколько «сестёр» — по записи на каждую.
// Нет комментария или срок 2000-01-01 — карточка новая, её ещё не повторяли.
//
// Расписание только читается. Пишет его плагин, когда ученик повторяет в Obsidian.
//
// Запуск:
//   node sr-due.mjs            — сводка для человека
//   node sr-due.mjs --hook     — короткая сводка для SessionStart-хука (молчит, если карточек нет)
//   node sr-due.mjs --json     — всё в JSON
//   node sr-due.mjs <фильтр>   — только файлы, в пути которых есть <фильтр>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.CLAUDE_PROJECT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["sessions", "node_modules"]);
const NEW_CARD_DATE = "2000-01-01"; // плагин ставит эту дату несыгранным сёстрам
const BASE_EASE = 250; // стартовый ease плагина по умолчанию
const HARD_EASE = 230; // ниже — ученик больше раз жал Hard, чем Easy
const LIST_LIMIT = 10;

const args = process.argv.slice(2);
const MODE = args.includes("--hook") ? "hook" : args.includes("--json") ? "json" : "human";
const FILTER = args.find((a) => !a.startsWith("--"));

// ─── Поиск файлов ────────────────────────────────────────────────────────────

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

// ─── Разбор карточек ─────────────────────────────────────────────────────────

const SR_RE = /<!--SR:(.*?)-->/;
const TAG_RE = /(?:^|\s)#(flashcards[^\s#]*)/;
const stripCode = (s) => s.replace(/`[^`]*`/g, "");
const stripSr = (s) => s.replace(/\s?<!--SR:.*?-->/g, "");
const isSrOnly = (s) => /^\s*<!--SR:.*?-->\s*$/.test(s);
const isHeading = (s) => /^#{1,6}\s/.test(s);

const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

// Одна запись расписания → {state, due, ease, lapses}
function parseSibling(chunk) {
  const f = chunk.split(",");
  if (f[0] === "fsrs") {
    const due = new Date(f[1]);
    const lapses = Number(f[7]) || 0;
    return {
      state: due <= new Date() ? "due" : "later",
      due: f[1].slice(0, 10),
      lapses,
      hard: lapses > 0,
    };
  }
  const [due, , ease] = f;
  if (!due || due === NEW_CARD_DATE) return { state: "new" };
  const e = Number(ease) || BASE_EASE;
  return { state: due <= today ? "due" : "later", due, ease: e, hard: e <= HARD_EASE };
}

function siblingsOf(srText, count) {
  const chunks = srText ? srText.split("!").filter(Boolean) : [];
  return Array.from({ length: count }, (_, i) =>
    chunks[i] ? parseSibling(chunks[i]) : { state: "new" },
  );
}

const short = (s) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 90 ? t.slice(0, 87) + "…" : t;
};

function parseFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!/#flashcards/.test(text)) return [];
  let lines = text.split("\n");
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) lines = lines.slice(end + 1);
  }

  // Блоки — подряд идущие непустые строки вне ```-блоков. Заголовок тоже рвёт блок.
  const blocks = [];
  let cur = [];
  let fence = false;
  let deck = "flashcards";
  const flush = () => {
    if (cur.length) blocks.push({ deck, lines: cur });
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      flush();
      continue;
    }
    if (fence) continue;
    const tag = TAG_RE.exec(stripCode(line));
    if (tag && !stripSr(line).includes("::")) {
      flush();
      deck = tag[1];
      continue;
    }
    if (!line.trim() || isHeading(line)) flush();
    else cur.push(line);
  }
  flush();

  const cards = [];
  const add = (deck, question, srText, count) =>
    cards.push({ file, deck, question: short(stripSr(question)), siblings: siblingsOf(srText, count) });

  for (const { deck, lines: b } of blocks) {
    const sr = (s) => SR_RE.exec(s ?? "")?.[1];
    const sep = b.findIndex((l) => l.trim() === "?" || l.trim() === "??");
    if (sep > 0) {
      const all = b.map(sr).find(Boolean);
      add(deck, b.slice(0, sep).join(" "), all, b[sep].trim() === "??" ? 2 : 1);
      continue;
    }
    let found = false;
    for (let i = 0; i < b.length; i++) {
      if (isSrOnly(b[i])) continue;
      const body = stripCode(stripSr(b[i]));
      const rev = body.includes(":::");
      if (!rev && !body.includes("::")) continue;
      found = true;
      const srText = sr(b[i]) ?? (isSrOnly(b[i + 1] ?? "") ? sr(b[i + 1]) : undefined);
      add(deck, body.split(rev ? ":::" : "::")[0], srText, rev ? 2 : 1);
    }
    if (found) continue;
    const clozes = stripCode(b.join("\n")).match(/==[^=\n]+==/g);
    if (clozes) add(deck, b.join(" "), b.map(sr).find(Boolean), clozes.length);
  }
  return cards;
}

// ─── Сводка ──────────────────────────────────────────────────────────────────

const files = [...walk(ROOT)].filter((f) => !FILTER || f.includes(FILTER));
const cards = files.flatMap(parseFile);

const byFile = new Map();
const dueList = [];
const hardList = [];
for (const c of cards) {
  const rel = path.relative(ROOT, c.file).replace(/\\/g, "/");
  const s = byFile.get(rel) ?? { file: rel, deck: c.deck, total: 0, due: 0, new: 0, hard: 0, oldest: null };
  for (const sib of c.siblings) {
    s.total++;
    if (sib.state === "new") s.new++;
    if (sib.state === "due") {
      s.due++;
      if (!s.oldest || sib.due < s.oldest) s.oldest = sib.due;
    }
    if (sib.hard) s.hard++;
  }
  byFile.set(rel, s);
  if (c.siblings.some((x) => x.state === "due")) dueList.push({ file: rel, question: c.question });
  if (c.siblings.some((x) => x.hard)) hardList.push({ file: rel, question: c.question });
}
const stats = [...byFile.values()];
const sum = (k) => stats.reduce((a, s) => a + s[k], 0);
const totals = { today, cards: sum("total"), due: sum("due"), new: sum("new"), hard: sum("hard") };

if (MODE === "json") {
  console.log(JSON.stringify({ totals, files: stats, due: dueList, hard: hardList }, null, 2));
  process.exit(0);
}
if (MODE === "hook" && !totals.cards) process.exit(0);

const out = [];
out.push(`Интервальное повторение на ${today} (скрипт .claude/hooks/sr-due.mjs):`);
if (!totals.cards) out.push("Карточек пока нет.");
for (const s of stats) {
  const old = s.oldest && s.oldest < today ? `, просрочено с ${s.oldest}` : "";
  out.push(`- ${s.file} [#${s.deck}]: всего ${s.total}, пора повторить ${s.due}, новых ${s.new}, трудных ${s.hard}${old}`);
}
const list = (title, arr) => {
  if (!arr.length) return;
  out.push(title);
  for (const x of arr.slice(0, LIST_LIMIT)) out.push(`  · ${x.question}`);
  if (arr.length > LIST_LIMIT) out.push(`  · …и ещё ${arr.length - LIST_LIMIT}`);
};
list("Пора повторить:", dueList);
list("Трудные (ученик на них спотыкался):", hardList);
if (MODE === "hook") {
  out.push(
    totals.due + totals.new
      ? "Перед уроком — фаза 0 скилла teach: отправь ученика повторить карточки в Obsidian."
      : "Всё повторено, можно сразу к уроку.",
  );
}
console.log(out.join("\n"));
