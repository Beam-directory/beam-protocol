import { optionalFlag, createAdminHeaders, createAdminToken, requestJson } from '../production/shared.mjs'

async function main() {
  const directoryUrl = optionalFlag('--directory-url', process.env['BEAM_DIRECTORY_URL'] ?? 'http://localhost:43100')
  const adminEmail = optionalFlag('--email', 'ops@beam.local')
  const providedToken = optionalFlag('--token', process.env['BEAM_ADMIN_TOKEN'] ?? null)
  const deliver = optionalFlag('--deliver', 'true') !== 'false'
  const respectSchedule = optionalFlag('--respect-schedule', 'true') !== 'false'
  const token = providedToken ?? await createAdminToken(directoryUrl, adminEmail)

  const response = await requestJson(`${directoryUrl}/admin/openclaw/fleet/digest/run`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({
      triggerKind: 'scheduled',
      deliver,
      respectSchedule,
    }),
  })

  console.log(JSON.stringify({
    ok: true,
    directoryUrl,
    deliver,
    respectSchedule,
    skipped: response.skipped,
    reason: response.reason ?? null,
    nextRunAt: response.nextRunAt ?? response.schedule?.nextRunAt ?? null,
    run: response.run
      ? {
          id: response.run.id,
          generatedAt: response.run.generatedAt,
          deliveryState: response.run.deliveryState,
        }
      : null,
    deliveries: response.deliveries?.map((entry) => ({
      kind: entry.delivery.kind,
      status: entry.status,
      errorCode: entry.errorCode,
      recipientEmail: entry.delivery.recipientEmail,
    })) ?? [],
  }, null, 2))
}

main().catch((error) => {
  console.error('[workspace:fleet-digest:tick] failed:', error)
  process.exitCode = 1
})
