import Database from 'better-sqlite3';

// Active (non-terminal) escalation statuses — the single source of truth for
// "this conversation already has pending or unresolved outbound work":
//   - open             awaiting a human decision
//   - sending          a Gmail call is in flight right now
//   - send_failed      Gmail threw mid-send — the mail MAY have gone out
//   - send_unconfirmed a 'sending' claim was orphaned by a crash — same risk
// While ANY of these exists, the conversation must not receive a new
// follow-up/precision draft: approving a fresh draft next to an ambiguous
// send is how a kommun gets double-messaged. Everything else (resolved_send,
// resolved_edit, resolved_skip, resolved_closed, superseded) is terminal.
export const ACTIVE_ESCALATION_STATUSES = Object.freeze(['open', 'sending', 'send_failed', 'send_unconfirmed']);

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
  next_review_at TEXT,
  next_review_source TEXT,
  refresh_round INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  gmail_thread_id TEXT NOT NULL,
  counterparty_email TEXT,
  counterparty_name TEXT,
  status TEXT NOT NULL DEFAULT 'neutral',
  status_source TEXT NOT NULL DEFAULT 'auto',
  last_inbound_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, gmail_thread_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_conversation ON threads(conversation_id);

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
  watchlist_vendors TEXT,
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

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name_nocase ON vendors(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  name TEXT NOT NULL,
  UNIQUE(vendor_id, name)
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  attachment_id INTEGER NOT NULL UNIQUE REFERENCES attachments(id),
  vendor_id INTEGER REFERENCES vendors(id),
  avtalsvarde TEXT,
  valuta TEXT,
  period_start TEXT,
  period_end TEXT,
  auto_renews INTEGER,
  renewal_term TEXT,
  last_cancellation_date TEXT,
  extension_option_until TEXT,
  is_contract INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  confidence REAL,
  analysis_json TEXT,
  model TEXT,
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_vendor ON contracts(vendor_id);

CREATE TABLE IF NOT EXISTS contract_products (
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (contract_id, product_id)
);
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
    // Perpetual-refresh arming (2026-07-09 design): distinct from follow_up_at,
    // which the M10 fix clears on terminal states — next_review_at deliberately
    // survives DONE so a closed case can be re-contacted.
    if (!convCols.includes('next_review_at')) {
      db.exec('ALTER TABLE conversations ADD COLUMN next_review_at TEXT');
    }
    if (!convCols.includes('next_review_source')) {
      db.exec('ALTER TABLE conversations ADD COLUMN next_review_source TEXT');
    }
    if (!convCols.includes('refresh_round')) {
      db.exec('ALTER TABLE conversations ADD COLUMN refresh_round INTEGER NOT NULL DEFAULT 0');
    }
    const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((r) => r.name);
    if (!msgCols.includes('analysis_json')) {
      db.exec('ALTER TABLE messages ADD COLUMN analysis_json TEXT');
    }
    if (!msgCols.includes('gmail_thread_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN gmail_thread_id TEXT');
    }
    if (!msgCols.includes('thread_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN thread_id INTEGER');
    }
    const hbCols = db.prepare("PRAGMA table_info(daemon_heartbeat)").all().map((r) => r.name);
    if (!hbCols.includes('last_success_at')) {
      db.exec('ALTER TABLE daemon_heartbeat ADD COLUMN last_success_at TEXT');
    }
    const escCols = db.prepare("PRAGMA table_info(escalations)").all().map((r) => r.name);
    if (!escCols.includes('watchlist_vendors')) {
      db.exec('ALTER TABLE escalations ADD COLUMN watchlist_vendors TEXT');
    }
    // Lifecycle fields for the perpetual-refresh loop (2026-07-09 design §2).
    const contractCols = db.prepare("PRAGMA table_info(contracts)").all().map((r) => r.name);
    if (!contractCols.includes('auto_renews')) {
      db.exec('ALTER TABLE contracts ADD COLUMN auto_renews INTEGER');
    }
    if (!contractCols.includes('renewal_term')) {
      db.exec('ALTER TABLE contracts ADD COLUMN renewal_term TEXT');
    }
    if (!contractCols.includes('last_cancellation_date')) {
      db.exec('ALTER TABLE contracts ADD COLUMN last_cancellation_date TEXT');
    }
    if (!contractCols.includes('extension_option_until')) {
      db.exec('ALTER TABLE contracts ADD COLUMN extension_option_until TEXT');
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
    const allowed = ['gmail_thread_id', 'last_outbound_at', 'arendenummer', 'notes', 'followup_count', 'receipt_sent', 'follow_up_at', 'next_review_at', 'next_review_source', 'refresh_round'];
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
        received_at, attachment_count, signature_extracted, analysis_json,
        gmail_thread_id, thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      m.received_at, m.attachment_count, sigJson, analysisJson,
      m.gmail_thread_id ?? null, m.thread_id ?? null
    );
    return Number(r.lastInsertRowid);
  }

  function listMessages(conversationId) {
    return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id').all(conversationId);
  }

  function hasGmailMessageId(gmailMessageId) {
    return !!db.prepare('SELECT 1 FROM messages WHERE gmail_message_id = ?').get(gmailMessageId);
  }

  function getMessageById(id) {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  function upsertThread({ conversation_id, gmail_thread_id, counterparty_email = null, counterparty_name = null, last_inbound_at = null }) {
    const existing = db.prepare(
      'SELECT * FROM threads WHERE conversation_id = ? AND gmail_thread_id = ?'
    ).get(conversation_id, gmail_thread_id);
    if (existing) {
      db.prepare(`
        UPDATE threads SET
          counterparty_email = COALESCE(?, counterparty_email),
          counterparty_name  = COALESCE(?, counterparty_name),
          last_inbound_at    = COALESCE(?, last_inbound_at)
        WHERE id = ?
      `).run(counterparty_email, counterparty_name, last_inbound_at, existing.id);
      return db.prepare('SELECT * FROM threads WHERE id = ?').get(existing.id);
    }
    const r = db.prepare(`
      INSERT INTO threads (conversation_id, gmail_thread_id, counterparty_email, counterparty_name, last_inbound_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversation_id, gmail_thread_id, counterparty_email, counterparty_name, last_inbound_at);
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  function getThread(conversation_id, gmail_thread_id) {
    return db.prepare('SELECT * FROM threads WHERE conversation_id = ? AND gmail_thread_id = ?')
      .get(conversation_id, gmail_thread_id);
  }

  function getThreadById(id) {
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  }

  function listThreadsForConversation(conversation_id) {
    return db.prepare(
      "SELECT * FROM threads WHERE conversation_id = ? ORDER BY last_inbound_at DESC NULLS LAST, id"
    ).all(conversation_id);
  }

  function setThreadStatus(id, status, source = 'manual') {
    db.prepare('UPDATE threads SET status = ?, status_source = ? WHERE id = ?').run(status, source, id);
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
      INSERT INTO escalations (conversation_id, message_id, reason, draft_template, draft_subject, draft_body, slack_ts, classifier_class, classifier_confidence, previous_state, watchlist_vendors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.conversation_id, e.message_id ?? null, e.reason,
      e.draft_template ?? null, e.draft_subject ?? null, e.draft_body ?? null,
      e.slack_ts ?? null,
      e.classifier_class ?? null, e.classifier_confidence ?? null, e.previous_state ?? null,
      e.watchlist_vendors ?? null
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

  // Atomically resolve an escalation only if it is still open — the same
  // claim pattern as claimEscalationForSending, for skip/close (hardening
  // finding 7). Returns true when this caller performed the resolve (exactly
  // one row moved). Returns false when the escalation was already claimed or
  // resolved elsewhere; the caller must then no-op (and re-read the current
  // status) instead of clobbering the real outcome — e.g. a racing skip
  // overwriting resolved_send with a false skip decision.
  function resolveEscalationIfOpen(id, { status, resolved_text = null }) {
    const r = db.prepare(`
      UPDATE escalations
      SET status = ?, resolved_text = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(status, resolved_text, id);
    return r.changes === 1;
  }

  // Atomically claim an open escalation for sending. Returns true when this
  // caller won the claim (exactly one row moved open → sending); false when the
  // escalation was already resolved, already claimed, or doesn't exist. This is
  // the send-path idempotency guard: every surface (Slack approve, dashboard
  // approve, CLI) must claim before calling Gmail, so a double click, a Slack
  // retry, or two racing processes can never double-send.
  // resolved_at doubles as the claim timestamp while status='sending' so the
  // tick can detect claims orphaned by a crash; it is overwritten on finalize.
  function claimEscalationForSending(id) {
    const r = db.prepare(`
      UPDATE escalations
      SET status = 'sending', resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(id);
    return r.changes === 1;
  }

  function listEscalationsByStatus(status) {
    return db.prepare('SELECT * FROM escalations WHERE status = ? ORDER BY id').all(status);
  }

  function listOpenEscalationsForConversation(conversationId) {
    return db.prepare("SELECT * FROM escalations WHERE conversation_id = ? AND status = 'open' ORDER BY id")
      .all(conversationId);
  }

  const activeStatusPlaceholders = ACTIVE_ESCALATION_STATUSES.map(() => '?').join(', ');

  function listActiveEscalationsForConversation(conversationId) {
    return db.prepare(
      `SELECT * FROM escalations WHERE conversation_id = ? AND status IN (${activeStatusPlaceholders}) ORDER BY id`
    ).all(conversationId, ...ACTIVE_ESCALATION_STATUSES);
  }

  // "Does this conversation already have pending or unresolved outbound
  // work?" — see ACTIVE_ESCALATION_STATUSES. Every guard that decides whether
  // a new follow-up/precision draft may be minted must use this, not a
  // hand-rolled status='open' check (hardening findings 2/3/5-root-cause).
  function hasActiveEscalation(conversationId) {
    return db.prepare(
      `SELECT 1 FROM escalations WHERE conversation_id = ? AND status IN (${activeStatusPlaceholders}) LIMIT 1`
    ).get(conversationId, ...ACTIVE_ESCALATION_STATUSES) != null;
  }

  // Atomically claim a due INITIAL conversation for its T-INITIAL send.
  // Two-phase outbound: the row moves INITIAL → SENDING *before* the Gmail
  // call, so a crash between Gmail accepting and the SENT finalize leaves a
  // SENDING row that is never auto-retried (listConversationsDueForInitialSend
  // only selects INITIAL) — it escalates to a human instead.
  function claimConversationForInitialSend(id) {
    const r = db.prepare(`
      UPDATE conversations
      SET state = 'SENDING', state_changed_at = datetime('now')
      WHERE id = ? AND state = 'INITIAL'
    `).run(id);
    return r.changes === 1;
  }

  // Run fn inside a single SQLite transaction (better-sqlite3 is synchronous,
  // so fn must not await). Used to make per-message ingest atomic.
  function transaction(fn) {
    return db.transaction(fn)();
  }

  function recordHeartbeat({ kind = 'tick', error = null } = {}) {
    const col = kind === 'followup' ? 'last_followup_at' : 'last_tick_at';
    // A clean tick (no error) also stamps last_success_at — that's what the
    // health check keys off, so "up but failing on Gmail" reads as unhealthy.
    const successSet = error == null
      ? ", last_success_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
      : '';
    db.prepare(`
      UPDATE daemon_heartbeat
      SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          tick_count = tick_count + 1,
          last_error = ?${successSet}
      WHERE id = 1
    `).run(error);
  }

  function getHeartbeat() {
    return db.prepare('SELECT * FROM daemon_heartbeat WHERE id = 1').get() ?? null;
  }

  // Pipeline health from the heartbeat row. `stale` is true when no successful
  // tick has ever happened, or the last one is older than thresholdMin.
  function getTickHealth({ now = new Date(), thresholdMin = 60 } = {}) {
    const hb = db.prepare('SELECT * FROM daemon_heartbeat WHERE id = 1').get() ?? null;
    const lastSuccess = hb?.last_success_at ?? null;
    let stale = true;
    if (lastSuccess) {
      const ageMin = (now.getTime() - new Date(lastSuccess).getTime()) / 60000;
      stale = ageMin > thresholdMin;
    }
    return {
      last_tick_at: hb?.last_tick_at ?? null,
      last_success_at: lastSuccess,
      last_error: hb?.last_error ?? null,
      tick_count: hb?.tick_count ?? 0,
      stale,
      ever: !!lastSuccess,
    };
  }

  function close() {
    db.close();
  }

  function slugify(name) {
    return name.toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function upsertVendor(name) {
    const existing = db.prepare('SELECT * FROM vendors WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) return existing;
    let slug = slugify(name) || 'leverantor';
    // Diacritics can fold two distinct names onto one slug — suffix until free.
    let candidate = slug, n = 2;
    while (db.prepare('SELECT 1 FROM vendors WHERE slug = ?').get(candidate)) {
      candidate = `${slug}-${n++}`;
    }
    const r = db.prepare('INSERT INTO vendors (name, slug) VALUES (?, ?)').run(name, candidate);
    return db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  function upsertProduct(vendorId, name) {
    db.prepare('INSERT OR IGNORE INTO products (vendor_id, name) VALUES (?, ?)').run(vendorId, name);
    return db.prepare('SELECT id FROM products WHERE vendor_id = ? AND name = ?').get(vendorId, name).id;
  }

  function recordContract(c) {
    // Re-analysis replaces: clear old row + product links for this attachment.
    const old = db.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(c.attachment_id);
    if (old) {
      db.prepare('DELETE FROM contract_products WHERE contract_id = ?').run(old.id);
      db.prepare('DELETE FROM contracts WHERE id = ?').run(old.id);
    }
    const r = db.prepare(`
      INSERT INTO contracts (attachment_id, vendor_id, avtalsvarde, valuta, period_start, period_end,
                             auto_renews, renewal_term, last_cancellation_date, extension_option_until,
                             is_contract, summary, confidence, analysis_json, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.attachment_id, c.vendor_id ?? null, c.avtalsvarde ?? null, c.valuta ?? null,
      c.period_start ?? null, c.period_end ?? null,
      c.auto_renews == null ? null : (c.auto_renews ? 1 : 0),
      c.renewal_term ?? null, c.last_cancellation_date ?? null, c.extension_option_until ?? null,
      c.is_contract ?? 1,
      c.summary ?? null, c.confidence ?? null,
      c.analysis_json != null ? JSON.stringify(c.analysis_json) : null, c.model ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  function linkContractProduct(contractId, productId) {
    db.prepare('INSERT OR IGNORE INTO contract_products (contract_id, product_id) VALUES (?, ?)').run(contractId, productId);
  }

  function listPendingContractAttachments() {
    return db.prepare(`
      SELECT a.*, conv.kommun_kod, conv.kommun_namn, conv.role
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      JOIN conversations conv ON conv.id = m.conversation_id
      LEFT JOIN contracts c ON c.attachment_id = a.id
      WHERE c.id IS NULL
        AND (a.mime_type = 'application/pdf' OR lower(a.filename) LIKE '%.pdf')
      ORDER BY a.id
    `).all();
  }

  function listContractInfoForMessage(messageId) {
    return db.prepare(`
      SELECT c.is_contract AS is_contract, v.name AS vendor_name, c.analysis_json AS analysis_json
      FROM attachments a
      JOIN contracts c ON c.attachment_id = a.id
      LEFT JOIN vendors v ON v.id = c.vendor_id
      WHERE a.message_id = ?
      ORDER BY a.id
    `).all(messageId);
  }

  function productsForContractIds(ids) {
    if (ids.length === 0) return new Map();
    const rows = db.prepare(`
      SELECT cp.contract_id, p.name FROM contract_products cp
      JOIN products p ON p.id = cp.product_id
      WHERE cp.contract_id IN (${ids.map(() => '?').join(',')})
      ORDER BY p.name
    `).all(...ids);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.contract_id)) map.set(r.contract_id, []);
      map.get(r.contract_id).push(r.name);
    }
    return map;
  }

  function listContractsForVendor(vendorId) {
    const rows = db.prepare(`
      SELECT c.*, a.filename, a.size_bytes, a.id AS attachment_id,
             m.received_at, conv.kommun_namn, conv.kommun_kod
      FROM contracts c
      JOIN attachments a ON a.id = c.attachment_id
      JOIN messages m ON m.id = a.message_id
      JOIN conversations conv ON conv.id = m.conversation_id
      WHERE c.vendor_id = ? AND c.is_contract = 1
      ORDER BY m.received_at DESC
    `).all(vendorId);
    const prodMap = productsForContractIds(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, products: prodMap.get(r.id) ?? [] }));
  }

  // Every stored contract row for a kommun, with the vendor name and the
  // lifecycle fields the refresh arming needs. Used by armRefresh to compute
  // the soonest next_review_date (deduped per vendor, newest-wins).
  function listContractsForKommun(kommunKod) {
    return db.prepare(`
      SELECT c.id, c.vendor_id, v.name AS vendor_name,
             c.period_start, c.period_end, c.is_contract,
             c.auto_renews, c.renewal_term, c.last_cancellation_date, c.extension_option_until,
             m.received_at
      FROM contracts c
      JOIN attachments a ON a.id = c.attachment_id
      JOIN messages m ON m.id = a.message_id
      JOIN conversations conv ON conv.id = m.conversation_id
      LEFT JOIN vendors v ON v.id = c.vendor_id
      WHERE conv.kommun_kod = ?
      ORDER BY m.received_at DESC, c.id DESC
    `).all(kommunKod);
  }

  // DONE conversations armed with a next_review_at at or before `todayIso`.
  // Drives the daily refresh scan.
  function listConversationsDueForRefresh(todayIso) {
    return db.prepare(`
      SELECT * FROM conversations
      WHERE state = 'DONE' AND next_review_at IS NOT NULL AND next_review_at <= ?
      ORDER BY next_review_at, id
    `).all(todayIso);
  }

  function listVendorsOverview() {
    const rows = db.prepare(`
      SELECT v.id, v.name, v.slug,
             COUNT(DISTINCT c.id) AS contract_count,
             COUNT(DISTINCT conv.kommun_kod) AS kommun_count,
             MAX(m.received_at) AS last_contract_at
      FROM vendors v
      LEFT JOIN contracts c ON c.vendor_id = v.id AND c.is_contract = 1
      LEFT JOIN attachments a ON a.id = c.attachment_id
      LEFT JOIN messages m ON m.id = a.message_id
      LEFT JOIN conversations conv ON conv.id = m.conversation_id
      GROUP BY v.id
      ORDER BY contract_count DESC, v.name COLLATE NOCASE
    `).all();
    const prods = db.prepare(`
      SELECT vendor_id, name FROM products ORDER BY name
    `).all();
    const byVendor = new Map();
    for (const p of prods) {
      if (!byVendor.has(p.vendor_id)) byVendor.set(p.vendor_id, []);
      byVendor.get(p.vendor_id).push(p.name);
    }
    return rows.map((r) => ({ ...r, products: byVendor.get(r.id) ?? [] }));
  }

  function getVendorBySlug(slug) {
    return db.prepare('SELECT * FROM vendors WHERE slug = ?').get(slug);
  }

  function listHandoffContacts(kommunKod) {
    // Handoff addresses the kommun explicitly gave us, derived from inbound
    // LLM analysis. Dedup by lowercased email; first occurrence wins for role.
    const rows = db.prepare(`
      SELECT conv.role AS role,
             json_extract(m.analysis_json, '$.extracted.handoff_to_email') AS email,
             json_extract(m.analysis_json, '$.extracted.handoff_to_forvaltning') AS forvaltning
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id
      WHERE conv.kommun_kod = ?
        AND m.direction = 'inbound'
        AND email IS NOT NULL AND email != ''
      ORDER BY m.received_at, m.id
    `).all(kommunKod);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = r.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ email: r.email, forvaltning: r.forvaltning ?? null, role: r.role });
    }
    return out;
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
    getMessageById,
    upsertThread,
    getThread,
    getThreadById,
    listThreadsForConversation,
    setThreadStatus,
    recordAttachment,
    recordEscalation,
    listOpenEscalations,
    listEscalationsByStatus,
    listOpenEscalationsForConversation,
    listActiveEscalationsForConversation,
    hasActiveEscalation,
    getEscalationBySlackTs,
    resolveEscalation,
    resolveEscalationIfOpen,
    claimEscalationForSending,
    claimConversationForInitialSend,
    transaction,
    recordDecision,
    listDecisions,
    recordHeartbeat,
    getHeartbeat,
    getTickHealth,
    close,
    upsertVendor,
    upsertProduct,
    recordContract,
    linkContractProduct,
    listPendingContractAttachments,
    listContractInfoForMessage,
    listContractsForVendor,
    listContractsForKommun,
    listConversationsDueForRefresh,
    listVendorsOverview,
    getVendorBySlug,
    listHandoffContacts,
  };
}
