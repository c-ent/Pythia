import express, { type Router } from 'express'
import { profileInputSchema, type ProfileService } from '../profile/profileService.js'
import { parseInput } from './api.js'

/** `GET`/`PUT /api/profile` (R17). Mounted after `requireSession`; errors go to `jsonErrorHandler`. */
export function createProfileRouter(profile: ProfileService): Router {
  const router = express.Router()
  router.use('/profile', (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })
  router.use('/profile', express.json({ limit: '4kb' }))

  router.get('/profile', async (_req, res) => {
    res.json({ profile: await profile.getProfile() })
  })

  router.put('/profile', async (req, res) => {
    const input = parseInput(profileInputSchema, req.body)
    res.json({ profile: await profile.setProfile(input) })
  })

  return router
}
