# Agreement with reference labels

Reference: `eval/gold_labels.json` (33 DEV chats × 8 criteria). Accuracy = exact match of the answer (yes/no/N/A/scale step).

## local:Qwen3.5-35B-A3B-GPTQ-Int4

- dialogues: 33, labels: 264, **overall accuracy 81.8%**
- by language: EN 77.5%, KZ 86.1%, RU 82.1%
- total score mean abs. error: 8.89 points
- N/A precision 1.0, recall 0.66
- gross errors: found 4, missed 0, false alarms 0
- binary errors: false pass 9, false fail 2 (of 112)
- evidence valid on first pass: 0.883; flagged for review: 0.008
- cost: $0 for 65 dialogues (≈ $0.0 per dialogue, 186 calls)

| criterion | n | accuracy | kappa | main confusions (gold→model) |
|---|---|---|---|---|
| c1 Установление контакта | 33 | 100% | 1.0 |  |
| c2 Выявление потребности | 33 | 61% | 0.378 | na→yes×10, na→no×2, yes→no×1 |
| c3 Идентификация | 33 | 88% | 0.664 | na→no×3, na→yes×1 |
| c4 Корректная и полная консультация | 33 | 82% | 0.393 | 10→5×1, 10→20×1, 5→10×1, 10→15×1 |
| c5 Эмпатия и клиентоориентированность | 33 | 94% | 0.633 | no→yes×1, yes→no×1 |
| c6 Управление диалогом, скорость и грамотность | 33 | 61% | 0.103 | 4→7×4, 7→10×3, 10→7×3, 10→0×1 |
| c7 Завершение | 33 | 70% | 0.402 | no→yes×8, na→no×2 |
| c8 Грубые ошибки | 33 | 100% | 1.0 |  |
