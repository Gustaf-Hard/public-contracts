// Local pilot dashboard. Standalone Express app that reads from
// data/municipalities.json (the 290-kommun dataset) and data/pilot.db
// (live SQLite written by the pilot daemon). Runs separately from the
// daemon so it works even when the daemon is off.

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { openDb } from './storage.js';
import {
  renderOverview,
  renderKommunDetail,
  renderEscalations,
  renderActivity,
} from './dashboard-views.js';

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const MUNICIPALITIES_PATH = process.env.PILOT_MUNICIPALITIES_PATH ?? 'data/municipalities.json';

function loadMunicipalities() {
  if (!existsSync(MUNICIPALITIES_PATH)) return [];
  return JSON.parse(readFileSync(MUNICIPALITIES_PATH, 'utf8'));
}

function openDbOrNull() {
  if (!existsSync(DB_PATH)) return null;
  const db = openDb(DB_PATH);
  db.migrate();
  return db;
}

// ---- Data aggregation helpers ----

function buildOverviewRows(municipalities, db) {
  const allConvs = db ? db.listAllConversations() : [];
  const convsByKod = new Map();
  for (const c of allConvs) {
    if (!convsByKod.has(c.kommun_kod)) convsByKod.set(c.kommun_kod, []);
    convsByKod.get(c.kommun_kod).push(c);
  }

  // Open escalations count per conversation
  const openEscalations = db
    ? db.raw.prepare("SELECT conversation_id, count(*) as n FROM escalations WHERE status='open' GROUP BY conversation_id").all()
    : [];
  const openEscByConvId = new Map(openEscalations.map((r) => [r.conversation_id, r.n]));

  // Attachment count per conversation
  const attachmentCounts = db
    ? db.raw.prepare(`
        SELECT m.conversation_id, count(a.id) as n
        FROM attachments a JOIN messages m ON m.id = a.message_id
        GROUP BY m.conversation_id
      `).all()
    : [];
  const attachByConvId = new Map(attachmentCounts.map((r) => [r.conversation_id, r.n]));

  return municipalities.map((m) => {
    const convs = convsByKod.get(m.kommun_kod) ?? [];
    let openEsc = 0;
    let contracts = 0;
    let lastActivityAt = null;
    for (const c of convs) {
      openEsc += openEscByConvId.get(c.id) ?? 0;
      contracts += attachByConvId.get(c.id) ?? 0;
      const candidate = c.last_outbound_at && c.state_changed_at && c.last_outbound_at > c.state_changed_at
        ? c.last_outbound_at : c.state_changed_at;
      if (!lastActivityAt || candidate > lastActivityAt) lastActivityAt = candidate;
    }
    return {
      kommun_kod: m.kommun_kod,
      kommun_namn: m.kommun_namn,
      lan: m.lan,
      folkmangd: m.folkmangd,
      states: convs.map((c) => ({ role: c.role, state: c.state })),
      open_escalations: openEsc,
      contracts,
      last_activity_at: lastActivityAt,
    };
  });
}

function buildSummary(rows) {
  const summary = {
    in_pilot: 0,
    sent: 0,
    ack_received: 0,
    awaiting_precision: 0,
    delivering: 0,
    done: 0,
    dead_end: 0,
    needs_human: 0,
    open_escalations: 0,
    contracts: 0,
    avg_reply_days: null,
  };
  for (const r of rows) {
    if (r.states.length > 0) summary.in_pilot++;
    summary.open_escalations += r.open_escalations;
    summary.contracts += r.contracts;
    // Worst-or-furthest state across roles for summary counting (1 per kommun)
    const states = new Set(r.states.map((s) => s.state));
    if (states.has('NEEDS_HUMAN')) summary.needs_human++;
    else if (states.has('DELIVERING')) summary.delivering++;
    else if (states.has('DONE')) summary.done++;
    else if (states.has('DEAD_END')) summary.dead_end++;
    else if (states.has('AWAITING_PRECISION')) summary.awaiting_precision++;
    else if (states.has('ACK_RECEIVED')) summary.ack_received++;
    else if (states.has('SENT')) summary.sent++;
  }
  return summary;
}

function applyFilter(rows, filter) {
  if (!filter || filter === 'all') return rows;
  if (filter === 'in-pilot') return rows.filter((r) => r.states.length > 0);
  if (filter === 'needs-attention') return rows.filter((r) => r.states.some((s) => s.state === 'NEEDS_HUMAN') || r.open_escalations > 0);
  if (filter === 'delivering') return rows.filter((r) => r.states.some((s) => s.state === 'DELIVERING'));
  if (filter === 'done') return rows.filter((r) => r.states.some((s) => s.state === 'DONE'));
  if (filter === 'dead-end') return rows.filter((r) => r.states.some((s) => s.state === 'DEAD_END'));
  return rows;
}

// Map a kommun's set of role states to a single numeric priority for
// column sorting. Lower = needs attention sooner.
const STATE_PRIORITY = {
  NEEDS_HUMAN: 0,
  AWAITING_PRECISION: 1,
  ACK_RECEIVED: 2,
  SENT: 3,
  DELIVERING: 4,
  INITIAL: 5,
  DONE: 6,
  DEAD_END: 7,
};

function rowStatePriority(states) {
  if (states.length === 0) return 100; // not yet contacted
  let min = 99;
  for (const s of states) {
    const p = STATE_PRIORITY[s.state] ?? 50;
    if (p < min) min = p;
  }
  return min;
}

const SORT_KEYS = {
  kommun_namn: (r) => r.kommun_namn ?? '',
  lan: (r) => r.lan ?? '',
  folkmangd: (r) => r.folkmangd ?? 0,
  state: (r) => rowStatePriority(r.states),
  contracts: (r) => r.contracts,
  open_escalations: (r) => r.open_escalations,
  last_activity: (r) => r.last_activity_at ?? '',
};

const DEFAULT_ORDER_FOR_KEY = {
  kommun_namn: 'asc',
  lan: 'asc',
  folkmangd: 'desc',
  state: 'asc', // lowest priority first = needs attention at top
  contracts: 'desc',
  open_escalations: 'desc',
  last_activity: 'desc',
};

function sortRows(rows, { sort, order } = {}) {
  // Default sort: in-pilot first, then by recent activity
  if (!sort || !(sort in SORT_KEYS)) {
    return rows.slice().sort((a, b) => {
      const aActive = a.states.length > 0 ? 0 : 1;
      const bActive = b.states.length > 0 ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (a.last_activity_at && b.last_activity_at) return b.last_activity_at.localeCompare(a.last_activity_at);
      if (a.last_activity_at) return -1;
      if (b.last_activity_at) return 1;
      return a.kommun_namn.localeCompare(b.kommun_namn, 'sv');
    });
  }
  const keyFn = SORT_KEYS[sort];
  const effectiveOrder = order === 'asc' || order === 'desc' ? order : DEFAULT_ORDER_FOR_KEY[sort];
  const dir = effectiveOrder === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = keyFn(a);
    const bv = keyFn(b);
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir * av.localeCompare(bv, 'sv');
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.kommun_namn.localeCompare(b.kommun_namn, 'sv');
  });
}

function parseSignatureJson(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// ---- Route handlers ----

export function createDashboardApp({ db = openDbOrNull(), municipalitiesLoader = loadMunicipalities } = {}) {
  const app = express();

  app.get('/', (req, res) => {
    const municipalities = municipalitiesLoader();
    const rows = buildOverviewRows(municipalities, db);
    const summary = buildSummary(rows);
    const filter = req.query.filter ?? 'all';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : null;
    const order = typeof req.query.order === 'string' ? req.query.order : null;
    const filtered = sortRows(applyFilter(rows, filter), { sort, order });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderOverview({
      summary,
      rows: filtered,
      filter,
      sort,
      order,
      totalKommuner: municipalities.length,
    }));
  });

  app.get('/kommun/:kod', (req, res) => {
    const municipalities = municipalitiesLoader();
    const kommun = municipalities.find((m) => m.kommun_kod === req.params.kod);
    if (!kommun) {
      res.status(404).set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderKommunDetail({ kommun: null }));
    }

    const conversations = db
      ? db.raw.prepare('SELECT * FROM conversations WHERE kommun_kod = ? ORDER BY id').all(req.params.kod)
      : [];

    const messagesByConv = {};
    const attachmentsByMsg = {};
    const escalationsByConv = {};
    const signatures = {};
    if (db) {
      for (const conv of conversations) {
        const msgs = db.raw.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id').all(conv.id);
        messagesByConv[conv.id] = msgs;
        for (const m of msgs) {
          const atts = db.raw.prepare('SELECT * FROM attachments WHERE message_id = ?').all(m.id);
          if (atts.length) attachmentsByMsg[m.id] = atts;
          if (m.signature_extracted) {
            const sig = parseSignatureJson(m.signature_extracted);
            if (sig) signatures[m.id] = sig;
          }
        }
        escalationsByConv[conv.id] = db.raw
          .prepare("SELECT * FROM escalations WHERE conversation_id = ? AND status = 'open' ORDER BY created_at DESC")
          .all(conv.id);
      }
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderKommunDetail({
      kommun,
      conversations,
      messagesByConv,
      attachmentsByMsg,
      escalationsByConv,
      signatures,
    }));
  });

  app.get('/escalations', (req, res) => {
    if (!db) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderEscalations({ items: [] }));
    }
    const items = db.raw.prepare(`
      SELECT e.id, e.reason, e.draft_template, e.draft_subject, e.draft_body, e.created_at,
             c.kommun_kod, c.kommun_namn, c.role,
             m.body_text as inbound_body
      FROM escalations e
      JOIN conversations c ON c.id = e.conversation_id
      LEFT JOIN messages m ON m.id = e.message_id
      WHERE e.status = 'open'
      ORDER BY e.created_at
    `).all();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderEscalations({ items }));
  });

  app.get('/activity', (req, res) => {
    if (!db) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderActivity({ events: [] }));
    }
    // Recent inbound + outbound messages + state changes (rough activity feed)
    const events = db.raw.prepare(`
      SELECT m.received_at as timestamp,
             c.kommun_kod, c.kommun_namn, c.role,
             m.direction as direction, m.subject, m.classification
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT 50
    `).all();

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderActivity({
      events: events.map((e) => ({
        timestamp: e.timestamp,
        kommun_kod: e.kommun_kod,
        kommun_namn: e.kommun_namn,
        role: e.role,
        event: e.direction === 'outbound' ? '⬆ Skickat' : '⬇ Mottaget',
        detail: e.direction === 'outbound'
          ? (e.subject ?? '')
          : `${e.classification ?? 'okänt'} — ${e.subject ?? ''}`,
      })),
    }));
  });

  return app;
}

export function startDashboard({ port = parseInt(process.env.PILOT_DASHBOARD_PORT ?? '3100', 10) } = {}) {
  const app = createDashboardApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Pilot dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}
