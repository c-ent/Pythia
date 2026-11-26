import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // Vitest empties CSS imports by default; the theme tests read index.css
    // with `?raw` to check the real token values.
    css: { include: [/\.css\?raw$/] },
  },
})
