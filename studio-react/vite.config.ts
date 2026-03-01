import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/voice': {
        target: 'ws://localhost:3002',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../public/studio',
    emptyOutDir: false,
  },
})
