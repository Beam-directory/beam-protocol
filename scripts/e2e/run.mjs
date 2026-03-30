import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { BeamClient, BeamIdentity } from '../../packages/sdk-typescript/dist/index.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const directoryEntry = path.join(repoRoot, 'packages/directory/dist/index.js')
const messageBusEntry = path.join(repoRoot, 'packages/message-bus/dist/server.js')
const cliEntry = path.join(repoRoot, 'packages/cli/dist/index.js')
const pythonSenderEntry = path.join(repoRoot, 'scripts/e2e/python_sender.py')

async function ensureBuiltArtifacts() {
  for (const file of [directoryEntry, messageBusEntry, cliEntry, pythonSenderEntry]) {
    await access(file)
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine an open TCP port'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

function logStep(message) {
  console.log(`[e2e] ${message}`)
}

function spawnProcess({ name, command, args, env, cwd = repoRoot }) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`)
  })

  return child
}

async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) {
    return
  }

  child.kill(signal)
  const exitPromise = once(child, 'exit').catch(() => undefined)
  await Promise.race([exitPromise, sleep(5_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }
}

async function waitForHealth(url, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // ignore during boot
    }
    await sleep(250)
  }

  throw new Error(`${label} did not become healthy at ${url}`)
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }

  return parsed
}

async function allowIntent(directoryUrl, targetBeamId, intentType, allowedFrom) {
  await requestJson(`${directoryUrl}/acl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetBeamId, intentType, allowedFrom }),
  })
}

async function runCli(args, cwd, env = {}) {
  return execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
    },
    maxBuffer: 1024 * 1024,
  })
}

async function runPython(env) {
  const pythonPathEntries = [
    path.join(repoRoot, 'packages/sdk-python'),
    process.env.PYTHONPATH,
  ].filter(Boolean)

  return execFileAsync('python3', [pythonSenderEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: pythonPathEntries.join(path.delimiter),
    },
    maxBuffer: 1024 * 1024,
  })
}

async function step(name, fn) {
  logStep(name)
  try {
    return await fn()
  } catch (error) {
    throw new Error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

async function main() {
  await ensureBuiltArtifacts()

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'beam-e2e-'))
  const cliRoot = path.join(tempRoot, 'cli-agent')
  const directoryDb = path.join(tempRoot, 'beam-directory.sqlite')
  const messageBusDb = path.join(tempRoot, 'beam-bus.sqlite')
  const identityBundlePath = path.join(tempRoot, 'beam-bus-identities.json')
  const directoryPort = await getFreePort()
  const messageBusPort = await getFreePort()
  const directoryUrl = `http://127.0.0.1:${directoryPort}`
  const messageBusUrl = `http://127.0.0.1:${messageBusPort}/v1/beam`
  const beamBusApiKey = 'beam-bus-e2e-key'

  await mkdir(cliRoot, { recursive: true })

  const receiverIdentity = BeamIdentity.generate({ agentName: 'ts-receiver', orgName: 'e2e' })
  const tsSenderIdentity = BeamIdentity.generate({ agentName: 'ts-sender', orgName: 'e2e' })
  const busSenderIdentity = BeamIdentity.generate({ agentName: 'bus-sender', orgName: 'e2e' })

  await writeFile(
    identityBundlePath,
    JSON.stringify({ busSender: busSenderIdentity.export() }, null, 2),
    'utf8',
  )

  let directoryProcess
  let messageBusProcess
  let receiver

  try {
    directoryProcess = spawnProcess({
      name: 'directory',
      command: process.execPath,
      args: [directoryEntry],
      env: {
        PORT: String(directoryPort),
        DB_PATH: directoryDb,
        JWT_SECRET: 'beam-e2e-jwt-secret',
      },
    })

    await waitForHealth(`${directoryUrl}/health`, 'directory')

    messageBusProcess = spawnProcess({
      name: 'message-bus',
      command: process.execPath,
      args: [
        messageBusEntry,
        '--port', String(messageBusPort),
        '--directory', directoryUrl,
        '--db', messageBusDb,
        '--identity', identityBundlePath,
        '--rate-limit', '50',
      ],
      env: {
        BEAM_BUS_API_KEY: beamBusApiKey,
        BEAM_BUS_STATS_PUBLIC: 'true',
        BEAM_BUS_CLEAN_TEST_DATA: 'true',
      },
    })

    await waitForHealth(`http://127.0.0.1:${messageBusPort}/health`, 'message bus')

    receiver = new BeamClient({
      identity: receiverIdentity.export(),
      directoryUrl,
    })

    await step('registering the TypeScript receiver', async () => {
      await receiver.register('TypeScript Receiver', ['conversation.message'])
      receiver.onTalk(async (message, from, respond) => {
        respond(`TS receiver heard: ${message}`, {
          echoed: message,
          from,
          via: 'typescript',
        })
      })
      await receiver.connect()
      await allowIntent(directoryUrl, receiver.beamId, 'conversation.message', '*')
    })

    await step('validating the TypeScript SDK flow', async () => {
      const sender = new BeamClient({
        identity: tsSenderIdentity.export(),
        directoryUrl,
      })

      await sender.register('TypeScript Sender', [])
      const lookup = await sender.directory.lookup(receiver.beamId)
      assert.equal(lookup?.beamId, receiver.beamId, 'TypeScript lookup did not resolve the receiver')

      const search = await sender.directory.search({
        org: 'e2e',
        capabilities: ['conversation.message'],
        limit: 10,
      })
      assert(search.some((agent) => agent.beamId === receiver.beamId), 'TypeScript search did not find the receiver')

      const reply = await sender.talk(receiver.beamId, 'hello from typescript')
      assert.equal(reply.message, 'TS receiver heard: hello from typescript', 'TypeScript talk returned the wrong reply')
      assert.equal(reply.structured?.via, 'typescript', 'TypeScript structured reply did not round-trip')
    })

    await step('validating the Python SDK flow', async () => {
      const { stdout, stderr } = await runPython({
        BEAM_DIRECTORY_URL: directoryUrl,
        BEAM_RECEIVER_BEAM_ID: receiver.beamId,
        BEAM_SEARCH_ORG: 'e2e',
        BEAM_MESSAGE: 'hello from python',
      })

      if (stderr.trim().length > 0) {
        console.error(stderr)
      }

      const payload = JSON.parse(stdout)
      assert.equal(payload.lookupBeamId, receiver.beamId, 'Python lookup did not resolve the receiver')
      assert(payload.searchMatches.includes(receiver.beamId), 'Python search did not include the receiver')
      assert.equal(payload.reply.message, 'TS receiver heard: hello from python', 'Python talk returned the wrong reply')
    })

    await step('validating the CLI flow', async () => {
      await runCli(['init', '--agent', 'cli-sender', '--org', 'e2e', '--directory', directoryUrl, '--force'], cliRoot)
      await runCli(['register', '--display-name', 'CLI Sender', '--capabilities', 'conversation.message', '--directory', directoryUrl], cliRoot)

      const lookup = JSON.parse((await runCli(['lookup', receiver.beamId, '--directory', directoryUrl, '--json'], cliRoot)).stdout)
      assert.equal(lookup.beamId, receiver.beamId, 'CLI lookup did not resolve the receiver')

      const search = JSON.parse((await runCli(['search', '--org', 'e2e', '--capability', 'conversation.message', '--directory', directoryUrl, '--json'], cliRoot)).stdout)
      assert(search.some((agent) => agent.beamId === receiver.beamId), 'CLI search did not include the receiver')

      const reply = JSON.parse((await runCli(['talk', receiver.beamId, 'hello from cli', '--directory', directoryUrl, '--json'], cliRoot)).stdout)
      assert.equal(reply.message, 'TS receiver heard: hello from cli', 'CLI talk returned the wrong reply')
    })

    await step('smoke testing the message bus', async () => {
      const busSender = new BeamClient({
        identity: busSenderIdentity.export(),
        directoryUrl,
      })
      await busSender.register('Bus Sender', [])

      const sendResult = await requestJson(`${messageBusUrl}/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${beamBusApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: busSender.beamId,
          to: receiver.beamId,
          intent: 'conversation.message',
          payload: { message: 'hello from message bus' },
        }),
      })

      assert.equal(sendResult.status, 'delivered', 'Message bus did not report a delivered send')

      const polled = await requestJson(
        `${messageBusUrl}/poll?agent=${encodeURIComponent(receiver.beamId)}&status=delivered&limit=5`,
        {
          headers: { 'Authorization': `Bearer ${beamBusApiKey}` },
        },
      )

      const deliveredMessage = polled.messages.find((message) => (
        message.sender === busSender.beamId && message.intent === 'conversation.message'
      ))
      assert(deliveredMessage, 'Message bus poll did not expose the delivered async handoff')

      const ack = await requestJson(`${messageBusUrl}/ack`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${beamBusApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message_id: deliveredMessage.id,
          status: 'acked',
          response: {
            acknowledgement: 'completed',
            handledBy: receiver.beamId,
          },
        }),
      })

      assert.equal(ack.status, 'acked', 'Message bus ack did not transition to acked')

      const history = await requestJson(
        `${messageBusUrl}/history?sender=${encodeURIComponent(busSender.beamId)}&recipient=${encodeURIComponent(receiver.beamId)}&limit=5`,
        {
          headers: { 'Authorization': `Bearer ${beamBusApiKey}` },
        },
      )

      assert(history.messages.some((message) => message.status === 'acked' && message.intent === 'conversation.message'), 'Message bus history did not contain the acked async message')

      const stats = await requestJson(`${messageBusUrl}/stats`)
      assert(stats.total >= 1, 'Message bus stats did not record the delivered message')
      assert(stats.by_agent?.[busSender.beamId]?.sent >= 1, 'Message bus sender stats were not updated')
    })

    logStep('all cross-stack checks passed')
  } finally {
    if (receiver) {
      receiver.disconnect()
    }
    await stopProcess(messageBusProcess)
    await stopProcess(directoryProcess)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[e2e] failed')
  if (error instanceof Error) {
    console.error(error.message)
    if (error.cause instanceof Error) {
      console.error(error.cause.message)
    }
  } else {
    console.error(String(error))
  }
  process.exit(1)
})
