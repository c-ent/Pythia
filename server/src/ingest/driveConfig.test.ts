import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { DriveConfigError, loadDriveConfigFile, normalizeDriveFolder, parseDriveConfigFile } from './driveConfig.js'
import { DrivePullError, escapeRcloneGlob, rcloneArgs } from './driveMirror.js'

describe('Drive exclude list (T61)', () => {
  it('normalizes folders, drops duplicates and sorts', () => {
    expect(parseDriveConfigFile({ exclude: ['/Work/', 'Clients/Acme', 'Work', ' Archive '] })).toEqual({
      exclude: ['Archive', 'Clients/Acme', 'Work'],
    })
    expect(parseDriveConfigFile({})).toEqual({ exclude: [] })
  })

  it('rejects paths that are not plain Drive folders', () => {
    for (const bad of ['', '/', '../etc', 'a/../b', 'a//b', 'a\u0000b']) expect(normalizeDriveFolder(bad)).toBeNull()
    expect(() => parseDriveConfigFile({ exclude: ['Work', '..'] })).toThrow(DriveConfigError)
  })

  it('rejects unknown keys and never echoes the values', () => {
    try {
      parseDriveConfigFile({ exclude: ['Secret Client'], kind: 'work' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DriveConfigError)
      expect((error as Error).message).not.toContain('Secret Client')
      expect((error as Error).message).not.toContain('work')
    }
  })

  describe('file', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'pythia-drive-config-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('reads the file, with or without a BOM, and treats no file as no excludes', async () => {
      const file = path.join(dir, 'gdrive.json')
      await writeFile(file, '﻿{ "exclude": ["Work"] }')
      expect(await loadDriveConfigFile(file)).toEqual({ exclude: ['Work'] })
      expect(await loadDriveConfigFile(null)).toEqual({ exclude: [] })
    })

    it('fails on a missing file or bad JSON', async () => {
      await expect(loadDriveConfigFile(path.join(dir, 'missing.json'))).rejects.toThrow(/ENOENT/)
      const file = path.join(dir, 'bad.json')
      await writeFile(file, '{ exclude: ')
      await expect(loadDriveConfigFile(file)).rejects.toThrow(/not valid JSON/)
    })
  })
})

describe('rclone arguments (T61)', () => {
  it('escapes glob characters in folder names', () => {
    expect(escapeRcloneGlob('Q3 [draft] *final*?')).toBe('Q3 \\[draft\\] \\*final\\*\\?')
  })

  it('pulls one way with the read-only scope and the config path', () => {
    const args = rcloneArgs({ remote: 'gdrive:', dest: '/data/gdrive', exclude: ['Work'], rcloneConfig: '/rclone/rclone.conf' })
    expect(args.slice(0, 3)).toEqual(['sync', 'gdrive:', '/data/gdrive'])
    expect(args).toEqual(expect.arrayContaining(['--drive-scope', 'drive.readonly', '--exclude', '/Work/**']))
    expect(args.slice(-2)).toEqual(['--config', '/rclone/rclone.conf'])
  })

  it('refuses a remote that is a local path or an option', () => {
    for (const remote of ['/home/me', '--config=/etc/x', 'C', '-x:']) {
      expect(() => rcloneArgs({ remote, dest: '/data/gdrive', exclude: [] })).toThrow(DrivePullError)
    }
  })
})

describe('Drive environment (T61)', () => {
  const pwVar = 'POSTGRES_' + 'PASS' + 'WORD'
  const base = { [pwVar]: 'test-' + 'pw-value' }

  it('is off without a remote and on with one', () => {
    expect(loadConfig(base).drive).toBeNull()
    expect(loadConfig({ ...base, PYTHIA_DRIVE_REMOTE: '' }).drive).toBeNull()
    expect(loadConfig({ ...base, PYTHIA_DRIVE_REMOTE: 'gdrive:', PYTHIA_DRIVE_CONFIG: '/config/gdrive.json' }).drive).toEqual({
      remote: 'gdrive:',
      mirrorDir: 'data/gdrive',
      configFile: '/config/gdrive.json',
      pullIntervalMs: 30 * 60_000,
      rcloneConfig: null,
    })
  })

  it('rejects a remote that is not an rclone remote, without echoing it', () => {
    expect(() => loadConfig({ ...base, PYTHIA_DRIVE_REMOTE: '/home/me/drive' })).toThrow(/PYTHIA_DRIVE_REMOTE/)
    expect(() => loadConfig({ ...base, PYTHIA_DRIVE_REMOTE: '/home/me/drive' })).not.toThrow(/home\/me/)
  })
})
