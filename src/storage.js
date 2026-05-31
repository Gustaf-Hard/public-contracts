import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  kommun_kod TEXT NOT NULL,
  kommun_namn TEXT NOT NULL,
  role TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  scheduled_send_at TEXT NOT NULL,
  gmail_thread_id TEXT,
  state TEXT NOT NULL DEFAULT 'INITIAL',
  state_changed_at TEXT NOT NULL,
  last_outbound_at TEXT,
  arendenummer TEXT,
  followup_count INTEGER NOT NULL DEFAULT 0,
  receipt_sent INTEGER NOT NULL DEFAULT 0,
  follow_up_at TEXT,
  notes TEXT,
  UNIQUE(kommun_kod, role)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  gmail_message_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  classification TEXT,
  classification_confidence REAL,
  received_at TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  signature_extracted TEXT,
  analysis_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  saved_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  message_id INTEGER REFERENCES messages(id),
  reason TEXT NOT NULL,
  draft_template TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  slack_ts TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  resolved_text TEXT,
  classifier_class TEXT,
  classifier_confidence REAL,
  previous_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  escalation_id INTEGER NOT NULL REFERENCES escalations(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  conversation_state TEXT NOT NULL,
  classifier_class TEXT,
  classifier_confidence REAL,
  draft_template TEXT,
  draft_body TEXT NOT NULL,
  decision TEXT NOT NULL,
  final_body TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_class_state ON decisions(classifier_class, conversation_state, decision);

CREATE TABLE IF NOT EXISTS daemon_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at TEXT,
  last_followup_at TEXT,
  tick_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT OR IGNORE INTO daemon_heartbeat (id, tick_count) VALUES (1, 0);
`;

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function migrate() {
    db.exec(SCHEMA);
    // Idempotent ALTERs for databases created before these columns existed.
    // SQLite has no IF NOT EXISTS for ADD COLUMN, so we probe with PRAGMA.
    const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((r) => r.name);
    if (!convCols.includes('follow_up_at')) {
      db.exec('ALTER TABLE conversations ADD COLUMN follow_up_at TEXT');
    }
    const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((r) => r.name);
    if (!msgCols.includes('analysis_json')) {
      db.exec('ALTER TABLE messages ADD COLUMN analysis_json TEXT');
    }
  }

  function createConversation({ kommun_kod, kommun_namn, role, contact_email, scheduled_send_at }) {
    const stmt = db.prepare(`
      INSERT INTO conversations (kommun_kod, kommun_namn, role, contact_email, scheduled_send_at, state_changed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const result = stmt.run(kommun_kod, kommun_namn, role, contact_email, scheduled_send_at);
    return Number(result.lastInsertRowid);
  }

  function getConversation(id) {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  function listConversationsByState(state) {
    return db.prepare('SELECT * FROM conversations WHERE state = ? ORDER BY id').all(state);
  }

  function listAllConversations() {
    return db.prepare('SELECT * FROM conversations ORDER BY id').all();
  }

  function listConversationsDueForInitialSend(nowIso) {
    return db.prepare(`
      SELECT * FROM conversations
      WHERE state = 'INITIAL' AND scheduled_send_at <= ?
      ORDER BY scheduled_send_at, id
    `).all(nowIso);
  }

  function updateConversationState(id, state, patch = {}) {
    const allowed = ['gmail_thread_id', 'last_outbound_at', 'arendenummer', 'notes', 'followup_count', 'receipt_sent', 'follow_up_at'];
    const sets = ["state = ?", "state_changed_at = datetime('now')"];
    const values = [state];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        values.push(patch[k]);
      }
    }
    values.push(id);
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  function recordMessage(m) {
    const stmt = db.prepare(`
      INSERT INTO messages (
        conversation_id, gmail_message_id, direction, from_email, to_email,
        subject, body_text, classification, classification_confidence,
        received_at, attachment_count, signature_extracted, analysis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const sigJson = m.signature_extracted
      ? (typeof m.signature_extracted === 'string' ? m.signature_extracted : JSON.stringify(m.signature_extracted))
      : null;
    const analysisJson = m.analysis_json
      ? (typeof m.analysis_json === 'string' ? m.analysis_json : JSON.stringify(m.analysis_json))
      : null;
    const r = stmt.run(
      m.conversation_id, m.gmail_message_id, m.direction, m.from_email, m.to_email,
      m.subject, m.body_text, m.classification, m.classification_confidence,
      m.received_at, m.attachment_count, sigJson, analysisJson
    );
    return Number(r.lastInsertRowid);
  }

  function listMessages(conversationId) {
    return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id').all(conversationId);
  }

  function hasGmailMessageId(gmailMessageId) {
    return !!db.prepare('SELECT 1 FROM messages WHERE gmail_message_id = ?').get(gmailMessageId);
  }

  function recordAttachment(a) {
    const r = db.prepare(`
      INSERT INTO attachments (message_id, filename, saved_path, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(a.message_id, a.filename, a.saved_path, a.mime_type, a.size_bytes);
    return Number(r.lastInsertRowid);
  }

  function recordEscalation(e) {
    const r = db.prepare(`
      INSERT INTO escalations (conversation_id, message_id, reason, draft_template, draft_subject, draft_body, slack_ts, classifier_class, classifier_confidence, previous_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.conversation_id, e.message_id ?? null, e.reason,
      e.draft_template ?? null, e.draft_subject ?? null, e.draft_body ?? null,
      e.slack_ts ?? null,
      e.classifier_class ?? null, e.classifier_confidence ?? null, e.previous_state ?? null
    );
    return Number(r.lastInsertRowid);
  }

  function recordDecision(d) {
    const r = db.prepare(`
      INSERT INTO decisions (
        escalation_id, conversation_id, conversation_state,
        classifier_class, classifier_confidence,
        draft_template, draft_body, decision, final_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.escalation_id, d.conversation_id, d.conversation_state,
      d.classifier_class ?? null, d.classifier_confidence ?? null,
      d.draft_template ?? null, d.draft_body, d.decision, d.final_body ?? null
    );
    return Number(r.lastInsertRowid);
  }

  function listDecisions() {
    return db.prepare('SELECT * FROM decisions ORDER BY id').all();
  }

  function listOpenEscalations() {
    return db.prepare("SELECT * FROM escalations WHERE status = 'open' ORDER BY id").all();
  }

  function getEscalationBySlackTs(ts) {
    return db.prepare('SELECT * FROM escalations WHERE slack_ts = ?').get(ts);
  }

  function resolveEscalation(id, { status, resolved_text = null }) {
    db.prepare(`
      UPDATE escalations
      SET status = ?, resolved_text = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(status, resolved_text, id);
  }

  function recordHeartbeat({ kind = 'tick', error = null } = {}) {
    const col = kind === 'followup' ? 'last_followup_at' : 'last_tick_at';
    db.prepare(`
      UPDATE daemon_heartbeat
      SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          tick_count = tick_count + 1,
          last_error = ?
      WHERE id = 1
    `).run(error);
  }

  function getHeartbeat() {
    return db.prepare('SELECT * FROM daemon_heartbeat WHERE id = 1').get() ?? null;
  }

  function close() {
    db.close();
  }

  return {
    raw: db,
    migrate,
    createConversation,
    getConversation,
    listConversationsByState,
    listAllConversations,
    listConversationsDueForInitialSend,
    updateConversationState,
    recordMessage,
    listMessages,
    hasGmailMessageId,
    recordAttachment,
    recordEscalation,
    listOpenEscalations,
    getEscalationBySlackTs,
    resolveEscalation,
    recordDecision,
    listDecisions,
    recordHeartbeat,
    getHeartbeat,
    close,
  };
}
