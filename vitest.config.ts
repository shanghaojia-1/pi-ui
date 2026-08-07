import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
      '@earendil-works/pi-agent-core': resolve('node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core'),
      '@earendil-works/pi-ai': resolve('node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai'),
      typebox: resolve('node_modules/@earendil-works/pi-coding-agent/node_modules/typebox'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
