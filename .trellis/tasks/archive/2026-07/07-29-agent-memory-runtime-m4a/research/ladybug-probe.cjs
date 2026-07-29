const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  Database,
  Connection,
  VERSION,
  STORAGE_VERSION,
} = require("@ladybugdb/core");

const root = __dirname;
const runId = `run-${process.pid}`;
const dbPath = path.join(root, `${runId}-graph.lbdb`);
const rebuiltPath = path.join(root, `${runId}-graph-rebuilt.lbdb`);
const exportPath = path.join(root, `${runId}-graph-export`);

function query(conn, statement) {
  const started = performance.now();
  const result = conn.querySync(statement);
  const results = Array.isArray(result) ? result : [result];
  const rows = results.map((item) => item.getAllSync());
  for (const item of results) item.close();
  return {
    duration_ms: Number((performance.now() - started).toFixed(3)),
    rows,
  };
}

function digestDirectory(directory) {
  if (fs.statSync(directory).isFile()) {
    const contents = fs.readFileSync(directory);
    return {
      sha256: crypto.createHash("sha256").update(contents).digest("hex"),
      files: 1,
      bytes: contents.length,
    };
  }
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(absolute);
      }
    }
  };
  visit(directory);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(directory, file));
    hash.update(fs.readFileSync(file));
  }
  return {
    sha256: hash.digest("hex"),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
  };
}

const database = new Database(dbPath);
const connection = new Connection(database);
connection.setQueryTimeout(250);

const schema = query(
  connection,
  `
    CREATE NODE TABLE Revision(
      revision_id STRING PRIMARY KEY,
      principal_id STRING,
      scope_kind STRING,
      scope_id STRING,
      valid_from TIMESTAMP,
      valid_to TIMESTAMP,
      lifecycle STRING,
      evidence_path STRING
    );
    CREATE REL TABLE Link(
      FROM Revision TO Revision,
      relation_id STRING,
      relation_type STRING,
      valid_from TIMESTAMP,
      valid_to TIMESTAMP
    );
  `,
);

const seed = query(
  connection,
  `
    CREATE (:Revision {
      revision_id: 'r1', principal_id: 'p1', scope_kind: 'topic',
      scope_id: 's1', valid_from: TIMESTAMP('2026-01-01T00:00:00Z'),
      valid_to: NULL, lifecycle: 'active', evidence_path: 'evidence/r1'
    });
    CREATE (:Revision {
      revision_id: 'r2', principal_id: 'p1', scope_kind: 'topic',
      scope_id: 's1', valid_from: TIMESTAMP('2026-01-02T00:00:00Z'),
      valid_to: NULL, lifecycle: 'active', evidence_path: 'evidence/r2'
    });
    CREATE (:Revision {
      revision_id: 'r3', principal_id: 'p1', scope_kind: 'topic',
      scope_id: 's1', valid_from: TIMESTAMP('2026-01-03T00:00:00Z'),
      valid_to: NULL, lifecycle: 'active', evidence_path: 'evidence/r3'
    });
    CREATE (:Revision {
      revision_id: 'r4', principal_id: 'p1', scope_kind: 'topic',
      scope_id: 'other', valid_from: TIMESTAMP('2026-01-04T00:00:00Z'),
      valid_to: NULL, lifecycle: 'active', evidence_path: 'evidence/r4'
    });
    MATCH (a:Revision), (b:Revision)
      WHERE a.revision_id = 'r1' AND b.revision_id = 'r2'
      CREATE (a)-[:Link {
        relation_id: 'e1', relation_type: 'supports',
        valid_from: TIMESTAMP('2026-01-05T00:00:00Z'), valid_to: NULL
      }]->(b);
    MATCH (a:Revision), (b:Revision)
      WHERE a.revision_id = 'r2' AND b.revision_id = 'r3'
      CREATE (a)-[:Link {
        relation_id: 'e2', relation_type: 'depends_on',
        valid_from: TIMESTAMP('2026-01-06T00:00:00Z'), valid_to: NULL
      }]->(b);
    MATCH (a:Revision), (b:Revision)
      WHERE a.revision_id = 'r3' AND b.revision_id = 'r4'
      CREATE (a)-[:Link {
        relation_id: 'e3', relation_type: 'applies_to_scenario',
        valid_from: TIMESTAMP('2026-01-07T00:00:00Z'), valid_to: NULL
      }]->(b);
  `,
);

const boundedPath = query(
  connection,
  `
    MATCH (a:Revision)-[rels:Link*1..3]->(b:Revision)
    WHERE a.revision_id = 'r1'
      AND b.principal_id = 'p1'
      AND b.scope_kind = 'topic'
      AND b.scope_id = 's1'
      AND b.lifecycle = 'active'
      AND b.valid_from <= TIMESTAMP('2026-07-29T00:00:00Z')
      AND (b.valid_to IS NULL OR b.valid_to > TIMESTAMP('2026-07-29T00:00:00Z'))
    RETURN DISTINCT b.revision_id AS revision_id, length(rels) AS depth
    ORDER BY depth, revision_id;
  `,
);

const deleteResult = query(
  connection,
  `
    MATCH ()-[r:Link]->()
    WHERE r.relation_id = 'e2'
    DELETE r;
    MATCH (a:Revision)-[rels:Link*1..3]->(b:Revision)
    WHERE a.revision_id = 'r1'
    RETURN DISTINCT b.revision_id AS revision_id, length(rels) AS depth
    ORDER BY depth, revision_id;
  `,
);

const transactionRollback = query(
  connection,
  `
    BEGIN TRANSACTION;
    CREATE (:Revision {
      revision_id: 'rollback-only', principal_id: 'p1',
      scope_kind: 'topic', scope_id: 's1',
      valid_from: TIMESTAMP('2026-07-29T00:00:00Z'),
      valid_to: NULL, lifecycle: 'active',
      evidence_path: 'evidence/rollback-only'
    });
    ROLLBACK;
    MATCH (n:Revision)
    WHERE n.revision_id = 'rollback-only'
    RETURN count(n) AS count;
  `,
);

const exportResult = query(
  connection,
  `EXPORT DATABASE '${exportPath.replaceAll("'", "''")}';`,
);
connection.closeSync();
database.closeSync();

const reopenedDatabase = new Database(dbPath);
const reopenedConnection = new Connection(reopenedDatabase);
const reopened = query(
  reopenedConnection,
  `
    MATCH (n:Revision)
    RETURN n.revision_id AS revision_id, n.scope_id AS scope_id
    ORDER BY revision_id;
    MATCH (a:Revision)-[r:Link]->(b:Revision)
    RETURN a.revision_id AS source_revision_id,
           r.relation_id AS relation_id,
           b.revision_id AS target_revision_id
    ORDER BY relation_id;
  `,
);
reopenedConnection.closeSync();
reopenedDatabase.closeSync();

const rebuiltDatabase = new Database(rebuiltPath);
const rebuiltConnection = new Connection(rebuiltDatabase);
const importResult = query(
  rebuiltConnection,
  `IMPORT DATABASE '${exportPath.replaceAll("'", "''")}';`,
);
const rebuilt = query(
  rebuiltConnection,
  `
    MATCH (n:Revision)
    RETURN n.revision_id AS revision_id, n.scope_id AS scope_id
    ORDER BY revision_id;
    MATCH (a:Revision)-[r:Link]->(b:Revision)
    RETURN a.revision_id AS source_revision_id,
           r.relation_id AS relation_id,
           b.revision_id AS target_revision_id
    ORDER BY relation_id;
  `,
);
rebuiltConnection.closeSync();
rebuiltDatabase.closeSync();

const binary = path.join(
  path.dirname(require.resolve("@ladybugdb/core")),
  "lbugjs.node",
);
const result = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  package_version: VERSION,
  storage_version: STORAGE_VERSION,
  native_binary: {
    path: binary,
    bytes: fs.statSync(binary).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  },
  schema,
  seed,
  bounded_path: boundedPath,
  after_relation_delete: deleteResult,
  transaction_rollback: transactionRollback,
  export_result: exportResult,
  reopen_result: reopened,
  import_result: importResult,
  rebuilt_result: rebuilt,
  source_database: digestDirectory(dbPath),
  rebuilt_database: digestDirectory(rebuiltPath),
  logical_rebuild_equal:
    JSON.stringify(reopened.rows) === JSON.stringify(rebuilt.rows),
};

console.log(JSON.stringify(result, null, 2));
