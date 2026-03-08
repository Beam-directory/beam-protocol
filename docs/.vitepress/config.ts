import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Beam Protocol',
  description: 'The open communication protocol for AI agents',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/typescript' },
      { text: 'Security', link: '/security/overview' },
      { text: 'RFC', link: 'https://github.com/beam-directory/beam-protocol/blob/main/spec/RFC-0001.md' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Self-Hosting', link: '/guide/self-hosting' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'TypeScript SDK', link: '/api/typescript' },
            { text: 'Python SDK', link: '/api/python' },
            { text: 'Directory API', link: '/api/directory' },
          ],
        },
      ],
      '/security/': [
        {
          text: 'Security',
          items: [
            { text: 'Overview', link: '/security/overview' },
            { text: 'Threat Model', link: '/security/threat-model' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
  },
})
