import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Beam Protocol',
  description: 'The trust layer for AI agents',
  ignoreDeadLinks: true,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['script', {}, `if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
      const analytics = document.createElement('script')
      analytics.src = 'https://beam.directory/beam-analytics.js'
      analytics.defer = true
      document.head.appendChild(analytics)
    }`],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap' }],
  ],
  sitemap: {
    hostname: 'https://docs.beam.directory',
  },
  themeConfig: {
    siteTitle: 'Beam Docs',
    nav: [
      { text: 'Evaluate', link: 'https://beam.directory/guided-evaluation.html' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/typescript' },
      { text: 'Security', link: '/security/overview' },
      { text: 'Status', link: 'https://beam.directory/status.html' }
    ],
    sidebar: [
      { text: 'Guide', items: [
        { text: 'Verified Partner Handoff', link: '/guide/partner-handoff' },
        { text: 'First Production Partner Workflow', link: '/guide/production-partner-workflow' },
        { text: 'Production Partner Onboarding Pack', link: '/guide/design-partner-onboarding' },
        { text: 'Production Go-Live Checklist', link: '/guide/production-go-live-checklist' },
        { text: 'Beam Workspaces', link: '/guide/beam-workspaces' },
        { text: 'Identity Onboarding', link: '/guide/identity-onboarding' },
        { text: 'Grok MCP Connector', link: '/guide/grok-mcp-connector' },
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'Hosted Quickstart', link: '/guide/hosted-quickstart' },
        { text: 'Compatibility', link: '/guide/compatibility' },
        { text: 'Vision', link: '/guide/vision' },
        { text: 'Use Cases', link: '/guide/use-cases' },
        { text: 'DID Identity', link: '/guide/did' },
        { text: 'Verification', link: '/guide/verification' },
        { text: 'Trust and Assurance', link: '/guide/trust-assurance' },
        { text: 'Federation', link: '/guide/federation' },
        { text: 'Intent Lifecycle', link: '/guide/intent-lifecycle' },
        { text: 'Restart Recovery', link: '/guide/restart-recovery' },
        { text: 'Operator Observability', link: '/guide/operator-observability' },
        { text: 'Operator Runbook', link: '/guide/operator-runbook' },
        { text: 'Operator Digest', link: '/guide/operator-digest' },
        { text: 'Production Recovery Drills', link: '/guide/production-recovery-drills' },
        { text: 'Production Fire Drill', link: '/guide/production-fire-drill' },
        { text: 'Consumer IDs', link: '/guide/consumer-ids' },
        { text: 'Core Concepts', link: '/guide/concepts' },
        { text: 'Self-Hosting', link: '/guide/self-hosting' }
      ]},
      { text: 'API Reference', items: [
        { text: 'TypeScript SDK', link: '/api/typescript' },
        { text: 'Python SDK', link: '/api/python' },
        { text: 'CLI', link: '/api/cli' },
        { text: 'Directory API', link: '/api/directory' }
      ]},
      { text: 'Security', items: [
        { text: 'Overview', link: '/security/overview' },
        { text: 'Beam Shield', link: '/security/beam-shield' },
        { text: 'Threat Model', link: '/security/threat-model' }
      ]}
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Beam-directory/beam-protocol' }
    ]
  }
})
