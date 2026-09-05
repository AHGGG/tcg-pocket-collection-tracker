import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Independent entry: no account bootstrap, backend settings, analytics or local CA installation.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    host: '127.0.0.1',
    open: process.env.VIDEO_IMPORT_TEST === '1' ? false : '/video-import.html',
  },
  build: {
    target: 'es2022',
    outDir: 'dist/video-import',
    rollupOptions: {
      input: path.resolve(import.meta.dirname, './video-import.html'),
    },
  },
})
