# Agreement with reference labels

Reference: `eval/gold_labels.json` (44 DEV dialogues × 8 criteria: 41 chats + 3 calls; two independent labelings agree 91.7% on their overlap). Accuracy = exact match of the answer (yes/no/N/A/scale step).

## router(claude-sonnet-5-5, local:Qwen3.5-35B-A3B-GPTQ-Int4@sc5)

- dialogues: 44, labels: 352, **overall accuracy 89.5%**
- by language: CALL 66.7%, EN 92.7%, KZ 88.5%, RU 91.9%
- total score mean abs. error: 6.96 points
- N/A precision 1.0, recall 0.939
- gross errors: found 7, missed 0, false alarms 0
- binary errors: false pass 4, false fail 5 (of 154)
- evidence valid on first pass: 0.946; flagged for review: 0.017
- cost: $0 for 0 dialogues (≈ $None per dialogue, 0 calls)

| criterion | n | accuracy | kappa | main confusions (gold→model) |
|---|---|---|---|---|
| c1 Установление контакта | 44 | 98% | 0.845 | no→yes×1 |
| c2 Выявление потребности | 44 | 93% | 0.871 | na→no×2, na→yes×1 |
| c3 Идентификация | 44 | 100% | 1.0 |  |
| c4 Корректная и полная консультация | 44 | 73% | 0.378 | 15→20×4, 20→10×2, 5→10×2, 10→20×2 |
| c5 Эмпатия и клиентоориентированность | 44 | 89% | 0.549 | no→yes×3, yes→no×2 |
| c6 Управление диалогом, скорость и грамотность | 44 | 73% | 0.417 | 7→10×3, 4→10×2, 4→7×2, 10→4×1 |
| c7 Завершение | 44 | 91% | 0.773 | yes→no×3, na→no×1 |
| c8 Грубые ошибки | 44 | 100% | 1.0 |  |

## claude-sonnet-5-5

- dialogues: 44, labels: 352, **overall accuracy 86.9%**
- by language: CALL 75.0%, EN 92.7%, KZ 85.4%, RU 86.0%
- total score mean abs. error: 8.88 points
- N/A precision 1.0, recall 0.939
- gross errors: found 7, missed 0, false alarms 0
- binary errors: false pass 1, false fail 9 (of 154)
- evidence valid on first pass: 0.943; flagged for review: 0.011
- cost: $1.4294 for 65 dialogues (≈ $0.022 per dialogue, 113 calls)

| criterion | n | accuracy | kappa | main confusions (gold→model) |
|---|---|---|---|---|
| c1 Установление контакта | 44 | 98% | 0.845 | no→yes×1 |
| c2 Выявление потребности | 44 | 93% | 0.871 | na→no×2, na→yes×1 |
| c3 Идентификация | 44 | 100% | 1.0 |  |
| c4 Корректная и полная консультация | 44 | 66% | 0.486 | 20→15×12, 15→10×1, 20→5×1, 10→5×1 |
| c5 Эмпатия и клиентоориентированность | 44 | 86% | 0.622 | yes→no×6 |
| c6 Управление диалогом, скорость и грамотность | 44 | 61% | 0.379 | 10→7×10, 7→4×4, 4→7×1, 4→0×1 |
| c7 Завершение | 44 | 91% | 0.773 | yes→no×3, na→no×1 |
| c8 Грубые ошибки | 44 | 100% | 1.0 |  |

## local:Qwen3.5-35B-A3B-GPTQ-Int4

- dialogues: 44, labels: 352, **overall accuracy 83.2%**
- by language: CALL 50.0%, EN 85.4%, KZ 85.4%, RU 86.0%
- total score mean abs. error: 7.85 points
- N/A precision 1.0, recall 0.697
- gross errors: found 6, missed 1, false alarms 0
- binary errors: false pass 15, false fail 3 (of 154)
- evidence valid on first pass: 0.852; flagged for review: 0.0
- cost: $0 for 65 dialogues (≈ $0.0 per dialogue, 720 calls)

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
