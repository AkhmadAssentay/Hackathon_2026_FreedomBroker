# Agreement with reference labels

Reference: `eval/gold_labels.json` (44 DEV dialogues × 8 criteria: 41 chats + 3 calls; two independent labelings agree 91.7% on their overlap). Accuracy = exact match of the answer (yes/no/N/A/scale step).

## local:Qwen3.5-35B-A3B-GPTQ-Int4

- dialogues: 44, labels: 352, **overall accuracy 83.2%**
- by language: CALL 50.0%, EN 85.4%, KZ 85.4%, RU 86.0%
- total score mean abs. error: 7.85 points
- N/A precision 1.0, recall 0.697
- gross errors: found 6, missed 1, false alarms 0
- binary errors: false pass 15, false fail 3 (of 154)
- evidence valid on first pass: 0.852; flagged for review: 0.0
- cost: $0 for 65 dialogues (≈ $0.0 per dialogue, 614 calls)

| criterion | n | accuracy | kappa | main confusions (gold→model) |
|---|---|---|---|---|
| c1 Установление контакта | 44 | 96% | 0.645 | no→yes×2 |
| c2 Выявление потребности | 44 | 68% | 0.5 | na→yes×11, na→no×3 |
| c3 Идентификация | 44 | 91% | 0.784 | na→no×2, na→yes×1, no→yes×1 |
| c4 Корректная и полная консультация | 44 | 77% | 0.463 | 15→20×4, 10→15×2, 5→10×2, 20→15×1 |
| c5 Эмпатия и клиентоориентированность | 44 | 96% | 0.83 | yes→no×1, no→yes×1 |
| c6 Управление диалогом, скорость и грамотность | 44 | 77% | 0.538 | 4→7×5, 7→10×2, 10→0×2, 7→4×1 |
| c7 Завершение | 44 | 64% | 0.275 | no→yes×11, na→no×3, yes→no×2 |
| c8 Грубые ошибки | 44 | 98% | 0.91 | yes→no×1 |
