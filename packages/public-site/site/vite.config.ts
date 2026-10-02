import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
const siteRoot = resolve(import.meta.dirname)

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
