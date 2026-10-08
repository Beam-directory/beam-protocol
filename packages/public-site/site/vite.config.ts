import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { HEAD_END, HTML_VARIANTS, applyHeadToHtml } from "./src/i18n/head.ts"

// https://vite.dev/config/
const siteRoot = resolve(import.meta.dirname)

/**
 * Static HTML per language for crawlers and link previews (they don't run JS):
 * - fills the beam:head block of index.html with the English head (dev and build),
 * - preloads the Latin Geist woff2 in the build,
 * - after the build writes start/index.html, de/index.html and de/start/index.html with their own head.
 */
function localizedHtml(): Plugin {
  let outDir = resolve(siteRoot, "dist")
  return {
    name: "beam-localized-html",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return applyHeadToHtml(html, "en", "home")
      },
    },
    async writeBundle() {
      let template = await readFile(resolve(outDir, "index.html"), "utf8")
      // Preload the Latin Geist subset (used above the fold); the other subsets load on demand via unicode-range.
      const font = (await readdir(resolve(outDir, "assets"))).find((name) => /^geist-latin-wght-normal-.+\.woff2$/.test(name))
      if (font && !template.includes(`/assets/${font}`)) {
        template = template.replace(
          HEAD_END,
          `${HEAD_END}\n    <link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin />`,
        )
      }
      for (const variant of HTML_VARIANTS) {
        const target = resolve(outDir, variant.file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, applyHeadToHtml(template, variant.locale, variant.route))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localizedHtml()],
  resolve: {
    alias: {
      "@": resolve(siteRoot, "./src"),
      // Keep one React 19 copy. Hoisted workspace packages otherwise import the
      // dashboard's React 18 and the page crashes on useRef.
      react: resolve(siteRoot, "node_modules/react"),
      "react-dom": resolve(siteRoot, "node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
})
