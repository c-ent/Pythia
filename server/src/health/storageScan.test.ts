import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createStorageScan, scanDirectoryTree } from './storageScan.js'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('storageScan', () => {
  it('scans a directory tree, sums nested folders, skips virtual host dirs and symlinks, and ranks largest files', async () => {
    const root = await makeTempDir('pythia-storage-')
    await mkdir(path.join(root, 'proc'), { recursive: true })
    await writeFile(path.join(root, 'proc', 'kcore'), 'should-be-skipped')
    await mkdir(path.join(root, 'var', 'log'), { recursive: true })
    await mkdir(path.join(root, 'var', 'lib', 'docker', 'overlay2'), { recursive: true })
    await mkdir(path.join(root, 'home', 'user'), { recursive: true })

    await writeFile(path.join(root, 'var', 'log', 'syslog'), Buffer.alloc(400))
    await writeFile(path.join(root, 'var', 'lib', 'docker', 'overlay2', 'layer.tar'), Buffer.alloc(5000))
    await writeFile(path.join(root, 'home', 'user', 'notes.md'), Buffer.alloc(1200))
    await symlink(path.join(root, 'var', 'lib', 'docker', 'overlay2', 'layer.tar'), path.join(root, 'home', 'user', 'link.tar')).catch(() => {})

    const result = await scanDirectoryTree(root, { displayRoot: '/', skipHostVirtual: true, minDirDepth: 2 })
    expect(result).not.toBeNull()
    expect(result!.totalBytes).toBe(6600)
    expect(result!.topLevel).toEqual([
      { path: '/var', bytes: 5400 },
      { path: '/home', bytes: 1200 },
    ])
    // /var/lib/docker (5000) is dominated by overlay2 (5000 >= 90%), so overlay2 surfaces instead of redundant parents.
    expect(result!.largestDirs.map((d) => d.path)).toContain('/var/lib/docker/overlay2')
    expect(result!.largestDirs.map((d) => d.path)).not.toContain('/var/lib')
    expect(result!.largestFiles).toEqual([
      { path: '/var/lib/docker/overlay2/layer.tar', bytes: 5000 },
      { path: '/home/user/notes.md', bytes: 1200 },
      { path: '/var/log/syslog', bytes: 400 },
    ])
  })

  it('combines host root, Pythia folders, database tables, and Ollama models in cached scan snapshot', async () => {
    const hostRoot = await makeTempDir('pythia-host-')
    const vaultDir = await makeTempDir('pythia-vault-')
    await mkdir(path.join(hostRoot, 'var'), { recursive: true })
    await writeFile(path.join(hostRoot, 'var', 'app.log'), Buffer.alloc(2000))
    await writeFile(path.join(vaultDir, 'big-note.md'), Buffer.alloc(800))

    const pool = {} as Pool
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'nomic-embed-text:latest', size: 274_000_000 },
              { name: 'qwen3:4b', size: 2_500_000_000 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', size_vram: 274_000_000 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const service = createStorageScan({
      pool,
      ollamaUrl: 'http://127.0.0.1:11434',
      hostRoot,
      vaultPath: vaultDir,
      fetch: fetchMock as unknown as typeof fetch,
      autoScan: false,
      now: () => Date.parse('2026-11-28T10:00:00.000Z'),
      databaseStats: async () => ({
        totalBytes: 97_000_000,
        tables: [
          { name: 'chunks', bytes: 80_000_000 },
          { name: 'documents', bytes: 10_000_000 },
        ],
      }),
    })

    expect(service.snapshot().status).toBe('idle')
    const snapshot = await service.scan()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.scannedAt).toBe('2026-11-28T10:00:00.000Z')
    expect(snapshot.hostRootMounted).toBe(true)
    expect(snapshot.areas.find((a) => a.id === 'database')?.bytes).toBe(97_000_000)
    expect(snapshot.areas.find((a) => a.id === 'ollama')?.bytes).toBe(2_774_000_000)
    expect(snapshot.areas.find((a) => a.id === 'vault')?.bytes).toBe(800)
    expect(snapshot.databaseTables).toEqual([
      { name: 'chunks', bytes: 80_000_000 },
      { name: 'documents', bytes: 10_000_000 },
    ])
    expect(snapshot.ollamaModels).toEqual([
      { name: 'qwen3:4b', diskBytes: 2_500_000_000, memoryBytes: 0 },
      { name: 'nomic-embed-text:latest', diskBytes: 274_000_000, memoryBytes: 274_000_000 },
    ])
    expect(snapshot.largestFiles.map((f) => f.path)).toContain('/var/app.log')
    expect(snapshot.largestFiles.map((f) => f.path)).toContain(path.join(vaultDir, 'big-note.md'))
    service.close()
  })
})
