import { describe, expect, it } from 'vitest'
import { buildRepoSummary, manifestLines, MAX_SUMMARY_CHARS, readmeExcerpt, treeOverview } from './repoSummary.js'

const files = [
  { path: 'README.md', language: 'markdown' },
  { path: 'package.json', language: 'json' },
  { path: 'src/index.ts', language: 'typescript' },
  { path: 'src/cart.ts', language: 'typescript' },
  { path: 'scripts/seed.py', language: 'python' },
]

describe('buildRepoSummary', () => {
  it('builds one SUMMARY chunk from README, manifests and tree', () => {
    const summary = buildRepoSummary({
      repo: 'kitchen-app',
      branch: null,
      files,
      readme: '# Kitchen app\n\n[![CI](https://x/badge.svg)](https://x)\n\nTracks recipes and a shopping list.\n',
      manifests: {
        'package.json': JSON.stringify({
          name: 'kitchen-app',
          description: 'Recipes',
          dependencies: { react: '^19', express: '^5' },
          devDependencies: { vitest: '^5' },
          scripts: { deploy: 'ssh prod ./deploy.sh' },
        }),
      },
    })
    expect(summary.headingPath).toBe('SUMMARY > kitchen-app')
    expect(summary.ordinal).toBe(0)
    expect(summary.content).toBe(
      [
        'Repository: kitchen-app',
        'Indexed files: 5',
        'Languages: typescript (2), json (1), markdown (1), python (1)',
        'README:\n# Kitchen app\n\nTracks recipes and a shopping list.',
        'Dependencies:\npackage.json name: kitchen-app\npackage.json description: Recipes\npackage.json dependencies: express, react\npackage.json dev dependencies: vitest',
        'Files:\nscripts/ (1 file)\nsrc/ (2 files)\nREADME.md\npackage.json',
      ].join('\n\n'),
    )
    expect(summary.content).not.toContain('deploy.sh')
    expect(summary.embedText).toBe(`SUMMARY > kitchen-app\n\n${summary.content}`)
  })

  it('is deterministic whatever the input order', () => {
    const manifests = { 'package.json': '{"dependencies":{"b":"1","a":"1"}}', 'requirements.txt': 'flask\n' }
    const a = buildRepoSummary({ repo: 'r', branch: 'main', files, manifests })
    const b = buildRepoSummary({
      repo: 'r',
      branch: 'main',
      files: [...files].reverse(),
      manifests: { 'requirements.txt': 'flask\n', 'package.json': '{"dependencies":{"a":"1","b":"1"}}' },
    })
    expect(a).toEqual(b)
    expect(a.content.startsWith('Repository: r (branch main)')).toBe(true)
  })

  it('includes first and latest commit dates when provided', () => {
    const summary = buildRepoSummary({
      repo: 'kitchen-app',
      branch: 'main',
      firstCommitAt: new Date('2026-09-01T10:00:00.000Z'),
      lastCommitAt: new Date('2026-11-28T12:30:00.000Z'),
      files,
    })
    expect(summary.content.split('\n\n')[0]).toBe(
      ['Repository: kitchen-app (branch main)', 'First commit: 2026-09-01T10:00:00.000Z', 'Latest commit: 2026-11-28T12:30:00.000Z'].join('\n'),
    )
  })

  it('works with no README and no manifests, and caps its size', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: `pkg${i}/file.ts`, language: 'typescript' }))
    const summary = buildRepoSummary({ repo: 'big', branch: null, files: many })
    expect(summary.content).not.toContain('README:')
    expect(summary.content).toContain('… 4960 more')
    expect(summary.content.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS)
  })
})

describe('manifestLines', () => {
  it('reads composer.json require and require-dev', () => {
    expect(
      manifestLines('composer.json', JSON.stringify({ name: 'me/shop', require: { php: '^8.3', 'laravel/framework': '^12' }, 'require-dev': { 'phpunit/phpunit': '^11' } })),
    ).toEqual([
      'composer.json name: me/shop',
      'composer.json dependencies: laravel/framework, php',
      'composer.json dev dependencies: phpunit/phpunit',
    ])
  })

  it('reads requirements.txt names without versions, options or comments', () => {
    expect(
      manifestLines('api/requirements.txt', '# web\nFlask==3.1\nrequests>=2 ; python_version>"3.8"\n-r base.txt\nuvicorn[standard]\n\nflask\n'),
    ).toEqual(['api/requirements.txt packages: flask, requests, uvicorn'])
  })

  it('names a manifest it cannot read without failing', () => {
    expect(manifestLines('package.json', '{ nope')).toEqual(['package.json: not valid JSON'])
    expect(manifestLines('go.mod', 'module x')).toEqual(['go.mod'])
  })
})

describe('readmeExcerpt and treeOverview', () => {
  it('drops front matter, HTML and images, and cuts long READMEs at a paragraph', () => {
    const text = `---\ntitle: x\n---\n<p align="center"><img src="logo.png"></p>\n\n# Title\n\n![shot](a.png)\n\n${'word '.repeat(200)}\n\n${'more '.repeat(300)}`
    const excerpt = readmeExcerpt(text)
    expect(excerpt.startsWith('# Title')).toBe(true)
    expect(excerpt).not.toContain('title: x')
    expect(excerpt).not.toContain('<img')
    expect(excerpt).not.toContain('a.png')
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).not.toContain('more')
  })

  it('lists folders with counts before root files', () => {
    expect(treeOverview([{ path: 'b.ts', language: null }, { path: 'a/x.ts', language: null }])).toEqual(['a/ (1 file)', 'b.ts'])
  })
})
