(function () {
  const revealItems = Array.from(document.querySelectorAll('.reveal'))

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible')
          observer.unobserve(entry.target)
        }
      }
    }, { threshold: 0.16 })

    for (const item of revealItems) {
      observer.observe(item)
    }
  } else {
    for (const item of revealItems) {
      item.classList.add('visible')
    }
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const finePointer = window.matchMedia('(pointer: fine)').matches

  if (!reducedMotion && finePointer) {
    const hero = document.querySelector('.page-hero')

    if (hero) {
      hero.addEventListener('pointermove', (event) => {
        const bounds = hero.getBoundingClientRect()
        const x = (event.clientX - bounds.left) / bounds.width
        const y = (event.clientY - bounds.top) / bounds.height
        hero.style.setProperty('--beam-pointer-x', `${(x * 100).toFixed(1)}%`)
        hero.style.setProperty('--beam-pointer-y', `${(y * 100).toFixed(1)}%`)
        hero.style.setProperty('--beam-hero-shift-x', `${((x - 0.5) * -16).toFixed(1)}px`)
        hero.style.setProperty('--beam-hero-shift-y', `${((y - 0.5) * -12).toFixed(1)}px`)
      })

      hero.addEventListener('pointerleave', () => {
        hero.style.setProperty('--beam-pointer-x', '72%')
        hero.style.setProperty('--beam-pointer-y', '28%')
        hero.style.setProperty('--beam-hero-shift-x', '0px')
        hero.style.setProperty('--beam-hero-shift-y', '0px')
      })
    }

    for (const frame of document.querySelectorAll('.screen-frame')) {
      frame.addEventListener('pointermove', (event) => {
        const bounds = frame.getBoundingClientRect()
        const x = (event.clientX - bounds.left) / bounds.width - 0.5
        const y = (event.clientY - bounds.top) / bounds.height - 0.5
        frame.style.setProperty('--beam-pointer-x', `${((x + 0.5) * 100).toFixed(1)}%`)
        frame.style.setProperty('--beam-pointer-y', `${((y + 0.5) * 100).toFixed(1)}%`)
        frame.style.transform = `perspective(1300px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg)`
      })

      frame.addEventListener('pointerleave', () => {
        frame.style.setProperty('--beam-pointer-x', '50%')
        frame.style.setProperty('--beam-pointer-y', '50%')
        frame.style.transform = ''
      })
    }
  }

  const form = document.getElementById('waitlist-form')
  if (!form) {
    return
  }

  const submitButton = document.getElementById('submit-button')
  const formStatus = document.getElementById('form-status')

  function resolveDirectoryApiBase() {
    if (window.location.hostname === 'localhost') {
      return 'http://localhost:43100'
    }

    if (window.location.hostname === '127.0.0.1') {
      return 'http://127.0.0.1:43100'
    }

    return 'https://api.beam.directory'
  }

  function setStatus(type, html) {
    formStatus.className = `status visible ${type}`
    formStatus.innerHTML = html
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    const formData = new FormData(form)
    const email = String(formData.get('email') || '').trim().toLowerCase()
    const company = String(formData.get('company') || '').trim()
    const workflow = String(formData.get('workflow') || 'hosted-beta-partner-handoff')
    const agentCountRaw = String(formData.get('agentCount') || '').trim()
    const agentCount = agentCountRaw ? Number.parseInt(agentCountRaw, 10) : null
    const notes = String(formData.get('notes') || '').trim()

    submitButton.disabled = true
    submitButton.textContent = 'Submitting...'
    setStatus('success', 'Submitting pilot request...')

    try {
      const response = await fetch(`${resolveDirectoryApiBase()}/waitlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          company: company || null,
          source: 'hosted-beta-page',
          agentCount: Number.isFinite(agentCount) ? agentCount : null,
          workflowType: workflow,
          workflowSummary: notes || null,
          analyticsSessionId: window.beamAnalytics?.sessionId || null,
          pageKey: window.beamAnalytics?.pageKey || 'hosted_beta',
        }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Pilot request failed')
      }

      const nextStep = payload.nextStep || 'Beam will review the workflow, send the onboarding pack, and follow up with the next concrete step.'
      const alreadyRegistered = payload.status === 'already_registered'

      setStatus(
        'success',
        `<strong>${alreadyRegistered ? 'Your pilot request is already recorded.' : 'Pilot request recorded.'}</strong><br />${nextStep}`,
      )
      form.reset()
    } catch (error) {
      setStatus('error', error instanceof Error ? error.message : 'Pilot request failed.')
    } finally {
      submitButton.disabled = false
      submitButton.textContent = 'Request pilot'
    }
  })
})()
