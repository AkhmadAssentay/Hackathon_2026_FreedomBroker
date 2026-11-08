# Experiments: judging strategies vs reference labels

Selection on `dev`, reported on `test` (deterministic split of 44 reference dialogues). Accuracy = exact match of the answer over 8 criteria.

| variant | dev acc | test acc | all acc | KZ | RU | EN | CALL | total MAE | gross tp/fn/fp | $ / dialogue |
|---|---|---|---|---|---|---|---|---|---|---|
| router_sonnet_qwensc5 | 0.9196 | 0.9083 | 0.9119 | 0.927 | 0.949 | 0.917 | 0.625 | 4.66 | 7/0/0 | 0.01502 |
| router_sonnet_qwensc5_haiku | 0.9286 | 0.9083 | 0.9148 | 0.927 | 0.949 | 0.917 | 0.667 | 4.43 | 7/0/0 | 0.01458 |
| router_prod_qwen3crit | 0.9107 | 0.9042 | 0.9062 | 0.927 | 0.934 | 0.906 | 0.667 | 5.32 | 7/0/0 | 0.01807 |
| cascade_qwen_sub_sc5_to_sonnet@1.0 | 0.9018 | 0.9 | 0.9006 | 0.906 | 0.926 | 0.927 | 0.625 | 6.39 | 7/0/0 | 0.01203 |
| router_qwen8crit_sc9 | 0.9196 | 0.8958 | 0.9034 | 0.927 | 0.934 | 0.906 | 0.625 | 5.78 | 7/0/0 | 0.01807 |
| router_sonnet_qwen | 0.9554 | 0.8958 | 0.9148 | 0.938 | 0.941 | 0.927 | 0.625 | 4.66 | 7/0/0 | 0.01502 |
| router_all | 0.9464 | 0.8958 | 0.9119 | 0.948 | 0.926 | 0.917 | 0.667 | 4.89 | 7/0/0 | 0.01458 |
| router_median_scales | 0.9196 | 0.8917 | 0.9006 | 0.896 | 0.934 | 0.906 | 0.708 | 5.01 | 7/0/0 | 0.01807 |
| cascade_qwen_sc5_to_sonnet@0.8 | 0.9018 | 0.8917 | 0.8949 | 0.896 | 0.941 | 0.906 | 0.583 | 6.16 | 7/0/0 | 0.01117 |
| router_qwen3crit_sc9 | 0.9018 | 0.8875 | 0.892 | 0.896 | 0.919 | 0.906 | 0.667 | 7.11 | 7/0/0 | 0.01807 |
| cascade_qwen_sc5_to_sonnet@1.0 | 0.8839 | 0.8875 | 0.8864 | 0.885 | 0.926 | 0.906 | 0.583 | 7.01 | 7/0/0 | 0.01143 |
| app:claude-sonnet-5-5 | 0.8571 | 0.875 | 0.8693 | 0.854 | 0.86 | 0.927 | 0.75 | 8.88 | 7/0/0 | 0.01807 |
| cascade_qwen_sub_sc5_to_sonnet@0.8 | 0.9107 | 0.875 | 0.8864 | 0.906 | 0.897 | 0.917 | 0.625 | 6.7 | 7/0/0 | 0.01156 |
| cascade_qwen_sub_sc5_to_sonnet@0.6 | 0.9196 | 0.8625 | 0.8807 | 0.917 | 0.89 | 0.906 | 0.583 | 6.85 | 7/0/0 | 0.01083 |
| cascade_qwen_sc5_to_sonnet@0.6 | 0.8929 | 0.8542 | 0.8665 | 0.875 | 0.904 | 0.885 | 0.542 | 6.48 | 7/0/0 | 0.01077 |
| router_cheap | 0.9196 | 0.85 | 0.8722 | 0.885 | 0.897 | 0.885 | 0.625 | 6.38 | 6/1/0 | 0.00073 |
| jury_sonnet_haiku_sub_qwen_sub | 0.8571 | 0.85 | 0.8523 | 0.823 | 0.868 | 0.885 | 0.75 | 10.4 | 7/0/0 | 0.01927 |
| router_free_local | 0.9464 | 0.8458 | 0.8778 | 0.896 | 0.919 | 0.885 | 0.542 | 6.22 | 6/1/0 | 0.0 |
| jury_sonnet_qwen_haiku | 0.8482 | 0.8458 | 0.8466 | 0.812 | 0.838 | 0.917 | 0.75 | 8.16 | 6/1/0 | 0.01902 |
| qwen_sc5 | 0.875 | 0.8417 | 0.8523 | 0.844 | 0.904 | 0.875 | 0.5 | 7.23 | 6/1/0 | 0.0 |
| qwen_gloss | 0.8571 | 0.8375 | 0.8438 | 0.865 | 0.868 | 0.875 | 0.5 | 8.02 | 6/1/1 | 0.0 |
| qwen_sc9 | 0.8571 | 0.8292 | 0.8381 | 0.854 | 0.868 | 0.865 | 0.5 | 8.29 | 6/1/0 | 0.0 |
| qwen_sub | 0.8571 | 0.8042 | 0.821 | 0.844 | 0.86 | 0.823 | 0.5 | 12.13 | 6/1/0 | 0.0 |
| app:local:Qwen3.5-35B-A3B-GPTQ-Int4 | 0.8929 | 0.8042 | 0.8324 | 0.854 | 0.86 | 0.854 | 0.5 | 7.85 | 6/1/0 | 0.0 |
| qwen_sub_sc5 | 0.8571 | 0.8 | 0.8182 | 0.854 | 0.86 | 0.792 | 0.542 | 12.66 | 7/0/0 | 0.0 |
| qwen_percrit | 0.8482 | 0.7917 | 0.8097 | 0.865 | 0.831 | 0.792 | 0.542 | 11.18 | 7/0/1 | 0.0 |
| haiku_sub | 0.8036 | 0.775 | 0.7841 | 0.781 | 0.801 | 0.833 | 0.5 | 13.69 | 6/1/0 | 0.0012 |
| haiku | 0.7768 | 0.7333 | 0.7472 | 0.75 | 0.721 | 0.792 | 0.708 | 12.26 | 6/1/0 | 0.00095 |
| gemma | 0.7857 | 0.6917 | 0.7216 | 0.76 | 0.706 | 0.76 | 0.5 | 16.24 | 4/3/0 | 0.0 |

Router choices (criterion -> source, picked on dev):
- app:claude-sonnet-5-5 + qwen_sc5: {'c1': 'app:claude-sonnet-5-5', 'c2': 'app:claude-sonnet-5-5', 'c3': 'app:claude-sonnet-5-5', 'c4': 'qwen_sc5', 'c5': 'qwen_sc5', 'c6': 'qwen_sc5', 'c7': 'app:claude-sonnet-5-5', 'c8': 'app:claude-sonnet-5-5'}
- app:claude-sonnet-5-5 + app:local:Qwen3.5-35B-A3B-GPTQ-Int4: {'c1': 'app:claude-sonnet-5-5', 'c2': 'app:claude-sonnet-5-5', 'c3': 'app:claude-sonnet-5-5', 'c4': 'app:local:Qwen3.5-35B-A3B-GPTQ-Int4', 'c5': 'app:local:Qwen3.5-35B-A3B-GPTQ-Int4', 'c6': 'app:local:Qwen3.5-35B-A3B-GPTQ-Int4', 'c7': 'app:claude-sonnet-5-5', 'c8': 'app:claude-sonnet-5-5'}
- app:claude-sonnet-5-5 + qwen_sc5 + haiku: {'c1': 'haiku', 'c2': 'app:claude-sonnet-5-5', 'c3': 'app:claude-sonnet-5-5', 'c4': 'qwen_sc5', 'c5': 'qwen_sc5', 'c6': 'qwen_sc5', 'c7': 'app:claude-sonnet-5-5', 'c8': 'app:claude-sonnet-5-5'}
- app:claude-sonnet-5-5 + haiku + haiku_sub + qwen_sc5 + qwen_sub_sc5 + qwen + gemma: {'c1': 'haiku', 'c2': 'app:claude-sonnet-5-5', 'c3': 'app:claude-sonnet-5-5', 'c4': 'qwen_sc5', 'c5': 'qwen_sub_sc5', 'c6': 'qwen_sub_sc5', 'c7': 'app:claude-sonnet-5-5', 'c8': 'app:claude-sonnet-5-5'}
- qwen_sc5 + qwen_sub_sc5 + qwen + qwen_percrit + qwen_gloss + gemma + gemma_sc5: {'c1': 'qwen_sc5', 'c2': 'qwen_percrit', 'c3': 'qwen_sub_sc5', 'c4': 'qwen_sc5', 'c5': 'qwen_sub_sc5', 'c6': 'qwen_gloss', 'c7': 'qwen_sub_sc5', 'c8': 'qwen_sc5'}
- haiku + haiku_sub + qwen_sc5 + qwen_sub_sc5 + gemma: {'c1': 'haiku', 'c2': 'qwen_sc5', 'c3': 'haiku', 'c4': 'qwen_sc5', 'c5': 'qwen_sub_sc5', 'c6': 'qwen_sub_sc5', 'c7': 'haiku', 'c8': 'haiku'}
