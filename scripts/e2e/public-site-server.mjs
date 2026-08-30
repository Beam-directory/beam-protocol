import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const publicRoot = path.join(repoRoot, 'packages/public-site')
const port = Number.parseInt(process.env.BEAM_PUBLIC_SITE_PORT ?? '4175', 10)
const aliases = new Map([
  ['/', '/index.html'],
  ['/claim', '/claim.html'],
  ['/network', '/network.html'],
])
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
])

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const aliasedPath = aliases.get(requestUrl.pathname) ?? requestUrl.pathname
  let decodedPath
  try {
    decodedPath = decodeURIComponent(aliasedPath)
  } catch {
    response.writeHead(400).end('Bad request')
    return
  }
  const filePath = path.resolve(publicRoot, `.${decodedPath}`)
  if (!filePath.startsWith(`${publicRoot}${path.sep}`) || path.basename(filePath).startsWith('.')) {
    response.writeHead(404).end('Not found')
    return
  }
  try {
    if (!statSync(filePath).isFile()) throw new Error('Not a file')
  } catch {
    response.writeHead(404).end('Not found')
    return
  }
  const extension = path.extname(filePath)
  response.setHeader('Content-Type', contentTypes.get(extension) ?? 'application/octet-stream')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  if (extension === '.html') response.setHeader('Cache-Control', 'no-store')
  createReadStream(filePath)
    .on('error', () => response.destroy())
    .pipe(response)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Beam public-site E2E server on http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
