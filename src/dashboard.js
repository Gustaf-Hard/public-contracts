// Local pilot dashboard. Standalone Express app that reads from
// data/municipalities.json (the 290-kommun dataset) and data/pilot.db
// (live SQLite written by the pilot daemon). Runs separately from the
// daemon so it works even when the daemon is off.

import express from 'express';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { openDb } from './storage.js';
import { effectiveFollowUp, TERMINAL_STATES } from './conversation.js';
import { buildOAuthClient, loadStoredToken, makeGmail } from './gmail.js';
import { sendApprovedReply, sendInitial, renderInitialDraft } from './send-reply.js';
import {
  renderOverview,
  renderKommunDetail,
  renderEscalations,
  renderActivity,
  renderCompose,
  renderVendors,
  renderVendorDetail,
  mergeContacts,
} from './dashboard-views.js';

const ROLE_PRIORITY = ['central', 'utbildning', 'gymnasie', 'vuxenutbildning', 'other'];

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const MUNICIPALITIES_PATH = process.env.PILOT_MUNICIPALITIES_PATH ?? 'data/municipalities.json';
const OVERRIDES_PATH = process.env.PILOT_OVERRIDES_PATH ?? 'data/pilot-overrides.json';
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;

function loadGmail(env) {
  const token = loadStoredToken(TOKEN_PATH);
  if (!token) return null;
  const oauth = buildOAuthClient(env);
  oauth.setCredentials(token);
  return makeGmail(oauth);
}

function loadMunicipalities() {
  const live = existsSync(MUNICIPALITIES_PATH)
    ? JSON.parse(readFileSync(MUNICIPALITIES_PATH, 'utf8'))
    : [];
  // Merge any rehearsal kommuner (e.g. Testkommun kod 9999) so the dashboard
  // shows the rehearsal target alongside the real 290 kommuner.
  if (existsSync(OVERRIDES_PATH)) {
    try {
      const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
      const liveKods = new Set(live.map((m) => m.kommun_kod));
      for (const r of overrides.rehearsal_kommuner ?? []) {
        if (!liveKods.has(r.kommun_kod)) live.unshift(r);
      }
    } catch {
      // ignore overrides loading errors — dashboard still works without
    }
  }
  return live;
}

function openDbOrNull() {
  if (!existsSync(DB_PATH)) return null;
  const db = openDb(DB_PATH);
  db.migrate();
  return db;
}

// ---- Data aggregation helpers ----

// Compute calendar days from today (UTC) to a YYYY-MM-DD string.
// Negative = past, 0 = today, positive = future.
function daysUntilIso(iso, now = new Date()) {
  if (!iso) return null;
  const target = new Date(iso + 'T00:00:00Z').getTime();
  if (Number.isNaN(target)) return null;
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((target - today) / 86400000);
}

// Translate an open escalation into a plain-Swedish action so the overview
// tooltip can say *how* a "Behöver dig" kommun needs the operator. Keyed on the
// queued draft template (the FSM picks the template per situation).
export function escalationActionLabel(esc) {
  const labels = {
    free_form: 'fritextsvar krävs',
    T_FOLLOWUP_NUDGE: 'skicka påminnelse',
    T_FOLLOWUP_CLOSE: 'skicka avslutspåminnelse',
    T_RECEIPT: 'skicka mottagningskvitto',
  };
  return labels[esc?.draft_template] ?? 'granska och svara';
}

// Build a short "what happened / what's next" tooltip line per case for the
// overview hover. ~1-2 sentences. Pure derivation, no DB I/O. `openEsc` is the
// latest open escalation row (or undefined) — used to spell out the action when
// the case is NEEDS_HUMAN.
export function caseTooltip(conv, latestInbound, follow_up, openEsc) {
  // --- Senast ---
  let happened;
  if (latestInbound) {
    let analysis = null;
    try { analysis = latestInbound.analysis_json ? JSON.parse(latestInbound.analysis_json) : null; }
    catch {}
    if (analysis?.summary) happened = `Senast: ${analysis.summary}`;
    else if (latestInbound.classification) happened = `Senast: ${latestInbound.classification} mottaget`;
    else happened = `Senast: svar mottaget`;
  } else if (conv.state === 'SENT' && conv.last_outbound_at) {
    const d = daysUntilIso(conv.last_outbound_at.slice(0, 10));
    const ago = d === null ? '' : ` för ${Math.max(0, -d)} dagar sedan`;
    happened = `Senast: T-INITIAL skickad${ago}, inget svar än`;
  } else {
    happened = `Senast: ${conv.state}`;
  }

  // --- Nästa ---
  let next;
  // NEEDS_HUMAN is in TERMINAL_STATES, so it must be checked first — otherwise
  // the terminal branch below mislabels it as "återvändsgränd".
  if (conv.state === 'NEEDS_HUMAN') {
    next = `Nästa: du måste agera — ${escalationActionLabel(openEsc)}`;
  } else if (TERMINAL_STATES.has(conv.state)) {
    next = conv.state === 'DONE' ? 'Nästa: ärendet är stängt' : 'Nästa: återvändsgränd';
  } else if (follow_up?.date) {
    const d = daysUntilIso(follow_up.date);
    const tag = follow_up.source === 'kommun_promise' ? ' (kommunen utlovade datum)' : ' (standardpåminnelse)';
    if (d === null) next = `Nästa: bevakar till ${follow_up.date}${tag}`;
    else if (d < 0) next = `Nästa: skicka påminnelse — försenat ${-d}d${tag}`;
    else if (d === 0) next = `Nästa: påminnelse förfaller idag${tag}`;
    else next = `Nästa: bevakar svar i ${d}d till ${follow_up.date}${tag}`;
  } else {
    next = `Nästa: bevakar (${conv.state})`;
  }

  return `${happened}\n${next}`;
}

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

  // Latest open escalation per conversation — feeds the tooltip's "du måste agera — …".
  const latestOpenEsc = db
    ? db.raw.prepare(`
        SELECT e.conversation_id, e.draft_template
        FROM escalations e
        WHERE e.status = 'open'
          AND e.id = (SELECT MAX(e2.id) FROM escalations e2
                      WHERE e2.conversation_id = e.conversation_id AND e2.status = 'open')
      `).all()
    : [];
  const latestOpenEscByConvId = new Map(latestOpenEsc.map((r) => [r.conversation_id, r]));

  // Attachment count per conversation
  const attachmentCounts = db
    ? db.raw.prepare(`
        SELECT m.conversation_id, count(a.id) as n
        FROM attachments a JOIN messages m ON m.id = a.message_id
        GROUP BY m.conversation_id
      `).all()
    : [];
  const attachByConvId = new Map(attachmentCounts.map((r) => [r.conversation_id, r.n]));

  // Latest inbound message per conversation — feeds the hover tooltip's "Senast: …"
  const latestInbound = db
    ? db.raw.prepare(`
        SELECT m.conversation_id, m.subject, m.classification, m.analysis_json
        FROM messages m
        WHERE m.direction = 'inbound'
          AND m.id = (SELECT MAX(m2.id) FROM messages m2
                      WHERE m2.conversation_id = m.conversation_id
                        AND m2.direction = 'inbound')
      `).all()
    : [];
  const latestInboundByConvId = new Map(latestInbound.map((r) => [r.conversation_id, r]));

  return municipalities.map((m) => {
    const convs = convsByKod.get(m.kommun_kod) ?? [];
    let openEsc = 0;
    let contracts = 0;
    let lastActivityAt = null;
    let earliestFollowUp = null;
    let earliestFollowUpSource = null;
    for (const c of convs) {
      openEsc += openEscByConvId.get(c.id) ?? 0;
      contracts += attachByConvId.get(c.id) ?? 0;
      const candidate = c.last_outbound_at && c.state_changed_at && c.last_outbound_at > c.state_changed_at
        ? c.last_outbound_at : c.state_changed_at;
      if (!lastActivityAt || candidate > lastActivityAt) lastActivityAt = candidate;
      const fu = effectiveFollowUp(c);
      if (fu.date && (!earliestFollowUp || fu.date < earliestFollowUp)) {
        earliestFollowUp = fu.date;
        earliestFollowUpSource = fu.source;
      }
    }
    return {
      kommun_kod: m.kommun_kod,
      kommun_namn: m.kommun_namn,
      lan: m.lan,
      folkmangd: m.folkmangd,
      states: convs.map((c) => ({
        role: c.role,
        state: c.state,
        tooltip: caseTooltip(c, latestInboundByConvId.get(c.id), effectiveFollowUp(c), latestOpenEscByConvId.get(c.id)),
      })),
      open_escalations: openEsc,
      contracts,
      last_activity_at: lastActivityAt,
      follow_up_at: earliestFollowUp,
      follow_up_source: earliestFollowUpSource,
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
  follow_up: (r) => r.follow_up_at ?? '9999-12-31', // null sorts last for asc
};

const DEFAULT_ORDER_FOR_KEY = {
  kommun_namn: 'asc',
  lan: 'asc',
  folkmangd: 'desc',
  state: 'asc', // lowest priority first = needs attention at top
  contracts: 'desc',
  open_escalations: 'desc',
  last_activity: 'desc',
  follow_up: 'asc', // soonest first
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

export function createDashboardApp({
  db = openDbOrNull(),
  municipalitiesLoader = loadMunicipalities,
  gmailClient = loadGmail(process.env),
  env = process.env,
  contractsDir = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts',
} = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  const hb = () => (db && typeof db.getHeartbeat === 'function' ? db.getHeartbeat() : null);

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
      heartbeat: hb(),
    }));
  });

  // Serve a stored contract PDF inline. Lookup is by DB id only — the file
  // path never appears in the URL. All failure modes are 404.
  app.get('/attachments/:id', (req, res) => {
    if (!db) return res.status(404).send('Not found');
    const att = db.raw.prepare('SELECT * FROM attachments WHERE id = ?')
      .get(parseInt(req.params.id, 10));
    if (!att) return res.status(404).send('Not found');
    const base = path.resolve(contractsDir);
    const full = path.resolve(att.saved_path);
    if (!full.startsWith(base + path.sep)) return res.status(404).send('Not found');
    if (!existsSync(full)) return res.status(404).send('Not found');
    res.set('Content-Type', att.mime_type || 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${att.filename.replace(/["\\\r\n]/g, '')}"`);
    res.sendFile(full);
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
    const followUpByConv = {};
    if (db) {
      for (const conv of conversations) {
        followUpByConv[conv.id] = effectiveFollowUp(conv);
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
    // Render a T-INITIAL draft per role that isn't already in a conversation.
    // The form lets the operator pick a contact email, tweak the body, and send.
    const rolesInUse = new Set(conversations.map((c) => c.role));
    const initialDrafts = (kommun.contacts ?? [])
      .filter((c) => !rolesInUse.has(c.role))
      .reduce((acc, c) => {
        if (acc[c.role]) return acc; // first contact per role wins
        const draft = renderInitialDraft({ kommun_namn: kommun.kommun_namn, role: c.role, env });
        acc[c.role] = {
          role: c.role,
          candidate_emails: (kommun.contacts ?? []).filter((x) => x.role === c.role).map((x) => x.email),
          subject: draft.subject,
          body: draft.body,
        };
        return acc;
      }, {});

    const vendorSlugsByName = new Map(
      (db ? db.listVendorsOverview() : []).map((v) => [v.name.toLowerCase(), v.slug])
    );
    const handoffContacts = db ? db.listHandoffContacts(kommun.kommun_kod) : [];
    res.send(renderKommunDetail({
      kommun,
      conversations,
      messagesByConv,
      attachmentsByMsg,
      escalationsByConv,
      signatures,
      followUpByConv,
      initialDrafts,
      gmailReady: !!gmailClient,
      vendorSlugsByName,
      handoffContacts,
      heartbeat: hb(),
    }));
  });

  app.get('/kommun/:kod/compose', (req, res) => {
    const municipalities = municipalitiesLoader();
    const kommun = municipalities.find((m) => m.kommun_kod === req.params.kod);
    if (!kommun) {
      res.status(404).set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderCompose({ kommun: null, env }));
    }

    const conversations = db
      ? db.raw.prepare('SELECT role FROM conversations WHERE kommun_kod = ?').all(req.params.kod)
      : [];
    const rolesInUse = new Set(conversations.map((c) => c.role));

    const allRoles = [...new Set((kommun.contacts ?? []).map((c) => c.role))];
    const availableRoles = allRoles
      .filter((r) => !rolesInUse.has(r))
      .sort((a, b) => {
        const ai = ROLE_PRIORITY.indexOf(a);
        const bi = ROLE_PRIORITY.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    const queryRole = typeof req.query.role === 'string' ? req.query.role : null;
    const selectedRole = queryRole && availableRoles.includes(queryRole)
      ? queryRole
      : availableRoles[0] ?? null;

    let draft = null;
    let candidateEmails = [];
    if (selectedRole) {
      const handoffContacts = db ? db.listHandoffContacts(kommun.kommun_kod) : [];
      const datasetForRole = (kommun.contacts ?? []).filter((c) => c.role === selectedRole);
      // Handoff addresses (kommun-given) rank first, then website addresses.
      candidateEmails = mergeContacts(datasetForRole, handoffContacts).map((c) => c.email);
      draft = renderInitialDraft({ kommun_namn: kommun.kommun_namn, role: selectedRole, env });
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderCompose({
      kommun,
      draft,
      availableRoles,
      selectedRole,
      candidateEmails,
      gmailReady: !!gmailClient,
      env,
      heartbeat: hb(),
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
    res.send(renderEscalations({ items, gmailReady: !!gmailClient, heartbeat: hb() }));
  });

  app.get('/activity', (req, res) => {
    if (!db) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderActivity({ events: [], heartbeat: hb() }));
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
      heartbeat: hb(),
    }));
  });

  app.get('/leverantorer', (req, res) => {
    const vendors = db ? db.listVendorsOverview() : [];
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderVendors({ vendors, heartbeat: hb() }));
  });

  app.get('/leverantor/:slug', (req, res) => {
    const vendor = db ? db.getVendorBySlug(req.params.slug) : null;
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!vendor) return res.status(404).send(renderVendorDetail({ vendor: null, heartbeat: hb() }));
    const contracts = db.listContractsForVendor(vendor.id);
    res.send(renderVendorDetail({ vendor, contracts, heartbeat: hb() }));
  });

  // --- Action endpoints (outbound email) ---

  // Resolve an open escalation: send, edit-send, or skip.
  // POST /escalations/:id  with body { action: 'send'|'edit'|'skip', body?: string, subject?: string }
  app.post('/escalations/:id', async (req, res) => {
    if (!db) return res.status(503).send('No DB');
    const escId = parseInt(req.params.id, 10);
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    if (!esc) return res.status(404).send('Escalation not found');
    if (esc.status !== 'open') return res.redirect(`/kommun/${db.getConversation(esc.conversation_id)?.kommun_kod ?? ''}`);

    const conv = db.getConversation(esc.conversation_id);
    const action = req.body.action;

    if (action === 'skip') {
      db.resolveEscalation(escId, { status: 'resolved_skip' });
      db.recordDecision({
        escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
        classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
        draft_template: esc.draft_template, draft_body: esc.draft_body,
        decision: 'skip', final_body: null,
      });
      return res.redirect(`/kommun/${conv.kommun_kod}`);
    }

    if (action !== 'send' && action !== 'edit') {
      return res.status(400).send(`Unknown action: ${action}`);
    }

    if (!gmailClient) return res.status(503).send('Gmail not configured — run pilot-auth first.');

    const finalBody = (action === 'edit' ? req.body.body : esc.draft_body) ?? '';
    const finalSubject = (action === 'edit' ? req.body.subject : esc.draft_subject) ?? undefined;
    if (!finalBody.trim()) return res.status(400).send('Cannot send an empty body');

    try {
      await sendApprovedReply({
        db, gmail: gmailClient, env, conv, esc,
        finalBody, finalSubject,
        decision: action === 'send' ? 'approve_unmodified' : 'edit',
      });
    } catch (e) {
      return res.status(500).send(`Send failed: ${escapeForError(e.message)}`);
    }
    res.redirect(`/kommun/${conv.kommun_kod}`);
  });

  // Manually close a case (or mark it as a dead-end). POST /conversations/:id/close
  // with body { state: 'DONE' | 'DEAD_END' }. Records the decision and updates
  // state_changed_at so case-duration math works.
  app.post('/conversations/:id/close', (req, res) => {
    if (!db) return res.status(503).send('No DB');
    const convId = parseInt(req.params.id, 10);
    const conv = db.getConversation(convId);
    if (!conv) return res.status(404).send('Case not found');
    const targetState = req.body.state === 'DEAD_END' ? 'DEAD_END' : 'DONE';
    db.updateConversationState(convId, targetState, {});
    res.redirect(`/kommun/${conv.kommun_kod}`);
  });

  // Reopen a previously-closed case. Sets state back to ACK_RECEIVED so
  // the staleness rules pick it up again. Mostly for typos / oh-shit moments.
  app.post('/conversations/:id/reopen', (req, res) => {
    if (!db) return res.status(503).send('No DB');
    const convId = parseInt(req.params.id, 10);
    const conv = db.getConversation(convId);
    if (!conv) return res.status(404).send('Case not found');
    db.updateConversationState(convId, 'ACK_RECEIVED', {});
    res.redirect(`/kommun/${conv.kommun_kod}`);
  });

  // Send T-INITIAL to a kommun that doesn't have a conversation yet.
  // POST /kommun/:kod/init  with body { role, contact_email, subject, body }
  app.post('/kommun/:kod/init', async (req, res) => {
    if (!db) return res.status(503).send('No DB');
    if (!gmailClient) return res.status(503).send('Gmail not configured — run pilot-auth first.');

    const municipalities = municipalitiesLoader();
    const kommun = municipalities.find((m) => m.kommun_kod === req.params.kod);
    if (!kommun) return res.status(404).send('Kommun not found');

    const { role, contact_email, subject, body } = req.body;
    if (!role || !contact_email || !subject || !body) {
      return res.status(400).send('Missing role, contact_email, subject, or body');
    }

    try {
      await sendInitial({
        db, gmail: gmailClient, env,
        kommun_kod: kommun.kommun_kod,
        kommun_namn: kommun.kommun_namn,
        role,
        contact_email,
        subject,
        body,
      });
    } catch (e) {
      return res.status(500).send(`Send failed: ${escapeForError(e.message)}`);
    }
    res.redirect(`/kommun/${kommun.kommun_kod}`);
  });

  return app;
}

function escapeForError(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
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
