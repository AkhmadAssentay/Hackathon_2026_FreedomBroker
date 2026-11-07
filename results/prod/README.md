# PROD results

`results.json` here will hold the evaluation of the organizers' control (test) dataset, which is released 23 hours after the start. It has the same format as `results/dev/results.json`.

How to fill it once the control `group_id` is announced:

1. On the site (https://cqa-freedom.vercel.app): «Диалоги» → enter the control `group_id` → «Загрузить из API», then «Оценить все».
2. Export the results:

```bash
node alt/node-prototype/scripts/export_results.js --api https://cqa-freedom.vercel.app --group <control group_id> --out results/prod/results.json
```

3. Commit and push `results/prod/results.json`.
