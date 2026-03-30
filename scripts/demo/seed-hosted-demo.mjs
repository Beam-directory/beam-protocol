import { loadQuickstartEnv, resolveRuntime, requestJson, waitForHealth } from './shared.mjs'

async function main() {
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)

  await waitForHealth(`${runtime.directoryUrl}/health`, 'directory')
  await waitForHealth(`${runtime.messageBusBaseUrl}/health`, 'message bus')
  await waitForHealth(`${runtime.demoAgentUrl}/health`, 'hosted demo agents', (response) => response.status === 200 || response.status === 503)

  const seed = await requestJson(`${runtime.demoAgentUrl}/demo/reseed`, {
    method: 'POST',
  })

  console.log('Hosted demo seeded.')
  console.log(`Procurement: ${seed.agents.procurement.beamId}`)
  console.log(`Partner desk: ${seed.agents.partnerDesk.beamId}`)
  console.log(`Warehouse: ${seed.agents.warehouse.beamId}`)
  console.log(`Finance: ${seed.agents.finance.beamId}`)
}

main().catch((error) => {
  console.error('[demo:seed] failed:', error)
  process.exit(1)
})
