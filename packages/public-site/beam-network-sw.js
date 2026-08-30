self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch { payload = {} }
  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : ''
  event.waitUntil(self.registration.showNotification(payload.title || 'New Beam message', {
    body: payload.body || 'A trusted identity sent you a message.',
    tag: payload.tag || (conversationId ? `beam-conversation-${conversationId}` : 'beam-network'),
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { conversationId, url: '/network' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/network'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => ['/network', '/network.html'].includes(new URL(client.url).pathname))
    if (existing) {
      await existing.focus()
      existing.postMessage({ type: 'beam.notification.open', conversationId: event.notification.data?.conversationId || '' })
      return
    }
    await self.clients.openWindow(url)
  })())
})
