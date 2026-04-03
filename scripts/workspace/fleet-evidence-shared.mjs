import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { getFreePort } from '../production/shared.mjs'

export async function startWebhookCapture({
  responseStatus = 202,
  responseBody = { ok: true },
  path = '/fleet-alerts',
} = {}) {
  const events = []
  const port = await getFreePort()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }

    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body = null
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }

    events.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body,
      receivedAt: new Date().toISOString(),
    })

    res.statusCode = responseStatus
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(responseBody))
  })

  server.listen(port, '127.0.0.1')
  await once(server, 'listening')

  return {
    url: `http://127.0.0.1:${port}${path}`,
    getEvents() {
      return [...events]
    },
    clear() {
      events.length = 0
    },
    async waitForCount(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (events.length >= count) {
          return [...events]
        }
        await sleep(100)
      }
      throw new Error(`Timed out waiting for ${count} captured webhook event(s); saw ${events.length}.`)
    },
    async close() {
      if (!server.listening) {
        return
      }
      server.close()
      await once(server, 'close').catch(() => undefined)
    },
  }
}
