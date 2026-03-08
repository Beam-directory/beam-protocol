import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Beam Protocol',
  description: 'The open communication protocol for AI agents',
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/typescript' },
      { text: 'Security', link: '/security/overview' },
      { text: 'RFC', link: 'https://github.com/Beam-directory/beam-protocol/blob/main/spec/RFC-0001.md' }
    ],
    sidebar: [
      { text: 'Guide', items: [
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'Core Concepts', link: '/guide/concepts' },
        { text: 'Self-Hosting', link: '/guide/self-hosting' }
      ]},
      { text: 'API Reference', items: [
        { text: 'TypeScript SDK', link: '/api/typescript' },
        { text: 'Python SDK', link: '/api/python' },
        { text: 'Directory API', link: '/api/directory' }
      ]},
      { text: 'Security', items: [
        { text: 'Overview', link: '/security/overview' },
        { text: 'Threat Model', link: '/security/threat-model' }
      ]}
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Beam-directory/beam-protocol' }
    ]
  }
})
