(function () {
  const heroEnterItems = Array.from(document.querySelectorAll('.hero-enter'))

  for (const item of heroEnterItems) {
    const completeEntrance = () => {
      item.classList.add('hero-enter-complete')
      item.classList.remove('hero-enter')
    }

    item.addEventListener('animationend', completeEntrance, { once: true })
    window.setTimeout(completeEntrance, 1400)
  }

  const revealItems = Array.from(document.querySelectorAll('.reveal'))

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible')
          observer.unobserve(entry.target)
        }
      }
    }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' })

    for (const item of revealItems) {
      observer.observe(item)
    }
  } else {
    for (const item of revealItems) {
      item.classList.add('visible')
    }
  }

  const finePointer = window.matchMedia('(pointer: fine)').matches
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!reducedMotion) {
    const tiltTargets = Array.from(document.querySelectorAll('[data-beam-tilt]'))

    if (finePointer) {
      for (const target of tiltTargets) {
        let frame = 0
        let currentX = 0
        let currentY = 0
        let targetX = 0
        let targetY = 0

        const render = () => {
          currentX += (targetX - currentX) * 0.13
          currentY += (targetY - currentY) * 0.13

          const heroScale = target.classList.contains('hero-visual') ? 1 : 0.72
          target.style.transform = `perspective(1500px) rotateX(${(-currentY * 4 * heroScale).toFixed(2)}deg) rotateY(${(currentX * 5.5 * heroScale).toFixed(2)}deg)`
          target.style.setProperty('--beam-shift-x', `${(currentX * 14).toFixed(1)}px`)
          target.style.setProperty('--beam-shift-y', `${(currentY * 12).toFixed(1)}px`)

          if (Math.abs(targetX - currentX) > 0.002 || Math.abs(targetY - currentY) > 0.002) {
            frame = requestAnimationFrame(render)
          } else {
            frame = 0
          }
        }

        const requestRender = () => {
          if (!frame) frame = requestAnimationFrame(render)
        }

        target.addEventListener('pointermove', (event) => {
          const bounds = target.getBoundingClientRect()
          targetX = (event.clientX - bounds.left) / bounds.width - 0.5
          targetY = (event.clientY - bounds.top) / bounds.height - 0.5
          target.style.setProperty('--beam-pointer-x', `${((targetX + 0.5) * 100).toFixed(1)}%`)
          target.style.setProperty('--beam-pointer-y', `${((targetY + 0.5) * 100).toFixed(1)}%`)
          requestRender()
        })

        target.addEventListener('pointerleave', () => {
          targetX = 0
          targetY = 0
          target.style.setProperty('--beam-pointer-x', '50%')
          target.style.setProperty('--beam-pointer-y', '50%')
          requestRender()
          window.setTimeout(() => {
            if (Math.abs(currentX) < 0.01 && Math.abs(currentY) < 0.01) {
              target.style.transform = ''
            }
          }, 420)
        })
      }
    }

    const productFrame = document.querySelector('.product-frame')
    let scrollFrame = 0

    const renderScrollDepth = () => {
      scrollFrame = 0
      if (!productFrame) return
      const bounds = productFrame.getBoundingClientRect()
      const viewport = window.innerHeight || 1
      const progress = Math.max(0, Math.min(1, (viewport - bounds.top) / (viewport + bounds.height)))
      productFrame.style.setProperty('--beam-image-shift', `${((progress - 0.5) * -18).toFixed(1)}px`)
    }

    const requestScrollDepth = () => {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(renderScrollDepth)
    }

    window.addEventListener('scroll', requestScrollDepth, { passive: true })
    window.addEventListener('resize', requestScrollDepth)
    requestScrollDepth()
  }
})()
