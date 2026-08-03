# fixtures/replay/manifest.json:1

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `frozen replay manifest`
- Why: The frozen corpus already separates calibration, holdout, and transfer risks for normal preference, conflict, correction, privacy, temporal, deletion, injection, multi-hop, projection failure, negative transfer, and policy exclusion.

````json
     1  {
     2    "corpus_version": "1.0.0",
     3    "fixture_schema_version": "1.0.0",
     4    "frozen_at": "2026-07-28T13:00:00.000Z",
     5    "hash_algorithm": "sha256-canonical-json-v1",
     6    "cases": [
     7      {
     8        "case_id": "cal_normal_preference",
     9        "partition": "calibration",
    10        "risk_family": "normal",
    11        "requirement_anchors": ["R7", "R10", "R11", "AE1"],
    12        "body_file": "calibration/normal-preference.json",
    13        "content_hash": "sha256:79a9da05cf8203bfe9fd7eb9e38428bbfa29d8f6e93ca9e5a746136dc46d43f2"
    14      },
    15      {
    16        "case_id": "cal_conflict_supersession",
    17        "partition": "calibration",
    18        "risk_family": "conflict",
    19        "requirement_anchors": ["R12", "R14", "AE2"],
    20        "body_file": "calibration/conflict-supersession.json",
    21        "content_hash": "sha256:a2c326551bf3803149ea2e7f67a3d5bf57fcc6fb038acefaea2fd979aa4c5205"
    22      },
    23      {
    24        "case_id": "cal_correction_lineage",
    25        "partition": "calibration",
    26        "risk_family": "correction",
    27        "requirement_anchors": ["R8", "R14", "R15", "AE4"],
    28        "body_file": "calibration/correction-lineage.json",
    29        "content_hash": "sha256:60925368f038c8ca9cd8d4b8c2e4108e8ae2b33fe23c7a161a0fa92e923aa4fe"
    30      },
    31      {
    32        "case_id": "cal_privacy_scope",
    33        "partition": "calibration",
    34        "risk_family": "privacy",
    35        "requirement_anchors": ["R2", "R10", "R18", "AE8"],
    36        "body_file": "calibration/privacy-scope.json",
    37        "content_hash": "sha256:fd6c6be68b785cea81de51e0a635b2ea99affcae883c8e48a237eb9ef307f6cb"
    38      },
    39      {
    40        "case_id": "cal_temporal_validity",
    41        "partition": "calibration",
    42        "risk_family": "temporal",
    43        "requirement_anchors": ["R7", "R10", "R12"],
    44        "body_file": "calibration/temporal-validity.json",
    45        "content_hash": "sha256:ff136748b2f521353eaf1171418314b733846ecc09d98ff657790f457649c7cd"
    46      },
    47      {
    48        "case_id": "hold_deletion_no_resurrection",
    49        "partition": "holdout",
    50        "risk_family": "deletion",
    51        "requirement_anchors": ["R14", "R15", "R20", "AE4", "AE8"],
    52        "body_file": "holdout/deletion-no-resurrection.json",
    53        "content_hash": "sha256:85cd8dcc0a61c38ada4e7864fab41496310626967df77f341243b905f909a5fa"
    54      },
    55      {
    56        "case_id": "hold_persisted_prompt_injection",
    57        "partition": "holdout",
    58        "risk_family": "prompt_injection",
    59        "requirement_anchors": ["R6", "R12", "R18", "R20"],
    60        "body_file": "holdout/persisted-prompt-injection.json",
    61        "content_hash": "sha256:1ef790619c11066f48c95d3c5f3816c3d848f267142f91b81658e1fdb86072fb"
    62      },
    63      {
    64        "case_id": "hold_multi_hop_lineage",
    65        "partition": "holdout",
    66        "risk_family": "multi_hop",
    67        "requirement_anchors": ["R8", "R10", "R11", "R20"],
    68        "body_file": "holdout/multi-hop-lineage.json",
    69        "content_hash": "sha256:0dc00c5f8519d8762185489f4f9e04dded29621ab39174bbedc5ce368fc44624"
    70      },
    71      {
    72        "case_id": "hold_projection_failure",
    73        "partition": "holdout",
    74        "risk_family": "failure",
    75        "requirement_anchors": ["R9", "R13", "R19", "AE3", "AE5"],
    76        "body_file": "holdout/projection-failure.json",
    77        "content_hash": "sha256:53831dedc37ad41c8e4115d289c31a081a3da4bd727cca0916db1055ff27b538"
    78      },
    79      {
    80        "case_id": "transfer_negative_transfer",
    81        "partition": "transfer",
    82        "risk_family": "negative_transfer",
    83        "requirement_anchors": ["R17", "R18", "R20", "AE6"],
    84        "body_file": "transfer/negative-transfer.json",
    85        "content_hash": "sha256:e29916fde800922a1daf72e04c11c3b8840ff58f61db80c34e49e62974b218a5"
    86      },
    87      {
    88        "case_id": "transfer_policy_exclusion",
    89        "partition": "transfer",
    90        "risk_family": "privacy",
    91        "requirement_anchors": ["R10", "R12", "R13", "AE5"],
    92        "body_file": "transfer/policy-exclusion.json",
    93        "content_hash": "sha256:fa213848817f7adbbde9daf74aaf6623c7ab27ec142d1dde806c9b8242148d18"
    94      }
    95    ]
````
