import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// The light `nav` token in src/index.css (the page frame); the manifest
// cannot read CSS. theme-init.js and src/theme/theme.ts use it too.
const FRAME = '#17191e'

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
      includeAssets: ['pythia.svg', 'apple-touch-icon.png', 'theme-init.js'],
      manifest: {
        name: 'Pythia',
        short_name: 'Pythia',
        description: 'Search your notes, repos and Keep exports.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: FRAME,
        theme_color: FRAME,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Fonts are bundled woff2 files; precache them so text looks the same offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
