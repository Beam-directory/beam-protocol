import type { Database } from 'better-sqlite3'
import { appendIntentTraceEvent, getAgent, getLatestIntentTraceEvent } from './db.js'
import { hashPayload, logShieldEvent } from './shield/audit.js'
import { sanitizeExternalMessage } from './shield/content-sandbox.js'
import { AnomalyDetector } from './shield/anomaly.js'
import {
  assertIntentLifecycleTransition,
  normalizeIntentLifecycleStatus,
  normalizeLegacyTraceLifecycle,
  type IntentLifecycleStatus,
} from './intent-lifecycle.js'

type TraceFrame = {
  nonce: string
  from: string
  to: string
  intent: string
}

type ShieldDecision = 'pass' | 'hold' | 'reject'

type AnomalyDb = ConstructorParameters<typeof AnomalyDetector>[0]

function severityToRiskScore(severity: 'low' | 'medium' | 'high' | 'critical'): number {
  switch (severity) {
    case 'critical':
      return 1
    case 'high':
      return 0.8
    case 'medium':
      return 0.55
    case 'low':
      return 0.35
    default:
      return 0
  }
}

function stringifyPayload(payload: unknown): string {
  try {
    return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
  } catch {
    return String(payload)
  }
}

export function recordIntentStage(
  db: Database,
  frame: TraceFrame,
  stage: IntentLifecycleStatus,
  details?: unknown,
  timestamp?: string,
): void {
  const previous = getLatestIntentTraceEvent(db, frame.nonce)
  const previousStage = previous
    ? (normalizeIntentLifecycleStatus(previous.stage) ?? normalizeLegacyTraceLifecycle(previous.stage, previous.status))
    : null

  assertIntentLifecycleTransition(previousStage, stage, `trace ${frame.nonce}`)
  appendIntentTraceEvent(db, {
    nonce: frame.nonce,
    fromBeamId: frame.from,
    toBeamId: frame.to,
    intentType: frame.intent,
    stage,
    details,
    timestamp,
  })
}

export function recordShieldDecision(
  db: Database,
  frame: TraceFrame & { payload: Record<string, unknown> },
  options: {
    decision?: ShieldDecision
    extraFlags?: string[]
    riskScore?: number
    timestamp?: string
  } = {},
): ShieldDecision {
  const payloadText = stringifyPayload(frame.payload)
  const senderTrust = getAgent(db, frame.from)?.trust_score ?? 0.5
  const sandboxResult = sanitizeExternalMessage(payloadText)
  const anomalies = new AnomalyDetector(db as unknown as AnomalyDb).detectAll({
    senderBeamId: frame.from,
    intentType: frame.intent,
    currentTrust: senderTrust,
    responseSize: payloadText.length,
  })

  const anomalyRisk = anomalies.reduce((maxRisk, anomaly) => {
    return Math.max(maxRisk, severityToRiskScore(anomaly.severity))
  }, 0)

  const riskScore = Math.max(
    options.riskScore ?? 0,
    sandboxResult.riskScore,
    anomalyRisk,
  )

  const flags = [
    ...sandboxResult.matchedPatterns,
    ...anomalies.map((anomaly) => anomaly.type),
    ...(options.extraFlags ?? []),
  ]

  const decision = options.decision ?? (
    riskScore >= 0.65 || anomalies.some((anomaly) => anomaly.shouldAlert)
      ? 'hold'
      : 'pass'
  )

  logShieldEvent(db, {
    nonce: frame.nonce,
    timestamp: options.timestamp ?? new Date().toISOString(),
    senderBeamId: frame.from,
    senderTrust,
    intentType: frame.intent,
    payloadHash: hashPayload(frame.payload),
    decision,
    riskScore,
    responseSize: payloadText.length,
    anomalyFlags: flags,
  })

  return decision
}
