import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['src/federation.test.ts', 'dist/**'],
  },
})
