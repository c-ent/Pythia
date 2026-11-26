import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type Profile } from '../api/profile'
import { readThemeChoice } from '../theme/theme'
import { canonicalTimeZone, loadProfile, PROFILE_KEY, readProfile, saveProfile, useProfile } from './profile'

const SAVED: Profile = {
  displayName: 'Cent',
  timeZone: 'Europe/Paris',
  vaultName: 'Notes',
  theme: 'dark',
  openingMode: 'ask',
  notePreviews: false,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('profile store', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('reads the defaults when nothing is cached', () => {
    expect(readProfile()).toEqual(DEFAULT_PROFILE)
  })

  it('ignores a cached copy that is not a profile', () => {
    localStorage.setItem(PROFILE_KEY, '{"displayName":3}')
    expect(readProfile()).toEqual(DEFAULT_PROFILE)
    localStorage.setItem(PROFILE_KEY, 'not json')
    expect(readProfile()).toEqual(DEFAULT_PROFILE)
  })

  it('returns the same object until the cached copy changes', () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(SAVED))
    const first = readProfile()
    expect(first).toEqual(SAVED)
    expect(readProfile()).toBe(first)
  })

  it('caches the loaded profile and applies its theme', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { profile: SAVED })),
    )
    await loadProfile()
    expect(JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null')).toEqual(SAVED)
    expect(readProfile()).toEqual(SAVED)
    expect(readThemeChoice()).toBe('dark')
  })

  it('keeps the cached copy when loading fails', async () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(SAVED))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, { error: { code: 'internal', message: 'Boom' } })),
    )
    await expect(loadProfile()).rejects.toThrow()
    expect(readProfile()).toEqual(SAVED)
  })

  it('saves the whole profile and caches what the server returns', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as Profile
      return json(200, { profile: { ...sent, displayName: sent.displayName.trim() } })
    })
    vi.stubGlobal('fetch', fetch)
    const saved = await saveProfile({ ...SAVED, displayName: ' Cent ' })
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('PUT')
    expect(saved.displayName).toBe('Cent')
    expect(readProfile().displayName).toBe('Cent')
  })

  it('re-renders when the profile loads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { profile: SAVED })),
    )
    const { result } = renderHook(() => useProfile())
    expect(result.current.displayName).toBe('')
    await act(async () => {
      await loadProfile()
    })
    expect(result.current.displayName).toBe('Cent')
  })
})

describe('canonicalTimeZone', () => {
  it('accepts known zones and refuses others', () => {
    expect(canonicalTimeZone('Asia/Taipei')).toBe('Asia/Taipei')
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull()
    expect(canonicalTimeZone('')).toBeNull()
  })
})
