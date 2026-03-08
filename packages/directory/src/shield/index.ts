/**
 * Beam Shield — Agent Security System
 *
 * 5-wall defense architecture:
 * Wall 1: Protocol Hardening (body limit, nonce expiry, timestamp validation)
 * Wall 2: Trust Gate (allowlist/blocklist, trust scoring, rate limiting)
 * Wall 3: Content Sandbox (injection detection, isolation frame)
 * Wall 4: Output Filter (PII detection, credential scanning, redaction)
 * Wall 5: Audit & Anomaly Detection (event logging, behavior analysis)
 */

export * from './content-sandbox.js'
export * from './output-filter.js'
export * from './audit.js'
export * from './anomaly.js'
