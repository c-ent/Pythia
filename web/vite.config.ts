import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Same value as --color-canvas in src/index.css; the manifest cannot read CSS.
const CANVAS = '#0e1014'

// The repo-root .env, which the API server also reads.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig(({ mode }) => {
  // The API server (pnpm dev in server/) listens on 127.0.0.1:$PORT (default
  // 3000). Proxying keeps the page and /api on one localhost origin, so the
  // session cookie (SameSite=Lax, __Host- prefix) is sent with every request.
  const port = loadEnv(mode, ROOT, 'PORT').PORT || '3000'
  const API = `http://127.0.0.1:${port}`

  return {
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['pythia.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Pythia',
        short_name: 'Pythia',
        description: 'Search your notes, repos and Keep exports.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: CANVAS,
        theme_color: CANVAS,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell opens offline; API and MCP requests never get the
        // cached index.html in place of a real response.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/, /^\/healthz/],
      },
    }),
  ],
  server: {
    proxy: { '/api': API, '/healthz': API },
  },
  preview: {
    proxy: { '/api': API, '/healthz': API },
  },
  }
})
