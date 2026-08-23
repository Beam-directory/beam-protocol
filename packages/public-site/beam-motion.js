(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const finePointer = window.matchMedia('(pointer: fine)').matches
  const root = document.documentElement

  root.classList.add('beam-motion-ready')

  const motionItems = Array.from(document.querySelectorAll([
    '.beam-playground .panel',
    '.beam-register .intro-copy',
    '.beam-register .intro-card',
    '.beam-register .register-card',
    '.beam-status .card',
    '.beam-legal .card',
    '.beam-blog-index .blog-card',
    '.beam-blog article > .container',
  ].join(',')))

  motionItems.forEach((item, index) => {
    item.classList.add('beam-motion-item')
    item.style.setProperty('--beam-motion-order', String(index % 6))
  })

  if (reducedMotion || !('IntersectionObserver' in window)) {
    motionItems.forEach((item) => item.classList.add('beam-motion-in'))
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('beam-motion-in')
        observer.unobserve(entry.target)
      }
    // Keep the threshold low: article containers can be several viewports tall,
    // so a percentage-based threshold would never be reached on small screens.
    }, { threshold: 0.01, rootMargin: '0px 0px -5% 0px' })

    motionItems.forEach((item) => observer.observe(item))
  }

  if (reducedMotion || !finePointer) return

  let cursorFrame = 0
  let pointerX = 50
  let pointerY = 18

  const renderCursor = () => {
    cursorFrame = 0
    root.style.setProperty('--beam-cursor-x', `${pointerX.toFixed(1)}%`)
    root.style.setProperty('--beam-cursor-y', `${pointerY.toFixed(1)}%`)
  }

  window.addEventListener('pointermove', (event) => {
    pointerX = event.clientX / window.innerWidth * 100
    pointerY = event.clientY / window.innerHeight * 100
    if (!cursorFrame) cursorFrame = requestAnimationFrame(renderCursor)
  }, { passive: true })

  const tiltTargets = Array.from(document.querySelectorAll([
    '.beam-register .intro-copy',
    '.beam-blog-index .blog-card',
    '.beam-playground .hero-copy',
  ].join(',')))

  for (const target of tiltTargets) {
    target.addEventListener('pointermove', (event) => {
      const bounds = target.getBoundingClientRect()
      const x = (event.clientX - bounds.left) / bounds.width - 0.5
      const y = (event.clientY - bounds.top) / bounds.height - 0.5
      target.style.transform = `perspective(1200px) rotateX(${(-y * 2.4).toFixed(2)}deg) rotateY(${(x * 3.2).toFixed(2)}deg) translateY(-2px)`
      target.style.setProperty('--beam-local-x', `${((x + 0.5) * 100).toFixed(1)}%`)
      target.style.setProperty('--beam-local-y', `${((y + 0.5) * 100).toFixed(1)}%`)
    })

    target.addEventListener('pointerleave', () => {
      target.style.transform = ''
      target.style.setProperty('--beam-local-x', '50%')
      target.style.setProperty('--beam-local-y', '50%')
    })
  }
})()
