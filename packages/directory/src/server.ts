import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import type { Database } from 'better-sqlite3'
import { adminAuthRouter } from './routes/admin-auth.js'
import { agentsRouter } from './routes/agents.js'
import { billingRouter } from './routes/billing.js'
import { businessVerificationRouter } from './routes/business-verify.js'
import { credentialsRouter } from './routes/credentials.js'
import { delegationsRouter } from './routes/delegations.js'
import { didRouter } from './routes/did.js'
import { federationRouter } from './routes/federation.js'
import { agentKeysRouter, revokedKeysRouter } from './routes/keys.js'
import { orgsRouter } from './routes/orgs.js'
import { observabilityRouter } from './routes/observability.js'
import { reportsRouter } from './routes/reports.js'
import { shieldRouter } from './routes/shield.js'
import { verificationRouter } from './routes/verify.js'
import { createTrustGateMiddleware } from './middleware/trust-gate.js'
import {
  createWebSocketServer,
  getConnectedCount,
  getConnectedBeamIds,
  recoverInterruptedIntentsOnStartup,
  relayIntentFromHttp,
  RelayError,
  startRecoveredIntentTimeoutSweep,
  stopRecoveredIntentTimeoutSweep,
} from './websocket.js'
import { createAcl, deleteAcl, listAclsForBeam, seedAclsFromCatalog } from './acl.js'
import { getAdminSessionFromRequest, requireAdminRole } from './admin-auth.js'
import { assignDirectoryRole, deleteDirectoryRole, getAgent, getDIDDocument, listAgentKeys, listAuditLog, listDirectoryRoles, listRecentIntentLogs, listTrustScores, logAuditEvent, upsertDIDDocument } from './db.js'
import { getFederationSharedSecret, getLocalDirectoryUrl, isPrivateDirectoryMode } from './federation.js'
import { createRateLimitMiddleware } from './middleware/rate-limit.js'
import type { AgentRow, IntentFrame } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const catalogPath = resolve(__dirname, '../../../intents/catalog.yaml')
const serverStartedAt = Date.now()

type WaitlistSignupInput = {
  email: string
  source: string | null
  company: string | null
  agentCount: number | null
  workflowType: string | null
  workflowSummary: string | null
}

type BetaRequestStatus = 'new' | 'reviewing' | 'contacted' | 'scheduled' | 'active' | 'closed'

type BetaRequestUpdateInput = {
  status?: BetaRequestStatus
  owner?: string | null
  operatorNotes?: string | null
}

type BetaRequestFilters = {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
  limit?: number
}

type WaitlistRow = {
  id: number
  email: string
  source: string | null
  company: string | null
  agent_count: number | null
  workflow_type: string | null
  workflow_summary: string | null
  status: string
  owner: string | null
  operator_notes: string | null
  created_at: string
  updated_at: string
}

const BETA_REQUEST_STATUSES: BetaRequestStatus[] = ['new', 'reviewing', 'contacted', 'scheduled', 'active', 'closed']
const BETA_REQUEST_STATUS_SET = new Set<string>(BETA_REQUEST_STATUSES)

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeBetaRequestStatus(value: unknown): BetaRequestStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!BETA_REQUEST_STATUS_SET.has(normalized)) {
    return null
  }

  return normalized as BetaRequestStatus
}

function serializeBetaRequest(row: WaitlistRow) {
  return {
    id: row.id,
    email: row.email,
    source: row.source,
    company: row.company,
    agentCount: row.agent_count,
    workflowType: row.workflow_type,
    workflowSummary: row.workflow_summary,
    requestStatus: normalizeBetaRequestStatus(row.status) ?? 'new',
    owner: row.owner,
    operatorNotes: row.operator_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getBetaRequestNextStep(status: string): string {
  switch (status) {
    case 'reviewing':
      return 'Beam is reviewing the workflow and assigning an operator.'
    case 'contacted':
      return 'Beam will follow up directly on the request by email.'
    case 'scheduled':
      return 'Beam has a follow-up call or working session queued for this request.'
    case 'active':
      return 'This request is in an active hosted beta rollout.'
    case 'closed':
      return 'This request is closed. Submit a fresh intake if the workflow changed materially.'
    default:
      return 'Beam will review the workflow, assign an owner, and follow up with the next concrete step.'
  }
}

function escapeCsvValue(value: string | number | null | undefined): string {
  if (value == null) {
    return ''
  }

  const text = String(value)
  if (!/[",\n]/.test(text)) {
    return text
  }

  return `"${text.replaceAll('"', '""')}"`
}

const PUBLIC_CORS_ORIGINS = new Set([
  'https://beam-dashboard.vercel.app',
  'https://dashboard.beam.directory',
  'https://beam.directory',
  'https://www.beam.directory',
])

function resolveCorsOrigin(origin?: string | null): string | null {
  if (!origin) {
    return null
  }

  if (PUBLIC_CORS_ORIGINS.has(origin)) {
    return origin
  }

  try {
    const parsed = new URL(origin)
    const isLoopbackHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isLoopbackHost && isHttp) {
      return origin
    }
  } catch {
    return null
  }

  return null
}

function serializeAgent(row: AgentRow, connectedSet: Set<string>): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...agent,
    capabilities: JSON.parse(row.capabilities) as string[],
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
    connected: connectedSet.has(row.beam_id),
  }
}

function loadIntentCatalog(): unknown {
  try {
    const raw = readFileSync(catalogPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { intents: [] }
  }
}

function hasFederationAuth(c: Context): boolean {
  if (c.req.header('x-beam-mtls-verified') === 'true') {
    return true
  }

  const secret = getFederationSharedSecret()
  return Boolean(secret) && c.req.header('x-beam-federation-secret') === secret
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined

  return Boolean(row)
}

function getTableColumns(db: Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function getBetaRequestWhereClause(filters: {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
} = {}): { whereSql: string; params: unknown[] } {
  const params: unknown[] = []
  const conditions: string[] = []

  if (filters.q) {
    const needle = `%${filters.q.trim()}%`
    conditions.push(`(
      email LIKE ?
      OR COALESCE(company, '') LIKE ?
      OR COALESCE(source, '') LIKE ?
      OR COALESCE(workflow_type, '') LIKE ?
      OR COALESCE(workflow_summary, '') LIKE ?
      OR COALESCE(owner, '') LIKE ?
      OR COALESCE(operator_notes, '') LIKE ?
    )`)
    params.push(needle, needle, needle, needle, needle, needle, needle)
  }

  if (filters.status && BETA_REQUEST_STATUS_SET.has(filters.status)) {
    conditions.push('status = ?')
    params.push(filters.status)
  }

  if (filters.owner) {
    conditions.push('COALESCE(owner, \'\') LIKE ?')
    params.push(`%${filters.owner.trim()}%`)
  }

  if (filters.source) {
    conditions.push('COALESCE(source, \'\') LIKE ?')
    params.push(`%${filters.source.trim()}%`)
  }

  if (filters.workflowType) {
    conditions.push('COALESCE(workflow_type, \'\') LIKE ?')
    params.push(`%${filters.workflowType.trim()}%`)
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function listBetaRequestRows(db: Database, filters: {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
  limit?: number
} = {}): { rows: WaitlistRow[]; total: number } {
  const limit = Math.min(Math.max(Number(filters.limit ?? 200) || 200, 1), 5000)
  const { whereSql, params } = getBetaRequestWhereClause(filters)
  const orderBy = `
    ORDER BY CASE status
      WHEN 'new' THEN 0
      WHEN 'reviewing' THEN 1
      WHEN 'contacted' THEN 2
      WHEN 'scheduled' THEN 3
      WHEN 'active' THEN 4
      WHEN 'closed' THEN 5
      ELSE 6
    END ASC,
    datetime(updated_at) DESC,
    datetime(created_at) DESC,
    id DESC
  `

  const rows = db.prepare(`
    SELECT
      id,
      email,
      source,
      company,
      agent_count,
      workflow_type,
      workflow_summary,
      status,
      owner,
      operator_notes,
      created_at,
      updated_at
    FROM waitlist
    ${whereSql}
    ${orderBy}
    LIMIT ?
  `).all(...params, limit) as WaitlistRow[]

  const total = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM waitlist
    ${whereSql}
  `).get(...params) as { count: number } | undefined)?.count ?? rows.length

  return { rows, total }
}

function getBetaRequestById(db: Database, id: number): WaitlistRow | null {
  const row = db.prepare(`
    SELECT
      id,
      email,
      source,
      company,
      agent_count,
      workflow_type,
      workflow_summary,
      status,
      owner,
      operator_notes,
      created_at,
      updated_at
    FROM waitlist
    WHERE id = ?
    LIMIT 1
  `).get(id) as WaitlistRow | undefined

  return row ?? null
}

function summarizeBetaRequests(rows: WaitlistRow[], total: number) {
  const byStatus = Object.fromEntries(BETA_REQUEST_STATUSES.map((status) => [status, 0])) as Record<BetaRequestStatus, number>
  let unowned = 0
  let active = 0

  for (const row of rows) {
    const status = normalizeBetaRequestStatus(row.status) ?? 'new'
    byStatus[status] += 1
    if (!row.owner) {
      unowned += 1
    }
    if (status !== 'closed') {
      active += 1
    }
  }

  return {
    total,
    active,
    unowned,
    byStatus,
  }
}

function buildBetaRequestCsv(rows: WaitlistRow[]): string {
  const headers = [
    'id',
    'email',
    'company',
    'source',
    'workflow_type',
    'workflow_summary',
    'agent_count',
    'status',
    'owner',
    'operator_notes',
    'created_at',
    'updated_at',
  ]

  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push([
      row.id,
      row.email,
      row.company,
      row.source,
      row.workflow_type,
      row.workflow_summary,
      row.agent_count,
      row.status,
      row.owner,
      row.operator_notes,
      row.created_at,
      row.updated_at,
    ].map((value) => escapeCsvValue(value as string | number | null | undefined)).join(','))
  }

  return `${lines.join('\n')}\n`
}

function getWaitlistEntries(db: Database): { available: boolean; waitlist: Array<{ email: string; company: string | null; signupDate: string | null; status: string | null; owner: string | null }>; total: number } {
  if (!tableExists(db, 'waitlist')) {
    return { available: false, waitlist: [], total: 0 }
  }

  const columns = getTableColumns(db, 'waitlist')
  const emailExpr = columns.has('email') ? 'email' : columns.has('contact_email') ? 'contact_email' : ''
  if (!emailExpr) {
    return { available: true, waitlist: [], total: 0 }
  }

  const companyExpr = columns.has('company')
    ? 'company'
    : columns.has('organization')
      ? 'organization'
      : columns.has('source')
        ? 'source'
        : 'NULL'
  const signupDateExpr = columns.has('created_at')
    ? 'created_at'
    : columns.has('signup_date')
      ? 'signup_date'
      : columns.has('createdAt')
        ? 'createdAt'
        : 'NULL'
  const statusExpr = columns.has('status')
    ? 'status'
    : 'NULL'
  const ownerExpr = columns.has('owner')
    ? 'owner'
    : 'NULL'
  const orderByExpr = columns.has('created_at')
    ? 'created_at'
    : columns.has('signup_date')
      ? 'signup_date'
      : columns.has('createdAt')
        ? 'createdAt'
        : 'rowid'

  const rows = db.prepare(`
    SELECT
      ${emailExpr} AS email,
      ${companyExpr} AS company,
      ${signupDateExpr} AS signupDate,
      ${statusExpr} AS status,
      ${ownerExpr} AS owner
    FROM waitlist
    ORDER BY ${orderByExpr} DESC
  `).all() as Array<{ email: string; company: string | null; signupDate: string | null; status: string | null; owner: string | null }>

  return {
    available: true,
    waitlist: rows,
    total: rows.length,
  }
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Beam Directory Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0a0f;
        --card: rgba(255,255,255,0.03);
        --accent: #F75C03;
        --text: #e2e8f0;
        --muted: #64748b;
        --border: rgba(255,255,255,0.08);
        --success: #22c55e;
        --warning: #f59e0b;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, rgba(247,92,3,0.12), transparent 28%), var(--bg);
        color: var(--text);
      }

      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }

      .hero {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-end;
        margin-bottom: 24px;
        flex-wrap: wrap;
      }

      h1, h2, h3, p { margin: 0; }
      h1 {
        font-size: 32px;
        line-height: 1.1;
        letter-spacing: -0.03em;
      }

      .subtle {
        color: var(--muted);
        margin-top: 8px;
        font-size: 14px;
      }

      .meta {
        display: flex;
        gap: 12px;
        align-items: center;
        color: var(--muted);
        font-size: 13px;
      }

      .pill, .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
        border-radius: 999px;
        padding: 8px 12px;
      }

      .badge {
        color: var(--accent);
        border-color: rgba(247,92,3,0.35);
        background: rgba(247,92,3,0.08);
        font-weight: 600;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        overflow: hidden;
        backdrop-filter: blur(12px);
        min-height: 260px;
      }

      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--border);
      }

      .card-body {
        padding: 12px 0;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        text-align: left;
        padding: 12px 20px;
        font-size: 14px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      tr:last-child td { border-bottom: none; }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
        white-space: nowrap;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--muted);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.03);
      }

      .dot.online { background: var(--success); }
      .dot.stale { background: var(--warning); }

      .muted { color: var(--muted); }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 13px;
      }

      .empty, .error {
        padding: 24px 20px;
        color: var(--muted);
        font-size: 14px;
      }

      .error { color: #fca5a5; }

      @media (max-width: 980px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <div class="badge">Beam Directory Admin</div>
          <h1>Network health at a glance</h1>
          <p class="subtle">Live visibility into agents, intents, waitlist demand, and pairwise trust.</p>
        </div>
        <div class="meta">
          <div class="pill">Auto-refresh every 30s</div>
          <div class="pill">Last updated <span id="last-updated">—</span></div>
        </div>
      </div>

      <div class="grid">
        <section class="card">
          <div class="card-header">
            <div>
              <h2>Connected Agents</h2>
              <p class="subtle">Registered agents with current connection state.</p>
            </div>
            <div class="badge" id="agents-count">0</div>
          </div>
          <div class="card-body" id="agents-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Recent Intents</h2>
              <p class="subtle">Most recent relay attempts with round-trip latency.</p>
            </div>
            <div class="badge" id="intents-count">0</div>
          </div>
          <div class="card-body" id="intents-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Waitlist Signups</h2>
              <p class="subtle">Interest from teams tracking Beam access.</p>
            </div>
            <div class="badge" id="waitlist-count">0</div>
          </div>
          <div class="card-body" id="waitlist-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Trust Scores</h2>
              <p class="subtle">Latest pairwise trust values inferred from relay outcomes.</p>
            </div>
            <div class="badge" id="trust-count">0</div>
          </div>
          <div class="card-body" id="trust-content"></div>
        </section>
      </div>
    </div>

    <script>
      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function formatTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return escapeHtml(value);
        return date.toLocaleString();
      }

      function formatLatency(value) {
        return typeof value === 'number' ? value.toLocaleString() + ' ms' : '—';
      }

      function setCount(id, value) {
        document.getElementById(id).textContent = String(value ?? 0);
      }

      function setBody(id, html) {
        document.getElementById(id).innerHTML = html;
      }

      function renderEmpty(message) {
        return '<div class="empty">' + escapeHtml(message) + '</div>';
      }

      function renderError(message) {
        return '<div class="error">' + escapeHtml(message) + '</div>';
      }

      function renderTable(headers, rows) {
        return '<table><thead><tr>'
          + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.join('')
          + '</tbody></table>';
      }

      function renderAgents(payload) {
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        setCount('agents-count', payload.total ?? agents.length);
        if (!agents.length) {
          setBody('agents-content', renderEmpty('No agents registered yet.'));
          return;
        }

        const rows = agents.map((agent) => {
          const statusClass = agent.connected ? 'online' : 'stale';
          const statusLabel = agent.connected ? 'Online' : 'Offline';
          return '<tr>'
            + '<td class="mono">' + escapeHtml(agent.beamId) + '</td>'
            + '<td>' + escapeHtml(agent.name) + '</td>'
            + '<td><span class="status"><span class="dot ' + statusClass + '"></span>' + statusLabel + '</span></td>'
            + '<td>' + escapeHtml(formatTime(agent.lastSeen)) + '</td>'
            + '</tr>';
        });

        setBody('agents-content', renderTable(['Beam ID', 'Name', 'Status', 'Last Seen'], rows));
      }

      function renderIntents(payload) {
        const intents = Array.isArray(payload.intents) ? payload.intents : [];
        setCount('intents-count', payload.total ?? intents.length);
        if (!intents.length) {
          setBody('intents-content', renderEmpty('No intent activity recorded yet.'));
          return;
        }

        const rows = intents.map((intent) => '<tr>'
          + '<td class="mono">' + escapeHtml(intent.from) + '</td>'
          + '<td class="mono">' + escapeHtml(intent.to) + '</td>'
          + '<td>' + escapeHtml(intent.intentType) + '</td>'
          + '<td>' + escapeHtml(formatTime(intent.timestamp)) + '</td>'
          + '<td>' + escapeHtml(formatLatency(intent.roundTripLatencyMs)) + '</td>'
          + '</tr>');

        setBody('intents-content', renderTable(['From', 'To', 'Intent', 'Timestamp', 'Latency'], rows));
      }

      function renderWaitlist(payload) {
        const waitlist = Array.isArray(payload.waitlist) ? payload.waitlist : [];
        setCount('waitlist-count', payload.total ?? waitlist.length);
        if (payload.available === false) {
          setBody('waitlist-content', renderEmpty('Waitlist table is not available in this deployment yet.'));
          return;
        }
        if (!waitlist.length) {
          setBody('waitlist-content', renderEmpty('No waitlist signups found.'));
          return;
        }

        const rows = waitlist.map((entry) => '<tr>'
          + '<td>' + escapeHtml(entry.email) + '</td>'
          + '<td>' + escapeHtml(formatTime(entry.signupDate)) + '</td>'
          + '<td>' + escapeHtml(entry.company ?? '—') + '</td>'
          + '</tr>');

        setBody('waitlist-content', renderTable(['Email', 'Signup Date', 'Company'], rows));
      }

      function renderTrust(payload) {
        const trust = Array.isArray(payload.trustScores) ? payload.trustScores : [];
        setCount('trust-count', payload.total ?? trust.length);
        if (!trust.length) {
          setBody('trust-content', renderEmpty('No pairwise trust scores recorded yet.'));
          return;
        }

        const rows = trust.map((entry) => '<tr>'
          + '<td class="mono">' + escapeHtml(entry.from) + '</td>'
          + '<td class="mono">' + escapeHtml(entry.to) + '</td>'
          + '<td>' + escapeHtml(Number(entry.score ?? 0).toFixed(2)) + '</td>'
          + '<td>' + escapeHtml(formatTime(entry.lastUpdated)) + '</td>'
          + '</tr>');

        setBody('trust-content', renderTable(['From', 'To', 'Score', 'Last Updated'], rows));
      }

      async function fetchJson(path) {
        const response = await fetch(path, {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        if (!response.ok) {
          let message = 'Request failed';
          try {
            const payload = await response.json();
            message = payload.error || message;
          } catch {}
          throw new Error(message);
        }

        return response.json();
      }

      async function refresh() {
        try {
          const [agents, intents, waitlist, trust] = await Promise.all([
            fetchJson('/admin/agents'),
            fetchJson('/admin/intents?limit=50'),
            fetchJson('/admin/waitlist'),
            fetchJson('/admin/trust'),
          ]);
          renderAgents(agents);
          renderIntents(intents);
          renderWaitlist(waitlist);
          renderTrust(trust);
          document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load dashboard data';
          setBody('agents-content', renderError(message));
          setBody('intents-content', renderError(message));
          setBody('waitlist-content', renderError(message));
          setBody('trust-content', renderError(message));
        }
      }

      refresh();
      setInterval(refresh, 30_000);
    </script>
  </body>
</html>`
}

export function createApp(db: Database): Hono {
  const app = new Hono()
  seedAclsFromCatalog(db)

  app.use('*', cors({
    origin: (origin) => resolveCorsOrigin(origin) ?? '',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
    ],
    credentials: true,
  }))

  app.use('*', createRateLimitMiddleware(db))

  // Beam Shield — Wall 1: Body size limit (64KB)
  app.use('*', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') ?? '0', 10)
    if (contentLength > 65536) {
      return c.json({ error: 'Payload too large (max 64KB)', errorCode: 'SHIELD_PAYLOAD_TOO_LARGE' }, 413)
    }
    await next()
  })

  // Beam Shield — Wall 2: Trust Gate (per-agent config from DB)
  app.use('*', createTrustGateMiddleware(db, {
    defaultMinTrust: 0.3,
    defaultRateLimit: 20,
  }))

  app.route('/admin/auth', adminAuthRouter(db))

  app.get('/dashboard', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    c.header('Cache-Control', 'no-store')
    return c.html(renderDashboardHtml())
  })

  app.get('/admin/agents', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const rows = db.prepare('SELECT * FROM agents ORDER BY last_seen DESC, beam_id ASC').all() as AgentRow[]
      const connected = new Set(getConnectedBeamIds())
      c.header('Cache-Control', 'no-store')
      return c.json({
        agents: rows.map((row) => ({
          beamId: row.beam_id,
          name: row.display_name,
          connected: connected.has(row.beam_id),
          lastSeen: row.last_seen,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin agents error:', err)
      return c.json({ error: 'Failed to load agents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/intents', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)

    try {
      const rows = listRecentIntentLogs(db, limit)
      c.header('Cache-Control', 'no-store')
      return c.json({
        intents: rows.map((row) => ({
          from: row.from_beam_id,
          to: row.to_beam_id,
          intentType: row.intent_type,
          timestamp: row.requested_at,
          roundTripLatencyMs: row.round_trip_latency_ms,
          status: row.status,
          errorCode: row.error_code,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin intents error:', err)
      return c.json({ error: 'Failed to load intents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.delete('/admin/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) return auth
    try {
      const result = db.prepare('DELETE FROM waitlist').run()
      logAuditEvent(db, {
        action: 'admin.waitlist.cleared',
        actor: auth.session.email,
        target: 'waitlist',
        details: { deleted: result.changes, role: auth.session.role },
      })
      return c.json({ deleted: result.changes })
    } catch (err) {
      console.error('Admin waitlist clear error:', err)
      return c.json({ error: 'Failed to clear waitlist', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const filters: BetaRequestFilters = {
        q: c.req.query('q') ?? undefined,
        status: c.req.query('status') ?? undefined,
        owner: c.req.query('owner') ?? undefined,
        source: c.req.query('source') ?? undefined,
        workflowType: c.req.query('workflowType') ?? undefined,
        limit: c.req.query('limit') ? Number.parseInt(c.req.query('limit') as string, 10) : undefined,
      }

      const { rows, total } = listBetaRequestRows(db, filters)
      c.header('Cache-Control', 'no-store')
      return c.json({
        requests: rows.map((row) => serializeBetaRequest(row)),
        total,
        summary: summarizeBetaRequests(rows, total),
      })
    } catch (err) {
      console.error('Admin beta requests error:', err)
      return c.json({ error: 'Failed to load beta requests', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests/export', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const format = (c.req.query('format') ?? 'json').trim().toLowerCase()
    if (format !== 'json' && format !== 'csv') {
      return c.json({ error: 'format must be json or csv', errorCode: 'INVALID_EXPORT_FORMAT' }, 400)
    }

    try {
      const filters: BetaRequestFilters = {
        q: c.req.query('q') ?? undefined,
        status: c.req.query('status') ?? undefined,
        owner: c.req.query('owner') ?? undefined,
        source: c.req.query('source') ?? undefined,
        workflowType: c.req.query('workflowType') ?? undefined,
        limit: c.req.query('limit') ? Number.parseInt(c.req.query('limit') as string, 10) : 5000,
      }

      const { rows, total } = listBetaRequestRows(db, filters)
      const timestamp = new Date().toISOString().replaceAll(':', '-')

      logAuditEvent(db, {
        action: 'admin.beta_requests.exported',
        actor: auth.session.email,
        target: 'beta_requests',
        details: {
          format,
          total,
          filters,
          role: auth.session.role,
        },
      })

      c.header('Cache-Control', 'no-store')
      if (format === 'csv') {
        c.header('Content-Type', 'text/csv; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename="beam-beta-requests-${timestamp}.csv"`)
        return c.body(buildBetaRequestCsv(rows))
      }

      c.header('Content-Type', 'application/json; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-beta-requests-${timestamp}.json"`)
      return c.body(JSON.stringify({
        exportedAt: new Date().toISOString(),
        total,
        summary: summarizeBetaRequests(rows, total),
        requests: rows.map((row) => serializeBetaRequest(row)),
      }, null, 2))
    } catch (err) {
      console.error('Admin beta request export error:', err)
      return c.json({ error: 'Failed to export beta requests', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests/:id', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid beta request id', errorCode: 'INVALID_BETA_REQUEST_ID' }, 400)
    }

    try {
      const row = getBetaRequestById(db, id)
      if (!row) {
        return c.json({ error: 'Beta request not found', errorCode: 'NOT_FOUND' }, 404)
      }
      c.header('Cache-Control', 'no-store')
      return c.json({ request: serializeBetaRequest(row) })
    } catch (err) {
      console.error('Admin beta request detail error:', err)
      return c.json({ error: 'Failed to load beta request', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.patch('/admin/beta-requests/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid beta request id', errorCode: 'INVALID_BETA_REQUEST_ID' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const patch: BetaRequestUpdateInput = {}

    if ('status' in raw) {
      const status = normalizeBetaRequestStatus(raw.status)
      if (!status) {
        return c.json({ error: 'Invalid beta request status', errorCode: 'INVALID_BETA_REQUEST_STATUS' }, 400)
      }
      patch.status = status
    }

    if ('owner' in raw) {
      patch.owner = normalizeOptionalString(raw.owner)
    }

    if ('operatorNotes' in raw) {
      patch.operatorNotes = normalizeOptionalString(raw.operatorNotes)
    }

    if (!('status' in patch) && !('owner' in patch) && !('operatorNotes' in patch)) {
      return c.json({ error: 'No supported fields to update', errorCode: 'EMPTY_PATCH' }, 400)
    }

    try {
      const existing = getBetaRequestById(db, id)
      if (!existing) {
        return c.json({ error: 'Beta request not found', errorCode: 'NOT_FOUND' }, 404)
      }

      const nextStatus = patch.status ?? (normalizeBetaRequestStatus(existing.status) ?? 'new')
      const nextOwner = 'owner' in patch ? patch.owner ?? null : existing.owner
      const nextOperatorNotes = 'operatorNotes' in patch ? patch.operatorNotes ?? null : existing.operator_notes
      const updatedAt = new Date().toISOString()

      db.prepare(`
        UPDATE waitlist
        SET status = ?, owner = ?, operator_notes = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, nextOwner, nextOperatorNotes, updatedAt, id)

      const updated = getBetaRequestById(db, id)
      if (!updated) {
        return c.json({ error: 'Beta request not found after update', errorCode: 'NOT_FOUND' }, 404)
      }

      logAuditEvent(db, {
        action: 'admin.beta_request.updated',
        actor: auth.session.email,
        target: String(id),
        details: {
          role: auth.session.role,
          status: nextStatus,
          owner: nextOwner,
          operatorNotesChanged: 'operatorNotes' in patch,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        ok: true,
        request: serializeBetaRequest(updated),
      })
    } catch (err) {
      console.error('Admin beta request update error:', err)
      return c.json({ error: 'Failed to update beta request', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const waitlist = getWaitlistEntries(db)
      c.header('Cache-Control', 'no-store')
      return c.json(waitlist)
    } catch (err) {
      console.error('Admin waitlist error:', err)
      return c.json({ error: 'Failed to load waitlist', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/trust', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const rows = listTrustScores(db)
      c.header('Cache-Control', 'no-store')
      return c.json({
        trustScores: rows.map((row) => ({
          from: row.source_beam_id,
          to: row.target_beam_id,
          score: row.score,
          lastUpdated: row.last_updated,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin trust error:', err)
      return c.json({ error: 'Failed to load trust scores', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/audit', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const limit = Number.parseInt(c.req.query('limit') ?? '100', 10)

    try {
      const rows = listAuditLog(db, {
        limit,
        action: c.req.query('action') ?? undefined,
        actor: c.req.query('actor') ?? undefined,
        target: c.req.query('target') ?? undefined,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        entries: rows.map((row) => ({
          id: row.id,
          action: row.action,
          actor: row.actor,
          target: row.target,
          timestamp: row.timestamp,
          details: row.details ? JSON.parse(row.details) as unknown : null,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin audit error:', err)
      return c.json({ error: 'Failed to load audit log', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // List all agents with connection status (before sub-router to avoid conflict)
  app.get('/directory/agents', (c) => {
    const adminSession = getAdminSessionFromRequest(db, c.req.raw)
    if (isPrivateDirectoryMode() && !hasFederationAuth(c) && !adminSession) {
      return c.json({ error: 'Directory is private', errorCode: 'PRIVATE_DIRECTORY' }, 403)
    }

    try {
      const includeUnlisted = c.req.query('includeUnlisted') === 'true' && Boolean(adminSession)
      const rows = includeUnlisted
        ? db.prepare('SELECT * FROM agents ORDER BY trust_score DESC, beam_id ASC').all() as AgentRow[]
        : db.prepare("SELECT * FROM agents WHERE visibility = 'public' ORDER BY trust_score DESC, beam_id ASC").all() as AgentRow[]
      const totalCount = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number }).cnt
      const connected = new Set(getConnectedBeamIds())
      return c.json({
        agents: rows.map((row) => serializeAgent(row, connected)),
        total: totalCount,
        listed: rows.length,
      })
    } catch (err) {
      console.error('List agents error:', err)
      return c.json({ error: 'Failed to list agents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.route('/orgs', orgsRouter(db))
  app.route('/agents', agentsRouter(db))
  app.route('/agents', verificationRouter(db))
  app.route('/agents', businessVerificationRouter(db))
  app.route('/agents', agentKeysRouter(db))
  app.route('/agents', delegationsRouter(db))
  app.route('/agents', reportsRouter(db))
  app.route('/agents', credentialsRouter())
  app.route('/agents', didRouter(db))

  // Top-level DID resolution for W3C compliance: /did/did:beam:*
  app.get('/did/:didString{.+}', async (c) => {
    const didString = c.req.param('didString')

    // First check stored DID documents
    const stored = getDIDDocument(db, didString)
    if (stored) return c.json(stored)

    // On-demand generation: convert DID → beam_id → lookup agent → generate
    const { generateDIDDocumentWithKeys, didToBeamId } = await import('./did.js')
    const beamId = didToBeamId(didString)
    if (beamId) {
      const agent = getAgent(db, beamId)
      if (agent) {
        const newDoc = generateDIDDocumentWithKeys(agent, listAgentKeys(db, beamId))
        upsertDIDDocument(db, newDoc)
        return c.json(newDoc)
      }
    }

    return c.json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404)
  })
  app.route('/federation', federationRouter(db))
  app.route('/billing', billingRouter(db))
  app.route('/shield', shieldRouter(db))
  app.route('/observability', observabilityRouter(db))
  app.route('/keys', revokedKeysRouter(db))

  app.get('/admin/roles', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const rows = listDirectoryRoles(db, getLocalDirectoryUrl())
    return c.json({
      roles: rows.map((row) => ({
        email: row.user_id,
        role: row.role,
      })),
      total: rows.length,
    })
  })

  app.post('/admin/roles', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: 'admin' | 'operator' | 'viewer' }
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = body.role
    if (!email || !email.includes('@') || (role !== 'admin' && role !== 'operator' && role !== 'viewer')) {
      return c.json({ error: 'email and role are required', errorCode: 'INVALID_ROLE_ASSIGNMENT' }, 400)
    }

    const assigned = assignDirectoryRole(db, {
      userId: email,
      role,
      directoryUrl: getLocalDirectoryUrl(),
    })

    logAuditEvent(db, {
      action: 'admin.role.assigned',
      actor: auth.session.email,
      target: email,
      details: {
        role: assigned.role,
        directoryUrl: assigned.directory_url,
      },
    })

    return c.json({
      email: assigned.user_id,
      role: assigned.role,
      directoryUrl: assigned.directory_url,
    }, 201)
  })

  app.delete('/admin/roles/:email', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const email = decodeURIComponent(c.req.param('email') ?? '').trim().toLowerCase()
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const deleted = deleteDirectoryRole(db, {
      userId: email,
      directoryUrl: getLocalDirectoryUrl(),
    })

    if (!deleted) {
      return c.json({ error: 'Role assignment not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.role.revoked',
      actor: auth.session.email,
      target: email,
      details: {
        directoryUrl: getLocalDirectoryUrl(),
      },
    })

    return new Response(null, { status: 204 })
  })

  app.post('/acl', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const targetBeamId = String(raw.targetBeamId ?? '')
    const intentType = String(raw.intentType ?? '')
    const allowedFrom = String(raw.allowedFrom ?? '')

    if (!targetBeamId || !intentType || !allowedFrom) {
      return c.json({ error: 'targetBeamId, intentType and allowedFrom are required', errorCode: 'INVALID_ACL' }, 400)
    }

    try {
      const acl = createAcl(db, { targetBeamId, intentType, allowedFrom })
      return c.json(acl, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create ACL entry'
      return c.json({ error: message, errorCode: 'ACL_ERROR' }, 400)
    }
  })

  app.get('/acl/:beamId', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    try {
      const rows = listAclsForBeam(db, beamId)
      return c.json({ acl: rows, total: rows.length })
    } catch (err) {
      console.error('List ACL error:', err)
      return c.json({ error: 'Failed to list ACL entries', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.delete('/acl/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid ACL id', errorCode: 'INVALID_ACL_ID' }, 400)
    }

    try {
      const removed = deleteAcl(db, id)
      if (!removed) {
        return c.json({ error: `ACL id ${id} not found`, errorCode: 'NOT_FOUND' }, 404)
      }
      return c.json({ ok: true, id })
    } catch (err) {
      console.error('Delete ACL error:', err)
      return c.json({ error: 'Failed to delete ACL entry', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.post('/waitlist', async (c) => {

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const email = String(raw.email ?? '').trim().toLowerCase()
    const source = typeof raw.source === 'string' && raw.source.trim().length > 0
      ? raw.source.trim()
      : null
    const company = typeof raw.company === 'string' && raw.company.trim().length > 0
      ? raw.company.trim()
      : null

    let agentCount: number | null = null
    if (raw.agentCount !== undefined && raw.agentCount !== null && raw.agentCount !== '') {
      const parsedAgentCount = Number(raw.agentCount)
      if (!Number.isInteger(parsedAgentCount) || parsedAgentCount < 0) {
        return c.json({ error: 'agentCount must be a non-negative integer', errorCode: 'INVALID_AGENT_COUNT' }, 400)
      }
      agentCount = parsedAgentCount
    }

    if (!email || !email.includes('@')) {
      return c.json({ error: 'A valid email is required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const workflowType = normalizeOptionalString(raw.workflowType)
      ?? (
        typeof raw.source === 'string' && raw.source.trim().startsWith('hosted-beta-')
          ? raw.source.trim()
          : null
      )
    const workflowSummary = normalizeOptionalString(raw.workflowSummary) ?? normalizeOptionalString(raw.notes)

    const signup: WaitlistSignupInput = {
      email,
      source,
      company,
      agentCount,
      workflowType,
      workflowSummary,
    }

    const timestamp = new Date().toISOString()

    try {
      const existing = db.prepare(`
        SELECT id, email, source, company, agent_count, workflow_type, workflow_summary, status, owner, operator_notes, created_at, updated_at
        FROM waitlist
        WHERE email = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(signup.email) as WaitlistRow | undefined

      if (existing) {
        const nextSource = signup.source ?? existing.source
        const nextCompany = signup.company ?? existing.company
        const nextAgentCount = signup.agentCount ?? existing.agent_count
        const nextWorkflowType = signup.workflowType ?? existing.workflow_type
        const nextWorkflowSummary = signup.workflowSummary ?? existing.workflow_summary
        const nextStatus = (normalizeBetaRequestStatus(existing.status) ?? 'new') === 'closed'
          ? 'new'
          : (normalizeBetaRequestStatus(existing.status) ?? 'new')

        db.prepare(`
          UPDATE waitlist
          SET source = ?, company = ?, agent_count = ?, workflow_type = ?, workflow_summary = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(nextSource, nextCompany, nextAgentCount, nextWorkflowType, nextWorkflowSummary, nextStatus, timestamp, existing.id)

        const updated = getBetaRequestById(db, existing.id)
        if (!updated) {
          return c.json({ error: 'Failed to load updated beta request', errorCode: 'DB_ERROR' }, 500)
        }

        return c.json({
          ok: true,
          status: 'already_registered',
          id: updated.id,
          email: updated.email,
          source: updated.source,
          company: updated.company,
          agentCount: updated.agent_count,
          workflowType: updated.workflow_type,
          workflowSummary: updated.workflow_summary,
          requestStatus: normalizeBetaRequestStatus(updated.status) ?? 'new',
          owner: updated.owner,
          operatorNotes: updated.operator_notes,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
          request: serializeBetaRequest(updated),
          nextStep: getBetaRequestNextStep(updated.status),
        }, 200)
      }

      const result = db.prepare(`
        INSERT INTO waitlist (
          email,
          source,
          company,
          agent_count,
          workflow_type,
          workflow_summary,
          status,
          owner,
          operator_notes,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'new', NULL, NULL, ?, ?)
      `).run(
        signup.email,
        signup.source,
        signup.company,
        signup.agentCount,
        signup.workflowType,
        signup.workflowSummary,
        timestamp,
        timestamp,
      )

      console.log(
        `[waitlist] new signup email=${signup.email} source=${signup.source ?? '-'} company=${signup.company ?? '-'} agentCount=${signup.agentCount ?? '-'} workflowType=${signup.workflowType ?? '-'} createdAt=${timestamp}`
      )

      logAuditEvent(db, {
        action: 'beta_request.created',
        actor: signup.email,
        target: signup.company ?? signup.email,
        details: {
          source: signup.source,
          workflowType: signup.workflowType,
          agentCount: signup.agentCount,
        },
      })

      const created = getBetaRequestById(db, Number(result.lastInsertRowid))
      if (!created) {
        return c.json({ error: 'Failed to load saved beta request', errorCode: 'DB_ERROR' }, 500)
      }

      return c.json({
        ok: true,
        status: 'registered',
        id: created.id,
        email: created.email,
        source: created.source,
        company: created.company,
        agentCount: created.agent_count,
        workflowType: created.workflow_type,
        workflowSummary: created.workflow_summary,
        requestStatus: normalizeBetaRequestStatus(created.status) ?? 'new',
        owner: created.owner,
        operatorNotes: created.operator_notes,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
        request: serializeBetaRequest(created),
        nextStep: getBetaRequestNextStep(created.status),
      }, 201)
    } catch (err) {
      console.error('Waitlist signup error:', err)
      return c.json({ error: 'Failed to save waitlist signup', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const { rows, total } = listBetaRequestRows(db, { limit: 5000 })

      return c.json({
        waitlist: rows.map((row) => serializeBetaRequest(row)),
        signups: rows.map((row) => serializeBetaRequest(row)),
        requests: rows.map((row) => serializeBetaRequest(row)),
        total,
        summary: summarizeBetaRequests(rows, total),
      })
    } catch (err) {
      console.error('List waitlist error:', err)
      return c.json({ error: 'Failed to list waitlist signups', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.post('/intents/send', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const payloadCandidate = (
      raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    )
      ? raw.payload
      : (
        raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      )
        ? raw.params
        : undefined

    const frame: IntentFrame = {
      v: '1',
      from: String(raw.from ?? ''),
      to: String(raw.to ?? ''),
      intent: String(raw.intent ?? ''),
      payload: payloadCandidate ? payloadCandidate as Record<string, unknown> : {},
      signature: typeof raw.signature === 'string' ? raw.signature : undefined,
      nonce: typeof raw.nonce === 'string' && raw.nonce.length > 0 ? raw.nonce : randomUUID(),
      timestamp: typeof raw.timestamp === 'string' && raw.timestamp.length > 0 ? raw.timestamp : new Date().toISOString(),
    }

    try {
      // Meter relayed intent
      const period = new Date().toISOString().slice(0, 7)
      db.prepare(
        `INSERT INTO usage_metering (beam_id, period, intent_count, relayed_count)
         VALUES (?, ?, 1, 1)
         ON CONFLICT(beam_id, period) DO UPDATE SET intent_count = intent_count + 1, relayed_count = relayed_count + 1`
      ).run(frame.from, period)

      const result = await relayIntentFromHttp(db, frame, 60_000)
      return c.json(result)
    } catch (err) {
      if (err instanceof RelayError) {
        if (err.code === 'OFFLINE') {
          return c.json({ error: 'agent_offline', errorCode: 'OFFLINE' }, 503)
        }
        if (err.code === 'TIMEOUT') {
          return c.json({ error: err.message, errorCode: 'TIMEOUT' }, 504)
        }
        if (err.code === 'BAD_REQUEST') {
          return c.json({ error: err.message, errorCode: 'INVALID_INTENT' }, 400)
        }
        if (err.code === 'FORBIDDEN') {
          return c.json({ error: err.message, errorCode: 'FORBIDDEN' }, 403)
        }
        if (err.code === 'RATE_LIMITED') {
          return c.json({ error: err.message, errorCode: 'RATE_LIMITED' }, 429)
        }
        if (err.code === 'IN_PROGRESS') {
          return c.json({ error: err.message, errorCode: 'IN_PROGRESS' }, 409)
        }
      }

      console.error('Relay intent HTTP error:', err)
      return c.json({ error: 'Failed to relay intent', errorCode: 'RELAY_ERROR' }, 500)
    }
  })

  app.get('/intents/catalog', (c) => {
    try {
      return c.json(loadIntentCatalog())
    } catch (err) {
      console.error('Catalog load error:', err)
      return c.json({ error: 'Catalog unavailable', errorCode: 'CATALOG_UNAVAILABLE' }, 500)
    }
  })

  app.get('/intents/recent', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)

    try {
      const rows = listRecentIntentLogs(db, limit)
      c.header('Cache-Control', 'no-store')
      return c.json({
        intents: rows.map((row) => ({
          nonce: row.nonce,
          from: row.from_beam_id,
          to: row.to_beam_id,
          intentType: row.intent_type,
          timestamp: row.requested_at,
          completedAt: row.completed_at,
          roundTripLatencyMs: row.round_trip_latency_ms,
          status: row.status,
          errorCode: row.error_code,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Recent intents error:', err)
      return c.json({ error: 'Failed to load recent intents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/health', (c) => {
    const timestamp = new Date().toISOString()

    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined

      return c.json({
        status: 'ok',
        protocol: 'beam/1',
        connectedAgents: getConnectedCount(),
        timestamp,
        uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        db: {
          status: row?.ok === 1 ? 'ok' : 'error',
        },
      })
    } catch (error) {
      return c.json({
        status: 'error',
        protocol: 'beam/1',
        connectedAgents: getConnectedCount(),
        timestamp,
        uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        db: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown database error',
        },
      }, 503)
    }
  })

  app.get('/stats', (c) => {
    let agents = 0
    let intentsProcessed = 0
    let waitlistSize = 0

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number } | undefined
      agents = row?.count ?? 0
    } catch {
      agents = 0
    }

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM intent_log').get() as { count: number } | undefined
      intentsProcessed = row?.count ?? 0
    } catch {
      intentsProcessed = 0
    }

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM waitlist').get() as { count: number } | undefined
      waitlistSize = row?.count ?? 0
    } catch {
      waitlistSize = 0
    }

    return c.json({
      agents,
      intentsProcessed,
      uptime: Math.floor(process.uptime()),
      waitlistSize,
      version: '0.5.0',
    })
  })

  app.notFound((c) => c.json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404))

  app.onError((err, c) => {
    console.error('Unhandled server error:', err)
    return c.json({ error: 'Internal server error', errorCode: 'INTERNAL_ERROR' }, 500)
  })

  return app
}

export function startServer(db: Database, port = 3100): HttpServer {
  const recovery = recoverInterruptedIntentsOnStartup(db)
  const app = createApp(db)
  const wss = createWebSocketServer(db)
  const recoverySweep = startRecoveredIntentTimeoutSweep(db)

  const server = serve(
    { fetch: app.fetch, port },
    (info) => {
      console.log(`Beam Directory Server running on http://localhost:${info.port}`)
      console.log(`WebSocket endpoint: ws://localhost:${info.port}/ws`)
      if (recovery.failedInterrupted > 0 || recovery.resumedAwaitingResult > 0 || recovery.timedOutAwaitingResult > 0) {
        console.log(
          `[beam-directory] Recovery summary: failed=${recovery.failedInterrupted}, ` +
          `resumed=${recovery.resumedAwaitingResult}, timed_out=${recovery.timedOutAwaitingResult}`,
        )
      }
    }
  ) as unknown as HttpServer

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  server.on('close', () => {
    stopRecoveredIntentTimeoutSweep(recoverySweep)
  })

  return server
}
