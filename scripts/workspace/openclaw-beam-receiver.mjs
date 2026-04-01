import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { optionalFlag } from '../production/shared.mjs'
import {
  loadOpenClawRuntimeState,
  resolveRuntimePaths,
  runtimeSourceFingerprint,
  slugify,
} from './openclaw-runtime-state.mjs'

const directoryUrl = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL || 'http://localhost:43100')
const workspaceSlug = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG || 'openclaw-local')
const pollMs = Number.parseInt(optionalFlag('--poll-ms', '1500'), 10)
const syncIntervalMs = Number.parseInt(optionalFlag('--sync-interval-ms', '10000'), 10)
const replyTimeoutMs = Number.parseInt(optionalFlag('--reply-timeout-ms', '120000'), 10)
const historyLimit = Number.parseInt(optionalFlag('--history-limit', '80'), 10)
const includeEndedSubagents = process.argv.includes('--include-ended-subagents')
const runtimePaths = resolveRuntimePaths({
  agentsDir: optionalFlag('--agents-dir'),
  workspaceAgentsDir: optionalFlag('--workspace-agents-dir'),
  identitiesPath: optionalFlag('--identities'),
  generatedIdentitiesPath: optionalFlag('--generated-identities'),
  mergedIdentitiesPath: optionalFlag('--merged-identities'),
  subagentRunsPath: optionalFlag('--subagent-runs'),
})

function log(message) {
  console.log(`[openclaw-receiver] ${message}`)
}

function resolveOpenClawBinary() {
  const candidates = [
    process.env.OPENCLAW_BIN,
    path.join(process.env.HOME ?? '', 'Library/pnpm/openclaw'),
    '/Users/tobik/Library/pnpm/openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }

  const which = spawnSync('/usr/bin/which', ['openclaw'], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  })
  if (which.status === 0) {
    const resolved = which.stdout.trim()
    if (resolved.length > 0) {
      return resolved
    }
  }

  return 'openclaw'
}

const openclawBinary = resolveOpenClawBinary()
const receiverPath = [...new Set([
  path.dirname(process.execPath),
  path.join(process.env.HOME ?? '', 'Library/pnpm'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.PATH,
].filter(Boolean))].join(':')

function openclawJson(params, { allowFailure = false } = {}) {
  const result = spawnSync(openclawBinary, ['gateway', 'call', ...params, '--json'], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: receiverPath,
    },
  })

  const stdout = result.stdout?.trim() ?? ''
  const stderr = result.stderr?.trim() ?? ''
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${openclawBinary} gateway call ${params.join(' ')} failed${stderr ? `: ${stderr}` : ''}${stdout ? `\n${stdout}` : ''}`)
  }

  if (stdout.length === 0) {
    return null
  }

  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Could not parse OpenClaw JSON output for ${params.join(' ')}: ${stdout.slice(0, 400)}`, { cause: error })
  }
}

async function openWebSocket(url) {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new globalThis.WebSocket(url)
  }

  const { default: WS } = await import('ws')
  return new WS(url)
}

function buildWsUrl(beamId, apiKey) {
  const params = new URLSearchParams({
    beamId,
    apiKey,
  })

  return directoryUrl
    .replace(/^http:\/\//u, 'ws://')
    .replace(/^https:\/\//u, 'wss://')
    .replace(/\/$/u, '') + `/ws?${params.toString()}`
}

function createRouteSignature(route) {
  return JSON.stringify({
    beamId: route.beamId,
    apiKey: route.apiKey,
    agentName: route.agentName,
    source: route.source,
    childSessionKey: route.childSessionKey ?? null,
    runtimeType: route.runtimeType,
  })
}

function extractTextContent(message) {
  const segments = Array.isArray(message?.content) ? message.content : []
  return segments
    .filter((segment) => segment?.type === 'text' && typeof segment.text === 'string')
    .map((segment) => segment.text.trim())
    .filter((segment) => segment.length > 0)
    .join('\n\n')
}

function maxOpenClawSeq(messages) {
  return messages.reduce((max, message) => {
    const seq = Number(message?.__openclaw?.seq ?? 0)
    return Number.isFinite(seq) && seq > max ? seq : max
  }, 0)
}

function selectAssistantReply(messages, minSeq) {
  const candidates = messages.filter((message) => {
    const seq = Number(message?.__openclaw?.seq ?? 0)
    if (!Number.isFinite(seq) || seq <= minSeq) {
      return false
    }
    if (message?.role !== 'assistant') {
      return false
    }
    return extractTextContent(message).length > 0
  })

  if (candidates.length === 0) {
    return null
  }

  const completed = candidates.filter((message) => message.stopReason && message.stopReason !== 'toolUse')
  const chosen = completed.at(-1) ?? candidates.at(-1)
  return {
    message: chosen,
    seq: Number(chosen.__openclaw?.seq ?? 0),
    text: extractTextContent(chosen),
  }
}

function normalizePayload(frame) {
  return frame?.payload && typeof frame.payload === 'object'
    ? { ...frame.payload }
    : {}
}

function buildBeamPrompt(route, frame, sessionKey) {
  const payload = normalizePayload(frame)
  const inlineMessage = typeof payload.message === 'string' ? payload.message.trim() : null
  if (inlineMessage) {
    delete payload.message
  }

  const lines = [
    'Beam handoff received.',
    `Target agent: ${route.agentName}`,
    `From: ${frame.from}`,
    `Intent: ${frame.intent}`,
    `Nonce: ${frame.nonce}`,
    `Workspace: ${workspaceSlug}`,
    `Session key: ${sessionKey}`,
    '',
  ]

  if (inlineMessage) {
    lines.push('Sender request:')
    lines.push(inlineMessage)
    lines.push('')
  }

  if (Object.keys(payload).length > 0 || !inlineMessage) {
    lines.push('Payload JSON:')
    lines.push(JSON.stringify(payload, null, 2))
    lines.push('')
  }

  lines.push('Reply for the sender in plain text. Be direct and concise unless the request requires detail.')
  return lines.join('\n')
}

function buildSessionKey(route, frame) {
  const payload = normalizePayload(frame)
  const requestedThreadKey = typeof payload.threadKey === 'string' && payload.threadKey.trim().length > 0
    ? payload.threadKey.trim()
    : null

  if (route.source === 'subagent-run' && route.childSessionKey) {
    return route.childSessionKey
  }

  if (requestedThreadKey) {
    return `agent:${route.agentName}:beam:${slugify(requestedThreadKey)}`
  }

  return `agent:${route.agentName}:beam:${frame.nonce.slice(0, 12)}`
}

function buildSessionLabel(route, frame) {
  const senderSlug = slugify(frame.from ?? 'beam')
  return `Beam Inbox (${route.agentName} <- ${senderSlug})`
}

async function ensureOpenClawSession(route, frame) {
  const sessionKey = buildSessionKey(route, frame)
  if (route.source === 'subagent-run' && route.childSessionKey) {
    return {
      sessionKey,
      mode: 'attached-subagent',
    }
  }

  openclawJson([
    'sessions.create',
    '--params',
    JSON.stringify({
      key: sessionKey,
      agentId: route.agentName,
      label: buildSessionLabel(route, frame),
    }),
  ])

  return {
    sessionKey,
    mode: 'managed-agent',
  }
}

async function loadHistory(sessionKey) {
  const payload = openclawJson([
    'chat.history',
    '--params',
    JSON.stringify({
      sessionKey,
      limit: historyLimit,
    }),
  ])

  return Array.isArray(payload?.messages) ? payload.messages : []
}

async function forwardIntentToOpenClaw(route, frame) {
  const session = await ensureOpenClawSession(route, frame)
  const historyBefore = await loadHistory(session.sessionKey)
  const baselineSeq = maxOpenClawSeq(historyBefore)
  const prompt = buildBeamPrompt(route, frame, session.sessionKey)

  const sendPayload = openclawJson([
    'sessions.send',
    '--params',
    JSON.stringify({
      key: session.sessionKey,
      message: prompt,
      timeoutMs: Math.min(replyTimeoutMs, 30_000),
      idempotencyKey: `beam:${frame.nonce}`,
    }),
  ])

  const messageSeq = Number(sendPayload?.messageSeq ?? baselineSeq)
  const minReplySeq = Number.isFinite(messageSeq) && messageSeq > 0 ? messageSeq : baselineSeq
  const deadline = Date.now() + replyTimeoutMs

  while (Date.now() < deadline) {
    const messages = await loadHistory(session.sessionKey)
    const reply = selectAssistantReply(messages, minReplySeq)
    if (reply) {
      return {
        sessionKey: session.sessionKey,
        sessionMode: session.mode,
        messageSeq: minReplySeq,
        responseSeq: reply.seq,
        text: reply.text,
      }
    }

    await sleep(pollMs)
  }

  throw new Error(`Timed out waiting for an OpenClaw reply in session ${session.sessionKey}`)
}

function buildSuccessResult(route, delivery) {
  return {
    message: delivery.text,
    openclaw: {
      agentName: route.agentName,
      runtimeType: route.runtimeType,
      sessionKey: delivery.sessionKey,
      sessionMode: delivery.sessionMode,
      messageSeq: delivery.messageSeq,
      responseSeq: delivery.responseSeq,
    },
  }
}

class RouteConnection {
  constructor(manager, route) {
    this.manager = manager
    this.route = route
    this.signature = createRouteSignature(route)
    this.ws = null
    this.connected = false
    this.stopped = false
    this.reconnectTimer = null
  }

  async start() {
    await this.connect()
  }

  async connect() {
    if (this.stopped) {
      return
    }

    const wsUrl = buildWsUrl(this.route.beamId, this.route.apiKey)
    log(`connecting ${this.route.beamId} (${this.route.runtimeType})`)
    const ws = await openWebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {}
    ws.onmessage = (event) => {
      void this.handleMessage(typeof event.data === 'string' ? event.data : event.data.toString())
    }
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      if (!this.stopped) {
        log(`connection closed for ${this.route.beamId}; retrying`)
        this.scheduleReconnect()
      }
    }
    ws.onerror = () => {
      if (!this.connected) {
        log(`connection error for ${this.route.beamId}`)
      }
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((error) => {
        log(`reconnect failed for ${this.route.beamId}: ${error instanceof Error ? error.message : String(error)}`)
        this.scheduleReconnect()
      })
    }, 2_000)
  }

  async stop() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Best effort only.
      }
    }
  }

  async handleMessage(raw) {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }

    if (payload?.type === 'connected') {
      this.connected = true
      log(`connected ${this.route.beamId}`)
      return
    }

    if (payload?.type !== 'intent' || !payload.frame) {
      return
    }

    const frame = payload.frame
    if (frame.to !== this.route.beamId) {
      return
    }

    try {
      const delivery = await forwardIntentToOpenClaw(this.route, frame)
      this.sendResult({
        v: '1',
        success: true,
        nonce: frame.nonce,
        timestamp: new Date().toISOString(),
        latency: 0,
        payload: buildSuccessResult(this.route, delivery),
      })
      log(`delivered ${frame.intent} for ${this.route.beamId} via ${delivery.sessionKey}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unhandled OpenClaw receiver error'
      this.sendResult({
        v: '1',
        success: false,
        nonce: frame.nonce,
        timestamp: new Date().toISOString(),
        error: message,
        errorCode: 'OPENCLAW_RECEIVER_ERROR',
      })
      log(`failed ${frame.intent} for ${this.route.beamId}: ${message}`)
    }
  }

  sendResult(frame) {
    if (!this.ws || !this.connected) {
      return
    }

    this.ws.send(JSON.stringify({
      type: 'result',
      frame,
    }))
  }
}

class ReceiverManager {
  constructor() {
    this.connections = new Map()
    this.lastFingerprint = ''
    this.watchers = []
    this.syncTimer = null
    this.periodicTimer = null
  }

  async sync(reason = 'manual') {
    const state = await loadOpenClawRuntimeState({
      ...runtimePaths,
      includeEndedSubagents,
    })

    if (reason !== 'startup' && state.fingerprint === this.lastFingerprint) {
      return
    }

    this.lastFingerprint = state.fingerprint
    const nextRoutes = new Map(state.routes.map((route) => [route.beamId, route]))

    for (const [beamId, connection] of this.connections) {
      const nextRoute = nextRoutes.get(beamId)
      const nextSignature = nextRoute ? createRouteSignature(nextRoute) : null
      if (!nextRoute || nextSignature !== connection.signature) {
        await connection.stop()
        this.connections.delete(beamId)
      }
    }

    for (const route of nextRoutes.values()) {
      if (this.connections.has(route.beamId)) {
        continue
      }
      const connection = new RouteConnection(this, route)
      this.connections.set(route.beamId, connection)
      void connection.start().catch((error) => {
        log(`initial connect failed for ${route.beamId}: ${error instanceof Error ? error.message : String(error)}`)
        connection.scheduleReconnect()
      })
    }

    log(`synced ${this.connections.size} receiver routes (${state.counts.persistentAgents} persistent, ${state.counts.workspaceAgents} workspace, ${state.counts.subagents} active subagents)`)
  }

  scheduleSync(reason) {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync(reason).catch((error) => {
        log(`sync failed (${reason}): ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 750)
  }

  async start() {
    await this.sync('startup')

    const watchTargets = [
      { path: runtimePaths.agentsDir, kind: 'directory' },
      { path: runtimePaths.workspaceAgentsDir, kind: 'directory' },
      { path: path.dirname(runtimePaths.subagentRunsPath), kind: 'file-parent', file: path.basename(runtimePaths.subagentRunsPath) },
      { path: path.dirname(runtimePaths.mergedIdentitiesPath), kind: 'file-parent', file: path.basename(runtimePaths.mergedIdentitiesPath) },
      { path: path.dirname(runtimePaths.generatedIdentitiesPath), kind: 'file-parent', file: path.basename(runtimePaths.generatedIdentitiesPath) },
    ].filter((target) => fs.existsSync(target.path))

    this.watchers = watchTargets.map((target) => fs.watch(target.path, (_eventType, filename) => {
      if (target.kind === 'file-parent' && filename && filename !== target.file) {
        return
      }
      this.scheduleSync(target.kind === 'file-parent' ? target.file : path.basename(target.path))
    }))

    this.periodicTimer = setInterval(() => {
      void this.sync('periodic').catch((error) => {
        log(`periodic sync failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, syncIntervalMs)
  }

  async stop() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
    for (const watcher of this.watchers) {
      watcher.close()
    }
    this.watchers = []
    for (const connection of this.connections.values()) {
      await connection.stop()
    }
    this.connections.clear()
  }
}

const manager = new ReceiverManager()

async function main() {
  log(`using OpenClaw binary: ${openclawBinary}`)
  log(`workspace: ${workspaceSlug}`)
  await manager.start()
}

process.on('SIGINT', () => {
  void manager.stop().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void manager.stop().finally(() => process.exit(0))
})

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
