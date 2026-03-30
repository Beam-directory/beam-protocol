import { loadQuickstartEnv, resolveRuntime, requestJson, waitForHealth } from './shared.mjs'

async function main() {
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)

  await waitForHealth(`${runtime.demoAgentUrl}/health`, 'hosted demo agents')

  const summary = await requestJson(`${runtime.demoAgentUrl}/demo/run`, {
    method: 'POST',
  })

  console.log('Hosted demo run passed.')
  console.log(`Quote nonce: ${summary.quote.nonce}`)
  console.log(`Quote total: ${summary.quote.totalPriceEur}`)
  console.log(`Inventory trace: ${summary.inventory.nonce ?? '—'}`)
  console.log(`Async preflight status: ${summary.asyncPreflight.messageBusStatus ?? '—'}`)
  console.log(`Async acknowledgement: ${summary.asyncPreflight.acknowledgement ?? '—'}`)
}

main().catch((error) => {
  console.error('[demo:run] failed:', error)
  process.exit(1)
})
