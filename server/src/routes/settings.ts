import express, { type Router } from 'express'
import { llmExclusionsInputSchema, type SettingsService } from '../settings/settingsService.js'
import { parseInput } from './api.js'

/** Settings routes (R3, R6). Mounted after `requireSession`; errors go to `jsonErrorHandler`. */
export function createSettingsRouter(settings: SettingsService): Router {
  const router = express.Router()
  // Scoped to /settings so the larger body limit does not apply to other /api routes.
  router.use('/settings', (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })
  router.use('/settings', express.json({ limit: '1mb' }))

  router.get('/settings/llm-exclusions', async (_req, res) => {
    res.json({ exclusions: await settings.getLlmExclusions() })
  })

  router.get('/settings/llm-exclusions/catalog', async (_req, res) => {
    res.json(await settings.getExclusionCatalog())
  })

  router.put('/settings/llm-exclusions', async (req, res) => {
    const input = parseInput(llmExclusionsInputSchema, req.body)
    res.json({ exclusions: await settings.setLlmExclusions(input.exclusions) })
  })

  return router
}
