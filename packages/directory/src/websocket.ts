import { createPublicKey, verify } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'better-sqlite3'
import type { IntentFrame, IntentLogRow, IntentTraceEventRow, ResultFrame } from './types.js'
import {
  finalizeIntentLog,
  getAgent,
  getIntentLogByNonce,
  getLatestIntentTraceEvent,
  hasActiveDelegation,
  listOpenClawResolvedRoutesByBeamId,
  listInFlightIntentLogs,
  logIntentStart,
  reconcileIntentLog,
  setIntentLifecycleStatus,
  updateLastSeen,
} from './db.js'
import { isIntentAllowed } from './acl.js'
import {
  getCachedFederatedPublicKey,
  getFederationRequestHeaders,
  getLocalDirectoryUrl,
  MAX_FEDERATION_HOPS,
  queryPeerForAgent,
  resolveAgentAcrossFederation,
} from './federation.js'
import { validateIntentPayload } from './validation.js'
import { checkAgentRateLimit, getRateLimitPerMinute, pruneRateLimitState } from './rate-limit.js'
import { agentApiKeyMatches, getSuppliedApiKey } from './api-key.js'
import { recordIntentStage, recordShieldDecision } from './observability-hooks.js'
import {
  isIntentLifecycleFailure,
  isIntentLifecycleInFlight,
  isIntentLifecycleSuccess,
  normalizeIntentLifecycleStatus,
  type IntentLifecycleStatus,
} from './intent-lifecycle.js'

const REPLAY_WINDOW_MS = 5 * 60 * 1000
const STALE_PENDING_RETRY_WINDOW_MS = 2 * 60 * 1000
const DEFAULT_RECOVERY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || 30_000)
const RECOVERY_SWEEP_INTERVAL_MS = Number(process.env.RELAY_RECOVERY_SWEEP_INTERVAL_MS || 5_000)
const RETRYABLE_INTENT_ERRORS = new Set(['OFFLINE', 'TIMEOUT', 'DELIVERY_FAILED', 'DIRECT_HTTP_FAILED'])
const PUBLIC_ECHO_BEAM_ID = 'echo@beam.directory'

type ConnectionSession = {
  ws: WebSocket
  authenticatedViaApiKey: boolean
}

const connections = new Map<string, ConnectionSession>()
const intentFeedSubscribers = new Set<WebSocket>()

const pendingResults = new Map<string, {
  db: Database
  fromBeamId: string
  toBeamId: string
  intentType: string
  startedAtMs: number
  resolve: (frame: ResultFrame) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

setInterval(() => {
  pruneRateLimitState()
}, 60_000).unref()

export class RelayError extends Error {
  code: 'OFFLINE' | 'BAD_REQUEST' | 'DELIVERY_FAILED' | 'TIMEOUT' | 'RATE_LIMITED' | 'FORBIDDEN' | 'IN_PROGRESS'

  constructor(code: RelayError['code'], message: string) {
    super(message)
    this.code = code
  }
}

type NonceClaimResult =
  | { kind: 'accepted' }
  | { kind: 'cached'; result: ResultFrame }
  | { kind: 'in_progress' }

function serializeResultFrame(result: ResultFrame): string {
  return JSON.stringify(result)
}

function lifecycleErrorCode(status: IntentLifecycleStatus, errorCode: string | null | undefined): string | null {
  return status === 'failed' || status === 'dead_letter'
    ? (errorCode ?? 'RESULT_ERROR')
    : null
}

function buildResultFrame(
  frame: IntentFrame,
  options: {
    success: boolean
    payload?: Record<string, unknown>
    error?: string
    errorCode?: string
    latency?: number | null
    timestamp?: string
  },
): ResultFrame {
  return {
    v: '1',
    success: options.success,
    nonce: frame.nonce,
    timestamp: options.timestamp ?? new Date().toISOString(),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
    ...(typeof options.latency === 'number' ? { latency: options.latency } : {}),
  }
}

function parseTraceDetails(trace: IntentTraceEventRow | null): Record<string, unknown> | null {
  if (!trace?.details) {
    return null
  }

  try {
    const parsed = JSON.parse(trace.details) as Record<string, unknown>
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function getOpenClawDeliveryBlock(
  db: Database,
  beamId: string,
): {
  relayCode: RelayError['code']
  errorCode: string
  message: string
  details: Record<string, unknown>
} | null {
  const routes = listOpenClawResolvedRoutesByBeamId(db, beamId)
  if (routes.length === 0) {
    return null
  }

  const conflictRoutes = routes.filter((route) => route.runtime_session_state === 'conflict')
  if (conflictRoutes.length > 0) {
    return {
      relayCode: 'FORBIDDEN',
      errorCode: 'HOST_ROUTE_CONFLICT',
      message: `Agent ${beamId} is claimed by multiple OpenClaw hosts`,
      details: {
        hostIds: conflictRoutes.map((route) => route.host_id),
        hostLabels: conflictRoutes.map((route) => route.host_label ?? route.hostname),
      },
    }
  }

  const preferredRoute = routes.find((route) => route.runtime_session_state !== 'ended') ?? routes[0]
  if (preferredRoute.runtime_session_state === 'revoked' || preferredRoute.host_status === 'revoked' || preferredRoute.host_health_status === 'revoked') {
    return {
      relayCode: 'FORBIDDEN',
      errorCode: 'HOST_REVOKED',
      message: `Agent ${beamId} belongs to a revoked OpenClaw host`,
      details: {
        hostId: preferredRoute.host_id,
        hostLabel: preferredRoute.host_label ?? preferredRoute.hostname,
      },
    }
  }

  if (preferredRoute.runtime_session_state === 'stale' || preferredRoute.host_health_status === 'stale') {
    return {
      relayCode: 'OFFLINE',
      errorCode: 'HOST_STALE',
      message: `Agent ${beamId} belongs to a stale OpenClaw host`,
      details: {
        hostId: preferredRoute.host_id,
        hostLabel: preferredRoute.host_label ?? preferredRoute.hostname,
      },
    }
  }

  if (preferredRoute.runtime_session_state === 'ended') {
    return {
      relayCode: 'OFFLINE',
      errorCode: 'ROUTE_ENDED',
      message: `Agent ${beamId} no longer has an active OpenClaw route`,
      details: {
        hostId: preferredRoute.host_id,
        hostLabel: preferredRoute.host_label ?? preferredRoute.hostname,
      },
    }
  }

  return null
}

function resolveRecoveryTimeoutMs(
  trace: IntentTraceEventRow | null,
  fallbackMs = DEFAULT_RECOVERY_TIMEOUT_MS,
): number {
  const traceDetails = parseTraceDetails(trace)
  const timeoutCandidate = traceDetails?.['timeoutMs']
  if (typeof timeoutCandidate === 'number' && Number.isFinite(timeoutCandidate) && timeoutCandidate > 0) {
    return timeoutCandidate
  }

  return fallbackMs
}

function getRequestedAtMs(row: IntentLogRow, nowMs = Date.now()): number {
  const parsed = new Date(row.requested_at).getTime()
  return Number.isNaN(parsed) ? nowMs : parsed
}

function buildIntentFrameFromLog(row: IntentLogRow): IntentFrame {
  return {
    v: '1',
    from: row.from_beam_id,
    to: row.to_beam_id,
    intent: row.intent_type,
    payload: {},
    nonce: row.nonce,
    timestamp: row.requested_at,
  }
}

function isRetryableIntentFailure(errorCode: string | null | undefined): boolean {
  return Boolean(errorCode && RETRYABLE_INTENT_ERRORS.has(errorCode))
}

function claimIntentNonce(db: Database, frame: IntentFrame): NonceClaimResult {
  const existing = getIntentLogByNonce(db, frame.nonce)
  if (!existing) {
    logIntentStart(db, frame)
    return { kind: 'accepted' }
  }

  if (
    existing.from_beam_id !== frame.from
    || existing.to_beam_id !== frame.to
    || existing.intent_type !== frame.intent
  ) {
    throw new RelayError('BAD_REQUEST', `Nonce ${frame.nonce} was already used for a different intent`)
  }

  const existingStatus = normalizeIntentLifecycleStatus(existing.status) ?? 'received'

  if (isIntentLifecycleInFlight(existingStatus)) {
    const existingRequestedAt = new Date(existing.requested_at).getTime()
    const ageMs = Number.isNaN(existingRequestedAt) ? 0 : Date.now() - existingRequestedAt
    if (ageMs <= STALE_PENDING_RETRY_WINDOW_MS) {
      return { kind: 'in_progress' }
    }

    logIntentStart(db, frame)
    return { kind: 'accepted' }
  }

  if (existing.result_json) {
    try {
      const parsed = JSON.parse(existing.result_json) as ResultFrame
      if (parsed && typeof parsed === 'object' && parsed.nonce === frame.nonce) {
        if (isIntentLifecycleSuccess(existingStatus)) {
          return { kind: 'cached', result: parsed }
        }
        if (isIntentLifecycleFailure(existingStatus) && existing.error_code && !RETRYABLE_INTENT_ERRORS.has(existing.error_code)) {
          return { kind: 'cached', result: parsed }
        }
      }
    } catch {
      // fall through to retry/reset path
    }
  }

  if (isIntentLifecycleFailure(existingStatus) && existing.error_code && RETRYABLE_INTENT_ERRORS.has(existing.error_code)) {
    logIntentStart(db, frame)
    return { kind: 'accepted' }
  }

  logIntentStart(db, frame)
  return { kind: 'accepted' }
}

function applyNonceClaimResult(
  nonce: string,
  claim: NonceClaimResult,
): ResultFrame | null {
  if (claim.kind === 'accepted') {
    return null
  }

  if (claim.kind === 'cached') {
    return claim.result
  }

  throw new RelayError('IN_PROGRESS', `Intent with nonce ${nonce} is already being processed`)
}

function finalizeIntentWithResult(
  db: Database,
  frame: IntentFrame,
  result: ResultFrame,
  latencyMs: number | null,
): void {
  finalizeIntentLog(db, {
    nonce: frame.nonce,
    fromBeamId: frame.from,
    toBeamId: frame.to,
    status: result.success ? 'acked' : 'failed',
    latencyMs,
    errorCode: result.success ? undefined : (result.errorCode ?? 'RESULT_ERROR'),
    resultJson: serializeResultFrame(result),
  })
}

function buildPublicEchoResult(frame: IntentFrame, latencyMs: number): ResultFrame {
  if (frame.intent === 'conversation.message') {
    const message = typeof frame.payload['message'] === 'string'
      ? frame.payload['message'].trim()
      : ''

    return buildResultFrame(frame, {
      success: true,
      payload: {
        message: `Echo: ${message || 'Hello from Beam.'}`,
        from: PUBLIC_ECHO_BEAM_ID,
        handledBy: 'builtin-echo',
      },
      latency: latencyMs,
    })
  }

  return buildResultFrame(frame, {
    success: true,
    payload: {
      ok: true,
      beamId: PUBLIC_ECHO_BEAM_ID,
      handledBy: PUBLIC_ECHO_BEAM_ID,
      transport: 'builtin-echo',
      intent: frame.intent,
      message: `Mock success for ${frame.intent}`,
      originalPayload: frame.payload ?? {},
    },
    latency: latencyMs,
  })
}

function maybeDeliverPublicEcho(
  db: Database,
  frame: IntentFrame,
  options: {
    transport: 'http' | 'ws'
    fallbackReason: 'missing_registration' | 'offline'
  },
): ResultFrame | null {
  if (frame.to !== PUBLIC_ECHO_BEAM_ID) {
    return null
  }

  const requestedAtMs = new Date(frame.timestamp).getTime()
  const latencyMs = Number.isNaN(requestedAtMs)
    ? 0
    : Math.max(0, Date.now() - requestedAtMs)
  const result = buildPublicEchoResult(frame, latencyMs)

  recordIntentStage(db, frame, 'delivered', {
    transport: options.transport,
    fallbackReason: options.fallbackReason,
    demoResponder: PUBLIC_ECHO_BEAM_ID,
    builtInResponder: true,
    latencyMs,
  })
  setIntentLifecycleStatus(db, {
    nonce: frame.nonce,
    status: 'delivered',
  })
  broadcastIntentFeed({
    nonce: frame.nonce,
    from: frame.from,
    to: frame.to,
    intentType: frame.intent,
    timestamp: frame.timestamp,
    completedAt: null,
    roundTripLatencyMs: null,
    status: 'delivered',
    errorCode: null,
  })

  finalizeIntentWithResult(db, frame, result, latencyMs)
  recordIntentStage(db, frame, 'acked', {
    transport: options.transport,
    fallbackReason: options.fallbackReason,
    demoResponder: PUBLIC_ECHO_BEAM_ID,
    builtInResponder: true,
    latencyMs,
  })
  broadcastCompletedIntent(frame, result, latencyMs)

  return result
}

function broadcastCompletedIntent(frame: IntentFrame, result: ResultFrame, latencyMs: number | null): void {
  const lifecycleStatus: IntentLifecycleStatus = result.success ? 'acked' : 'failed'
  broadcastIntentFeed({
    nonce: frame.nonce,
    from: frame.from,
    to: frame.to,
    intentType: frame.intent,
    timestamp: frame.timestamp,
    completedAt: new Date().toISOString(),
    roundTripLatencyMs: latencyMs,
    status: lifecycleStatus,
    errorCode: lifecycleErrorCode(lifecycleStatus, result.errorCode),
  })
}

function finalizeFailedIntent(
  db: Database,
  frame: IntentFrame,
  options: {
    error: string
    errorCode: string
    latencyMs: number | null
    transport: string
    details?: Record<string, unknown>
  },
): ResultFrame {
  const result = buildResultFrame(frame, {
    success: false,
    error: options.error,
    errorCode: options.errorCode,
    latency: options.latencyMs ?? undefined,
  })

  finalizeIntentWithResult(db, frame, result, options.latencyMs)
  recordIntentStage(db, frame, 'failed', {
    transport: options.transport,
    latencyMs: options.latencyMs,
    errorCode: options.errorCode,
    ...options.details,
  })
  broadcastCompletedIntent(frame, result, options.latencyMs)

  return result
}

function normalizeDirectHttpResult(
  frame: IntentFrame,
  raw: unknown,
  latencyMs: number,
): ResultFrame {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const result = raw as Record<string, unknown>
    if (result['v'] === '1' && typeof result['success'] === 'boolean') {
      return {
        v: '1',
        success: result['success'],
        nonce: typeof result['nonce'] === 'string' ? result['nonce'] : frame.nonce,
        timestamp: typeof result['timestamp'] === 'string' ? result['timestamp'] : new Date().toISOString(),
        ...(result['payload'] && typeof result['payload'] === 'object' && !Array.isArray(result['payload'])
          ? { payload: result['payload'] as Record<string, unknown> }
          : {}),
        ...(typeof result['error'] === 'string' ? { error: result['error'] } : {}),
        ...(typeof result['errorCode'] === 'string' ? { errorCode: result['errorCode'] } : {}),
        ...(typeof result['latency'] === 'number' ? { latency: result['latency'] } : { latency: latencyMs }),
      }
    }

    if (typeof result['success'] === 'boolean') {
      return buildResultFrame(frame, {
        success: result['success'],
        payload: result['payload'] && typeof result['payload'] === 'object' && !Array.isArray(result['payload'])
          ? result['payload'] as Record<string, unknown>
          : undefined,
        error: typeof result['error'] === 'string' ? result['error'] : undefined,
        errorCode: typeof result['errorCode'] === 'string' ? result['errorCode'] : undefined,
        latency: typeof result['latency'] === 'number' ? result['latency'] : latencyMs,
      })
    }

    return buildResultFrame(frame, {
      success: true,
      payload: result,
      latency: latencyMs,
    })
  }

  return buildResultFrame(frame, {
    success: true,
    payload: {},
    latency: latencyMs,
  })
}

export interface DirectoryRecoverySummary {
  failedInterrupted: number
  resumedAwaitingResult: number
  timedOutAwaitingResult: number
}

export function recoverInterruptedIntentsOnStartup(
  db: Database,
  options: {
    nowMs?: number
    defaultTimeoutMs?: number
  } = {},
): DirectoryRecoverySummary {
  const nowMs = options.nowMs ?? Date.now()
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  const summary: DirectoryRecoverySummary = {
    failedInterrupted: 0,
    resumedAwaitingResult: 0,
    timedOutAwaitingResult: 0,
  }

  for (const row of listInFlightIntentLogs(db)) {
    const status = normalizeIntentLifecycleStatus(row.status) ?? 'received'
    const frame = buildIntentFrameFromLog(row)
    const requestedAtMs = getRequestedAtMs(row, nowMs)
    const latencyMs = Math.max(0, nowMs - requestedAtMs)

    if (status === 'delivered') {
      const timeoutMs = resolveRecoveryTimeoutMs(getLatestIntentTraceEvent(db, row.nonce), defaultTimeoutMs)
      if (latencyMs < timeoutMs) {
        summary.resumedAwaitingResult += 1
        continue
      }

      finalizeFailedIntent(db, frame, {
        error: `Intent timed out waiting for result after restart (${timeoutMs}ms)`,
        errorCode: 'TIMEOUT',
        latencyMs,
        transport: 'recovery',
        details: {
          previousStatus: status,
          recoveryAction: 'timeout_after_restart',
          recoveredOnBoot: true,
          timeoutMs,
        },
      })
      summary.timedOutAwaitingResult += 1
      continue
    }

    finalizeFailedIntent(db, frame, {
      error: `Intent recovery failed after restart while it was ${status}`,
      errorCode: 'DELIVERY_FAILED',
      latencyMs,
      transport: 'recovery',
      details: {
        previousStatus: status,
        recoveryAction: 'fail_interrupted_intent',
        recoveredOnBoot: true,
      },
    })
    summary.failedInterrupted += 1
  }

  return summary
}

export function expireRecoveredIntentTimeouts(
  db: Database,
  options: {
    nowMs?: number
    defaultTimeoutMs?: number
  } = {},
): number {
  const nowMs = options.nowMs ?? Date.now()
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  let expiredCount = 0

  for (const row of listInFlightIntentLogs(db)) {
    const status = normalizeIntentLifecycleStatus(row.status) ?? 'received'
    if (status !== 'delivered' || pendingResults.has(row.nonce)) {
      continue
    }

    const timeoutMs = resolveRecoveryTimeoutMs(getLatestIntentTraceEvent(db, row.nonce), defaultTimeoutMs)
    const requestedAtMs = getRequestedAtMs(row, nowMs)
    const latencyMs = Math.max(0, nowMs - requestedAtMs)
    if (latencyMs < timeoutMs) {
      continue
    }

    finalizeFailedIntent(db, buildIntentFrameFromLog(row), {
      error: `Intent timed out waiting for result after restart (${timeoutMs}ms)`,
      errorCode: 'TIMEOUT',
      latencyMs,
      transport: 'recovery',
      details: {
        previousStatus: status,
        recoveryAction: 'timeout_without_waiter',
        recoveredOnBoot: true,
        timeoutMs,
      },
    })
    expiredCount += 1
  }

  return expiredCount
}

export function startRecoveredIntentTimeoutSweep(
  db: Database,
  options: {
    intervalMs?: number
    defaultTimeoutMs?: number
  } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS

  const timer = setInterval(() => {
    try {
      const expired = expireRecoveredIntentTimeouts(db, { defaultTimeoutMs })
      if (expired > 0) {
        console.warn(`[beam-directory] Timed out ${expired} recovered intent(s) waiting for late results`)
      }
    } catch (err) {
      console.error('[beam-directory] Intent recovery sweep failed:', err)
    }
  }, intervalMs)
  timer.unref()

  return timer
}

export function stopRecoveredIntentTimeoutSweep(timer: NodeJS.Timeout): void {
  clearInterval(timer)
}

async function attemptDirectHttpDelivery(
  db: Database,
  frame: IntentFrame,
  endpoint: string,
): Promise<ResultFrame | null> {
  try {
    const startedAt = Date.now()
    const directResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Beam-Sender': frame.from,
        'X-Beam-Signature': frame.signature ?? '',
        'X-Beam-Nonce': frame.nonce,
        'X-Beam-Timestamp': frame.timestamp,
      },
      body: JSON.stringify({
        intent: frame.intent,
        from: frame.from,
        payload: frame.payload,
        nonce: frame.nonce,
        timestamp: frame.timestamp,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const latencyMs = Date.now() - startedAt
    if (!directResponse.ok) {
      recordIntentStage(db, frame, 'dispatched', {
        transport: 'direct-http',
        endpoint,
        outcome: 'fallback',
        status: directResponse.status,
        errorCode: 'DIRECT_HTTP_FAILED',
      })
      return null
    }

    let body: unknown = {}
    try {
      body = await directResponse.json()
    } catch {
      body = {}
    }

    const result = normalizeDirectHttpResult(frame, body, latencyMs)
    recordIntentStage(db, frame, 'delivered', {
      transport: 'direct-http',
      endpoint,
      status: directResponse.status,
      latencyMs,
    })
    setIntentLifecycleStatus(db, {
      nonce: frame.nonce,
      status: 'delivered',
    })
    broadcastIntentFeed({
      nonce: frame.nonce,
      from: frame.from,
      to: frame.to,
      intentType: frame.intent,
      timestamp: frame.timestamp,
      completedAt: null,
      roundTripLatencyMs: null,
      status: 'delivered',
      errorCode: null,
    })
    finalizeIntentWithResult(db, frame, result, latencyMs)
    recordIntentStage(db, frame, result.success ? 'acked' : 'failed', {
      transport: 'direct-http',
      endpoint,
      status: directResponse.status,
      latencyMs,
      errorCode: result.success ? null : (result.errorCode ?? 'DIRECT_HTTP_ERROR'),
    })
    broadcastCompletedIntent(frame, result, latencyMs)
    return result
  } catch (err) {
    recordIntentStage(db, frame, 'dispatched', {
      transport: 'direct-http',
      endpoint,
      outcome: 'fallback',
      errorCode: 'DIRECT_HTTP_FAILED',
      message: err instanceof Error ? err.message : 'Direct delivery failed',
    })
    return null
  }
}

export function createWebSocketServer(db: Database): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const urlStr = req.url ?? '/'
    const url = new URL(urlStr, 'http://localhost')
    const feed = url.searchParams.get('feed')

    if (feed === 'intents') {
      intentFeedSubscribers.add(ws)
      sendJson(ws, { type: 'feed_connected' })

      ws.on('close', () => {
        intentFeedSubscribers.delete(ws)
      })

      ws.on('error', () => {
        intentFeedSubscribers.delete(ws)
      })

      return
    }

    const beamId = url.searchParams.get('beamId')

    if (!beamId) {
      ws.close(1008, 'Missing beamId query parameter')
      return
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      ws.close(1008, `Agent ${beamId} is not registered`)
      return
    }

    const authenticatedViaApiKey = agentApiKeyMatches(
      agent,
      url.searchParams.get('apiKey')?.trim() || getSuppliedApiKey(req),
    )

    const existingSession = connections.get(beamId)
    if (existingSession && existingSession.ws.readyState === WebSocket.OPEN) {
      existingSession.ws.close(1001, 'Replaced by new connection')
    }

    connections.set(beamId, { ws, authenticatedViaApiKey })
    updateLastSeen(db, beamId)

    sendJson(ws, { type: 'connected', beamId, auth: authenticatedViaApiKey ? 'api_key' : 'identity' })

    ws.on('message', (data: Buffer) => {
      void handleMessage(db, beamId, ws, data, { authenticatedViaApiKey })
    })

    ws.on('close', () => {
      if (connections.get(beamId)?.ws === ws) {
        connections.delete(beamId)
      }
    })

    ws.on('error', (err: Error) => {
      console.error(`WebSocket error for ${beamId}:`, err)
      if (connections.get(beamId)?.ws === ws) {
        connections.delete(beamId)
      }
    })
  })

  return wss
}

export function getConnectedCount(): number {
  return connections.size
}

export function isAgentConnected(beamId: string): boolean {
  const session = connections.get(beamId)
  return Boolean(session && session.ws.readyState === WebSocket.OPEN)
}

export function getConnectedBeamIds(): string[] {
  return Array.from(connections.entries())
    .filter(([, session]) => session.ws.readyState === WebSocket.OPEN)
    .map(([beamId]) => beamId)
}

export async function relayIntentFromHttp(
  db: Database,
  frame: IntentFrame,
  timeoutMs = Number(process.env.RELAY_TIMEOUT_MS || 120_000),
  options: {
    sourceDirectory?: string
    hopCount?: number
    trustedControlPlane?: boolean
    skipLocalAclCheck?: boolean
  } = {},
): Promise<ResultFrame> {
  const prepared = normalizeAndValidateFrame(frame)
  const sourceDirectory = options.sourceDirectory ?? getLocalDirectoryUrl()
  const hopCount = options.hopCount ?? 0

  if (hopCount > MAX_FEDERATION_HOPS) {
    throw new RelayError('BAD_REQUEST', `Federation hop limit exceeded (${MAX_FEDERATION_HOPS})`)
  }

  const sender = getAgent(db, prepared.from)
  const senderPublicKey = sender?.public_key ?? await resolveSenderPublicKey(db, prepared.from, sourceDirectory)

  if (!senderPublicKey) {
    throw new RelayError('BAD_REQUEST', `Sender ${prepared.from} is not registered`)
  }

  try {
    enforceSecurityChecks(db, prepared, senderPublicKey, {
      skipSignatureVerification: options.trustedControlPlane === true,
      skipLocalAclCheck: options.skipLocalAclCheck === true,
    })
    recordShieldDecision(db, prepared, { timestamp: prepared.timestamp })
  } catch (err) {
    recordShieldDecision(db, prepared, {
      decision: 'reject',
      timestamp: prepared.timestamp,
      extraFlags: [err instanceof RelayError ? err.code : 'INVALID_INTENT'],
    })
    throw err
  }

  const cachedResult = applyNonceClaimResult(prepared.nonce, claimIntentNonce(db, prepared))
  if (cachedResult) {
    updateLastSeen(db, prepared.from)
    return cachedResult
  }

  recordIntentStage(db, prepared, 'received', {
    transport: 'http',
    sourceDirectory,
    hopCount,
  }, prepared.timestamp)
  recordIntentStage(db, prepared, 'validated', {
    transport: 'http',
    sourceDirectory,
    senderSource: sender ? 'local' : 'federated',
  })
  setIntentLifecycleStatus(db, {
    nonce: prepared.nonce,
    status: 'validated',
  })

  recordIntentStage(db, prepared, 'dispatched', {
    deliveryTarget: 'local-or-federated',
    transport: 'http',
  })
  setIntentLifecycleStatus(db, {
    nonce: prepared.nonce,
    status: 'dispatched',
  })
  broadcastIntentFeed({
    nonce: prepared.nonce,
    from: prepared.from,
    to: prepared.to,
    intentType: prepared.intent,
    timestamp: prepared.timestamp,
    completedAt: null,
    roundTripLatencyMs: null,
    status: 'dispatched',
    errorCode: null,
  })

  const localRecipient = getAgent(db, prepared.to)
  if (!localRecipient) {
    const echoFallback = maybeDeliverPublicEcho(db, prepared, {
      transport: 'http',
      fallbackReason: 'missing_registration',
    })
    if (echoFallback) {
      updateLastSeen(db, prepared.from)
      return echoFallback
    }

    recordIntentStage(db, prepared, 'dispatched', {
      deliveryTarget: 'federation',
    })
    const federatedResult = await relayIntentToFederatedPeer(db, prepared, timeoutMs, {
      sourceDirectory,
      hopCount,
    })
    updateLastSeen(db, prepared.from)
    return federatedResult
  }

  if (localRecipient.http_endpoint) {
    const routeBlock = getOpenClawDeliveryBlock(db, prepared.to)
    if (routeBlock) {
      finalizeFailedIntent(db, prepared, {
        error: routeBlock.message,
        errorCode: routeBlock.errorCode,
        latencyMs: null,
        transport: 'ws',
        details: routeBlock.details,
      })
      throw new RelayError(routeBlock.relayCode, routeBlock.message)
    }

    const directResult = await attemptDirectHttpDelivery(db, prepared, localRecipient.http_endpoint)
    if (directResult) {
      updateLastSeen(db, prepared.from)
      return directResult
    }
  }

  const routeBlock = getOpenClawDeliveryBlock(db, prepared.to)
  if (routeBlock) {
    finalizeFailedIntent(db, prepared, {
      error: routeBlock.message,
      errorCode: routeBlock.errorCode,
      latencyMs: null,
      transport: 'ws',
      details: routeBlock.details,
    })
    throw new RelayError(routeBlock.relayCode, routeBlock.message)
  }

  const recipientSession = connections.get(prepared.to)
  const recipientWs = recipientSession?.ws
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    const echoFallback = maybeDeliverPublicEcho(db, prepared, {
      transport: 'http',
      fallbackReason: 'offline',
    })
    if (echoFallback) {
      updateLastSeen(db, prepared.from)
      return echoFallback
    }

    finalizeFailedIntent(db, prepared, {
      error: `Agent ${prepared.to} is not currently connected`,
      errorCode: 'OFFLINE',
      latencyMs: null,
      transport: 'ws',
    })
    throw new RelayError('OFFLINE', `Agent ${prepared.to} is not currently connected`)
  }

  const resultPromise = createResultWaiter(db, prepared, timeoutMs)
  recordIntentStage(db, prepared, 'dispatched', {
    transport: 'ws',
    timeoutMs,
  })

  try {
    sendJson(recipientWs, {
      type: 'intent',
      frame: prepared,
      senderPublicKey,
    })
    recordIntentStage(db, prepared, 'delivered', {
      transport: 'ws',
      timeoutMs,
    })
    setIntentLifecycleStatus(db, {
      nonce: prepared.nonce,
      status: 'delivered',
    })
    broadcastIntentFeed({
      nonce: prepared.nonce,
      from: prepared.from,
      to: prepared.to,
      intentType: prepared.intent,
      timestamp: prepared.timestamp,
      completedAt: null,
      roundTripLatencyMs: null,
      status: 'delivered',
      errorCode: null,
    })
  } catch (err) {
    clearPendingResult(prepared.nonce)
    finalizeFailedIntent(db, prepared, {
      error: err instanceof Error ? err.message : 'Failed to relay intent',
      errorCode: 'DELIVERY_FAILED',
      latencyMs: null,
      transport: 'ws',
    })
    throw new RelayError('DELIVERY_FAILED', err instanceof Error ? err.message : 'Failed to relay intent')
  }

  updateLastSeen(db, prepared.from)
  return resultPromise
}

async function handleMessage(
  db: Database,
  senderBeamId: string,
  senderWs: WebSocket,
  data: Buffer,
  auth: { authenticatedViaApiKey: boolean }
): Promise<void> {
  let msg: { type: string; frame: IntentFrame | ResultFrame }

  try {
    msg = JSON.parse(data.toString()) as { type: string; frame: IntentFrame | ResultFrame }
  } catch {
    sendJson(senderWs, { type: 'error', message: 'Invalid message format: must be valid JSON' })
    return
  }

  if (!msg || typeof msg.type !== 'string') {
    sendJson(senderWs, { type: 'error', message: 'Invalid message: missing type field' })
    return
  }

  if (msg.type === 'intent') {
    await handleIntent(db, senderBeamId, senderWs, msg.frame as IntentFrame, auth)
  } else if (msg.type === 'result') {
    handleResult(db, msg.frame as ResultFrame)
  } else {
    sendJson(senderWs, { type: 'error', message: `Unknown message type: ${msg.type}` })
  }
}

async function handleIntent(
  db: Database,
  senderBeamId: string,
  senderWs: WebSocket,
  frame: IntentFrame,
  auth: { authenticatedViaApiKey: boolean }
): Promise<void> {
  let prepared: IntentFrame
  try {
    prepared = normalizeAndValidateFrame(frame)
  } catch (err) {
    sendJson(senderWs, {
      type: 'error',
      nonce: typeof frame?.nonce === 'string' ? frame.nonce : undefined,
      errorCode: 'INVALID_INTENT',
      message: err instanceof Error ? err.message : 'Invalid intent frame',
    })
    return
  }

  let senderAgent
  try {
    senderAgent = resolveIntentSender(db, senderBeamId, prepared)
  } catch (err) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'UNKNOWN_SENDER',
      message: err instanceof Error ? err.message : 'Sender is not registered in the directory',
    })
    return
  }

  try {
    enforceSecurityChecks(db, prepared, senderAgent.public_key, { skipSignatureVerification: auth.authenticatedViaApiKey })
    recordShieldDecision(db, prepared, { timestamp: prepared.timestamp })
  } catch (err) {
    recordShieldDecision(db, prepared, {
      decision: 'reject',
      timestamp: prepared.timestamp,
      extraFlags: [err instanceof RelayError ? err.code : 'INVALID_INTENT'],
    })
    if (err instanceof RelayError && err.code === 'RATE_LIMITED') {
      sendJson(senderWs, {
        type: 'error',
        nonce: prepared.nonce,
        errorCode: 'RATE_LIMITED',
        status: 429,
        message: err.message,
      })
      return
    }

    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'INVALID_INTENT',
      message: err instanceof Error ? err.message : 'Rejected by relay security checks',
    })
    return
  }

  let cachedResult: ResultFrame | null
  try {
    cachedResult = applyNonceClaimResult(prepared.nonce, claimIntentNonce(db, prepared))
  } catch (err) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'INVALID_INTENT',
      message: err instanceof Error ? err.message : 'Failed nonce validation',
    })
    return
  }

  if (cachedResult) {
    updateLastSeen(db, senderBeamId)
    sendJson(senderWs, { type: 'result', frame: cachedResult })
    return
  }

  recordIntentStage(db, prepared, 'received', {
    transport: 'ws',
    connectedBeamId: senderBeamId,
  }, prepared.timestamp)
  recordIntentStage(db, prepared, 'validated', {
    transport: 'ws',
    connectedBeamId: senderBeamId,
    actingOnBehalf: senderBeamId !== prepared.from,
    authenticatedViaApiKey: auth.authenticatedViaApiKey,
  })
  setIntentLifecycleStatus(db, {
    nonce: prepared.nonce,
    status: 'validated',
  })

  recordIntentStage(db, prepared, 'dispatched', {
    deliveryTarget: 'local-or-federated',
    transport: 'ws',
  })
  setIntentLifecycleStatus(db, {
    nonce: prepared.nonce,
    status: 'dispatched',
  })
  broadcastIntentFeed({
    nonce: prepared.nonce,
    from: prepared.from,
    to: prepared.to,
    intentType: prepared.intent,
    timestamp: prepared.timestamp,
    completedAt: null,
    roundTripLatencyMs: null,
    status: 'dispatched',
    errorCode: null,
  })

  const localRecipient = getAgent(db, prepared.to)
  if (!localRecipient) {
    const echoFallback = maybeDeliverPublicEcho(db, prepared, {
      transport: 'ws',
      fallbackReason: 'missing_registration',
    })
    if (echoFallback) {
      updateLastSeen(db, senderBeamId)
      sendJson(senderWs, { type: 'result', frame: echoFallback })
      return
    }

    recordIntentStage(db, prepared, 'dispatched', {
      deliveryTarget: 'federation',
    })
    try {
      const result = await relayIntentToFederatedPeer(db, prepared, 30_000, {
        sourceDirectory: getLocalDirectoryUrl(),
        hopCount: 0,
      })
      updateLastSeen(db, senderBeamId)
      sendJson(senderWs, { type: 'result', frame: result })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Federated delivery failed'
      sendJson(senderWs, {
        type: 'error',
        nonce: prepared.nonce,
        errorCode: err instanceof RelayError ? err.code : 'DELIVERY_FAILED',
        message,
      })
    }
    return
  }

  if (localRecipient.http_endpoint) {
    const routeBlock = getOpenClawDeliveryBlock(db, prepared.to)
    if (routeBlock) {
      finalizeFailedIntent(db, prepared, {
        error: routeBlock.message,
        errorCode: routeBlock.errorCode,
        latencyMs: null,
        transport: 'ws',
        details: {
          ...routeBlock.details,
          actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
        },
      })
      sendJson(senderWs, {
        type: 'error',
        nonce: prepared.nonce,
        errorCode: routeBlock.errorCode,
        message: routeBlock.message,
      })
      return
    }

    const directResult = await attemptDirectHttpDelivery(db, prepared, localRecipient.http_endpoint)
    if (directResult) {
      updateLastSeen(db, senderBeamId)
      sendJson(senderWs, { type: 'result', frame: directResult })
      return
    }
  }

  const routeBlock = getOpenClawDeliveryBlock(db, prepared.to)
  if (routeBlock) {
    finalizeFailedIntent(db, prepared, {
      error: routeBlock.message,
      errorCode: routeBlock.errorCode,
      latencyMs: null,
      transport: 'ws',
      details: {
        ...routeBlock.details,
        actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
      },
    })
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: routeBlock.errorCode,
      message: routeBlock.message,
    })
    return
  }

  const recipientSession = connections.get(prepared.to)
  const recipientWs = recipientSession?.ws
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    const echoFallback = maybeDeliverPublicEcho(db, prepared, {
      transport: 'ws',
      fallbackReason: 'offline',
    })
    if (echoFallback) {
      updateLastSeen(db, senderBeamId)
      sendJson(senderWs, { type: 'result', frame: echoFallback })
      return
    }

    finalizeFailedIntent(db, prepared, {
      error: `Agent ${prepared.to} is not currently connected`,
      errorCode: 'OFFLINE',
      latencyMs: null,
      transport: 'ws',
      details: {
        actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
      },
    })
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'OFFLINE',
      message: `Agent ${prepared.to} is not currently connected`,
    })
    return
  }

  const resultPromise = createResultWaiter(db, prepared, 30_000)
  recordIntentStage(db, prepared, 'dispatched', {
    transport: 'ws',
    timeoutMs: 30_000,
    actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
  })

  try {
    sendJson(recipientWs, {
      type: 'intent',
      frame: prepared,
      senderPublicKey: senderAgent.public_key,
      actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
    })
    recordIntentStage(db, prepared, 'delivered', {
      transport: 'ws',
      timeoutMs: 30_000,
      actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
    })
    setIntentLifecycleStatus(db, {
      nonce: prepared.nonce,
      status: 'delivered',
    })
    broadcastIntentFeed({
      nonce: prepared.nonce,
      from: prepared.from,
      to: prepared.to,
      intentType: prepared.intent,
      timestamp: prepared.timestamp,
      completedAt: null,
      roundTripLatencyMs: null,
      status: 'delivered',
      errorCode: null,
    })
  } catch (err) {
    clearPendingResult(prepared.nonce)
    finalizeFailedIntent(db, prepared, {
      error: err instanceof Error ? err.message : 'Failed to relay intent',
      errorCode: 'DELIVERY_FAILED',
      latencyMs: null,
      transport: 'ws',
      details: {
        actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
      },
    })
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'DELIVERY_FAILED',
      message: err instanceof Error ? err.message : 'Failed to relay intent',
    })
    return
  }

  updateLastSeen(db, senderBeamId)

  try {
    const result = await resultPromise
    sendJson(senderWs, { type: 'result', frame: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delivery failed'
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'DELIVERY_FAILED',
      message,
    })
  }
}

async function resolveSenderPublicKey(
  db: Database,
  beamId: string,
  sourceDirectory: string
): Promise<string | null> {
  const local = getAgent(db, beamId)
  if (local) {
    return local.public_key
  }

  const cached = getCachedFederatedPublicKey(db, beamId)
  if (cached) {
    return cached
  }

  if (sourceDirectory && sourceDirectory !== getLocalDirectoryUrl()) {
    const fromSource = await queryPeerForAgent(db, sourceDirectory, beamId, { localOnly: true })
    const publicKey = fromSource?.agent.public_key ?? fromSource?.agent.publicKey
    if (typeof publicKey === 'string' && publicKey.length > 0) {
      return publicKey
    }
  }

  const resolved = await resolveAgentAcrossFederation(db, beamId, { autoDiscover: false })
  const publicKey = resolved?.agent.public_key ?? resolved?.agent.publicKey
  return typeof publicKey === 'string' && publicKey.length > 0 ? publicKey : null
}

async function relayIntentToFederatedPeer(
  db: Database,
  frame: IntentFrame,
  timeoutMs: number,
  options: { sourceDirectory: string; hopCount: number }
): Promise<ResultFrame> {
  const resolved = await resolveAgentAcrossFederation(db, frame.to)
  const peerUrl = resolved?.directoryUrl

  if (!resolved || !peerUrl || peerUrl === getLocalDirectoryUrl()) {
    finalizeFailedIntent(db, frame, {
      error: `Agent ${frame.to} is not available locally or through federation`,
      errorCode: 'OFFLINE',
      latencyMs: null,
      transport: 'federation',
    })
    throw new RelayError('OFFLINE', `Agent ${frame.to} is not available locally or through federation`)
  }

  recordIntentStage(db, frame, 'dispatched', {
    peerUrl,
    scope: resolved.scope,
    transport: 'federation',
  })

  const nextHopCount = options.hopCount + 1
  if (nextHopCount > MAX_FEDERATION_HOPS) {
    finalizeFailedIntent(db, frame, {
      error: `Federation hop limit exceeded (${MAX_FEDERATION_HOPS})`,
      errorCode: 'BAD_REQUEST',
      latencyMs: null,
      transport: 'federation',
      details: {
        hopCount: nextHopCount,
      },
    })
    throw new RelayError('BAD_REQUEST', `Federation hop limit exceeded (${MAX_FEDERATION_HOPS})`)
  }

  const startedAt = Date.now()
  recordIntentStage(db, frame, 'dispatched', {
    peerUrl,
    hopCount: nextHopCount,
    transport: 'federation',
  })
  try {
    const response = await fetch(`${peerUrl}/federation/relay`, {
      method: 'POST',
      headers: getFederationRequestHeaders({
        'Content-Type': 'application/json',
        'X-Beam-Source-Directory': options.sourceDirectory,
        'X-Beam-Hop-Count': String(nextHopCount),
      }),
      body: JSON.stringify(frame),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      finalizeFailedIntent(db, frame, {
        error: `Federated relay failed with status ${response.status}`,
        errorCode: 'DELIVERY_FAILED',
        latencyMs,
        transport: 'federation',
        details: {
          peerUrl,
          hopCount: nextHopCount,
          status: response.status,
        },
      })
      throw new RelayError('DELIVERY_FAILED', `Federated relay failed with status ${response.status}`)
    }

    const result = await response.json() as ResultFrame
    const resolvedLatencyMs = typeof result.latency === 'number' ? result.latency : latencyMs
    recordIntentStage(db, frame, 'delivered', {
      peerUrl,
      hopCount: nextHopCount,
      transport: 'federation',
      latencyMs: resolvedLatencyMs,
    })
    setIntentLifecycleStatus(db, {
      nonce: frame.nonce,
      status: 'delivered',
    })
    broadcastIntentFeed({
      nonce: frame.nonce,
      from: frame.from,
      to: frame.to,
      intentType: frame.intent,
      timestamp: frame.timestamp,
      completedAt: null,
      roundTripLatencyMs: null,
      status: 'delivered',
      errorCode: null,
    })
    finalizeIntentWithResult(db, frame, result, resolvedLatencyMs)
    recordIntentStage(db, frame, result.success ? 'acked' : 'failed', {
      transport: 'federation',
      peerUrl,
      latencyMs: resolvedLatencyMs,
      errorCode: result.success ? null : (result.errorCode ?? 'RESULT_ERROR'),
    })
    broadcastCompletedIntent(frame, result, resolvedLatencyMs)
    return result
  } catch (err) {
    if (err instanceof RelayError) {
      throw err
    }

    const latencyMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : 'Federated relay failed'
    finalizeFailedIntent(db, frame, {
      error: message,
      errorCode: 'DELIVERY_FAILED',
      latencyMs,
      transport: 'federation',
      details: {
        peerUrl,
        hopCount: nextHopCount,
      },
    })
    throw new RelayError('DELIVERY_FAILED', message)
  }
}

function normalizeAndValidateFrame(frame: IntentFrame): IntentFrame {
  if (!frame || typeof frame !== 'object') {
    throw new RelayError('BAD_REQUEST', 'Invalid intent frame body')
  }

  const payloadCandidate = (frame as unknown as { payload?: unknown; params?: unknown }).payload
    ?? (frame as unknown as { params?: unknown }).params

  const payload = (payloadCandidate && typeof payloadCandidate === 'object' && !Array.isArray(payloadCandidate))
    ? payloadCandidate as Record<string, unknown>
    : null

  if (typeof frame.from !== 'string' || typeof frame.to !== 'string' || typeof frame.intent !== 'string') {
    throw new RelayError('BAD_REQUEST', 'from, to and intent are required')
  }
  if (!payload) {
    throw new RelayError('BAD_REQUEST', 'payload must be an object')
  }
  if (typeof frame.nonce !== 'string' || frame.nonce.length === 0) {
    throw new RelayError('BAD_REQUEST', 'nonce is required')
  }
  if (typeof frame.timestamp !== 'string' || frame.timestamp.length === 0) {
    throw new RelayError('BAD_REQUEST', 'timestamp is required')
  }
  if (frame.signature !== undefined && typeof frame.signature !== 'string') {
    throw new RelayError('BAD_REQUEST', 'signature must be a string when provided')
  }
  if (frame.signature === '') {
    throw new RelayError('BAD_REQUEST', 'signature is required')
  }

  return {
    ...frame,
    payload,
  }
}

export function canActOnBehalf(
  db: Database,
  connectedBeamId: string,
  claimedFromBeamId: string,
  intentType: string,
): boolean {
  if (connectedBeamId === claimedFromBeamId) {
    return true
  }

  return hasActiveDelegation(db, {
    grantorBeamId: claimedFromBeamId,
    granteeBeamId: connectedBeamId,
    scope: intentType,
  })
}

function resolveIntentSender(db: Database, connectedBeamId: string, frame: IntentFrame) {
  const senderAgent = getAgent(db, connectedBeamId)
  if (!senderAgent) {
    throw new RelayError('BAD_REQUEST', 'Sender is not registered in the directory')
  }

  if (!canActOnBehalf(db, connectedBeamId, frame.from, frame.intent)) {
    throw new RelayError(
      connectedBeamId === frame.from ? 'BAD_REQUEST' : 'FORBIDDEN',
      connectedBeamId === frame.from
        ? 'Sender is not registered in the directory'
        : `No active delegation allows ${connectedBeamId} to send ${frame.intent} for ${frame.from}`,
    )
  }

  return senderAgent
}

function enforceSecurityChecks(
  db: Database,
  frame: IntentFrame,
  senderPublicKey: string,
  options: { skipSignatureVerification?: boolean; skipLocalAclCheck?: boolean } = {},
): void {
  if (!checkAgentRateLimit(frame.from, getRateLimitPerMinute())) {
    throw new RelayError('RATE_LIMITED', `Rate limit exceeded for ${frame.from}`)
  }

  if (!options.skipSignatureVerification && !verifyIntentSignature(frame, senderPublicKey)) {
    throw new RelayError('BAD_REQUEST', 'Signature verification failed')
  }

  const localTarget = getAgent(db, frame.to)
  if (localTarget && !options.skipLocalAclCheck && !isIntentAllowed(db, {
    targetBeamId: frame.to,
    intentType: frame.intent,
    fromBeamId: frame.from,
  })) {
    throw new RelayError('FORBIDDEN', `ACL denied intent ${frame.intent} from ${frame.from} to ${frame.to}`)
  }

  const payloadValidation = validateIntentPayload(frame.intent, frame.payload)
  if (!payloadValidation.valid) {
    throw new RelayError('BAD_REQUEST', payloadValidation.error ?? 'Invalid payload')
  }

  enforceReplayProtection(db, frame)
}

function enforceReplayProtection(db: Database, frame: IntentFrame): void {
  void db
  const parsedTimestamp = new Date(frame.timestamp).getTime()
  if (Number.isNaN(parsedTimestamp)) {
    throw new RelayError('BAD_REQUEST', 'Invalid timestamp format')
  }

  if (Math.abs(Date.now() - parsedTimestamp) > REPLAY_WINDOW_MS) {
    throw new RelayError('BAD_REQUEST', 'Timestamp outside allowed replay window (5 minutes)')
  }
}

function verifyIntentSignature(frame: IntentFrame, senderPublicKeyBase64: string): boolean {
  // K5 FIX: Use JSON.stringify with insertion-order keys to match SDK's signFrame().
  // The SDK signs {type, from, to, intent, payload, timestamp, nonce} via JSON.stringify (NO sorting).
  // Previously: verifyPayload() called canonicalizeJson() which sorted keys → mismatch with SDK signatures.
  const signedPayloadStr = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  try {
    const keyObject = createPublicKey({
      key: Buffer.from(senderPublicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(signedPayloadStr, 'utf8'), keyObject, Buffer.from(frame.signature ?? '', 'base64'))
  } catch {
    return false
  }
}

function handleResult(db: Database, frame: ResultFrame): void {
  if (!frame || typeof frame.nonce !== 'string') {
    return
  }

  const pending = pendingResults.get(frame.nonce)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingResults.delete(frame.nonce)
    const latencyMs = typeof frame.latency === 'number' ? frame.latency : Math.max(0, Date.now() - pending.startedAtMs)
    finalizeIntentWithResult(pending.db, {
      v: '1',
      from: pending.fromBeamId,
      to: pending.toBeamId,
      intent: pending.intentType,
      payload: {},
      nonce: frame.nonce,
      timestamp: new Date(pending.startedAtMs).toISOString(),
    }, frame, latencyMs)
    recordIntentStage(pending.db, {
      nonce: frame.nonce,
      from: pending.fromBeamId,
      to: pending.toBeamId,
      intent: pending.intentType,
    }, frame.success ? 'acked' : 'failed', {
      transport: 'ws',
      latencyMs,
      errorCode: frame.success ? null : (frame.errorCode ?? 'RESULT_ERROR'),
    })
    broadcastCompletedIntent({
      v: '1',
      from: pending.fromBeamId,
      to: pending.toBeamId,
      intent: pending.intentType,
      payload: {},
      nonce: frame.nonce,
      timestamp: new Date(pending.startedAtMs).toISOString(),
    }, frame, latencyMs)
    pending.resolve(frame)
    return
  }

  const existing = getIntentLogByNonce(db, frame.nonce)
  if (!existing) {
    return
  }

  const existingStatus = normalizeIntentLifecycleStatus(existing.status) ?? 'received'
  if (isIntentLifecycleSuccess(existingStatus)) {
    return
  }

  const recoveringFailedAttempt = isIntentLifecycleFailure(existingStatus) && isRetryableIntentFailure(existing.error_code)
  if (isIntentLifecycleFailure(existingStatus) && !recoveringFailedAttempt) {
    return
  }

  const requestedAtMs = new Date(existing.requested_at).getTime()
  const fallbackLatencyMs = existing.round_trip_latency_ms
    ?? (Number.isNaN(requestedAtMs) ? null : Math.max(0, Date.now() - requestedAtMs))
  const resolvedLatencyMs = typeof frame.latency === 'number' ? frame.latency : fallbackLatencyMs

  const finalState = {
    nonce: frame.nonce,
    fromBeamId: existing.from_beam_id,
    toBeamId: existing.to_beam_id,
    status: frame.success ? 'acked' : 'failed' as IntentLifecycleStatus,
    latencyMs: resolvedLatencyMs,
    errorCode: frame.success ? undefined : (frame.errorCode ?? existing.error_code ?? 'RESULT_ERROR'),
    resultJson: serializeResultFrame(frame),
  }
  if (recoveringFailedAttempt) {
    reconcileIntentLog(db, finalState)
  } else {
    finalizeIntentLog(db, finalState)
  }
  recordIntentStage(db, {
    nonce: frame.nonce,
    from: existing.from_beam_id,
    to: existing.to_beam_id,
    intent: existing.intent_type,
  }, frame.success ? 'acked' : 'failed', {
    transport: 'ws',
    latencyMs: resolvedLatencyMs,
    errorCode: frame.success ? null : (frame.errorCode ?? existing.error_code ?? 'RESULT_ERROR'),
    lateResult: true,
    recoveredAfterFailure: recoveringFailedAttempt || undefined,
    previousStatus: existingStatus,
  })
  broadcastCompletedIntent({
    v: '1',
    from: existing.from_beam_id,
    to: existing.to_beam_id,
    intent: existing.intent_type,
    payload: {},
    nonce: frame.nonce,
    timestamp: existing.requested_at,
  }, frame, resolvedLatencyMs)
}

function createResultWaiter(db: Database, frame: IntentFrame, timeoutMs: number): Promise<ResultFrame> {
  if (pendingResults.has(frame.nonce)) {
    clearPendingResult(frame.nonce)
  }

  const startedAtMs = new Date(frame.timestamp).getTime()
  const safeStartedAtMs = Number.isNaN(startedAtMs) ? Date.now() : startedAtMs

  return new Promise<ResultFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(frame.nonce)
      const latencyMs = Math.max(0, Date.now() - safeStartedAtMs)
      const message = `Intent timed out waiting for result (${timeoutMs}ms)`
      finalizeFailedIntent(db, frame, {
        error: message,
        errorCode: 'TIMEOUT',
        latencyMs,
        transport: 'ws',
        details: {
          timeoutMs,
        },
      })
      reject(new RelayError('TIMEOUT', message))
    }, timeoutMs)

    pendingResults.set(frame.nonce, {
      db,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      startedAtMs: safeStartedAtMs,
      resolve,
      reject,
      timeout,
    })
  })
}

function clearPendingResult(nonce: string): void {
  const pending = pendingResults.get(nonce)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingResults.delete(nonce)
}

export function resetRelayRuntimeState(
  options: {
    closeConnections?: boolean
    rejectPending?: boolean
  } = {},
): void {
  const { closeConnections = false, rejectPending = false } = options

  for (const pending of pendingResults.values()) {
    clearTimeout(pending.timeout)
    if (rejectPending) {
      pending.reject(new RelayError('DELIVERY_FAILED', 'Relay runtime reset'))
    }
  }
  pendingResults.clear()

  if (closeConnections) {
    for (const session of connections.values()) {
      try {
        session.ws.terminate()
      } catch {
        // Ignore best-effort connection cleanup during runtime resets.
      }
    }
    for (const ws of intentFeedSubscribers.values()) {
      try {
        ws.terminate()
      } catch {
        // Ignore best-effort feed cleanup during runtime resets.
      }
    }
  }

  connections.clear()
  intentFeedSubscribers.clear()
}

function sendJson(ws: WebSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcastIntentFeed(entry: {
  nonce: string
  from: string
  to: string
  intentType: string
  timestamp: string
  completedAt: string | null
  roundTripLatencyMs: number | null
  status: IntentLifecycleStatus
  errorCode: string | null
}): void {
  for (const ws of intentFeedSubscribers) {
    if (ws.readyState !== WebSocket.OPEN) {
      intentFeedSubscribers.delete(ws)
      continue
    }

    sendJson(ws, {
      type: 'intent_feed',
      entry,
    })
  }
}
