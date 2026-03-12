import { createServer, type Server } from 'node:http'
import { allowIntent, createRegisteredClient, directoryUrl, shutdown } from '../shared.js'

const demoWebhookPort = Number.parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)

function startDemoWebhookServer(): Promise<{ server: Server; webhookUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/beam-webhook') {
        res.statusCode = 404
        res.end('not found')
        return
      }

      const chunks: Uint8Array[] = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }

      const body = Buffer.concat(chunks).toString('utf8')
      console.log(`[webhook] ${body}`)

      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })

    server.listen(demoWebhookPort, () => {
      resolve({
        server,
        webhookUrl: `http://127.0.0.1:${demoWebhookPort}/beam-webhook`,
      })
    })
  })
}

async function main(): Promise<void> {
  let webhookUrl = process.env.WEBHOOK_URL
  let demoServer: Server | null = null

  if (!webhookUrl) {
    const started = await startDemoWebhookServer()
    demoServer = started.server
    webhookUrl = started.webhookUrl
  }

  const bridge = await createRegisteredClient({
    prefix: 'bridge',
    displayName: 'Webhook Bridge',
    capabilities: ['task.delegate'],
  })

  bridge.on('task.delegate', async (frame, respond) => {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        receivedAt: new Date().toISOString(),
        bridge: bridge.beamId,
        from: frame.from,
        intent: frame.intent,
        payload: frame.payload,
      }),
    })

    respond({
      success: response.ok,
      payload: {
        webhookUrl,
        status: response.status,
      },
      ...(response.ok ? {} : { error: `Webhook returned ${response.status}` }),
    })
  })

  await bridge.connect()

  const sender = await createRegisteredClient({
    prefix: 'sender',
    displayName: 'Webhook Sender',
    capabilities: [],
  })

  await allowIntent({
    targetBeamId: bridge.beamId,
    intentType: 'task.delegate',
    allowedFrom: sender.beamId,
  })

  const result = await sender.send(bridge.beamId, 'task.delegate', {
    task: 'forward launch.ready to webhook',
    context: 'beam-protocol',
  })

  console.log(`directory: ${directoryUrl}`)
  console.log(`bridge:    ${bridge.beamId}`)
  console.log(`sender:    ${sender.beamId}`)
  console.log(`webhook:   ${webhookUrl}`)
  console.log(`result:    ${JSON.stringify(result.payload ?? {})}`)

  shutdown(bridge, sender)
  demoServer?.close()
}

main().catch((error) => {
  console.error('[webhook-bridge] failed:', error)
  process.exit(1)
})
