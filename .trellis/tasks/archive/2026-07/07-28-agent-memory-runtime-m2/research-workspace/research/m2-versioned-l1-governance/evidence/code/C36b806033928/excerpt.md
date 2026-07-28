# migrations/0001-evidence-ledger.sql:1

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `evidence_ledger_control_tables`
- Why: M1 权威账本已有 append-only evidence、idempotency、outbox 和 backup manifest 基础表

````text
     1  CREATE TABLE ledger_state (
     2    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     3    ledger_epoch INTEGER NOT NULL DEFAULT 0 CHECK (ledger_epoch >= 0),
     4    created_at TEXT NOT NULL,
     5    updated_at TEXT NOT NULL
     6  ) STRICT;
     7  
     8  INSERT INTO ledger_state (singleton, ledger_epoch, created_at, updated_at)
     9  VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    10  
    11  CREATE TABLE artifacts (
    12    content_hash TEXT PRIMARY KEY
    13      CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
    14    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    15    media_type TEXT NOT NULL,
    16    relative_path TEXT NOT NULL UNIQUE,
    17    created_at TEXT NOT NULL
    18  ) STRICT;
    19  
    20  CREATE TABLE evidence_events (
    21    evidence_id TEXT PRIMARY KEY,
    22    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    23    occurred_at TEXT NOT NULL,
    24    recorded_at TEXT NOT NULL,
    25    scope_kind TEXT NOT NULL
    26      CHECK (scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')),
    27    scope_id TEXT NOT NULL,
    28    principal_id TEXT NOT NULL,
    29    actor_authority TEXT NOT NULL,
    30    source TEXT NOT NULL
    31      CHECK (source IN ('conversation_turn', 'tool_result', 'artifact', 'user_feedback', 'evaluation', 'import')),
    32    authority TEXT NOT NULL,
    33    sensitivity TEXT NOT NULL,
    34    payload_storage TEXT NOT NULL CHECK (payload_storage IN ('inline', 'blob')),
    35    payload_inline TEXT,
    36    payload_blob_hash TEXT REFERENCES artifacts(content_hash),
    37    media_type TEXT NOT NULL,
    38    content_hash TEXT NOT NULL
    39      CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
    40    schema_version TEXT NOT NULL,
    41    CHECK (
    42      (payload_storage = 'inline' AND payload_inline IS NOT NULL AND payload_blob_hash IS NULL)
    43      OR
    44      (payload_storage = 'blob' AND payload_inline IS NULL AND payload_blob_hash IS NOT NULL)
    45    )
    46  ) STRICT;
    47  
    48  CREATE INDEX evidence_events_scope_occurred_at
    49    ON evidence_events (scope_kind, scope_id, occurred_at DESC);
    50  CREATE INDEX evidence_events_content_hash
    51    ON evidence_events (content_hash);
    52  
    53  CREATE TABLE episodes (
    54    episode_id TEXT PRIMARY KEY,
    55    scope_kind TEXT NOT NULL,
    56    scope_id TEXT NOT NULL,
    57    started_at TEXT NOT NULL,
    58    ended_at TEXT NOT NULL,
    59    outcome TEXT NOT NULL
    60      CHECK (outcome IN ('succeeded', 'failed', 'partial', 'abandoned')),
    61    artifact_hashes_json TEXT NOT NULL CHECK (json_valid(artifact_hashes_json)),
    62    sealed_hash TEXT NOT NULL UNIQUE
    63      CHECK (length(sealed_hash) = 71 AND sealed_hash GLOB 'sha256:[0-9a-f]*'),
    64    schema_version TEXT NOT NULL
    65  ) STRICT;
    66  
    67  CREATE TABLE episode_events (
    68    episode_id TEXT NOT NULL REFERENCES episodes(episode_id),
    69    evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_events(evidence_id),
    70    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    71    PRIMARY KEY (episode_id, ordinal),
    72    UNIQUE (episode_id, evidence_id)
    73  ) STRICT;
    74  
    75  CREATE TABLE mutation_receipts (
    76    receipt_id TEXT PRIMARY KEY,
    77    idempotency_key TEXT NOT NULL UNIQUE,
    78    request_hash TEXT NOT NULL,
    79    receipt_hash TEXT NOT NULL UNIQUE,
    80    state TEXT NOT NULL,
    81    resulting_epoch INTEGER NOT NULL CHECK (resulting_epoch >= 0),
    82    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    83    created_at TEXT NOT NULL
    84  ) STRICT;
    85  
    86  CREATE TABLE idempotency_keys (
    87    idempotency_key TEXT PRIMARY KEY,
    88    request_hash TEXT NOT NULL,
    89    receipt_id TEXT NOT NULL UNIQUE REFERENCES mutation_receipts(receipt_id),
    90    created_at TEXT NOT NULL
    91  ) STRICT;
    92  
    93  CREATE TABLE outbox_jobs (
    94    job_id TEXT PRIMARY KEY,
    95    kind TEXT NOT NULL,
    96    aggregate_id TEXT NOT NULL,
    97    status TEXT NOT NULL DEFAULT 'pending'
    98      CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    99    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
   100    available_at TEXT NOT NULL,
   101    created_at TEXT NOT NULL,
   102    processed_at TEXT,
   103    last_error_code TEXT
   104  ) STRICT;
   105  
   106  CREATE INDEX outbox_jobs_status_available_at
   107    ON outbox_jobs (status, available_at, job_id);
   108  
   109  CREATE TABLE backup_manifests (
   110    backup_id TEXT PRIMARY KEY,
   111    relative_path TEXT NOT NULL UNIQUE,
   112    created_at TEXT NOT NULL,
   113    ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
   114    latest_receipt_hash TEXT,
   115    migration_hashes_json TEXT NOT NULL CHECK (json_valid(migration_hashes_json)),
   116    blob_hashes_json TEXT NOT NULL CHECK (json_valid(blob_hashes_json)),
   117    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
   118    integrity_check TEXT NOT NULL
   119  ) STRICT;
   120  
````
