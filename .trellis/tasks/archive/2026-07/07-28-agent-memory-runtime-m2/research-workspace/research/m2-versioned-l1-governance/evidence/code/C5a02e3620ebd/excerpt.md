# migrations/0003-recall-context.sql:1

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `recall_context_tables`
- Why: M1 已持久化 Context 和 retrieval receipt 且附加 append-only triggers，M2 删除必须显式处理派生物

````text
     1  CREATE TABLE recall_requests (
     2    request_id TEXT PRIMARY KEY,
     3    principal_id TEXT NOT NULL,
     4    request_hash TEXT NOT NULL,
     5    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
     6    created_at TEXT NOT NULL
     7  ) STRICT;
     8  
     9  CREATE TABLE context_slices (
    10    context_slice_id TEXT PRIMARY KEY,
    11    request_id TEXT NOT NULL UNIQUE REFERENCES recall_requests(request_id),
    12    compiler_version TEXT NOT NULL,
    13    token_budget INTEGER NOT NULL CHECK (token_budget > 0),
    14    token_used INTEGER NOT NULL CHECK (token_used >= 0 AND token_used <= token_budget),
    15    frozen_hash TEXT NOT NULL UNIQUE,
    16    slice_json TEXT NOT NULL CHECK (json_valid(slice_json)),
    17    created_at TEXT NOT NULL
    18  ) STRICT;
    19  
    20  CREATE TABLE context_slice_items (
    21    context_slice_id TEXT NOT NULL REFERENCES context_slices(context_slice_id),
    22    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    23    memory_id TEXT NOT NULL,
    24    revision_id TEXT NOT NULL,
    25    item_json TEXT NOT NULL CHECK (json_valid(item_json)),
    26    PRIMARY KEY (context_slice_id, ordinal),
    27    UNIQUE (context_slice_id, memory_id, revision_id)
    28  ) STRICT;
    29  
    30  CREATE TABLE context_slice_item_evidence (
    31    context_slice_id TEXT NOT NULL,
    32    ordinal INTEGER NOT NULL,
    33    evidence_id TEXT NOT NULL REFERENCES evidence_events(evidence_id),
    34    PRIMARY KEY (context_slice_id, ordinal, evidence_id),
    35    FOREIGN KEY (context_slice_id, ordinal)
    36      REFERENCES context_slice_items(context_slice_id, ordinal)
    37  ) STRICT;
    38  
    39  CREATE TABLE retrieval_receipts (
    40    receipt_id TEXT PRIMARY KEY,
    41    request_id TEXT NOT NULL UNIQUE REFERENCES recall_requests(request_id),
    42    context_slice_id TEXT REFERENCES context_slices(context_slice_id),
    43    request_hash TEXT NOT NULL,
    44    receipt_hash TEXT NOT NULL UNIQUE,
    45    state TEXT NOT NULL,
    46    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    47    created_at TEXT NOT NULL
    48  ) STRICT;
    49  
    50  CREATE INDEX retrieval_receipts_context_slice_id
    51    ON retrieval_receipts (context_slice_id);
    52  
    53  CREATE TABLE receipt_access_scopes (
    54    receipt_id TEXT NOT NULL,
    55    receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('mutation', 'retrieval')),
    56    principal_id TEXT NOT NULL,
    57    scope_kind TEXT NOT NULL,
    58    scope_id TEXT NOT NULL,
    59    created_at TEXT NOT NULL,
    60    PRIMARY KEY (
    61      receipt_id, receipt_kind, principal_id, scope_kind, scope_id
    62    )
    63  ) STRICT;
    64  
    65  CREATE INDEX receipt_access_principal_scope
    66    ON receipt_access_scopes (
    67      principal_id, scope_kind, scope_id, receipt_id
    68    );
    69  
    70  CREATE TRIGGER recall_requests_no_update
    71  BEFORE UPDATE ON recall_requests BEGIN
    72    SELECT RAISE(ABORT, 'APPEND_ONLY:recall_requests');
    73  END;
    74  
    75  CREATE TRIGGER recall_requests_no_delete
    76  BEFORE DELETE ON recall_requests BEGIN
    77    SELECT RAISE(ABORT, 'APPEND_ONLY:recall_requests');
    78  END;
    79  
    80  CREATE TRIGGER context_slices_no_update
    81  BEFORE UPDATE ON context_slices BEGIN
    82    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
    83  END;
    84  
    85  CREATE TRIGGER context_slices_no_delete
    86  BEFORE DELETE ON context_slices BEGIN
    87    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
    88  END;
    89  
    90  CREATE TRIGGER context_slice_items_no_update
    91  BEFORE UPDATE ON context_slice_items BEGIN
    92    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
    93  END;
    94  
    95  CREATE TRIGGER context_slice_items_no_delete
    96  BEFORE DELETE ON context_slice_items BEGIN
    97    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
    98  END;
    99  
   100  CREATE TRIGGER context_slice_item_evidence_no_update
   101  BEFORE UPDATE ON context_slice_item_evidence BEGIN
   102    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_item_evidence');
   103  END;
   104  
   105  CREATE TRIGGER context_slice_item_evidence_no_delete
   106  BEFORE DELETE ON context_slice_item_evidence BEGIN
   107    SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_item_evidence');
   108  END;
   109  
   110  CREATE TRIGGER retrieval_receipts_no_update
   111  BEFORE UPDATE ON retrieval_receipts BEGIN
   112    SELECT RAISE(ABORT, 'APPEND_ONLY:retrieval_receipts');
   113  END;
   114  
   115  CREATE TRIGGER retrieval_receipts_no_delete
   116  BEFORE DELETE ON retrieval_receipts BEGIN
   117    SELECT RAISE(ABORT, 'APPEND_ONLY:retrieval_receipts');
````
