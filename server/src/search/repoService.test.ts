import { describe, expect, it } from 'vitest'
import { createRepoService, parseRepoSummaryMetadata } from './repoService.js'

describe('parseRepoSummaryMetadata', () => {
  it('parses commit dates and languages from SUMMARY text', () => {
    const content = [
      '# Pythia',
      'First commit: 2025-01-15T10:00:00Z',
      'Latest commit: 2026-11-28T16:00:00Z',
      'Languages: TypeScript, SQL',
    ].join('\n')

    const meta = parseRepoSummaryMetadata(content)
    expect(meta.firstCommitAt?.toISOString()).toBe('2025-01-15T10:00:00.000Z')
    expect(meta.lastCommitAt?.toISOString()).toBe('2026-11-28T16:00:00.000Z')
    expect(meta.languages).toBe('TypeScript, SQL')
  })

  it('falls back to mtime when Latest commit is absent', () => {
    const fallback = new Date('2026-10-01T00:00:00Z')
    expect(parseRepoSummaryMetadata('# Empty', fallback)).toEqual({
      firstCommitAt: null,
      lastCommitAt: fallback,
      languages: null,
    })
  })
})

describe('createRepoService', () => {
  it('lists repos and maps overviews', async () => {
    const updatedAt = new Date('2026-11-28T00:00:00Z')
    const service = createRepoService({
      store: {
        async listRepos() {
          return [{ name: 'pythia', files: 10, chunks: 25, updatedAt }]
        },
        async getRepo(name) {
          if (name !== 'pythia') return null
          return {
            name: 'pythia',
            files: 10,
            chunks: 25,
            updatedAt,
            summary: { documentId: 42, allowLlm: true, content: 'Summary text' },
          }
        },
      },
    })

    expect(await service.listRepos()).toEqual([{ name: 'pythia', files: 10, chunks: 25, updatedAt }])
    expect(await service.getOverview('pythia')).toEqual({
      name: 'pythia',
      files: 10,
      chunks: 25,
      updatedAt,
      summary: { documentId: 42, allowLlm: true, text: 'Summary text' },
    })
    expect(await service.getOverview('missing')).toBeNull()
  })
})
