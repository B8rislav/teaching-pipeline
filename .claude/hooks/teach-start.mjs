#!/usr/bin/env node
// teach-start: сам создаёт лог сессии и привязку к нему, когда начинается /teach.
//
// Два пути запуска скилла — два события:
//   UserPromptExpansion (matcher "teach") — ученик набрал /teach <тема>;
//   PreToolUse (matcher "Skill")          — Claude сам вызвал скилл teach.
// Тема берётся из аргументов. Нет темы — хук молчит, лог создаст Claude по скиллу.
//
// Что делает:
//   1. sessions/<ГГГГ-ММ-ДД>-<slug>.md — создаёт, если такого ещё нет (тот же день и тема → тот же лог);
//   2. sessions/.links/<session_id> — путь к логу (его читает md-log);
//   3. сообщает Claude пути к логу, конспекту, карточкам и модели ученика.

import fs from "node:fs";
import path from "node:path";

const readStdin = () =>
  new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
  });

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const slugify = (s) =>
  [...s.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Существующие материалы темы: ищем по совпадению slug имени файла
const findBySlug = (dir, slug, filter = () => true) => {
  if (!fs.existsSync(dir)) return null;
  const hit = fs
    .readdirSync(dir)
    .filter(filter)
    .find((f) => {
      const s = slugify(f.replace(/\.md$/, "").replace(/ — конспект$/, ""));
      return s === slug || s.startsWith(slug) || slug.startsWith(s);
    });
  return hit ? path.join(dir, hit) : null;
};

async function main() {
  const input = JSON.parse((await readStdin()) || "{}");
  const event = input.hook_event_name;
  let topic;
  if (event === "UserPromptExpansion") {
    if (input.command_name !== "teach") return;
    topic = input.command_args;
  } else if (event === "PreToolUse") {
    if (input.tool_name !== "Skill" || input.tool_input?.skill !== "teach") return;
    topic = input.tool_input?.args;
  } else return;

  topic = (topic || "").trim();
  const sessionId = input.session_id;
  if (!topic || !sessionId) return;

  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
  const asked = slugify(topic) || "teach";

  const conspectus = findBySlug(path.join(root, "notes"), asked, (f) => f.endsWith("конспект.md"));
  const cards = findBySlug(path.join(root, "cards"), asked);
  const modelDir = findBySlug(path.join(root, "model"), asked);
  // Тема уже есть под полным именем («JLPT» → «JLPT N3») — берём его, чтобы логи темы назывались одинаково
  if (conspectus) topic = path.basename(conspectus, ".md").replace(/ — конспект$/, "");
  const slug = slugify(topic) || asked;
  const date = ymd(new Date());
  const logRel = `sessions/${date}-${slug}.md`;
  const logPath = path.join(root, logRel);
  const linkDir = path.join(root, "sessions", ".links");
  const linkFile = path.join(linkDir, sessionId);

  const created = !fs.existsSync(logPath);
  if (created) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `---\ntopic: ${topic}\ndate: ${date}\n---\n\n# ${topic}\n\n`, "utf8");
  }
  fs.mkdirSync(linkDir, { recursive: true });
  fs.writeFileSync(linkFile, logRel + "\n", "utf8");

  const lines = [
    `teach-start: лог сессии ${created ? "создан" : "уже был, продолжаю"} — ${logRel}; привязка к сессии сделана, вручную её не создавай.`,
    conspectus ? `Конспект темы: ${rel(conspectus)} (начни с раздела «Где остановились»).` : "Конспекта темы ещё нет — создай по скиллу и впиши ссылку на него в лог.",
    cards ? `Карточки: ${rel(cards)}.` : "Карточек по теме ещё нет.",
    modelDir ? `Модель ученика: ${rel(modelDir)}/.` : "Узлов модели ученика по теме ещё нет.",
  ];
  if (!conspectus && !cards && !modelDir) {
    lines.push(`Если тема на самом деле уже есть под другим именем — привяжи сессию к правильному логу и удали пустой ${logRel}.`);
  }

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } }),
  );
}

main().catch((e) => {
  process.stderr.write(`teach-start: ${e.message}\n`);
  process.exit(0); // не мешаем уроку из-за сбоя хука
});
