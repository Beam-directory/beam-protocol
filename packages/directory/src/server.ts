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
}

type WaitlistRow = {
  id: number
  email: string
  source: string | null
  company: string | null
  agent_count: number | null
  created_at: string
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

function getWaitlistEntries(db: Database): { available: boolean; waitlist: Array<{ email: string; company: string | null; signupDate: string | null }>; total: number } {
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
      ${signupDateExpr} AS signupDate
    FROM waitlist
    ORDER BY ${orderByExpr} DESC
  `).all() as Array<{ email: string; company: string | null; signupDate: string | null }>

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
    origin: [
      'https://beam-dashboard.vercel.app',
      'https://dashboard.beam.directory',
      'http://localhost:5173',
    ],
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

    const signup: WaitlistSignupInput = {
      email,
      source,
      company,
      agentCount,
    }

    const createdAt = new Date().toISOString()

    try {
      const result = db.prepare(`
        INSERT INTO waitlist (email, source, company, agent_count, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(signup.email, signup.source, signup.company, signup.agentCount, createdAt)

      console.log(
        `[waitlist] new signup email=${signup.email} source=${signup.source ?? '-'} company=${signup.company ?? '-'} agentCount=${signup.agentCount ?? '-'} createdAt=${createdAt}`
      )

      return c.json({
        id: Number(result.lastInsertRowid),
        email: signup.email,
        source: signup.source,
        company: signup.company,
        agentCount: signup.agentCount,
        createdAt,
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
      const rows = db.prepare(`
        SELECT id, email, source, company, agent_count, created_at
        FROM waitlist
        ORDER BY created_at DESC, id DESC
      `).all() as WaitlistRow[]

      return c.json({
        signups: rows.map((row) => ({
          id: row.id,
          email: row.email,
          source: row.source,
          company: row.company,
          agentCount: row.agent_count,
          createdAt: row.created_at,
        })),
        total: rows.length,
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
