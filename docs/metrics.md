# Agreement with reference labels

Reference: `eval/gold_labels.json` (33 DEV chats × 8 criteria). Accuracy = exact match of the answer (yes/no/N/A/scale step).

## local:Qwen3.5-35B-A3B-GPTQ-Int4

- dialogues: 33, labels: 264, **overall accuracy 86.0%**
- by language: EN 83.8%, KZ 88.9%, RU 85.7%
- total score mean abs. error: 10.62 points
- N/A precision 1.0, recall 0.811
- gross errors: found 4, missed 0, false alarms 0
- binary errors: false pass 11, false fail 3 (of 112)
- evidence valid on first pass: 0.864; flagged for review: 0.004
- cost: $0 for 65 dialogues (≈ $0.0 per dialogue, 495 calls)

| criterion | n | accuracy | kappa | main confusions (gold→model) |
|---|---|---|---|---|
| c1 Установление контакта | 33 | 100% | 1.0 |  |
| c2 Выявление потребности | 33 | 79% | 0.613 | na→yes×7 |
| c3 Идентификация | 33 | 94% | 0.807 | na→no×2 |
| c4 Корректная и полная консультация | 33 | 82% | 0.34 | 10→20×2, 10→5×1, 5→10×1, 15→20×1 |
| c5 Эмпатия и клиентоориентированность | 33 | 88% | 0.436 | yes→no×3, no→yes×1 |
| c6 Управление диалогом, скорость и грамотность | 33 | 79% | 0.449 | 7→10×3, 4→7×2, 10→0×2 |
| c7 Завершение | 33 | 67% | 0.403 | no→yes×10, na→no×1 |
| c8 Грубые ошибки | 33 | 100% | 1.0 |  |
