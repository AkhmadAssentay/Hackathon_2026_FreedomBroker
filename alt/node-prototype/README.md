# CQA — Conversation Quality Analytics

Prototype for the **Freedom Broker CQA Hackathon (Datathon Fall 2026)**.
The system evaluates an operator's work in chats and calls against a configurable checklist,
shows points, explanations and the evidence messages, and supports appeal → reviewer decision → recalculated total.

## Quick start

Requirements: **Node.js 18+**. There are no npm dependencies, so no `npm install` is needed.

```bash
git clone https://github.com/AkhmadAssentay/cqa-freedom.git
cd cqa-freedom
cp .env.example .env      # add one LLM key (see below)
npm start                 # → http://localhost:3000
npm test                  # unit tests for the scoring engine
```

Open http://localhost:3000. Then:

1. **Диалоги** → set the `group_id` (default `DEV`) → **Загрузить из API**. You can also upload the JSON response as a file. A small `SAMPLE` set is bundled for offline demo.
2. Click **Оценить все** to evaluate the whole set, or open one dialog and click **Оценить**.
3. Click an evidence chip to jump to the message. For calls, it also seeks the audio player to that moment.
4. Click **Оспорить** on a criterion to file an appeal. In **Апелляции** the reviewer sees the disputed score, the comment and the dialog fragment, then confirms or changes the score. The total is recalculated.
5. **Чек-листы**: edit, add or remove criteria, weights, the answer type (Да/Нет, scale, flag), N/A availability and scale steps. Every save creates a new version and makes it active. Re-evaluate to apply it.

## LLM

**Default setup for the demo: Qwen 2.5 7B running locally through Ollama.** It is free (cost of one evaluation: $0) and needs no internet. Tested on a MacBook Air M4 with 16 GB RAM.

```bash
brew install ollama
OLLAMA_CONTEXT_LENGTH=16384 ollama serve     # keep this running; 16K context fits the longest calls
ollama pull qwen2.5:7b                       # ~4.7 GB, once
```

`.env`:

```
LLM_PROVIDER=openai
LLM_MODEL=qwen2.5:7b
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
EVAL_CONCURRENCY=1
LLM_TIMEOUT_MS=300000
```

`OLLAMA_CONTEXT_LENGTH` matters: Ollama's default context is smaller than a long call transcript plus the checklist, and it would silently cut the prompt.

A local model only works when the app runs on the same machine (`npm start`). A static deploy (e.g. Vercel) serves only the UI and has no backend or model, so run the demo locally.

Cloud alternatives: set one key in `.env`. The provider is auto-detected from the key:

| Provider | Key | Default model (`LLM_MODEL` to override) |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI / any OpenAI-compatible (Ollama, vLLM) | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | `gpt-4.1-mini` |
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| none | — | heuristic rules mode (approximate, for offline demo) |

One evaluation = **one LLM call** for all criteria, about 3–6k input tokens and under 1.5k output tokens.
Set `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` to see the exact cost of each evaluation and batch in the UI.

## Measuring quality against human labels

`gold/` holds a 20-dialog gold set from DEV (7 RU, 5 KZ, 5 EN chats and 3 calls) for the team to label by hand, plus a report script:

```bash
npm run gold
```

It compares the model's original answers with the human labels and reports, per criterion and per language: agreement, Cohen's kappa, **false "No"** (the model penalised the operator where a human said "Yes"), **false "Yes"** (a missed problem), N/A mistakes, and the average gap in the total score. See `gold/README.md` for how to label.

How the evaluation is made reliable on a small local model (details and measurements in `gold/RESULTS.md`):

- **Explicit evaluation plans**: each criterion's description is a step-by-step check, not a one-line rule.
- **Code checks for crisp rules**: greeting in the client's language, operator name, goodbye and "client left early" are detected in code (RU/KZ/EN); the model only answers what needs understanding.
- **Sub-questions with locked rules** (`lib/checks.js`) where they measurably helped (identification, closing): the model answers yes/no sub-questions and the criterion's answer is computed by a fixed rule. Editing or replacing a criterion in the UI switches its sub-questions off, so a new criterion is evaluated from its new wording.
- **Grounded evidence**: quotes are checked against the transcript, and a "yes" about an operator action must cite an operator message.
- **Call structure from system events**: while the client is on hold, the operator's talk with a colleague is marked internal and not evaluated.
- **Second opinion** (optional, `JURY_MODEL`, `JURY_SCOPE`): a model of another family re-evaluates (by default only Kazakh dialogs); disagreements are flagged "проверить" for a human reviewer without changing the score.

## How scoring works

The LLM **only returns verdicts** (yes / no / na / scale step + explanation + quotes). All arithmetic is done
deterministically in `lib/scoring.js`, exactly as the checklist PDF prescribes:

1. N/A is accepted only where the criterion allows it. Otherwise it is coerced and a warning is shown.
2. Да = full weight, Нет = 0. A scale step is converted proportionally, so the top step gives the full weight.
3. N/A criteria are excluded and their weight is redistributed proportionally, so the maximum stays 100.
4. The total is rounded to 2 digits. If no weighted criterion is applicable, the total is not calculated.
5. Gross errors are a separate flag without points.

Other safeguards:
- **Evidence verification**: every quote returned by the model is matched against the transcript. A wrong index is corrected; a quote that cannot be found is marked as unverified.
- **Deterministic facts** (time to first response, pauses over the threshold, suspicious "pay me personally / give me your number" phrases) are computed in code and given to the model as hints and cross-checks.
- The **prompt is built from the checklist config**, so a new or replaced criterion works without code changes.
- Bot and system messages are passed to the model as context only.

## Project structure

```
server.js            HTTP API + static files (no dependencies)
lib/scoring.js       weights, scales, N/A redistribution, rounding, sections
lib/prompt.js        prompt generated from the checklist config
lib/llm.js           Anthropic / OpenAI / Gemini adapters, JSON parsing, retries
lib/evaluator.js     orchestration + evidence verification
lib/rules.js         deterministic signals + heuristic fallback
lib/transcript.js    timestamps (chat MM:SS, call ISO 8601), timing facts
lib/store.js         JSON-file storage (data/), replaceable by Dataverse/SQL
checklists/default.json   initial checklist from the PDF
public/              UI: plain HTML/CSS/JS, mounts into #cqa-root
test/                scoring tests (node --test)
```

### Dynamics 365
The UI is plain HTML/CSS/JS with no build step. It mounts into a single `#cqa-root` element, and all styles are scoped under `.cqa`.
To embed it as an HTML web resource, upload `index.html`, `styles.css` and `app.js` and set `data-api-base` on the root to the evaluation service URL. CORS is enabled on the API.

## API (short)

| Method | Path | |
|---|---|---|
| POST | `/api/datasets/fetch` `{group_id}` | load a set from the organizers' API |
| POST | `/api/datasets/upload` `{group_id, payload}` | load a set from JSON |
| GET | `/api/conversations?group_id=` | list with latest scores |
| POST | `/api/evaluate` `{conversation_id, checklist_uid?}` | evaluate one dialog |
| POST | `/api/evaluate-batch` `{group_id, only_missing?}` → GET `/api/jobs/:id` | batch evaluation |
| GET/POST | `/api/checklists` | list / save a new version |
| POST | `/api/appeals` `{evaluation_id, criterion_id, comment}` | file an appeal |
| POST | `/api/appeals/:id/decision` `{action: confirm\|change, answer, reason}` | reviewer decision |
| GET | `/api/export?group_id=` | final results as JSON |

## Read-only web demo (Vercel)

Static hosting has no backend, so the UI falls back to a saved snapshot of evaluated results and shows a "view only" banner; evaluating, appeals and checklist edits need the local server.

```bash
npm start                                   # local server with evaluated results
node scripts/export_snapshot.js --group DEV # writes public/snapshot.json (voice calls excluded)
```

Voice calls are real customer conversations and are left out by default; `--include-calls` adds them. The repository root `vercel.json` publishes `alt/node-prototype/public`, and Vercel redeploys on every push to `main`.
