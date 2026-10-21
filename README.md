# learn — система обучения с ИИ в Claude Code

> **EN:** A Russian-language port of [amosblomqvist/learn](https://github.com/amosblomqvist/learn) from pi to Claude Code. `/teach <topic>` runs a tutoring session: placement quizzes, a dependency map, node-by-node lessons, and an Obsidian vault with notes, spaced-repetition cards and a learner model. All prompts are in Russian; translate `.claude/skills/` and `CLAUDE.md` to use it in another language.

Порт [amosblomqvist/learn](https://github.com/amosblomqvist/learn) (видео Eero Alvar «How I Use AI to Learn Things») с pi на Claude Code. Работает на Windows без WSL и tmux.

## Что внутри

| Файл | Что делает | Аналог в оригинале |
| --- | --- | --- |
| `.claude/skills/teach/SKILL.md` | Педагогика и процесс: зонд → план → обучение | `skills/teach` |
| `.claude/skills/visualize/SKILL.md` | Когда и как рисовать mermaid/SVG | `skills/visualize` + `mermaid-maker`, `svg-maker` |
| `.claude/agents/researcher.md` | Субагент для проверки фактов (Sonnet, веб-поиск) | `agents/researcher` |
| `.claude/hooks/md-log.mjs` | Stop-хук: зеркалит сессию в markdown-лог | `extensions/md-log` |
| `.claude/hooks/teach-start.mjs` | При `/teach <тема>` сам создаёт лог и привязку сессии к нему | — |
| `.claude/hooks/sr-due.mjs` | SessionStart-хук: сколько карточек пора повторить | — |
| `.claude/skills/teach/references/cards.md` | Как писать карточки (Matuschak, Woźniak) | — |
| `notes/<Тема> — конспект.md` | Конспект: правила по узлам карты | — |
| `cards/<Тема>.md` | Карточки плагина Spaced Repetition | — |
| `model/<Тема>/<Узел>.md` | Модель ученика: статус узла, доля верных, срок проверки, заблуждения | — |
| `.claude/hooks/node-check.mjs` | Записывает результат квиза по узлу и считает срок следующей проверки | — |
| `Прогресс.base` | Дашборд Bases: «повторить сегодня», все узлы по цвету, заблуждения | — |
| `.claude/settings.json` | Регистрирует хук, разрешает веб-поиск и запись в `sessions/` | — |
| `CLAUDE.md` | Контекст проекта для каждой сессии | — |

Квизы и вопросы идут через встроенный `AskUserQuestion` вместо расширений `quiz` и `ask-user-question`.

## Установка

1. Нужны [Claude Code](https://claude.com/claude-code), Node.js 18+ (на нём работают хуки) и [Obsidian](https://obsidian.md).
2. Склонируй репозиторий: `git clone <url> learn`.
3. Открой папку `learn` в Obsidian как хранилище: *Open folder as vault*.
4. В Obsidian: *Settings → Community plugins* → выключи *Restricted mode* → *Browse* → **Spaced Repetition** (автор st3v3nmw) → *Install* → *Enable*. Настройки по умолчанию подходят.
5. В терминале: `cd learn` и `claude`. При первом запуске Claude Code спросит, доверяешь ли ты папке: хуки из `.claude/settings.json` заработают только после согласия.

Папки `notes/`, `cards/`, `model/` и `sessions/` в репозиторий не входят: они появятся сами на первом уроке. `.gitignore` пропускает в git только файлы системы, поэтому твои учебные материалы останутся локальными, даже если ты сделаешь форк и будешь пушить доработки.

`.claude/settings.json` заранее разрешает `WebSearch`, `WebFetch` на любой домен (это нужно субагенту researcher) и правку файлов в `sessions/`. Если такие права не нужны, убери их оттуда — Claude будет спрашивать каждый раз.

## Как учиться

```
/teach <тема>
```

Claude создаст лог `sessions/<дата>-<тема>.md` и скажет, какой файл открыть в Obsidian. Держи терминал и Obsidian рядом: в терминале отвечаешь на вопросы, в Obsidian читаешь урок с отрендеренными формулами и диаграммами.

Дальше по шагам:
0. **Повторение.** Если есть карточки, которым пора, Claude отправит повторить их в Obsidian и проверит, что колода пуста. Потом — короткая разминка по узлам, у которых наступил срок проверки (`Прогресс.base` → «Повторить сегодня»).
1. **Зонд.** Пачки квизов, пока не найдена граница твоих знаний по каждой нужной нити, плюс вопросы о цели.
2. **План.** Разведка темы через researcher, затем подход и карта зависимостей. Обучение начнётся только после твоего «ок».
3. **Обучение.** Узел за узлом: мотивация → объяснение → связь с уже известным → квиз → запись в конспект и карточки.

Перебивать вопросами можно в любой момент. Чтобы продолжить тему в другой день: «продолжим <тема>». Claude прочитает лог и найдёт, где остановились.

## Отличия от оригинала

- **Квизы оценивает сам Claude**, сразу после ответа. В оригинале оценку давало расширение `quiz` мгновенно в интерфейсе.
- **Картинки не проходят визуальную проверку.** Оригинальные субагенты рендерили PNG и смотрели на него; здесь mermaid пишется прямо в лог, а SVG проверяется только арифметикой. Если поставишь `rsvg-convert` или ImageMagick, Claude сможет рендерить и смотреть.
- **Лог пишется хуком после каждого ответа**, а не в реальном времени.
- Researcher работает на Sonnet, чтобы экономить лимиты подписки. Модель меняется в `.claude/agents/researcher.md`.

## Под себя

Скилл `teach` написан под одного ученика — правь его как хочешь. Например, поменяй язык или поведение по умолчанию (сократический или повествовательный режим).

## Лицензия

[MIT](LICENSE) — на код и тексты этого порта. Идеи, структура и тексты оригинала принадлежат автору [amosblomqvist/learn](https://github.com/amosblomqvist/learn); у оригинала лицензии нет.
