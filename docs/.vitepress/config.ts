import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Beam Protocol',
  description: 'Verified B2B handoffs for AI agents',
  ignoreDeadLinks: true,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['script', { src: 'https://beam.directory/beam-analytics.js', defer: '' }],
  ],
  sitemap: {
    hostname: 'https://docs.beam.directory',
  },
  themeConfig: {
    siteTitle: 'Beam Protocol Docs',
    nav: [
      { text: 'Guide', link: '/guide/partner-handoff' },
      { text: 'API', link: '/api/typescript' },
      { text: 'Security', link: '/security/overview' },
      { text: 'RFC', link: 'https://github.com/Beam-directory/beam-protocol/blob/main/spec/RFC-0003.md' }
    ],
    sidebar: [
      { text: 'Guide', items: [
        { text: 'Verified Partner Handoff', link: '/guide/partner-handoff' },
        { text: 'Design-Partner Onboarding Pack', link: '/guide/design-partner-onboarding' },
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'Hosted Quickstart', link: '/guide/hosted-quickstart' },
        { text: 'Compatibility', link: '/guide/compatibility' },
        { text: 'Vision', link: '/guide/vision' },
        { text: 'Use Cases', link: '/guide/use-cases' },
        { text: 'DID Identity', link: '/guide/did' },
        { text: 'Verification', link: '/guide/verification' },
        { text: 'Federation', link: '/guide/federation' },
        { text: 'Intent Lifecycle', link: '/guide/intent-lifecycle' },
        { text: 'Restart Recovery', link: '/guide/restart-recovery' },
        { text: 'Operator Observability', link: '/guide/operator-observability' },
        { text: 'Operator Runbook', link: '/guide/operator-runbook' },
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
