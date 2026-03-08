/**
 * Beam Shield — Wall 5: Anomaly Detection
 * Detects unusual behavior patterns that may indicate compromise or attack.
 */

export interface AnomalyResult {
  type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  shouldAlert: boolean
}

interface DB {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => Record<string, unknown> | undefined
    all: (...args: unknown[]) => Record<string, unknown>[]
  }
}

export class AnomalyDetector {
  private db: DB

  constructor(db: DB) {
    this.db = db
  }

  /** Check if response size is 10x the agent's average */
  checkResponseSizeAnomaly(agentBeamId: string, currentSize: number): AnomalyResult | null {
    const row = this.db.prepare(
      'SELECT AVG(response_size) as avg_size, COUNT(*) as cnt FROM shield_audit_log WHERE sender_beam_id = ? AND response_size > 0',
    ).get(agentBeamId) as { avg_size: number | null; cnt: number } | undefined

    if (!row || row.cnt < 5 || !row.avg_size) return null

    const ratio = currentSize / row.avg_size
    if (ratio > 10) {
      return {
        type: 'response_size_spike',
        severity: ratio > 50 ? 'critical' : 'high',
        description: `Response size ${currentSize} is ${ratio.toFixed(0)}x the average (${Math.round(row.avg_size)})`,
        shouldAlert: true,
      }
    }
    return null
  }

  /** Check if this intent type was never seen from this sender */
  checkNewIntentType(senderBeamId: string, intentType: string): AnomalyResult | null {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM shield_audit_log WHERE sender_beam_id = ? AND intent_type = ?',
    ).get(senderBeamId, intentType) as { cnt: number } | undefined

    const totalRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM shield_audit_log WHERE sender_beam_id = ?',
    ).get(senderBeamId) as { cnt: number } | undefined

    if (!totalRow || totalRow.cnt < 3) return null // Not enough history

    if (!row || row.cnt === 0) {
      return {
        type: 'new_intent_type',
        severity: 'medium',
        description: `Sender ${senderBeamId} sent ${intentType} for the first time (${totalRow.cnt} prior intents of other types)`,
        shouldAlert: true,
      }
    }
    return null
  }

  /** Check for burst of intents from a single sender */
  checkRapidSenderRate(senderBeamId: string, windowMinutes = 5): AnomalyResult | null {
    const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString()
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM shield_audit_log WHERE sender_beam_id = ? AND created_at > ?',
    ).get(senderBeamId, cutoff) as { cnt: number } | undefined

    if (!row) return null

    if (row.cnt > 20) {
      return {
        type: 'rapid_sender_rate',
        severity: row.cnt > 50 ? 'critical' : 'high',
        description: `${row.cnt} intents from ${senderBeamId} in last ${windowMinutes} minutes`,
        shouldAlert: true,
      }
    }
    return null
  }

  /** Check if sender's trust score dropped since last contact */
  checkTrustDrop(senderBeamId: string, currentTrust: number): AnomalyResult | null {
    const row = this.db.prepare(
      'SELECT sender_trust FROM shield_audit_log WHERE sender_beam_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(senderBeamId) as { sender_trust: number } | undefined

    if (!row) return null

    const drop = row.sender_trust - currentTrust
    if (drop > 0.2) {
      return {
        type: 'trust_score_drop',
        severity: drop > 0.4 ? 'high' : 'medium',
        description: `Trust for ${senderBeamId} dropped from ${row.sender_trust.toFixed(2)} to ${currentTrust.toFixed(2)} (Δ${drop.toFixed(2)})`,
        shouldAlert: true,
      }
    }
    return null
  }

  /** Run all anomaly checks */
  detectAll(context: {
    senderBeamId: string
    intentType: string
    currentTrust: number
    responseSize?: number
  }): AnomalyResult[] {
    const results: AnomalyResult[] = []

    const checks = [
      this.checkNewIntentType(context.senderBeamId, context.intentType),
      this.checkRapidSenderRate(context.senderBeamId),
      this.checkTrustDrop(context.senderBeamId, context.currentTrust),
    ]

    if (context.responseSize !== undefined) {
      checks.push(this.checkResponseSizeAnomaly(context.senderBeamId, context.responseSize))
    }

    for (const check of checks) {
      if (check) results.push(check)
    }

    return results
  }
}
