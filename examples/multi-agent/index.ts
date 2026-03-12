import { allowIntent, createRegisteredClient, directoryUrl, shutdown } from '../shared.js'

async function main(): Promise<void> {
  const alpha = await createRegisteredClient({
    prefix: 'alpha',
    displayName: 'Alpha Coordinator',
    capabilities: ['conversation.message'],
  })
  const beta = await createRegisteredClient({
    prefix: 'beta',
    displayName: 'Beta Router',
    capabilities: ['task.delegate'],
  })
  const gamma = await createRegisteredClient({
    prefix: 'gamma',
    displayName: 'Gamma Worker',
    capabilities: ['agent.ping'],
  })

  alpha.onTalk(async (message, from, respond) => {
    console.log(`[alpha] notice from ${from}`)
    respond(`Alpha acknowledged: ${message}`, {
      acknowledgedBy: alpha.beamId,
    })
  })

  gamma.on('agent.ping', async (frame, respond) => {
    console.log(`[gamma] ping from ${frame.from}`)
    const alphaNotice = await gamma.talk(
      alpha.beamId,
      `Gamma received ${String(frame.payload.message ?? 'a ping')}`,
    )

    respond({
      success: true,
      payload: {
        stage: 'gamma',
        alphaNotice: {
          message: alphaNotice.message,
          structured: alphaNotice.structured,
        },
      },
    })
  })

  beta.on('task.delegate', async (frame, respond) => {
    console.log(`[beta] sync from ${frame.from}`)
    const gammaResult = await beta.send(gamma.beamId, 'agent.ping', {
      message: `Checkpoint for ${String(frame.payload.task ?? 'unknown-task')}`,
    })

    respond({
      success: true,
      payload: {
        stage: 'beta',
        gammaResult: gammaResult.payload,
      },
    })
  })

  await allowIntent({
    targetBeamId: beta.beamId,
    intentType: 'task.delegate',
    allowedFrom: alpha.beamId,
  })
  await allowIntent({
    targetBeamId: gamma.beamId,
    intentType: 'agent.ping',
    allowedFrom: beta.beamId,
  })
  await allowIntent({
    targetBeamId: alpha.beamId,
    intentType: 'conversation.message',
    allowedFrom: gamma.beamId,
  })

  await Promise.all([alpha.connect(), beta.connect(), gamma.connect()])

  const chain = await alpha.send(beta.beamId, 'task.delegate', {
    task: 'prepare-launch-checklist',
    priority: 'high',
  })

  console.log(`directory: ${directoryUrl}`)
  console.log(`alpha:     ${alpha.beamId}`)
  console.log(`beta:      ${beta.beamId}`)
  console.log(`gamma:     ${gamma.beamId}`)
  console.log(JSON.stringify(chain.payload, null, 2))

  shutdown(alpha, beta, gamma)
}

main().catch((error) => {
  console.error('[multi-agent] failed:', error)
  process.exit(1)
})
