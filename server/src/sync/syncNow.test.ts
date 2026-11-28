import { describe, expect, it } from 'vitest'
import { createSyncNow } from './syncNow.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FetchError extends Error {
  override name = 'FetchError'
}

function setup(options: { vault?: boolean; repos?: boolean; names?: string[] } = {}) {
  const gate = deferred()
  const calls = { vault: 0, repos: 0, repo: [] as string[] }
  const logs: string[] = []
  const names = options.names ?? ['pythia', 'notes']
  const sync = createSyncNow({
    ...(options.vault === false
      ? {}
      : {
          vault: async () => {
            calls.vault += 1
            await gate.promise
          },
        }),
    ...(options.repos === false
      ? {}
      : {
          repos: async () => {
            calls.repos += 1
            await gate.promise
          },
          repo: (name: string) =>
            names.includes(name)
              ? (async () => {
                  calls.repo.push(name)
                  await gate.promise
                })()
              : null,
        }),
    log: (message) => logs.push(message),
  })
  return { sync, gate, calls, logs }
}

describe('sync now', () => {
  it('starts the vault scan and the repo round side by side', async () => {
    const { sync, gate, calls } = setup()
    expect(sync.syncNow()).toEqual({ started: true, vault: 'started', repos: 'started', drive: 'off' })
    expect(calls).toMatchObject({ vault: 1, repos: 1 })
    expect(sync.state()).toEqual({ running: true, repos: [] })
    gate.resolve()
    await sync.idle()
    expect(sync.state()).toEqual({ running: false, repos: [] })
  })

  it('never starts a second run while one is in progress (pressed twice quickly)', async () => {
    const { sync, gate, calls } = setup()
    sync.syncNow()
    expect(sync.syncNow()).toEqual({ started: false, vault: 'running', repos: 'running', drive: 'off' })
    expect(sync.syncNow()).toEqual({ started: false, vault: 'running', repos: 'running', drive: 'off' })
    expect(calls).toMatchObject({ vault: 1, repos: 1 })
    gate.resolve()
    await sync.idle()
    expect(sync.syncNow()).toEqual({ started: true, vault: 'started', repos: 'started', drive: 'off' })
    expect(calls).toMatchObject({ vault: 2, repos: 2 })
    await sync.idle()
  })

  it('reports a part that is not configured as off', async () => {
    const { sync, gate, calls } = setup({ vault: false })
    expect(sync.syncNow()).toEqual({ started: true, vault: 'off', repos: 'started', drive: 'off' })
    expect(sync.syncNow()).toEqual({ started: false, vault: 'off', repos: 'running', drive: 'off' })
    expect(calls.vault).toBe(0)
    gate.resolve()
    await sync.idle()
  })

  it('finishes at once when nothing is configured', async () => {
    const { sync } = setup({ vault: false, repos: false })
    expect(sync.syncNow()).toEqual({ started: true, vault: 'off', repos: 'off', drive: 'off' })
    await sync.idle()
    expect(sync.state().running).toBe(false)
  })

  it('logs a failed part by error class only and frees the guard', async () => {
    const logs: string[] = []
    const sync = createSyncNow({
      vault: async () => {
        throw new FetchError('/home/me/vault/secret.md: permission denied')
      },
      repos: async () => {},
      log: (message) => logs.push(message),
    })
    expect(sync.syncNow().started).toBe(true)
    await sync.idle()
    expect(logs).toEqual(['sync now: vault failed: FetchError'])
    expect(sync.syncNow().started).toBe(true)
    await sync.idle()
  })
})

describe('repo re-sync', () => {
  it('fetches one repo and guards it per name', async () => {
    const { sync, gate, calls } = setup()
    expect(sync.syncRepo('pythia')).toBe('started')
    expect(sync.syncRepo('pythia')).toBe('running')
    expect(sync.syncRepo('notes')).toBe('started')
    expect(calls.repo).toEqual(['pythia', 'notes'])
    expect(sync.state()).toEqual({ running: false, repos: ['notes', 'pythia'] })
    gate.resolve()
    await sync.idle()
    expect(sync.state().repos).toEqual([])
    expect(sync.syncRepo('pythia')).toBe('started')
    await sync.idle()
  })

  it('answers not_found for a name not in the config and off without repos', () => {
    expect(setup().sync.syncRepo('missing')).toBe('not_found')
    expect(setup({ repos: false }).sync.syncRepo('pythia')).toBe('off')
  })

  it('logs a failed fetch by error class only and frees the guard', async () => {
    const logs: string[] = []
    const sync = createSyncNow({
      repo: async () => {
        throw new FetchError('fatal: could not read from https://token@github.com/me/pythia')
      },
      log: (message) => logs.push(message),
    })
    expect(sync.syncRepo('pythia')).toBe('started')
    await sync.idle()
    expect(logs).toEqual(['sync now: repo failed: FetchError'])
    expect(sync.syncRepo('pythia')).toBe('started')
    await sync.idle()
  })
})
