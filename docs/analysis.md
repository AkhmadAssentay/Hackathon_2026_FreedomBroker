# Analysis: confidence intervals, error analysis, calibration

| system | accuracy all 44 (95% CI) | held-out test (95% CI) | total MAE |
|---|---|---|---|
| Маршрутизатор (рабочий прогон) | 89.5% (85.2%–93.8%) | 89.2% (83.8%–93.8%) | 6.96 |
| Claude Sonnet 5.5 | 86.9% (83.0%–90.6%) | 87.5% (83.3%–91.7%) | 8.88 |
| Qwen × 5 голосов | 85.2% (80.4%–89.8%) | 84.2% (77.9%–90.0%) | 7.23 |
| Qwen (один ответ) | 83.2% (78.1%–88.1%) | 80.4% (73.8%–86.2%) | 7.85 |
| Claude Haiku 5.5 | 74.7% (71.0%–78.4%) | 73.3% (68.3%–77.9%) | 12.26 |

McNemar router vs Sonnet (paired labels): router right & Sonnet wrong 23, the reverse 14, p = 0.1877

## Remaining errors of the production router: 37 of 352 labels
- by criterion: c6 12, c4 12, c5 5, c7 4, c2 3, c1 1
- top confusions (gold→model): c4: 15→20 ×4, c6: 7→10 ×3, c5: no→yes ×3, c7: yes→no ×3, c5: yes→no ×2, c2: na→no ×2, c6: 4→10 ×2, c4: 20→10 ×2
- scale errors one step off: c6 8/12, c4 7/12
- error rate by slice: EN 7.3%, KZ 11.5%, RU 8.1%, звонки 33.3%

## RULERS-style calibration of scale criteria (fit on dev, applied on test)
- Claude Sonnet 5.5: test 0.875 → 0.8958, MAE 7.8 → 6.06; mapping {'c4': {'0': '0', '5': '20', '10': '20', '15': '20', '20': '20'}, 'c6': {'0': '0', '4': '7', '7': '10', '10': '10'}}
- Qwen × 5 голосов: test 0.8417 → 0.8292, MAE 7.35 → 8.55; mapping {'c4': {'0': '0', '5': '5', '10': '10', '15': '15', '20': '20'}, 'c6': {'0': '0', '4': '4', '7': '10', '10': '10'}}
- Маршрутизатор (рабочий прогон): test 0.8917 → 0.8708, MAE 7.07 → 7.33; mapping {'c4': {'0': '10', '5': '10', '10': '10', '15': '15', '20': '20'}, 'c6': {'0': '0', '4': '4', '7': '10', '10': '10'}}

## Conformal Trust-or-Escalate on the production router (threshold fit on dev, 90% confidence)
- target 90%: threshold 0.8, test auto-accepted 0.808 with accuracy 0.9278, to human 46
- target 93%: threshold 1.0, test auto-accepted 0.767 with accuracy 0.9402, to human 56
- target 95%: threshold None, test auto-accepted None with accuracy None, to human None

## Verifier-weighted self-consistency (c4-c6 from 8 Qwen samples, rest Sonnet)
- majority (8 votes): test 0.9167, all 0.9375, MAE 3.66
- verifier-weighted: test 0.9167, all 0.9375, MAE 3.66
- verifier × confidence: test 0.9167, all 0.9375, MAE 3.66
- first 5 votes: test 0.9167, all 0.9375, MAE 3.66

## Question-coverage decomposition for consultation
- {'c4_all_before': 0.705, 'c4_all_after': 0.682, 'c4_test_before': 0.7, 'c4_test_after': 0.6, 'router_all_before': 0.9062, 'router_all_after': 0.8864}
