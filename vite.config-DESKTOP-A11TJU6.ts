import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') }
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  },
  server: { port: 5173 },
  test: {
    globals: true,
    environment: 'jsdom',
    root: '.',
    include: ['src/**/*.test.{ts,tsx}'],
    resolve: {
      alias: { '@shared': path.resolve(__dirname, 'src/shared') }
    },
  },
})
