# DEV results

`results.json` — evaluation of all 65 DEV dialogs (60 chats, 5 calls) with the checklist, exported from the online app (Vercel + MongoDB).

- `summary`: averages, dialogs with gross errors, dialogs changed by appeals, models used, total cost.
- `dialogs[].result`: the online evaluation.
  - `total_ai` is the model's score; `total_final` includes reviewers' appeal decisions.
  - `criteria[]`: per criterion, the model's answer (`answer_ai`) and the final one (`answer_final`), points after N/A redistribution, explanation, and evidence quotes with message numbers.
  - `appeals[]`: appeals and decisions.
- `dialogs[].local_comparison`: the same dialog evaluated locally by Qwen 2.5 7B (answers only).
- Models: free-tier Groq limits switch between `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b` (see `summary.models_used` and each `result.model`).
- Call recording links are not included.

Regenerate:

```bash
node alt/node-prototype/scripts/export_results.js --api https://cqa-freedom.vercel.app --group DEV --out results/dev/results.json
```
