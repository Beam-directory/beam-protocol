import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(siteRoot, '..')
const dist = path.join(siteRoot, 'dist')
const assetsTarget = path.join(packageRoot, 'assets')
const stash = path.join(siteRoot, '.asset-stash')

await mkdir(packageRoot, { recursive: true })
await cp(path.join(dist, 'index.html'), path.join(packageRoot, 'index.html'))

const staticAsset = /\.(png|jpe?g|gif|webp|svg|ico)$/i
const preserved = []
try {
  for (const name of await readdir(assetsTarget)) {
    if (!staticAsset.test(name)) continue
    try {
      await stat(path.join(dist, 'assets', name))
    } catch {
      preserved.push(name)
    }
  }
} catch {
  // The published assets directory may not exist on a fresh checkout.
}

await rm(stash, { recursive: true, force: true })
await mkdir(stash, { recursive: true })
for (const name of preserved) {
  await cp(path.join(assetsTarget, name), path.join(stash, name))
}

await rm(assetsTarget, { recursive: true, force: true })
await cp(path.join(dist, 'assets'), assetsTarget, { recursive: true })
for (const name of preserved) {
  await cp(path.join(stash, name), path.join(assetsTarget, name))
}
await rm(stash, { recursive: true, force: true })
