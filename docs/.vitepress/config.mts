import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Beam Protocol',
  description: 'SMTP for AI Agents — Agent-to-Agent Communication Standard',
  base: '/',
  cleanUrls: true,
  themeConfig: {
    logo: '📡',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/typescript' },
      { text: 'Security', link: '/security/overview' },
      { text: 'Spec', link: '/spec/rfc-0001' },
      { text: 'GitHub', link: 'https://github.com/Beam-directory/beam-protocol' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Self-Hosting', link: '/guide/self-hosting' }
          ]
        }
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'TypeScript SDK', link: '/api/typescript' },
            { text: 'Python SDK', link: '/api/python' },
            { text: 'Directory Server', link: '/api/directory' },
            { text: 'CLI', link: '/api/cli' }
          ]
        }
      ],
      '/security/': [
        {
          text: 'Security',
          items: [
            { text: 'Overview', link: '/security/overview' },
            { text: 'Threat Model', link: '/security/threat-model' }
          ]
        }
      ],
      '/spec/': [
        {
          text: 'RFCs',
          items: [
            { text: 'RFC-0001 Protocol', link: '/spec/rfc-0001' },
            { text: 'RFC-0002 Federation', link: '/spec/rfc-0002' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Beam-directory/beam-protocol' }
    ],
    footer: {
      message: 'Released under Apache-2.0.',
      copyright: 'Copyright © 2026 Beam Protocol Contributors'
    },
    search: {
      provider: 'local'
    },
    outline: [2, 3]
  }
})
