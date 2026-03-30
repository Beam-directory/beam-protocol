import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { getAgent, listAuditLog, listIntentTraceEvents, listShieldAuditLog, logAuditEvent } from '../db.js'
import {
  classifyIntentLifecycle,
  isIntentLifecycleFailure,
  isIntentLifecycleSuccess,
  normalizeIntentLifecycleStatus,
  normalizeLegacyTraceLifecycle,
  type IntentLifecycleStatus,
} from '../intent-lifecycle.js'
import type {
  AuditLogRow,
  FederationPeerRow,
  IntentLogRow,
  IntentTraceEventRow,
  ShieldAuditLogRow,
} from '../types.js'

type BindValue = string | number | null
type AlertSeverity = 'info' | 'warning' | 'critical'
type AlertMetricUnit = 'ratio' | 'ms' | 'count'
type AlertLinkSurface = 'trace' | 'intents' | 'audit' | 'errors' | 'federation' | 'alerts'

type ObservabilityDatasetInfo = {
  name: string
  description: string
  cascadesTo?: string[]
}

type AlertLink = {
  label: string
  href: string
  surface: AlertLinkSurface
}

type AlertTraceSample = {
  nonce: string
  from: string
  to: string
  intentType: string
  requestedAt: string
  status: IntentLifecycleStatus
  errorCode: string | null
}

type AlertItem = {
  id: string
  severity: AlertSeverity
  title: string
  scope: 'network' | 'agent' | 'federation' | 'shield'
  message: string
  metric: string
  value: number
  threshold: number
  valueUnit: AlertMetricUnit
  startedAt: string
  thresholdExplanation: string
  severityReason: string
  links: AlertLink[]
  sampleTraces: AlertTraceSample[]
}

type IntentQuery = {
  q?: string
  fromBeamId?: string
  toBeamId?: string
  intentType?: string
  status?: string
  errorCode?: string
  limit: number
  sinceHours?: number
}

const DEFAULT_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env['BEAM_OBSERVABILITY_RETENTION_DAYS'] ?? '30', 10) || 30)
const OBSERVABILITY_DATASETS: ObservabilityDatasetInfo[] = [
  {
    name: 'intents',
    description: 'Intent log rows with lifecycle status, latency, and error summary fields.',
    cascadesTo: ['traces'],
  },
  {
    name: 'traces',
    description: 'Per-stage lifecycle events used to reconstruct nonce timelines.',
  },
  {
    name: 'audit',
    description: 'Administrative and federation control-plane events recorded by operators and services.',
  },
  {
    name: 'shield',
    description: 'Beam Shield hold and reject decisions with anomaly context.',
  },
]

const EXPORT_DATASETS = [
  {
    dataset: 'intents',
    formats: ['json', 'csv', 'ndjson'],
    description: 'Snapshot filtered intent rows for incident review or handoff.',
  },
  {
    dataset: 'audit',
    formats: ['json', 'csv', 'ndjson'],
    description: 'Export control-plane activity, role changes, and prune history.',
  },
  {
    dataset: 'errors',
    formats: ['json', 'csv', 'ndjson'],
    description: 'Download aggregated error hotspots and affected routes.',
  },
  {
    dataset: 'federation',
    formats: ['json', 'csv', 'ndjson'],
    description: 'Capture peer status, cache age, and trust assertions.',
  },
  {
    dataset: 'alerts',
    formats: ['json', 'csv', 'ndjson'],
    description: 'Store the current heuristic alert set with threshold reasoning.',
  },
] as const

function parseLimit(value: string | undefined, fallback: number, max = 500): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.min(max, parsed))
}

function parseHours(value: string | undefined, fallback: number, max = 24 * 90): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.min(max, parsed))
}

function parseDays(value: string | undefined, fallback: number, max = 3650): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.min(max, parsed))
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function nowMinusHours(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function nowMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function buildDashboardSearch(params: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    query.set(key, String(value))
  }

  const serialized = query.toString()
  return serialized ? `?${serialized}` : ''
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1))
  return sorted[index] ?? null
}

function bucketSizeHours(windowHours: number): number {
  if (windowHours <= 24) {
    return 1
  }

  if (windowHours <= 24 * 7) {
    return 6
  }

  return 24
}

function toBucketStart(isoTimestamp: string, bucketHours: number): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp
  }

  const utcHours = date.getUTCHours()
  const snappedHours = Math.floor(utcHours / bucketHours) * bucketHours
  date.setUTCMinutes(0, 0, 0)
  date.setUTCHours(snappedHours)
  return date.toISOString()
}

function serializeIntentRow(row: IntentLogRow) {
  const lifecycleStatus = normalizeIntentLifecycleStatus(row.status) ?? 'received'
  return {
    nonce: row.nonce,
    from: row.from_beam_id,
    to: row.to_beam_id,
    intentType: row.intent_type,
    timestamp: row.requested_at,
    completedAt: row.completed_at,
    roundTripLatencyMs: row.round_trip_latency_ms,
    status: lifecycleStatus,
    errorCode: isIntentLifecycleFailure(lifecycleStatus) ? row.error_code : null,
  }
}

function serializeTraceEvent(row: IntentTraceEventRow) {
  const lifecycleStatus = normalizeIntentLifecycleStatus(row.stage)
    ?? normalizeLegacyTraceLifecycle(row.stage, row.status)
    ?? 'received'
  return {
    id: row.id,
    nonce: row.nonce,
    from: row.from_beam_id,
    to: row.to_beam_id,
    intentType: row.intent_type,
    stage: lifecycleStatus,
    status: lifecycleStatus,
    timestamp: row.timestamp,
    details: parseJson<Record<string, unknown> | null>(row.details, null),
  }
}

function serializeAlertTraceSample(row: IntentLogRow): AlertTraceSample {
  return {
    nonce: row.nonce,
    from: row.from_beam_id,
    to: row.to_beam_id,
    intentType: row.intent_type,
    requestedAt: row.requested_at,
    status: normalizeIntentLifecycleStatus(row.status) ?? 'received',
    errorCode: row.error_code ?? null,
  }
}

function serializeAuditRow(row: AuditLogRow) {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    target: row.target,
    timestamp: row.timestamp,
    details: parseJson<Record<string, unknown> | null>(row.details, null),
  }
}

function serializeShieldRow(row: ShieldAuditLogRow) {
  return {
    id: row.id,
    nonce: row.nonce,
    timestamp: row.timestamp,
    senderBeamId: row.sender_beam_id,
    senderTrust: row.sender_trust,
    intentType: row.intent_type,
    payloadHash: row.payload_hash,
    decision: row.decision,
    riskScore: row.risk_score,
    responseSize: row.response_size,
    anomalyFlags: parseJson<string[]>(row.anomaly_flags, []),
    createdAt: row.created_at,
  }
}

function buildIntentWhereClause(query: IntentQuery): { whereClause: string; params: BindValue[] } {
  const conditions: string[] = []
  const params: BindValue[] = []

  if (query.fromBeamId) {
    conditions.push('from_beam_id = ?')
    params.push(query.fromBeamId)
  }

  if (query.toBeamId) {
    conditions.push('to_beam_id = ?')
    params.push(query.toBeamId)
  }

  if (query.intentType) {
    conditions.push('intent_type = ?')
    params.push(query.intentType)
  }

  if (query.status && query.status !== 'all') {
    const normalized = normalizeIntentLifecycleStatus(query.status)
    if (query.status === 'success') {
      conditions.push(`status = 'acked'`)
    } else if (query.status === 'error') {
      conditions.push(`status IN ('failed', 'dead_letter')`)
    } else if (query.status === 'pending' || query.status === 'in_flight') {
      conditions.push(`status NOT IN ('acked', 'failed', 'dead_letter')`)
    } else if (normalized) {
      conditions.push('status = ?')
      params.push(normalized)
    } else {
      conditions.push('status = ?')
      params.push(query.status)
    }
  }

  if (query.errorCode) {
    conditions.push('error_code = ?')
    params.push(query.errorCode)
  }

  if (query.q) {
    const like = `%${query.q}%`
    conditions.push('(nonce LIKE ? OR from_beam_id LIKE ? OR to_beam_id LIKE ? OR intent_type LIKE ? OR COALESCE(error_code, \'\') LIKE ?)')
    params.push(like, like, like, like, like)
  }

  if (query.sinceHours) {
    conditions.push('requested_at >= ?')
    params.push(nowMinusHours(query.sinceHours))
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function searchIntentRows(db: Database, query: IntentQuery): { intents: IntentLogRow[]; total: number } {
  const { whereClause, params } = buildIntentWhereClause(query)
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM intent_log
    ${whereClause}
  `).get(...params) as { count: number } | undefined

  const intents = db.prepare(`
    SELECT *
    FROM intent_log
    ${whereClause}
    ORDER BY requested_at DESC, id DESC
    LIMIT ${query.limit}
  `).all(...params) as IntentLogRow[]

  return { intents, total: totalRow?.count ?? intents.length }
}

function searchAuditRows(
  db: Database,
  query: { limit: number; action?: string; actor?: string; target?: string; q?: string; sinceHours?: number },
): { entries: AuditLogRow[]; total: number } {
  const conditions: string[] = []
  const params: BindValue[] = []

  if (query.action) {
    conditions.push('action = ?')
    params.push(query.action)
  }

  if (query.actor) {
    conditions.push('actor = ?')
    params.push(query.actor)
  }

  if (query.target) {
    conditions.push('target = ?')
    params.push(query.target)
  }

  if (query.q) {
    const like = `%${query.q}%`
    conditions.push('(action LIKE ? OR actor LIKE ? OR target LIKE ? OR COALESCE(details, \'\') LIKE ?)')
    params.push(like, like, like, like)
  }

  if (query.sinceHours) {
    conditions.push('timestamp >= ?')
    params.push(nowMinusHours(query.sinceHours))
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    ${whereClause}
  `).get(...params) as { count: number } | undefined

  const entries = db.prepare(`
    SELECT *
    FROM audit_log
    ${whereClause}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${query.limit}
  `).all(...params) as AuditLogRow[]

  return { entries, total: totalRow?.count ?? entries.length }
}

function buildOverviewPayload(db: Database, windowHours: number) {
  const since = nowMinusHours(windowHours)
  const rows = db.prepare(`
    SELECT *
    FROM intent_log
    WHERE requested_at >= ?
    ORDER BY requested_at ASC, id ASC
  `).all(since) as IntentLogRow[]

  const bucketHours = bucketSizeHours(windowHours)
  const bucketMap = new Map<string, {
    bucketStart: string
    total: number
    success: number
    error: number
    inFlight: number
    latencies: number[]
  }>()

  const intentTypeMap = new Map<string, {
    intentType: string
    total: number
    errors: number
    latencies: number[]
  }>()

  const errorCodeMap = new Map<string, {
    errorCode: string
    count: number
    lastSeenAt: string
  }>()

  const latencies = rows
    .map((row) => row.round_trip_latency_ms)
    .filter((value): value is number => typeof value === 'number')

  for (const row of rows) {
    const lifecycleStatus = normalizeIntentLifecycleStatus(row.status) ?? 'received'
    const lifecycleBucket = classifyIntentLifecycle(lifecycleStatus)
    const bucketStart = toBucketStart(row.requested_at, bucketHours)
    const bucket = bucketMap.get(bucketStart) ?? {
      bucketStart,
      total: 0,
      success: 0,
      error: 0,
      inFlight: 0,
      latencies: [],
    }
    bucket.total += 1
    if (lifecycleBucket === 'success') {
      bucket.success += 1
    } else if (lifecycleBucket === 'error') {
      bucket.error += 1
    } else {
      bucket.inFlight += 1
    }
    if (typeof row.round_trip_latency_ms === 'number') {
      bucket.latencies.push(row.round_trip_latency_ms)
    }
    bucketMap.set(bucketStart, bucket)

    const intentEntry = intentTypeMap.get(row.intent_type) ?? {
      intentType: row.intent_type,
      total: 0,
      errors: 0,
      latencies: [],
    }
    intentEntry.total += 1
    if (lifecycleBucket === 'error') {
      intentEntry.errors += 1
    }
    if (typeof row.round_trip_latency_ms === 'number') {
      intentEntry.latencies.push(row.round_trip_latency_ms)
    }
    intentTypeMap.set(row.intent_type, intentEntry)

    if (row.error_code) {
      const errorEntry = errorCodeMap.get(row.error_code) ?? {
        errorCode: row.error_code,
        count: 0,
        lastSeenAt: row.requested_at,
      }
      errorEntry.count += 1
      if (row.requested_at > errorEntry.lastSeenAt) {
        errorEntry.lastSeenAt = row.requested_at
      }
      errorCodeMap.set(row.error_code, errorEntry)
    }
  }

  const totalAgents = (db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number } | undefined)?.count ?? 0
  const liveAgents = (db.prepare('SELECT COUNT(*) AS count FROM agents WHERE last_seen >= ?').get(nowMinusHours(1)) as { count: number } | undefined)?.count ?? 0
  const staleAgents = (db.prepare('SELECT COUNT(*) AS count FROM agents WHERE last_seen < ?').get(nowMinusHours(24)) as { count: number } | undefined)?.count ?? 0
  const federatedAgents = (db.prepare('SELECT COUNT(*) AS count FROM federated_agents').get() as { count: number } | undefined)?.count ?? 0
  const federationPeers = (db.prepare('SELECT COUNT(*) AS count FROM federation_peers').get() as { count: number } | undefined)?.count ?? 0

  const inFlightOlderThan15m = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM intent_log
    WHERE status NOT IN ('acked', 'failed', 'dead_letter') AND requested_at < ?
  `).get(new Date(Date.now() - 15 * 60 * 1000).toISOString()) as { count: number } | undefined)?.count ?? 0

  const timeline = Array.from(bucketMap.values())
    .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
    .map((bucket) => ({
      bucketStart: bucket.bucketStart,
      total: bucket.total,
      success: bucket.success,
      error: bucket.error,
      inFlight: bucket.inFlight,
      p95LatencyMs: percentile(bucket.latencies, 0.95),
    }))

  const summary = {
    totalAgents,
    liveAgents,
    staleAgents,
    federatedAgents,
    federationPeers,
    totalIntents: rows.length,
    successCount: rows.filter((row) => isIntentLifecycleSuccess(normalizeIntentLifecycleStatus(row.status) ?? 'received')).length,
    errorCount: rows.filter((row) => isIntentLifecycleFailure(normalizeIntentLifecycleStatus(row.status) ?? 'received')).length,
    inFlightCount: rows.filter((row) => classifyIntentLifecycle(normalizeIntentLifecycleStatus(row.status) ?? 'received') === 'in_flight').length,
    avgLatencyMs: latencies.length > 0 ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    p95LatencyMs: percentile(latencies, 0.95),
    successRate: rows.length > 0 ? round(rows.filter((row) => isIntentLifecycleSuccess(normalizeIntentLifecycleStatus(row.status) ?? 'received')).length / rows.length, 4) : 0,
    inFlightOlderThan15m,
  }

  return {
    windowHours,
    summary,
    timeline,
    topIntents: Array.from(intentTypeMap.values())
      .sort((left, right) => right.total - left.total)
      .slice(0, 8)
      .map((entry) => ({
        intentType: entry.intentType,
        total: entry.total,
        errors: entry.errors,
        avgLatencyMs: entry.latencies.length > 0 ? round(entry.latencies.reduce((sum, value) => sum + value, 0) / entry.latencies.length) : null,
      })),
    topErrors: Array.from(errorCodeMap.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 8),
  }
}

function buildAgentHealthPayload(db: Database, beamId: string, windowHours: number) {
  const agent = getAgent(db, beamId)
  if (!agent) {
    return null
  }

  const since = nowMinusHours(windowHours)
  const rows = db.prepare(`
    SELECT *
    FROM intent_log
    WHERE requested_at >= ? AND (from_beam_id = ? OR to_beam_id = ?)
    ORDER BY requested_at ASC, id ASC
  `).all(since, beamId, beamId) as IntentLogRow[]

  const outbound = rows.filter((row) => row.from_beam_id === beamId)
  const inbound = rows.filter((row) => row.to_beam_id === beamId)
  const completed = rows.filter((row) => classifyIntentLifecycle(normalizeIntentLifecycleStatus(row.status) ?? 'received') !== 'in_flight')
  const latencies = completed
    .map((row) => row.round_trip_latency_ms)
    .filter((value): value is number => typeof value === 'number')

  const bucketHours = bucketSizeHours(windowHours)
  const timelineMap = new Map<string, {
    bucketStart: string
    sent: number
    received: number
    success: number
    error: number
    latencies: number[]
  }>()

  const counterpartyMap = new Map<string, {
    beamId: string
    outbound: number
    inbound: number
    errors: number
  }>()

  const intentTypeMap = new Map<string, {
    intentType: string
    total: number
    errors: number
    latencies: number[]
  }>()

  const errorMap = new Map<string, {
    errorCode: string
    count: number
    lastSeenAt: string
  }>()

  for (const row of rows) {
    const lifecycleStatus = normalizeIntentLifecycleStatus(row.status) ?? 'received'
    const lifecycleBucket = classifyIntentLifecycle(lifecycleStatus)
    const bucketStart = toBucketStart(row.requested_at, bucketHours)
    const bucket = timelineMap.get(bucketStart) ?? {
      bucketStart,
      sent: 0,
      received: 0,
      success: 0,
      error: 0,
      latencies: [],
    }
    if (row.from_beam_id === beamId) {
      bucket.sent += 1
    }
    if (row.to_beam_id === beamId) {
      bucket.received += 1
    }
    if (lifecycleBucket === 'success') {
      bucket.success += 1
    }
    if (lifecycleBucket === 'error') {
      bucket.error += 1
    }
    if (typeof row.round_trip_latency_ms === 'number') {
      bucket.latencies.push(row.round_trip_latency_ms)
    }
    timelineMap.set(bucketStart, bucket)

    const counterpartyBeamId = row.from_beam_id === beamId ? row.to_beam_id : row.from_beam_id
    const counterparty = counterpartyMap.get(counterpartyBeamId) ?? {
      beamId: counterpartyBeamId,
      outbound: 0,
      inbound: 0,
      errors: 0,
    }
    if (row.from_beam_id === beamId) {
      counterparty.outbound += 1
    } else {
      counterparty.inbound += 1
    }
    if (lifecycleBucket === 'error') {
      counterparty.errors += 1
    }
    counterpartyMap.set(counterpartyBeamId, counterparty)

    const intentEntry = intentTypeMap.get(row.intent_type) ?? {
      intentType: row.intent_type,
      total: 0,
      errors: 0,
      latencies: [],
    }
    intentEntry.total += 1
    if (lifecycleBucket === 'error') {
      intentEntry.errors += 1
    }
    if (typeof row.round_trip_latency_ms === 'number') {
      intentEntry.latencies.push(row.round_trip_latency_ms)
    }
    intentTypeMap.set(row.intent_type, intentEntry)

    if (row.error_code) {
      const errorEntry = errorMap.get(row.error_code) ?? {
        errorCode: row.error_code,
        count: 0,
        lastSeenAt: row.requested_at,
      }
      errorEntry.count += 1
      if (row.requested_at > errorEntry.lastSeenAt) {
        errorEntry.lastSeenAt = row.requested_at
      }
      errorMap.set(row.error_code, errorEntry)
    }
  }

  const currentPeriod = new Date().toISOString().slice(0, 7)
  const usage = db.prepare(`
    SELECT intent_count, encrypted_count, direct_count, relayed_count
    FROM usage_metering
    WHERE beam_id = ? AND period = ?
  `).get(beamId, currentPeriod) as {
    intent_count: number
    encrypted_count: number
    direct_count: number
    relayed_count: number
  } | undefined

  const shieldRows = listShieldAuditLog(db, { senderBeamId: beamId, limit: 500 })
    .filter((row) => row.created_at >= since)

  return {
    beamId,
    windowHours,
    summary: {
      beamId,
      displayName: agent.display_name,
      trustScore: agent.trust_score,
      verificationTier: agent.verification_tier,
      lastSeen: agent.last_seen,
      sentCount: outbound.length,
      receivedCount: inbound.length,
      completedCount: completed.length,
      successRate: completed.length > 0 ? round(completed.filter((row) => isIntentLifecycleSuccess(normalizeIntentLifecycleStatus(row.status) ?? 'received')).length / completed.length, 4) : 0,
      errorRate: completed.length > 0 ? round(completed.filter((row) => isIntentLifecycleFailure(normalizeIntentLifecycleStatus(row.status) ?? 'received')).length / completed.length, 4) : 0,
      avgLatencyMs: latencies.length > 0 ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      p95LatencyMs: percentile(latencies, 0.95),
      uniqueCounterparties: counterpartyMap.size,
    },
    timeline: Array.from(timelineMap.values())
      .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
      .map((bucket) => ({
        bucketStart: bucket.bucketStart,
        sent: bucket.sent,
        received: bucket.received,
        success: bucket.success,
        error: bucket.error,
        p95LatencyMs: percentile(bucket.latencies, 0.95),
      })),
    counterparties: Array.from(counterpartyMap.values())
      .sort((left, right) => (right.inbound + right.outbound) - (left.inbound + left.outbound))
      .slice(0, 10),
    intents: Array.from(intentTypeMap.values())
      .sort((left, right) => right.total - left.total)
      .slice(0, 10)
      .map((entry) => ({
        intentType: entry.intentType,
        total: entry.total,
        errors: entry.errors,
        avgLatencyMs: entry.latencies.length > 0 ? round(entry.latencies.reduce((sum, value) => sum + value, 0) / entry.latencies.length) : null,
      })),
    errors: Array.from(errorMap.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    usage: {
      period: currentPeriod,
      intentCount: usage?.intent_count ?? 0,
      encryptedCount: usage?.encrypted_count ?? 0,
      directCount: usage?.direct_count ?? 0,
      relayedCount: usage?.relayed_count ?? 0,
    },
    shield: {
      total: shieldRows.length,
      passed: shieldRows.filter((row) => row.decision === 'pass').length,
      held: shieldRows.filter((row) => row.decision === 'hold').length,
      rejected: shieldRows.filter((row) => row.decision === 'reject').length,
      highRiskCount: shieldRows.filter((row) => (row.risk_score ?? 0) >= 0.65).length,
    },
  }
}

function buildFederationPayload(db: Database) {
  const peerRows = db.prepare(`
    SELECT *
    FROM federation_peers
    ORDER BY trust_level DESC, directory_url ASC
  `).all() as FederationPeerRow[]

  const cachedRows = db.prepare(`
    SELECT home_directory_url, COUNT(*) AS cached_agents, MAX(cached_at) AS last_cached_at
    FROM federated_agents
    GROUP BY home_directory_url
  `).all() as Array<{ home_directory_url: string; cached_agents: number; last_cached_at: string | null }>

  const trustRows = db.prepare(`
    SELECT
      source_directory_url,
      COUNT(*) AS trust_assertions,
      AVG(effective_trust) AS avg_effective_trust,
      MAX(asserted_at) AS last_asserted_at
    FROM federated_trust
    GROUP BY source_directory_url
  `).all() as Array<{
    source_directory_url: string
    trust_assertions: number
    avg_effective_trust: number | null
    last_asserted_at: string | null
  }>

  const trustByPeer = new Map(trustRows.map((row) => [row.source_directory_url, row]))
  const cacheByPeer = new Map(cachedRows.map((row) => [row.home_directory_url, row]))
  const staleCutoff = nowMinusHours(24)

  const peers = peerRows.map((peer) => {
    const cache = cacheByPeer.get(peer.directory_url)
    const trust = trustByPeer.get(peer.directory_url)
    const stale = !peer.last_seen || peer.last_seen < staleCutoff || peer.status !== 'active'

    return {
      id: peer.id,
      directoryUrl: peer.directory_url,
      trustLevel: peer.trust_level,
      status: peer.status,
      createdAt: peer.created_at,
      lastSeen: peer.last_seen,
      syncedAt: peer.synced_at,
      cachedAgents: cache?.cached_agents ?? 0,
      lastCachedAt: cache?.last_cached_at ?? null,
      trustAssertions: trust?.trust_assertions ?? 0,
      avgEffectiveTrust: trust?.avg_effective_trust == null ? null : round(trust.avg_effective_trust, 4),
      lastAssertedAt: trust?.last_asserted_at ?? null,
      stale,
    }
  })

  const federatedAgents = db.prepare(`
    SELECT
      fa.beam_id,
      fa.home_directory_url,
      fa.cached_at,
      fa.ttl,
      MAX(ft.effective_trust) AS effective_trust
    FROM federated_agents fa
    LEFT JOIN federated_trust ft ON ft.beam_id = fa.beam_id
    GROUP BY fa.beam_id, fa.home_directory_url, fa.cached_at, fa.ttl
    ORDER BY fa.cached_at DESC
    LIMIT 20
  `).all() as Array<{
    beam_id: string
    home_directory_url: string
    cached_at: string
    ttl: number
    effective_trust: number | null
  }>

  const totalCachedAgents = cachedRows.reduce((sum, row) => sum + row.cached_agents, 0)

  return {
    summary: {
      peerCount: peers.length,
      activePeers: peers.filter((peer) => peer.status === 'active' && !peer.stale).length,
      stalePeers: peers.filter((peer) => peer.stale).length,
      cachedAgents: totalCachedAgents,
      trustAssertions: trustRows.reduce((sum, row) => sum + row.trust_assertions, 0),
      avgPeerTrust: peers.length > 0 ? round(peers.reduce((sum, peer) => sum + peer.trustLevel, 0) / peers.length, 4) : 0,
    },
    peers,
    agents: federatedAgents.map((agent) => ({
      beamId: agent.beam_id,
      directoryUrl: agent.home_directory_url,
      cachedAt: agent.cached_at,
      ttl: agent.ttl,
      effectiveTrust: agent.effective_trust == null ? null : round(agent.effective_trust, 4),
    })),
  }
}

function buildErrorsPayload(db: Database, windowHours: number) {
  const since = nowMinusHours(windowHours)
  const rows = db.prepare(`
    SELECT *
    FROM intent_log
    WHERE status IN ('failed', 'dead_letter') AND requested_at >= ?
    ORDER BY requested_at ASC, id ASC
  `).all(since) as IntentLogRow[]

  const bucketHours = bucketSizeHours(windowHours)
  const timelineMap = new Map<string, { bucketStart: string; total: number }>()
  const codeMap = new Map<string, {
    errorCode: string
    count: number
    lastSeenAt: string
    latencies: number[]
    senders: Set<string>
    recipients: Set<string>
  }>()
  const routeMap = new Map<string, { route: string; count: number }>()

  for (const row of rows) {
    const bucketStart = toBucketStart(row.requested_at, bucketHours)
    const bucket = timelineMap.get(bucketStart) ?? { bucketStart, total: 0 }
    bucket.total += 1
    timelineMap.set(bucketStart, bucket)

    const errorCode = row.error_code ?? 'UNKNOWN'
    const codeEntry = codeMap.get(errorCode) ?? {
      errorCode,
      count: 0,
      lastSeenAt: row.requested_at,
      latencies: [],
      senders: new Set<string>(),
      recipients: new Set<string>(),
    }
    codeEntry.count += 1
    if (row.requested_at > codeEntry.lastSeenAt) {
      codeEntry.lastSeenAt = row.requested_at
    }
    if (typeof row.round_trip_latency_ms === 'number') {
      codeEntry.latencies.push(row.round_trip_latency_ms)
    }
    codeEntry.senders.add(row.from_beam_id)
    codeEntry.recipients.add(row.to_beam_id)
    codeMap.set(errorCode, codeEntry)

    const routeKey = `${row.from_beam_id} → ${row.to_beam_id}`
    const route = routeMap.get(routeKey) ?? { route: routeKey, count: 0 }
    route.count += 1
    routeMap.set(routeKey, route)
  }

  return {
    windowHours,
    summary: {
      totalErrors: rows.length,
      distinctErrorCodes: codeMap.size,
      timeoutCount: rows.filter((row) => row.error_code === 'TIMEOUT').length,
      offlineCount: rows.filter((row) => row.error_code === 'OFFLINE').length,
      deliveryFailedCount: rows.filter((row) => row.error_code === 'DELIVERY_FAILED').length,
    },
    timeline: Array.from(timelineMap.values()).sort((left, right) => left.bucketStart.localeCompare(right.bucketStart)),
    codes: Array.from(codeMap.values())
      .sort((left, right) => right.count - left.count)
      .map((entry) => ({
        errorCode: entry.errorCode,
        count: entry.count,
        lastSeenAt: entry.lastSeenAt,
        avgLatencyMs: entry.latencies.length > 0 ? round(entry.latencies.reduce((sum, value) => sum + value, 0) / entry.latencies.length) : null,
        affectedSenders: entry.senders.size,
        affectedRecipients: entry.recipients.size,
      })),
    routes: Array.from(routeMap.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
  }
}

function recentIntentSamples(
  db: Database,
  whereClause: string,
  params: BindValue[],
  limit = 3,
): AlertTraceSample[] {
  if (!whereClause.trim()) {
    return []
  }

  const rows = db.prepare(`
    SELECT *
    FROM intent_log
    ${whereClause}
    ORDER BY requested_at DESC, id DESC
    LIMIT ${limit}
  `).all(...params) as IntentLogRow[]

  return rows.map(serializeAlertTraceSample)
}

function buildAlertLinks(
  alertId: string,
  primaryPath: string,
  primaryLabel: string,
  primarySurface: AlertLinkSurface,
  primaryParams: Record<string, string | number | undefined | null>,
  extra: Array<{
    path: string
    label: string
    surface: AlertLinkSurface
    params?: Record<string, string | number | undefined | null>
  }> = [],
): AlertLink[] {
  return [
    {
      label: primaryLabel,
      href: `${primaryPath}${buildDashboardSearch({ alert: alertId, ...primaryParams })}`,
      surface: primarySurface,
    },
    ...extra.map((entry) => ({
      label: entry.label,
      href: `${entry.path}${buildDashboardSearch({ alert: alertId, ...entry.params })}`,
      surface: entry.surface,
    })),
  ]
}

function buildAlerts(db: Database, windowHours: number): AlertItem[] {
  const overview = buildOverviewPayload(db, windowHours)
  const errors = buildErrorsPayload(db, windowHours)
  const federation = buildFederationPayload(db)
  const alerts: AlertItem[] = []
  const since = nowMinusHours(windowHours)

  const completedCount = overview.summary.successCount + overview.summary.errorCount
  const errorRate = completedCount > 0 ? overview.summary.errorCount / completedCount : 0
  if (completedCount >= 10 && errorRate >= 0.1) {
    const sampleTraces = recentIntentSamples(
      db,
      "WHERE requested_at >= ? AND status IN ('failed', 'dead_letter')",
      [since],
    )
    const latestNonce = sampleTraces[0]?.nonce
    alerts.push({
      id: 'network-error-rate',
      severity: errorRate >= 0.25 ? 'critical' : 'warning',
      title: 'Error rate exceeded threshold',
      scope: 'network',
      message: `${Math.round(errorRate * 100)}% of completed intents failed in the selected window.`,
      metric: 'error_rate',
      value: round(errorRate, 4),
      threshold: 0.1,
      valueUnit: 'ratio',
      startedAt: sampleTraces[0]?.requestedAt ?? new Date().toISOString(),
      thresholdExplanation: 'Beam raises this alert once completed intent failures cross 10% of the selected window.',
      severityReason: errorRate >= 0.25
        ? 'Critical because the network error rate is at or above the 25% escalation threshold.'
        : 'Warning because the network error rate is above the 10% investigation threshold.',
      links: buildAlertLinks(
        'network-error-rate',
        '/intents',
        'Open failing intents',
        'intents',
        { status: 'error', hours: windowHours },
        [
          latestNonce
            ? {
              path: `/intents/${encodeURIComponent(latestNonce)}`,
              label: 'Open latest failing trace',
              surface: 'trace' as const,
            }
            : null,
          latestNonce
            ? {
              path: '/audit',
              label: 'Open audit for latest failing trace',
              surface: 'audit' as const,
              params: { target: latestNonce, hours: windowHours },
            }
            : null,
          {
            path: '/errors',
            label: 'Open error dashboard',
            surface: 'errors' as const,
            params: { alert: 'network-error-rate' },
          },
        ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      ),
      sampleTraces,
    })
  }

  if ((overview.summary.p95LatencyMs ?? 0) >= 2000) {
    const sampleTraces = recentIntentSamples(
      db,
      'WHERE requested_at >= ? AND round_trip_latency_ms >= ?',
      [since, 2000],
    )
    const latestNonce = sampleTraces[0]?.nonce
    alerts.push({
      id: 'network-latency-p95',
      severity: (overview.summary.p95LatencyMs ?? 0) >= 5000 ? 'critical' : 'warning',
      title: 'p95 latency is elevated',
      scope: 'network',
      message: `p95 intent latency is ${overview.summary.p95LatencyMs}ms.`,
      metric: 'p95_latency_ms',
      value: overview.summary.p95LatencyMs ?? 0,
      threshold: 2000,
      valueUnit: 'ms',
      startedAt: sampleTraces[0]?.requestedAt ?? new Date().toISOString(),
      thresholdExplanation: 'Beam raises this alert once p95 round-trip latency crosses 2 seconds in the selected window.',
      severityReason: (overview.summary.p95LatencyMs ?? 0) >= 5000
        ? 'Critical because p95 latency crossed the 5 second escalation threshold.'
        : 'Warning because p95 latency crossed the 2 second investigation threshold.',
      links: buildAlertLinks(
        'network-latency-p95',
        '/intents',
        'Open recent intents',
        'intents',
        { hours: windowHours },
        [
          latestNonce
            ? {
              path: `/intents/${encodeURIComponent(latestNonce)}`,
              label: 'Open slowest recent trace',
              surface: 'trace' as const,
            }
            : null,
          latestNonce
            ? {
              path: '/audit',
              label: 'Open audit for latest slow trace',
              surface: 'audit' as const,
              params: { target: latestNonce, hours: windowHours },
            }
            : null,
        ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      ),
      sampleTraces,
    })
  }

  if (overview.summary.inFlightOlderThan15m > 0) {
    const sampleTraces = recentIntentSamples(
      db,
      "WHERE status NOT IN ('acked', 'failed', 'dead_letter') AND requested_at < ?",
      [new Date(Date.now() - 15 * 60 * 1000).toISOString()],
    )
    const latestNonce = sampleTraces[0]?.nonce
    alerts.push({
      id: 'network-in-flight-backlog',
      severity: overview.summary.inFlightOlderThan15m >= 5 ? 'critical' : 'warning',
      title: 'In-flight intent backlog detected',
      scope: 'network',
      message: `${overview.summary.inFlightOlderThan15m} intents have remained in-flight for more than 15 minutes.`,
      metric: 'in_flight_older_than_15m',
      value: overview.summary.inFlightOlderThan15m,
      threshold: 1,
      valueUnit: 'count',
      startedAt: sampleTraces[0]?.requestedAt ?? new Date().toISOString(),
      thresholdExplanation: 'Beam raises this alert when at least one intent has been in flight for more than 15 minutes.',
      severityReason: overview.summary.inFlightOlderThan15m >= 5
        ? 'Critical because five or more in-flight intents exceeded the 15 minute backlog threshold.'
        : 'Warning because at least one in-flight intent exceeded the 15 minute backlog threshold.',
      links: buildAlertLinks(
        'network-in-flight-backlog',
        '/intents',
        'Open in-flight intents',
        'intents',
        { status: 'in_flight', hours: windowHours },
        [
          latestNonce
            ? {
              path: `/intents/${encodeURIComponent(latestNonce)}`,
              label: 'Open oldest in-flight trace',
              surface: 'trace' as const,
            }
            : null,
          latestNonce
            ? {
              path: '/audit',
              label: 'Open audit for oldest in-flight trace',
              surface: 'audit' as const,
              params: { target: latestNonce, hours: windowHours },
            }
            : null,
        ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      ),
      sampleTraces,
    })
  }

  if (federation.summary.stalePeers > 0) {
    alerts.push({
      id: 'federation-stale-peers',
      severity: federation.summary.stalePeers >= 2 ? 'critical' : 'warning',
      title: 'Federation peers are stale',
      scope: 'federation',
      message: `${federation.summary.stalePeers} peer directories have stale sync or heartbeat data.`,
      metric: 'stale_peers',
      value: federation.summary.stalePeers,
      threshold: 1,
      valueUnit: 'count',
      startedAt: new Date().toISOString(),
      thresholdExplanation: 'Beam raises this alert when at least one federated peer is stale or has stopped syncing.',
      severityReason: federation.summary.stalePeers >= 2
        ? 'Critical because two or more federation peers are stale.'
        : 'Warning because at least one federation peer is stale.',
      links: buildAlertLinks(
        'federation-stale-peers',
        '/federation',
        'Open federation health',
        'federation',
        {},
        [
          {
            path: '/audit',
            label: 'Open federation audit history',
            surface: 'audit' as const,
            params: { q: 'federation', hours: windowHours },
          },
        ],
      ),
      sampleTraces: [],
    })
  }

  const shieldRow = db.prepare(`
    SELECT
      SUM(CASE WHEN decision = 'reject' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN decision = 'hold' THEN 1 ELSE 0 END) AS held
    FROM shield_audit_log
    WHERE created_at >= ?
  `).get(nowMinusHours(windowHours)) as { rejected: number | null; held: number | null } | undefined

  const rejected = shieldRow?.rejected ?? 0
  const held = shieldRow?.held ?? 0
  if (rejected >= 3 || held >= 5) {
    const sampleTraces = recentIntentSamples(
      db,
      `WHERE nonce IN (
        SELECT nonce
        FROM shield_audit_log
        WHERE created_at >= ? AND decision IN ('reject', 'hold') AND nonce IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 3
      )`,
      [since],
    )
    const latestNonce = sampleTraces[0]?.nonce
    alerts.push({
      id: 'shield-review-load',
      severity: rejected >= 5 ? 'critical' : 'warning',
      title: 'Shield is flagging elevated traffic',
      scope: 'shield',
      message: `${rejected} rejects and ${held} holds were recorded in the selected window.`,
      metric: 'shield_flagged_events',
      value: rejected + held,
      threshold: 5,
      valueUnit: 'count',
      startedAt: sampleTraces[0]?.requestedAt ?? new Date().toISOString(),
      thresholdExplanation: 'Beam raises this alert when Shield records at least three rejects or five held requests in the selected window.',
      severityReason: rejected >= 5
        ? 'Critical because Shield recorded five or more rejected requests.'
        : 'Warning because Shield review volume crossed the hold and reject thresholds.',
      links: buildAlertLinks(
        'shield-review-load',
        '/audit',
        'Open Shield audit history',
        'audit',
        { q: 'shield', hours: windowHours },
        [
          latestNonce
            ? {
              path: `/intents/${encodeURIComponent(latestNonce)}`,
              label: 'Open latest flagged trace',
              surface: 'trace' as const,
            }
            : null,
          {
            path: '/alerts',
            label: 'Open alert feed',
            surface: 'alerts' as const,
            params: { hours: windowHours },
          },
        ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      ),
      sampleTraces,
    })
  }

  const topError = errors.codes[0]
  if (topError && topError.count >= 5) {
    const sampleTraces = recentIntentSamples(
      db,
      "WHERE requested_at >= ? AND error_code = ? AND status IN ('failed', 'dead_letter')",
      [since, topError.errorCode],
    )
    const latestNonce = sampleTraces[0]?.nonce
    alerts.push({
      id: `error-hotspot-${topError.errorCode.toLowerCase()}`,
      severity: topError.count >= 10 ? 'critical' : 'warning',
      title: `Error hotspot: ${topError.errorCode}`,
      scope: 'agent',
      message: `${topError.count} intents failed with ${topError.errorCode}.`,
      metric: 'error_code_count',
      value: topError.count,
      threshold: 5,
      valueUnit: 'count',
      startedAt: topError.lastSeenAt,
      thresholdExplanation: 'Beam raises this alert when the same error code occurs at least five times in the selected window.',
      severityReason: topError.count >= 10
        ? `Critical because ${topError.errorCode} crossed the 10 failure escalation threshold.`
        : `Warning because ${topError.errorCode} crossed the 5 failure investigation threshold.`,
      links: buildAlertLinks(
        `error-hotspot-${topError.errorCode.toLowerCase()}`,
        '/intents',
        `Open ${topError.errorCode} intents`,
        'intents',
        { status: 'error', q: topError.errorCode, hours: windowHours },
        [
          latestNonce
            ? {
              path: `/intents/${encodeURIComponent(latestNonce)}`,
              label: 'Open latest hotspot trace',
              surface: 'trace' as const,
            }
            : null,
          latestNonce
            ? {
              path: '/audit',
              label: 'Open audit for latest hotspot trace',
              surface: 'audit' as const,
              params: { target: latestNonce, hours: windowHours },
            }
            : null,
          {
            path: '/errors',
            label: 'Open error analytics',
            surface: 'errors' as const,
            params: { alert: `error-hotspot-${topError.errorCode.toLowerCase()}` },
          },
        ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      ),
      sampleTraces,
    })
  }

  return alerts.sort((left, right) => {
    const severityOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
    return severityOrder[left.severity] - severityOrder[right.severity]
  })
}

function createSyntheticTrace(intent: IntentLogRow): Array<ReturnType<typeof serializeTraceEvent>> {
  const lifecycleStatus = normalizeIntentLifecycleStatus(intent.status) ?? 'received'
  const stages: Array<ReturnType<typeof serializeTraceEvent>> = [
    {
      id: 0,
      nonce: intent.nonce,
      from: intent.from_beam_id,
      to: intent.to_beam_id,
      intentType: intent.intent_type,
      stage: 'received',
      status: 'received',
      timestamp: intent.requested_at,
      details: null,
    },
  ]

  if (lifecycleStatus !== 'received') {
    stages.push({
      id: -1,
      nonce: intent.nonce,
      from: intent.from_beam_id,
      to: intent.to_beam_id,
      intentType: intent.intent_type,
      stage: lifecycleStatus,
      status: lifecycleStatus,
      timestamp: intent.completed_at ?? intent.requested_at,
      details: {
        latencyMs: intent.round_trip_latency_ms,
        errorCode: intent.error_code,
      },
    })
  }

  return stages
}

function flattenCsvValue(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return ''
  }

  const keys = Array.from(rows.reduce((acc, row) => {
    for (const key of Object.keys(row)) {
      acc.add(key)
    }
    return acc
  }, new Set<string>()))

  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
  const lines = [keys.map(escape).join(',')]

  for (const row of rows) {
    lines.push(keys.map((key) => escape(flattenCsvValue(row[key]))).join(','))
  }

  return lines.join('\n')
}

function pruneDataset(db: Database, dataset: string, olderThanDays: number): { deleted: number; extra?: Record<string, number> } {
  const cutoff = nowMinusDays(olderThanDays)

  switch (dataset) {
    case 'intents': {
      const intents = db.prepare('DELETE FROM intent_log WHERE requested_at < ?').run(cutoff)
      const traces = db.prepare('DELETE FROM intent_trace_events WHERE timestamp < ?').run(cutoff)
      return { deleted: intents.changes + traces.changes, extra: { intents: intents.changes, traces: traces.changes } }
    }
    case 'traces': {
      const result = db.prepare('DELETE FROM intent_trace_events WHERE timestamp < ?').run(cutoff)
      return { deleted: result.changes }
    }
    case 'audit': {
      const result = db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff)
      return { deleted: result.changes }
    }
    case 'shield': {
      const result = db.prepare('DELETE FROM shield_audit_log WHERE created_at < ?').run(cutoff)
      return { deleted: result.changes }
    }
    default:
      throw new Error(`Unsupported dataset: ${dataset}`)
  }
}

function previewPruneDataset(db: Database, dataset: string, olderThanDays: number): { deleted: number; extra?: Record<string, number> } {
  const cutoff = nowMinusDays(olderThanDays)

  switch (dataset) {
    case 'intents': {
      const intents = (db.prepare('SELECT COUNT(*) AS count FROM intent_log WHERE requested_at < ?').get(cutoff) as { count: number } | undefined)?.count ?? 0
      const traces = (db.prepare('SELECT COUNT(*) AS count FROM intent_trace_events WHERE timestamp < ?').get(cutoff) as { count: number } | undefined)?.count ?? 0
      return { deleted: intents + traces, extra: { intents, traces } }
    }
    case 'traces': {
      const deleted = (db.prepare('SELECT COUNT(*) AS count FROM intent_trace_events WHERE timestamp < ?').get(cutoff) as { count: number } | undefined)?.count ?? 0
      return { deleted }
    }
    case 'audit': {
      const deleted = (db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE timestamp < ?').get(cutoff) as { count: number } | undefined)?.count ?? 0
      return { deleted }
    }
    case 'shield': {
      const deleted = (db.prepare('SELECT COUNT(*) AS count FROM shield_audit_log WHERE created_at < ?').get(cutoff) as { count: number } | undefined)?.count ?? 0
      return { deleted }
    }
    default:
      throw new Error(`Unsupported dataset: ${dataset}`)
  }
}

export function observabilityRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/overview', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const windowHours = parseHours(c.req.query('hours'), 24)
    const overview = buildOverviewPayload(db, windowHours)
    const alerts = buildAlerts(db, windowHours)
    return c.json({
      ...overview,
      alerts: alerts.slice(0, 5),
    })
  })

  router.get('/intents', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const result = searchIntentRows(db, {
      q: c.req.query('q') ?? undefined,
      fromBeamId: c.req.query('from') ?? undefined,
      toBeamId: c.req.query('to') ?? undefined,
      intentType: c.req.query('intentType') ?? undefined,
      status: c.req.query('status') ?? undefined,
      errorCode: c.req.query('errorCode') ?? undefined,
      limit: parseLimit(c.req.query('limit'), 100),
      sinceHours: c.req.query('hours') ? parseHours(c.req.query('hours'), 24 * 7) : undefined,
    })

    return c.json({
      intents: result.intents.map(serializeIntentRow),
      total: result.total,
    })
  })

  router.get('/intents/:nonce', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const nonce = c.req.param('nonce')
    const intent = db.prepare('SELECT * FROM intent_log WHERE nonce = ?').get(nonce) as IntentLogRow | undefined
    if (!intent) {
      return c.json({ error: 'Intent not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const trace = listIntentTraceEvents(db, nonce)
    const shield = listShieldAuditLog(db, { nonce, limit: 50 })
    const audit = listAuditLog(db, { limit: 100 })
      .filter((entry) => entry.target === nonce || entry.details?.includes?.(nonce))
      .slice(0, 25)
    const stages = trace.length > 0
      ? trace.map(serializeTraceEvent)
      : createSyntheticTrace(intent)

    return c.json({
      intent: serializeIntentRow(intent),
      stages,
      audit: audit.map(serializeAuditRow),
      shield: shield.map(serializeShieldRow),
    })
  })

  router.get('/audit', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const result = searchAuditRows(db, {
      limit: parseLimit(c.req.query('limit'), 100),
      action: c.req.query('action') ?? undefined,
      actor: c.req.query('actor') ?? undefined,
      target: c.req.query('target') ?? undefined,
      q: c.req.query('q') ?? undefined,
      sinceHours: c.req.query('hours') ? parseHours(c.req.query('hours'), 24 * 30) : undefined,
    })

    return c.json({
      entries: result.entries.map(serializeAuditRow),
      total: result.total,
    })
  })

  router.get('/agents/:beamId/health', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    const payload = buildAgentHealthPayload(db, beamId, parseHours(c.req.query('hours'), 24 * 7))
    if (!payload) {
      return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json(payload)
  })

  router.get('/federation', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    return c.json(buildFederationPayload(db))
  })

  router.get('/errors', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    return c.json(buildErrorsPayload(db, parseHours(c.req.query('hours'), 24 * 7)))
  })

  router.get('/alerts', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const windowHours = parseHours(c.req.query('hours'), 24)
    return c.json({
      windowHours,
      generatedAt: new Date().toISOString(),
      alerts: buildAlerts(db, windowHours),
      retention: {
        defaultDays: DEFAULT_RETENTION_DAYS,
        minimumDays: 1,
        confirmPhrasePrefix: 'prune',
        datasets: OBSERVABILITY_DATASETS.map((dataset) => dataset.name),
        details: OBSERVABILITY_DATASETS,
      },
      exports: EXPORT_DATASETS,
    })
  })

  router.get('/retention', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    return c.json({
      defaultDays: DEFAULT_RETENTION_DAYS,
      minimumDays: 1,
      confirmPhrasePrefix: 'prune',
      datasets: OBSERVABILITY_DATASETS.map((dataset) => dataset.name),
      details: OBSERVABILITY_DATASETS,
    })
  })

  router.get('/prune-preview', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const dataset = String(c.req.query('dataset') ?? '').trim()
    const olderThanDays = parseDays(c.req.query('olderThanDays'), DEFAULT_RETENTION_DAYS)

    if (!dataset) {
      return c.json({ error: 'dataset is required', errorCode: 'INVALID_PRUNE' }, 400)
    }

    try {
      const result = previewPruneDataset(db, dataset, olderThanDays)
      return c.json({
        dataset,
        olderThanDays,
        wouldDelete: result.deleted,
        ...result.extra,
      })
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'Failed to preview prune dataset',
        errorCode: 'PRUNE_PREVIEW_ERROR',
      }, 400)
    }
  })

  router.get('/export/:dataset', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const dataset = c.req.param('dataset')
    const format = (c.req.query('format') ?? 'json').toLowerCase()
    const windowHours = parseHours(c.req.query('hours'), 24 * 7)

    let rows: Array<Record<string, unknown>>
    switch (dataset) {
      case 'intents':
        rows = searchIntentRows(db, {
          limit: parseLimit(c.req.query('limit'), 500, 5000),
          sinceHours: windowHours,
          q: c.req.query('q') ?? undefined,
          fromBeamId: c.req.query('from') ?? undefined,
          toBeamId: c.req.query('to') ?? undefined,
          intentType: c.req.query('intentType') ?? undefined,
          status: c.req.query('status') ?? undefined,
          errorCode: c.req.query('errorCode') ?? undefined,
        }).intents.map(serializeIntentRow)
        break
      case 'audit':
        rows = searchAuditRows(db, {
          limit: parseLimit(c.req.query('limit'), 500, 5000),
          sinceHours: windowHours,
          action: c.req.query('action') ?? undefined,
          actor: c.req.query('actor') ?? undefined,
          target: c.req.query('target') ?? undefined,
          q: c.req.query('q') ?? undefined,
        }).entries.map(serializeAuditRow)
        break
      case 'errors':
        rows = buildErrorsPayload(db, windowHours).codes
        break
      case 'federation':
        rows = buildFederationPayload(db).peers
        break
      case 'alerts':
        rows = buildAlerts(db, windowHours)
        break
      default:
        return c.json({ error: 'Unsupported export dataset', errorCode: 'INVALID_EXPORT' }, 400)
    }

    if (format === 'csv') {
      c.header('Content-Type', 'text/csv; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-${dataset}.csv"`)
      return c.body(toCsv(rows))
    }

    if (format === 'ndjson') {
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-${dataset}.ndjson"`)
      return c.body(rows.map((row) => JSON.stringify(row)).join('\n'))
    }

    c.header('Content-Disposition', `attachment; filename="beam-${dataset}.json"`)
    return c.json({
      dataset,
      exportedAt: new Date().toISOString(),
      rows,
      total: rows.length,
    })
  })

  router.post('/prune', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
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
    const dataset = String(raw.dataset ?? '').trim()
    const olderThanDays = parseDays(
      raw.olderThanDays == null ? undefined : String(raw.olderThanDays),
      DEFAULT_RETENTION_DAYS,
    )
    const confirmDataset = String(raw.confirmDataset ?? '').trim()
    const confirmPhrase = String(raw.confirmPhrase ?? '').trim()

    if (!dataset) {
      return c.json({ error: 'dataset is required', errorCode: 'INVALID_PRUNE' }, 400)
    }

    if (confirmDataset !== dataset || confirmPhrase !== `prune ${dataset}`) {
      return c.json({
        error: 'Prune confirmation is required. Repeat the dataset name and the phrase exactly.',
        errorCode: 'PRUNE_CONFIRMATION_REQUIRED',
      }, 400)
    }

    try {
      const result = pruneDataset(db, dataset, olderThanDays)
      logAuditEvent(db, {
        action: 'observability.prune',
        actor: auth.session.email,
        target: dataset,
        details: {
          olderThanDays,
          deleted: result.deleted,
          role: auth.session.role,
        },
      })
      return c.json({
        dataset,
        olderThanDays,
        deleted: result.deleted,
        ...result.extra,
      })
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'Failed to prune dataset',
        errorCode: 'PRUNE_ERROR',
      }, 400)
    }
  })

  return router
}
