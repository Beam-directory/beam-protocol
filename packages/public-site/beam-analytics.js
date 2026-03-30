(function () {
  const DNT = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.msDoNotTrack === '1'
  if (DNT) {
    window.beamAnalytics = {
      disabled: true,
      pageKey: null,
      sessionId: null,
      track() {},
    }
    return
  }

  const STORAGE_KEY = 'beam_analytics_session_id'
  const COOKIE_KEY = 'beam_analytics_session_id'
  const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

  function resolveApiBase() {
    if (window.location.hostname === 'localhost') {
      return 'http://localhost:43100'
    }
    if (window.location.hostname === '127.0.0.1') {
      return 'http://127.0.0.1:43100'
    }
    return 'https://api.beam.directory'
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : null
  }

  function setCookie(name, value) {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      'SameSite=Lax',
    ]

    if (window.location.hostname.endsWith('.beam.directory') || window.location.hostname === 'beam.directory') {
      parts.push('Domain=.beam.directory')
      parts.push('Secure')
    }

    document.cookie = parts.join('; ')
  }

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '')
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  }

  function getSessionId() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored) {
        setCookie(COOKIE_KEY, stored)
        return stored
      }
    } catch {
    }

    const cookieValue = getCookie(COOKIE_KEY)
    if (cookieValue) {
      try {
        window.localStorage.setItem(STORAGE_KEY, cookieValue)
      } catch {
      }
      return cookieValue
    }

    const generated = makeSessionId()
    try {
      window.localStorage.setItem(STORAGE_KEY, generated)
    } catch {
    }
    setCookie(COOKIE_KEY, generated)
    return generated
  }

  function cleanPath(pathname) {
    return pathname.replace(/\/+$/, '') || '/'
  }

  function pageKeyForLocation() {
    const host = window.location.hostname
    const path = cleanPath(window.location.pathname)

    if (host === 'docs.beam.directory') {
      if (path === '/') return 'docs_home'
      if (path === '/guide/design-partner-onboarding') return 'docs_design_partner_onboarding'
      if (path === '/guide/hosted-quickstart') return 'docs_hosted_quickstart'
      if (path === '/guide/partner-handoff') return 'docs_partner_handoff'
      return 'docs_other'
    }

    const pageMap = {
      '/': 'landing',
      '/guided-evaluation.html': 'guided_evaluation',
      '/hosted-beta.html': 'hosted_beta',
      '/playground.html': 'playground',
      '/register.html': 'register',
      '/status.html': 'status',
      '/privacy.html': 'privacy',
      '/terms.html': 'terms',
    }

    return pageMap[path] || 'landing'
  }

  function inferTargetPage(href) {
    if (!href) return null

    try {
      const url = new URL(href, window.location.origin)
      const path = cleanPath(url.pathname)
      if (url.hostname === 'docs.beam.directory') {
        if (path === '/') return 'docs_home'
        if (path === '/guide/design-partner-onboarding') return 'docs_design_partner_onboarding'
        if (path === '/guide/hosted-quickstart') return 'docs_hosted_quickstart'
        if (path === '/guide/partner-handoff') return 'docs_partner_handoff'
        return 'docs_other'
      }

      if (path === '/') return 'landing'
      if (path === '/guided-evaluation.html') return 'guided_evaluation'
      if (path === '/hosted-beta.html') return 'hosted_beta'
      if (path === '/playground.html') return 'playground'
      if (path === '/register.html') return 'register'
      if (path === '/status.html') return 'status'
      return null
    } catch {
      return null
    }
  }

  function send(payload) {
    const body = JSON.stringify(payload)
    const url = `${resolveApiBase()}/analytics/events`
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon(url, blob)
      return
    }

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }

  const sessionId = getSessionId()
  const pageKey = pageKeyForLocation()

  function track(event) {
    const payload = {
      sessionId,
      pageKey: event.pageKey || pageKey,
      eventCategory: event.category,
      ctaKey: event.ctaKey || null,
      targetPage: event.targetPage || null,
      workflowType: event.workflowType || null,
      milestoneKey: event.milestoneKey || null,
    }

    send(payload)
  }

  track({ category: 'page_view' })

  if (pageKey === 'guided_evaluation') {
    track({ category: 'demo_milestone', milestoneKey: 'guided_evaluation_view' })
  }
  if (pageKey === 'hosted_beta') {
    track({ category: 'demo_milestone', milestoneKey: 'hosted_beta_view' })
  }
  if (pageKey === 'docs_design_partner_onboarding') {
    track({ category: 'demo_milestone', milestoneKey: 'design_partner_onboarding_view' })
  }
  if (pageKey === 'docs_hosted_quickstart') {
    track({ category: 'demo_milestone', milestoneKey: 'hosted_quickstart_view' })
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-beam-cta]') : null
    if (!target) {
      return
    }

    const ctaKey = target.getAttribute('data-beam-cta')
    if (!ctaKey) {
      return
    }

    const href = target instanceof HTMLAnchorElement ? target.href : target.getAttribute('href')
    track({
      category: 'cta_click',
      ctaKey,
      targetPage: inferTargetPage(href),
    })
  })

  window.beamAnalytics = {
    disabled: false,
    pageKey,
    sessionId,
    track,
  }
})()
