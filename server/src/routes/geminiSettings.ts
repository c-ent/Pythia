import express, { type Router } from 'express'
import { z } from 'zod'
import { SecretsKeyMissingError, type GeminiSettingsService, type GeminiStatus } from '../settings/geminiSettings.js'
import { HttpError, parseInput } from './api.js'

// Gemini keys are about 39 characters; the bounds only stop junk and huge bodies.
const MIN_KEY_LENGTH = 20
const MAX_KEY_LENGTH = 256

/** Body of `PUT /api/settings/gemini/key`. */
export const geminiKeyInputSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(MIN_KEY_LENGTH, `apiKey must be at least ${MIN_KEY_LENGTH} characters`)
    .max(MAX_KEY_LENGTH, `apiKey must be at most ${MAX_KEY_LENGTH} characters`)
    .regex(/^[\x21-\x7e]+$/, 'apiKey must not contain spaces or control characters'),
})

/** The JSON shape of a status: never the key, only its last 4 characters. */
export function statusJson(status: GeminiStatus) {
  return {
    configured: status.configured,
    source: status.source,
    last4: status.last4,
    savedAt: status.savedAt?.toISOString() ?? null,
    envOverridesSaved: status.envOverridesSaved,
    canSave: status.canSave,
    warning: status.warning,
    model: status.model,
    usedToday: status.usedToday,
  }
}

/**
 * Gemini access (R16, T39): `GET /api/settings/gemini`, `PUT` and `DELETE`
 * `/api/settings/gemini/key`, `POST /api/settings/gemini/test`. Mounted after
 * `requireSession`; errors go to `jsonErrorHandler`.
 */
export function createGeminiSettingsRouter(gemini: GeminiSettingsService): Router {
  const router = express.Router()
  router.use('/settings/gemini', (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })
  router.use('/settings/gemini', express.json({ limit: '4kb' }))

  router.get('/settings/gemini', async (_req, res) => {
    res.json(statusJson(await gemini.status()))
  })

  router.put('/settings/gemini/key', async (req, res) => {
    const input = parseInput(geminiKeyInputSchema, req.body)
    try {
      res.json(statusJson(await gemini.save(input.apiKey)))
    } catch (error) {
      if (error instanceof SecretsKeyMissingError) {
        throw new HttpError(
          409,
          'secrets_key_missing',
          'Set PYTHIA_SECRETS_KEY in .env (printed by pnpm --filter server auth-env) and restart the server to save a key here.',
        )
      }
      throw error
    }
  })

  router.delete('/settings/gemini/key', async (_req, res) => {
    res.json(statusJson(await gemini.remove()))
  })

  router.post('/settings/gemini/test', async (_req, res) => {
    res.json(await gemini.test())
  })

  return router
}
