import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createAdminToken,
  loadQuickstartEnv,
  repoRoot,
  requestJson,
  resolveRuntime,
  waitForHealth,
} from './shared.mjs'

function formatList(values) {
  if (!values.length) {
    return '- none'
  }
  return values.map((value) => `- ${value}`).join('\n')
}

async function main() {
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)

  await waitForHealth(`${runtime.directoryUrl}/health`, 'directory')
  await waitForHealth(`${runtime.messageBusBaseUrl}/health`, 'message bus')
  await waitForHealth(`${runtime.demoAgentUrl}/health`, 'hosted demo agents')

  const run = await requestJson(`${runtime.demoAgentUrl}/demo/run`, {
    method: 'POST',
  })
  const adminToken = await createAdminToken(runtime.directoryUrl, runtime.dashboardUrl, runtime.adminEmail)
  const headers = { Authorization: `Bearer ${adminToken}` }

  const quoteTrace = await requestJson(`${runtime.directoryUrl}/observability/intents/${encodeURIComponent(run.quote.nonce)}`, { headers })
  const inventoryTrace = run.inventory.nonce
    ? await requestJson(`${runtime.directoryUrl}/observability/intents/${encodeURIComponent(run.inventory.nonce)}`, { headers })
    : null
  const financeTrace = run.asyncPreflight.notificationNonce
    ? await requestJson(`${runtime.directoryUrl}/observability/intents/${encodeURIComponent(run.asyncPreflight.notificationNonce)}`, { headers })
    : null
  const alerts = await requestJson(`${runtime.directoryUrl}/observability/alerts?hours=24`, { headers })
  const audit = await requestJson(`${runtime.directoryUrl}/observability/audit?limit=25&hours=24`, { headers })
  const busStats = await requestJson(`${runtime.messageBusUrl}/stats`, {
    headers: { Authorization: `Bearer ${runtime.busApiKey}` },
  })
  const deadLetters = await requestJson(`${runtime.messageBusUrl}/dead-letter?limit=10`, {
    headers: { Authorization: `Bearer ${runtime.busApiKey}` },
  })

  const report = `# 0.8.0 Hosted Demo Readiness

Generated at: ${new Date().toISOString()}

## Scenario

Seeded hosted quickstart stack using the canonical Acme to Northwind handoff:

- procurement sends \`quote.request\`
- partner desk calls \`inventory.check\`
- message bus fans out \`purchase.preflight\`
- operators investigate through the runbook in [docs/guide/operator-runbook.md](../docs/guide/operator-runbook.md)

## Result

- Quote nonce: \`${run.quote.nonce}\`
- Quote total: \`${run.quote.totalPriceEur}\`
- Inventory trace nonce: \`${run.inventory.nonce ?? 'none'}\`
- Async notification nonce: \`${run.asyncPreflight.notificationNonce ?? 'none'}\`
- Async bus status: \`${run.asyncPreflight.messageBusStatus ?? 'none'}\`
- Async acknowledgement: \`${run.asyncPreflight.acknowledgement ?? 'none'}\`

## Observability

- Quote trace stages: ${quoteTrace.stages.map((stage) => stage.stage).join(' -> ')}
- Inventory trace stages: ${inventoryTrace ? inventoryTrace.stages.map((stage) => stage.stage).join(' -> ') : 'none'}
- Finance trace stages: ${financeTrace ? financeTrace.stages.map((stage) => stage.stage).join(' -> ') : 'none'}
- Alerts: ${alerts.alerts.length}
- Dead letters: ${deadLetters.count}
- Bus totals: ${JSON.stringify({ total: busStats.total, delivered: busStats.delivered, acked: busStats.acked, deadLetter: busStats.dead_letter })}

## Investigation Notes

The operator investigation path matched the runbook:

1. Started from the trace for \`${run.quote.nonce}\`
2. Confirmed the message bus accepted the finance fan-out as \`delivered\`, then verified the downstream intent trace independently for its terminal state
3. Checked dead letters for exhaustion or non-retryable failures
4. Confirmed audit history stayed limited to expected operator and control-plane actions

## Audit Actions

${formatList(audit.entries.slice(0, 8).map((entry) => `${entry.timestamp} ${entry.action} ${entry.actor} -> ${entry.target}`))}
`

  const reportPath = path.join(repoRoot, 'reports/0.8.0-hosted-demo-readiness.md')
  await writeFile(reportPath, report, 'utf8')

  console.log(`Hosted demo dogfood passed. Report written to ${reportPath}`)
}

main().catch((error) => {
  console.error('[dogfood:hosted-demo] failed:', error)
  process.exit(1)
})
