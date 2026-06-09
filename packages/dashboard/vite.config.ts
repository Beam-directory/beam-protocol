import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const dashboardPackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const dashboardVersion = dashboardPackage.version

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'beam-dashboard-version-html',
      transformIndexHtml(html) {
        return html
          .replace('</head>', `    <meta name="beam-dashboard-version" content="${dashboardVersion}" />\n  </head>`)
          .replace('<div id="root"></div>', `<div id="root" data-beam-dashboard-version="${dashboardVersion}"></div>`)
      },
    },
  ],
  server: {
    port: 5173,
  },
})
