import { allowIntent, createRegisteredClient, directoryUrl, shutdown } from '../shared.js'

async function main(): Promise<void> {
  const procurement = await createRegisteredClient({
    prefix: 'procurement',
    displayName: 'Acme Procurement Desk',
    capabilities: ['quote.request'],
  })

  const partnerDesk = await createRegisteredClient({
    prefix: 'partner-desk',
    displayName: 'Northwind Partner Desk',
    capabilities: ['quote.request', 'inventory.check'],
  })

  const warehouse = await createRegisteredClient({
    prefix: 'warehouse',
    displayName: 'Northwind Warehouse',
    capabilities: ['inventory.check'],
  })

  warehouse.on('inventory.check', async (frame, respond) => {
    console.log(`[warehouse] stock check from ${frame.from}`)
    const quantity = Number(frame.payload.quantity ?? 0)

    respond({
      success: true,
      payload: {
        sku: frame.payload.sku,
        quantity,
        available: quantity <= 240,
        confidence: 'high',
        shipWindow: 'Thu 08:00-12:00 CET',
        warehouse: warehouse.beamId,
      },
    })
  })

  partnerDesk.on('quote.request', async (frame, respond) => {
    console.log(`[partner-desk] quote request from ${frame.from}`)
    const inventoryResult = await partnerDesk.send(warehouse.beamId, 'inventory.check', {
      sku: frame.payload.sku,
      quantity: frame.payload.quantity,
      shipTo: frame.payload.shipTo,
    })

    respond({
      success: true,
      payload: {
        project: frame.payload.project,
        sku: frame.payload.sku,
        quantity: frame.payload.quantity,
        quotedUnitPriceEur: 184,
        totalPriceEur: Number(frame.payload.quantity ?? 0) * 184,
        supplier: partnerDesk.beamId,
        inventory: inventoryResult.payload,
      },
    })
  })

  await allowIntent({
    targetBeamId: partnerDesk.beamId,
    intentType: 'quote.request',
    allowedFrom: procurement.beamId,
  })

  await allowIntent({
    targetBeamId: warehouse.beamId,
    intentType: 'inventory.check',
    allowedFrom: partnerDesk.beamId,
  })

  await Promise.all([procurement.connect(), partnerDesk.connect(), warehouse.connect()])

  const quote = await procurement.send(partnerDesk.beamId, 'quote.request', {
    project: 'Mannheim rooftop rollout',
    sku: 'INV-240',
    quantity: 240,
    shipTo: 'Mannheim, DE',
    neededBy: '2026-04-03',
  })

  console.log(`directory:     ${directoryUrl}`)
  console.log(`procurement:   ${procurement.beamId}`)
  console.log(`partner-desk:  ${partnerDesk.beamId}`)
  console.log(`warehouse:     ${warehouse.beamId}`)
  console.log(JSON.stringify(quote.payload, null, 2))

  shutdown(procurement, partnerDesk, warehouse)
}

main().catch((error) => {
  console.error('[partner-handoff] failed:', error)
  process.exit(1)
})
