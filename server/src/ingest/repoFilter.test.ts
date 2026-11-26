import { describe, expect, it } from 'vitest'
import {
  classifyRepoPath,
  createGitignoreMatcher,
  looksBinary,
  MAX_REPO_FILE_BYTES,
  selectRepoFiles,
} from './repoFilter.js'

describe('classifyRepoPath', () => {
  it.each([
    ['src/index.ts', 'code', 'typescript'],
    ['app/Component.tsx', 'code', 'tsx'],
    ['scripts/build.py', 'code', 'python'],
    ['Dockerfile', 'code', 'dockerfile'],
    ['README.md', 'readme', 'markdown'],
    ['docs/readme', 'readme', 'markdown'],
    ['README.rst', 'readme', null],
    ['package.json', 'manifest', 'json'],
    ['backend/pyproject.toml', 'manifest', 'toml'],
    ['requirements-dev.txt', 'manifest', null],
    ['go.mod', 'manifest', null],
  ])('indexes %s as %s', (filePath, kind, language) => {
    expect(classifyRepoPath(filePath, 100)).toEqual({ index: true, kind, language })
  })

  it.each([
    ['.env', 'blocked'],
    ['config/.env.production', 'blocked'],
    ['node_modules/pkg/index.js', 'ignored-directory'],
    ['web/dist/app.js', 'ignored-directory'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['sub/Cargo.lock', 'lockfile'],
    ['public/app.min.js', 'minified'],
    ['public/app.js.map', 'minified'],
    ['assets/logo.png', 'not-allowlisted'],
    ['notes.txt', 'not-allowlisted'],
    ['.eslintrc', 'not-allowlisted'],
  ])('skips %s (%s)', (filePath, reason) => {
    expect(classifyRepoPath(filePath, 100)).toEqual({ index: false, reason })
  })

  it('skips files over 200 KB and keeps one exactly at the limit', () => {
    expect(classifyRepoPath('src/big.ts', MAX_REPO_FILE_BYTES + 1)).toEqual({ index: false, reason: 'too-large' })
    expect(classifyRepoPath('src/edge.ts', MAX_REPO_FILE_BYTES).index).toBe(true)
  })
})

describe('createGitignoreMatcher', () => {
  it('applies each file relative to its own directory', () => {
    const isIgnored = createGitignoreMatcher([
      { dir: '', text: '*.log\n/build-output/\n' },
      { dir: 'web', text: 'generated/\n' },
    ])
    expect(isIgnored('debug.log')).toBe(true)
    expect(isIgnored('web/deep/trace.log')).toBe(true)
    expect(isIgnored('build-output/x.ts')).toBe(true)
    expect(isIgnored('web/build-output/x.ts')).toBe(false)
    expect(isIgnored('web/generated/api.ts')).toBe(true)
    expect(isIgnored('server/generated/api.ts')).toBe(false)
  })

  it('lets a deeper file re-include what a shallower one excluded', () => {
    const isIgnored = createGitignoreMatcher([
      { dir: 'pkg', text: '!keep.ts\n' },
      { dir: '', text: '*.ts\n' },
    ])
    expect(isIgnored('src/a.ts')).toBe(true)
    expect(isIgnored('pkg/keep.ts')).toBe(false)
    expect(isIgnored('pkg/other.ts')).toBe(true)
  })
})

describe('selectRepoFiles', () => {
  it('counts every skip reason and never lets .gitignore re-include a blocked file', () => {
    const files = [
      { path: 'src/index.ts', size: 10 },
      { path: '.env', size: 10 },
      { path: 'src/generated/out.ts', size: 10 },
      { path: 'yarn.lock', size: 10 },
      { path: 'node_modules/a/b.js', size: 10 },
      { path: 'logo.png', size: 10 },
      { path: 'src/huge.ts', size: MAX_REPO_FILE_BYTES + 1 },
      { path: 'app.min.js', size: 10 },
    ]
    const selection = selectRepoFiles(files, [{ dir: '', text: 'src/generated/\n!.env\n' }])
    expect(selection.included).toEqual([{ path: 'src/index.ts', size: 10, kind: 'code', language: 'typescript' }])
    expect(selection.skipped).toEqual({
      blocked: 1,
      'ignored-directory': 1,
      gitignore: 1,
      lockfile: 1,
      minified: 1,
      'not-allowlisted': 1,
      'too-large': 1,
      binary: 0,
    })
  })

  it('keeps extra fields on included files', () => {
    const selection = selectRepoFiles([{ path: 'README.md', size: 5, blob: 'abc' }])
    expect(selection.included[0]).toMatchObject({ blob: 'abc', kind: 'readme' })
  })
})

describe('looksBinary', () => {
  it('flags a NUL byte in the first 8000 bytes only', () => {
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false)
    expect(looksBinary(Uint8Array.from([0x89, 0x50, 0, 0x47]))).toBe(true)
    const late = new Uint8Array(9000).fill(0x61)
    late[8500] = 0
    expect(looksBinary(late)).toBe(false)
  })
})
