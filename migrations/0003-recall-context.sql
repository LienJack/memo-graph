CREATE TABLE recall_requests (
  request_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_slices (
  context_slice_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES recall_requests(request_id),
  compiler_version TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  token_used INTEGER NOT NULL CHECK (token_used >= 0 AND token_used <= token_budget),
  frozen_hash TEXT NOT NULL UNIQUE,
  slice_json TEXT NOT NULL CHECK (json_valid(slice_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_slice_items (
  context_slice_id TEXT NOT NULL REFERENCES context_slices(context_slice_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  PRIMARY KEY (context_slice_id, ordinal),
  UNIQUE (context_slice_id, memory_id, revision_id)
) STRICT;

CREATE TABLE context_slice_item_evidence (
  context_slice_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES evidence_events(evidence_id),
  PRIMARY KEY (context_slice_id, ordinal, evidence_id),
  FOREIGN KEY (context_slice_id, ordinal)
    REFERENCES context_slice_items(context_slice_id, ordinal)
) STRICT;

CREATE TABLE retrieval_receipts (
  receipt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES recall_requests(request_id),
  context_slice_id TEXT REFERENCES context_slices(context_slice_id),
  request_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX retrieval_receipts_context_slice_id
  ON retrieval_receipts (context_slice_id);

CREATE TABLE receipt_access_scopes (
  receipt_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('mutation', 'retrieval')),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    receipt_id, receipt_kind, principal_id, scope_kind, scope_id
  )
) STRICT;

CREATE INDEX receipt_access_principal_scope
  ON receipt_access_scopes (
    principal_id, scope_kind, scope_id, receipt_id
  );

CREATE TRIGGER recall_requests_no_update
BEFORE UPDATE ON recall_requests BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recall_requests');
END;

CREATE TRIGGER recall_requests_no_delete
BEFORE DELETE ON recall_requests BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recall_requests');
END;

CREATE TRIGGER context_slices_no_update
BEFORE UPDATE ON context_slices BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
END;

CREATE TRIGGER context_slices_no_delete
BEFORE DELETE ON context_slices BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
END;

CREATE TRIGGER context_slice_items_no_update
BEFORE UPDATE ON context_slice_items BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
END;

CREATE TRIGGER context_slice_items_no_delete
BEFORE DELETE ON context_slice_items BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
END;

CREATE TRIGGER context_slice_item_evidence_no_update
BEFORE UPDATE ON context_slice_item_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_item_evidence');
END;

CREATE TRIGGER context_slice_item_evidence_no_delete
BEFORE DELETE ON context_slice_item_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_item_evidence');
END;

CREATE TRIGGER retrieval_receipts_no_update
BEFORE UPDATE ON retrieval_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:retrieval_receipts');
END;

CREATE TRIGGER retrieval_receipts_no_delete
BEFORE DELETE ON retrieval_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:retrieval_receipts');
END;

CREATE TRIGGER receipt_access_scopes_no_update
BEFORE UPDATE ON receipt_access_scopes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:receipt_access_scopes');
END;

CREATE TRIGGER receipt_access_scopes_no_delete
BEFORE DELETE ON receipt_access_scopes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:receipt_access_scopes');
END;
