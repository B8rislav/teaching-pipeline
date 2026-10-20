#!/usr/bin/env node
// md-log: Stop-хук, который зеркалит учебную сессию в markdown-лог для Obsidian.
// Аналог расширения md-log из amosblomqvist/learn.
//
// Сессия привязывается к логу файлом sessions/.links/<session_id>, в котором
// одна строка — путь к логу относительно корня проекта. Нет привязки — хук молчит.
// После каждого ответа Claude хук дописывает в лог: реплику ученика, текст
// ответа, квизы (AskUserQuestion) и ответы на них, вызовы researcher.
// Состояние (что уже записано) хранится в sessions/.links/<session_id>.state.json.
//
// Устройство файла (сверху вниз):
//   1. Утилиты
//   2. Транскрипт  — чтение jsonl и разбор записей
//   3. Рендеринг   — чистые функции «данные → markdown»
//   4. Состояние   — SessionState, что уже записано в лог
//   5. Лог         — LogBuffer, копит куски и дописывает их в файл
//   6. Обработчики — по одному на вид блока (паттерн «стратегия»)
//   7. main        — конвейер шагов с ранними выходами

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const TRANSCRIPT_POLL = { attempts: 10, delayMs: 150 };

// ─── 1. Утилиты ──────────────────────────────────────────────────────────────

const readStdin = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash("sha1").update(s.trim()).digest("hex");

const quote = (s) =>
  s
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

function readJsonOr(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ─── 2. Транскрипт ───────────────────────────────────────────────────────────

function readTranscript(p) {
  if (!p || !fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // последняя строка может быть дописана не до конца
    }
  }
  return out;
}

function blocks(entry) {
  const c = entry?.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

const isToolUse = (block, name) => block.type === "tool_use" && block.name === name;

const hasAssistantText = (entries, text) =>
  entries.some(
    (e) => e.type === "assistant" && blocks(e).some((b) => b.type === "text" && b.text.trim() === text)
  );

// Транскрипт пишется асинхронно и может отставать: немного подождём,
// пока в нём появится финальный текст этого хода.
async function waitForTranscript(transcriptPath, lastMessage) {
  let entries = readTranscript(transcriptPath);
  if (!lastMessage) return entries;

  for (let i = 0; i < TRANSCRIPT_POLL.attempts; i++) {
    if (hasAssistantText(entries, lastMessage)) break;
    await sleep(TRANSCRIPT_POLL.delayMs);
    entries = readTranscript(transcriptPath);
  }
  return entries;
}

// Служебные вставки, которые харнесс подмешивает в реплику пользователя.
const SERVICE_TAGS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g,
];
const COMMAND_TAGS = /<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g;
const INTERRUPTED = /^\[Request interrupted/;

// `/teach тема` приходит как <command-name>/teach</command-name><command-args>тема</command-args>.
function collapseSlashCommand(text) {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (name === undefined) return text;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || "";
  return `${name.trim()} ${args.trim()}`;
}

function cleanPrompt(raw) {
  const withoutService = SERVICE_TAGS.reduce((t, re) => t.replace(re, ""), raw);
  return collapseSlashCommand(withoutService).replace(COMMAND_TAGS, "").trim();
}

// Текст настоящей реплики пользователя или null, если это служебная запись.
function promptText(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;

  const bs = blocks(entry);
  if (bs.some((b) => b.type === "tool_result")) return null; // ответ инструмента, а не человека

  const raw = bs
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const text = cleanPrompt(raw);

  if (!text || INTERRUPTED.test(text)) return null;
  return text;
}

// ─── 3. Рендеринг ────────────────────────────────────────────────────────────

const renderPrompt = (text) => quote(`**Я:** ${text}`);

const renderResearcher = (input) => `*🔎 Проверка фактов: ${input.description || "researcher"}*`;

function renderQuestions(input) {
  return (input?.questions || [])
    .map((q) => {
      const head = q.header || "Вопрос";
      const opts = (q.options || [])
        .map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ""}`)
        .join("\n");
      const multi = q.multiSelect ? "\n*(можно выбрать несколько)*" : "";
      return quote(`[!question] ${head}\n**${q.question}**${multi}\n${opts}`);
    })
    .join("\n\n");
}

// asked: { текст вопроса → заголовок }, чтобы подписать каждый ответ.
function renderAnswers(answers, asked) {
  const lines = Object.entries(answers).map(([question, answer]) => {
    const header = asked?.[question];
    return `- ${header ? `**${header}:** ` : ""}${answer}`;
  });
  return lines.length ? quote(`[!note] Ответ\n${lines.join("\n")}`) : "";
}

// Запасной вариант, если харнесс не положил структурированные ответы.
function renderRawAnswer(block) {
  const raw = Array.isArray(block.content)
    ? block.content.map((c) => c.text || "").join("\n")
    : String(block.content || "");
  return quote(`[!note] Ответ\n${raw}`);
}

function renderQuizAnswer(entry, block, asked) {
  const answers = entry.toolUseResult?.answers;
  if (answers && typeof answers === "object") return renderAnswers(answers, asked);
  return renderRawAnswer(block);
}

// ─── 4. Состояние ────────────────────────────────────────────────────────────

class SessionState {
  static load(file) {
    const data = { startTs: null, seen: [], texts: [], asks: {}, ...readJsonOr(file, {}) };
    return new SessionState(file, data);
  }

  constructor(file, { startTs, seen, texts, asks }) {
    this.file = file;
    this.startTs = startTs; // с какой записи транскрипта начинается лог
    this.seen = new Set(seen); // uuid уже обработанных записей
    this.texts = new Set(texts); // хэши уже записанных ответов Claude
    this.asks = asks; // открытые квизы: tool_use_id → { вопрос → заголовок }
  }

  // Первый запуск: начинаем с реплики, в ходе которой создана привязка.
  ensureStart(entries, linkFile) {
    if (this.startTs) return;
    const lastPrompt = entries.findLast((e) => promptText(e) !== null);
    this.startTs = lastPrompt ? lastPrompt.timestamp : fs.statSync(linkFile).mtime.toISOString();
  }

  isBeforeStart(entry) {
    return Boolean(entry.timestamp && this.startTs && entry.timestamp < this.startTs);
  }

  // Отбирает записи, которых ещё нет в логе, и сразу помечает их обработанными.
  takeNewEntries(entries) {
    const fresh = [];
    for (const e of entries) {
      if (e.type !== "user" && e.type !== "assistant") continue;
      if (e.isSidechain || !e.uuid) continue;
      if (this.seen.has(e.uuid) || this.isBeforeStart(e)) continue;
      this.seen.add(e.uuid);
      fresh.push(e);
    }
    return fresh;
  }

  // true, если текст новый (и запоминает его); false — уже был в логе.
  rememberText(text) {
    const h = hash(text);
    if (this.texts.has(h)) return false;
    this.texts.add(h);
    return true;
  }

  openQuiz(toolUseId, input) {
    const asked = {};
    for (const q of input?.questions || []) asked[q.question] = q.header || "";
    this.asks[toolUseId] = asked;
  }

  hasQuiz(toolUseId) {
    return Boolean(this.asks[toolUseId]);
  }

  closeQuiz(toolUseId) {
    const asked = this.asks[toolUseId];
    delete this.asks[toolUseId];
    return asked;
  }

  save() {
    const data = {
      startTs: this.startTs,
      seen: [...this.seen],
      texts: [...this.texts],
      asks: this.asks,
    };
    fs.writeFileSync(this.file, JSON.stringify(data), "utf8");
  }
}

// ─── 5. Лог ──────────────────────────────────────────────────────────────────

class LogBuffer {
  #chunks = [];

  constructor(state) {
    this.state = state;
  }

  add(chunk) {
    if (chunk) this.#chunks.push(chunk);
  }

  // Ответ Claude: пропускаем пустые и уже записанные (финальный текст хода
  // может прийти и из транскрипта, и из last_assistant_message).
  addText(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    if (!this.state.rememberText(trimmed)) return;
    this.#chunks.push(trimmed);
  }

  flushTo(logPath) {
    if (this.#chunks.length === 0) return;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `\n\n${this.#chunks.join("\n\n")}\n`, "utf8");
  }
}

// ─── 6. Обработчики блоков ───────────────────────────────────────────────────
// Каждый блок записи обрабатывает первый подошедший обработчик.
// Новый вид события = новый элемент массива, остальной код не трогаем.

const BLOCK_HANDLERS = [
  {
    name: "assistant text",
    matches: ({ entry, block }) => entry.type === "assistant" && block.type === "text",
    handle: ({ block, log }) => log.addText(block.text),
  },
  {
    name: "quiz question",
    matches: ({ block }) => isToolUse(block, "AskUserQuestion"),
    handle: ({ block, state, log }) => {
      state.openQuiz(block.id, block.input);
      log.add(renderQuestions(block.input));
    },
  },
  {
    name: "researcher call",
    matches: ({ block }) => isToolUse(block, "Agent") && block.input?.subagent_type === "researcher",
    handle: ({ block, log }) => log.add(renderResearcher(block.input)),
  },
  {
    name: "quiz answer",
    matches: ({ block, state }) => block.type === "tool_result" && state.hasQuiz(block.tool_use_id),
    handle: ({ entry, block, state, log }) => {
      const asked = state.closeQuiz(block.tool_use_id);
      log.add(renderQuizAnswer(entry, block, asked));
    },
  },
];

function logEntry(entry, state, log) {
  const prompt = promptText(entry);
  if (prompt !== null) {
    log.add(renderPrompt(prompt));
    return;
  }

  for (const block of blocks(entry)) {
    const ctx = { entry, block, state, log };
    BLOCK_HANDLERS.find((h) => h.matches(ctx))?.handle(ctx);
  }
}

// ─── 7. main ─────────────────────────────────────────────────────────────────

async function readHookInput() {
  return JSON.parse((await readStdin()) || "{}");
}

// Пути этой сессии или null, если сессия не привязана к логу.
function resolveSession(input) {
  const sessionId = input.session_id;
  if (!sessionId) return null;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const linkFile = path.join(projectDir, "sessions", ".links", sessionId);
  if (!fs.existsSync(linkFile)) return null;

  const logRel = fs.readFileSync(linkFile, "utf8").trim();
  if (!logRel) return null;

  return {
    linkFile,
    stateFile: `${linkFile}.state.json`,
    logPath: path.resolve(projectDir, logRel),
  };
}

async function main() {
  const input = await readHookInput();

  const session = resolveSession(input);
  if (!session) return; // нет привязки — хук молчит

  const state = SessionState.load(session.stateFile);
  const lastMessage = (input.last_assistant_message || "").trim();
  const entries = await waitForTranscript(input.transcript_path, lastMessage);
  state.ensureStart(entries, session.linkFile);

  const log = new LogBuffer(state);
  for (const entry of state.takeNewEntries(entries)) logEntry(entry, state, log);
  log.addText(lastMessage); // даже если транскрипт ещё не успел его записать

  log.flushTo(session.logPath);
  state.save();
}

main().catch((err) => {
  process.stderr.write(`md-log: ${err?.stack || err}\n`);
  process.exit(0); // лог не должен ломать сессию
});
