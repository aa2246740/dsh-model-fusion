# SWE-rebench results (25 graded attempts, 0 infrastructure errors, 7 contaminated and excluded)

| condition | easy resolved | medium resolved | hard resolved | total resolved | total $ | median $/attempt | median minutes | timeouts |
|---|---|---|---|---|---|---|---|---|
| D_F | 1/2 | 2/3 | 0/0 | 3/5 | 6.33 | 1.131 | 4.2 | 0 |
| D_X | 1/2 | 2/3 | 0/0 | 3/5 | 11.14 | 1.816 | 5.3 | 0 |
| S_F | 2/2 | 2/2 | 0/3 | 4/7 | 4.96 | 0.707 | 13.6 | 0 |
| S_X | 1/2 | 2/3 | 2/3 | 5/8 | 19.21 | 2.465 | 6.0 | 0 |

## Paired cost ratio vs S_X (same task and repetition)

| condition | tier | median cost ratio | pairs |
|---|---|---|---|
| D_F | easy | 0.54 | 2 |
| D_F | medium | 0.51 | 3 |
| D_F | all | 0.51 | 5 |
| D_X | easy | 0.93 | 2 |
| D_X | medium | 0.83 | 3 |
| D_X | all | 0.87 | 5 |
| S_F | easy | 0.31 | 2 |
| S_F | medium | 0.28 | 2 |
| S_F | hard | 0.36 | 3 |
| S_F | all | 0.32 | 7 |

## Per attempt

| task | tier | condition | rep | resolved | F2P | P2P | $ | min | lead calls | worker calls | cache% | tools/turn | multiCmd | delegations | lead refused |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| delgan__loguru-1451 | easy | D_F | 1 | yes | 2/2 | 22/22 | 1.125 | 4.0 | 12 | 11 | 93 | 1.13 | 14 | 2 |  |
| delgan__loguru-1451 | easy | D_X | 1 | yes | 2/2 | 22/22 | 1.678 | 5.3 | 17 | 0 | 100 | 1.471 | 13 | 0 |  |
| delgan__loguru-1451 | easy | S_F | 1 | yes | 2/2 | 22/22 | 0.707 | 13.6 | 12 | 23 | 91 | 1.265 | 12 | 2 | 0 |
| delgan__loguru-1451 | easy | S_X | 1 | yes | 2/2 | 22/22 | 1.710 | 5.9 | 25 | 0 | 94 |  |  | 0 | 0 |
| sqlfluff__sqlfluff-7615 | easy | D_F | 1 | no | 0/1 | 24/24 | 1.714 | 13.3 | 15 | 25 | 83 | 0.975 | 31 | 1 |  |
| sqlfluff__sqlfluff-7615 | easy | D_X | 1 | no | 0/1 | 24/24 | 3.523 | 8.7 | 22 | 0 | 94 | 1.455 | 22 | 0 |  |
| sqlfluff__sqlfluff-7615 | easy | S_F | 1 | yes | 1/1 | 24/24 | 0.842 | 30.0 | 10 | 116 | 95 | 1.128 | 87 | 1 | 0 |
| sqlfluff__sqlfluff-7615 | easy | S_X | 1 | no | 0/1 | 24/24 | 4.040 | 7.5 | 34 | 0 | 95 |  |  | 0 | 0 |
| holoviz__param-1117 | medium | D_F | 1 | yes | 2/2 | 94/94 | 1.131 | 4.2 | 10 | 8 | 95 | 0.944 | 12 | 1 |  |
| holoviz__param-1117 | medium | D_X | 1 | yes | 2/2 | 94/94 | 1.816 | 4.0 | 15 | 0 | 100 | 1.533 | 16 | 0 |  |
| holoviz__param-1117 | medium | S_F | 1 | yes | 2/2 | 94/94 | 0.753 | 34.1 | 10 | 106 | 96 | 1.113 | 65 | 1 | 0 |
| holoviz__param-1117 | medium | S_X | 1 | yes | 2/2 | 94/94 | 3.016 | 6.8 | 37 | 0 | 96 |  |  | 0 | 0 |
| pycqa__isort-2491 | medium | D_F | 1 | no | 0/1 | 73/73 | 1.519 | 8.6 | 13 | 36 | 90 | 1.02 | 33 | 2 |  |
| pycqa__isort-2491 | medium | D_X | 1 | no | 0/1 | 73/73 | 3.015 | 7.5 | 25 | 0 | 100 | 1.8 | 28 | 0 |  |
| pycqa__isort-2491 | medium | S_X | 1 | no | 0/1 | 73/73 | 2.967 | 7.4 | 39 | 0 | 96 |  |  | 0 | 0 |
| ucfopen__canvasapi-716 | medium | D_F | 1 | yes | 2/2 | 60/60 | 0.845 | 2.7 | 8 | 14 | 89 | 1.227 | 16 | 1 |  |
| ucfopen__canvasapi-716 | medium | D_X | 1 | yes | 2/2 | 60/60 | 1.111 | 2.4 | 13 | 0 | 100 | 1.538 | 13 | 0 |  |
| ucfopen__canvasapi-716 | medium | S_F | 1 | yes | 2/2 | 60/60 | 0.427 | 2.9 | 7 | 13 | 77 | 1.474 | 5 | 1 | 0 |
| ucfopen__canvasapi-716 | medium | S_X | 1 | yes | 2/2 | 60/60 | 1.344 | 3.1 | 18 | 0 | 90 |  |  | 0 | 0 |
| pallets-eco__wtforms-892_interface | hard | S_F | 1 | no | 9/10 | 0/0 | 0.429 | 2.7 | 6 | 18 | 81 | 2.0 | 7 | 1 | 0 |
| pallets-eco__wtforms-892_interface | hard | S_X | 1 | no | 9/10 | 0/0 | 1.204 | 3.9 | 17 | 0 | 93 |  |  | 0 | 0 |
| pallets__click-3239 | hard | S_F | 1 | no | 4/4 | 693/694 | 0.664 | 13.2 | 12 | 38 | 87 | 1.224 | 13 | 2 | 0 |
| pallets__click-3239 | hard | S_X | 1 | yes | 4/4 | 694/694 | 2.620 | 4.9 | 33 | 0 | 90 |  |  | 0 | 0 |
| python-scim__scim2-models-139_interface | hard | S_F | 1 | no | 6/9 | 0/0 | 1.133 | 24.1 | 13 | 88 | 96 | 1.35 | 40 | 1 | 0 |
| python-scim__scim2-models-139_interface | hard | S_X | 1 | yes | 9/9 | 0/0 | 2.309 | 6.0 | 24 | 0 | 93 |  |  | 0 | 0 |

## Contaminated attempts (excluded above)

- pycqa__isort-2491|S_F|1: fetch; resolved=False
- pallets__click-3239|D_X|1: workspace; resolved=True
- pallets__click-3239|D_F|1: workspace; resolved=True
- python-scim__scim2-models-139_interface|D_F|1: workspace; resolved=True
- python-scim__scim2-models-139_interface|D_X|1: workspace; resolved=True
- pallets-eco__wtforms-892_interface|D_X|1: workspace; resolved=True
- pallets-eco__wtforms-892_interface|D_F|1: workspace; resolved=True

## Tasks clean in every condition (4): delgan__loguru-1451, holoviz__param-1117, sqlfluff__sqlfluff-7615, ucfopen__canvasapi-716

| condition | resolved | total $ | mean minutes |
|---|---|---|---|
| D_F | 3/4 | 4.81 | 6.0 |
| D_X | 3/4 | 8.13 | 5.1 |
| S_F | 4/4 | 2.73 | 20.1 |
| S_X | 3/4 | 10.11 | 5.8 |
