import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        // Sandboxed preload scripts cannot use ESM; force CJS output even though
        // package.json is "type": "module".
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
