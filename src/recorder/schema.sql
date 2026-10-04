-- Observer v1 设计草案；尚未作为应用 migration 发布。
-- 时间为毫秒；cursor 在 JSON 中编码为十进制字符串。
PRAGMA foreign_keys = ON;

CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  pi_session_id TEXT,
  source_file TEXT,
  cwd TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE producers (
  producer_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  last_acked_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_acked_seq >= 0),
  state TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE payloads (
  payload_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','truncated')),
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX payload_hash ON payloads(sha256, byte_length);
CREATE TABLE payload_chunks (
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
  part INTEGER NOT NULL CHECK(part >= 0),
  bytes BLOB NOT NULL,
  PRIMARY KEY(payload_id, part)
);
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  producer_id TEXT NOT NULL REFERENCES producers(producer_id),
  producer_seq INTEGER NOT NULL CHECK(producer_seq > 0),
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  wall_ms INTEGER NOT NULL,
  mono_ms REAL,
  clock_id TEXT,
  received_at INTEGER NOT NULL,
  refs_json TEXT NOT NULL,
  fact_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(producer_id, producer_seq)
);
CREATE INDEX events_session_cursor ON events(session_key, cursor);
CREATE INDEX events_session_kind_cursor ON events(session_key, kind, cursor);
CREATE TABLE event_payloads (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
  PRIMARY KEY(event_id, payload_id)
);
CREATE TABLE source_entries (
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  entry_id TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  parent_entry_id TEXT,
  entry_type TEXT NOT NULL,
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
  first_event_cursor INTEGER NOT NULL REFERENCES events(cursor),
  PRIMARY KEY(session_key, entry_id, revision_hash)
);
-- 下列两表是可重建的当前投影，不可直接用于历史游标展示。
CREATE TABLE source_bindings (
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  entry_id TEXT NOT NULL,
  canonical_span_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  last_event_cursor INTEGER NOT NULL REFERENCES events(cursor),
  PRIMARY KEY(session_key, entry_id)
);
CREATE TABLE session_projections (
  session_key TEXT PRIMARY KEY REFERENCES sessions(session_key),
  reducer_version INTEGER NOT NULL,
  through_cursor INTEGER NOT NULL REFERENCES events(cursor),
  state_json TEXT NOT NULL
);
