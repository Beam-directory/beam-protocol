/**
 * Beam Message Bus — Background Retry Worker
 */

import type Database from 'better-sqlite3'
import { getPendingRetries, markDeadLetter, markDelivered, scheduleRetry } from './db.js'
import { deliverToDirectory } from './delivery.js'
import { computeRetryAt } from './retry.js'

export interface WorkerOptions {
  db: Database.Database
  directoryUrl: string
  intervalMs?: number
}

export function startRetryWorker(options: WorkerOptions): NodeJS.Timeout {
  const { db, directoryUrl, intervalMs = 30_000 } = options

  console.log(`[beam-bus] Retry worker started (interval: ${intervalMs / 1000}s)`)

  const timer = setInterval(async () => {
    try {
      const pending = getPendingRetries(db, 10)
      if (pending.length === 0) return

      for (const msg of pending) {
        const payload = JSON.parse(msg.payload) as Record<string, unknown>
        const result = await deliverToDirectory(
          directoryUrl,
          msg.id,
          msg.nonce,
          msg.sender,
          msg.recipient,
          msg.intent,
          payload,
        )

        if (result.success) {
          markDelivered(db, msg.id)
          console.log(`[beam-bus] ✅ Retry success: ${msg.sender} → ${msg.recipient} (${msg.intent})`)
        } else if (!result.retryable) {
          markDeadLetter(db, msg.id, result.error)
          console.log(`[beam-bus] 🪦 Non-retryable dead letter: ${msg.id.slice(0, 8)}... (${result.error})`)
        } else {
          const newCount = msg.retry_count + 1
          if (newCount >= msg.max_retries) {
            markDeadLetter(db, msg.id, result.error)
            console.log(`[beam-bus] 🪦 Max retries: ${msg.id.slice(0, 8)}... (${result.error})`)
          } else {
            const nextRetry = computeRetryAt(newCount, msg.nonce)
            scheduleRetry(db, msg.id, newCount, nextRetry, result.error)
          }
        }
      }
    } catch (err) {
      console.error('[beam-bus] Retry worker error:', err)
    }
  }, intervalMs)

  return timer
}

export function stopRetryWorker(timer: NodeJS.Timeout): void {
  clearInterval(timer)
  console.log('[beam-bus] Retry worker stopped')
}
