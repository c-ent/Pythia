import { describe, expect, it } from 'vitest'
import { isMapDocument, isRepoMapPath } from './mapEligible.js'

describe('isMapDocument (R20 map documents)', () => {
  it('includes every Obsidian note', () => {
    expect(isMapDocument('obsidian', 'Daily/2026-11-27.md')).toBe(true)
    expect(isMapDocument('obsidian', 'README.md')).toBe(true)
  })

  it('includes every Keep note', () => {
    expect(isMapDocument('keep', 'Takeout/Keep/Shopping.json')).toBe(true)
  })

  it('includes every Drive document outside the exclude list', () => {
    expect(isMapDocument('gdrive', 'Notes/plan.docx')).toBe(true)
    expect(isMapDocument('gdrive', 'budget.xlsx', { driveExclude: ['Work'] })).toBe(true)
  })

  it('leaves out Drive documents in an excluded folder and its subfolders', () => {
    const options = { driveExclude: ['Work', 'Clients/Acme'] }
    expect(isMapDocument('gdrive', 'Work/plan.docx', options)).toBe(false)
    expect(isMapDocument('gdrive', 'Clients/Acme/2026/brief.pdf', options)).toBe(false)
    // A folder name that only starts the same is not excluded.
    expect(isMapDocument('gdrive', 'Workshop/notes.md', options)).toBe(true)
    expect(isMapDocument('gdrive', 'Clients/Other/brief.pdf', options)).toBe(true)
  })

  it('never includes work documents', () => {
    expect(isMapDocument('work', 'notes/plan.md')).toBe(false)
  })

  it('leaves out sources that are not on the R20 list', () => {
    expect(isMapDocument('chat', 'thread.md')).toBe(false)
    expect(isMapDocument('email', 'x.md')).toBe(false)
  })

  it('applies the repo rules to repo documents', () => {
    expect(isMapDocument('repo', 'README.md')).toBe(true)
    expect(isMapDocument('repo', 'src/index.ts')).toBe(false)
  })
})

describe('isRepoMapPath includes', () => {
  it('README at the root and at any depth, any extension or none', () => {
    for (const repoPath of ['README.md', 'README', 'readme.txt', 'README.rst', 'packages/web/README.md', 'a/b/c/Readme.markdown']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(true)
    }
  })

  it('Markdown and text files under docs/ or doc/, at any depth', () => {
    for (const repoPath of ['docs/setup.md', 'doc/usage.txt', 'docs/agent/spec.md', 'packages/api/docs/guide.mdx', 'Docs/Intro.MD']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(true)
    }
  })

  it('CHANGELOG and CONTRIBUTING at any depth', () => {
    for (const repoPath of ['CHANGELOG.md', 'CHANGELOG', 'packages/a/CHANGELOG.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(true)
    }
  })
})

describe('isRepoMapPath excludes', () => {
  it('code files, also under docs/', () => {
    for (const repoPath of ['src/index.ts', 'main.py', 'docs/example.ts', 'doc/build.sh', 'docs/diagram.json']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })

  it('Markdown outside docs/ that is not a README, CHANGELOG or CONTRIBUTING', () => {
    expect(isRepoMapPath('notes.md')).toBe(false)
    expect(isRepoMapPath('src/components/Button.md')).toBe(false)
    expect(isRepoMapPath('documentation/setup.md')).toBe(false)
  })

  it('LICENSE and COPYING files, also under docs/', () => {
    for (const repoPath of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT', 'licence.txt', 'COPYING', 'COPYING.LESSER', 'docs/LICENSE.md', 'docs/COPYING.txt']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })

  it('lockfiles', () => {
    for (const repoPath of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'web/pnpm-lock.yaml']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })

  it('package.json', () => {
    expect(isRepoMapPath('package.json')).toBe(false)
    expect(isRepoMapPath('server/package.json')).toBe(false)
  })

  it('config files', () => {
    for (const repoPath of [
      'vite.config.ts',
      'vitest.config.mts',
      'eslint.config.js',
      'docs/docusaurus.config.md',
      'tsconfig.json',
      'tsconfig.build.json',
      '.eslintrc',
      '.eslintrc.json',
      '.prettierrc',
      '.prettierrc.yaml',
      '.editorconfig',
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.prod.yml',
      'docker-compose.override.yaml',
    ]) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })

  it('CI files under .github/', () => {
    for (const repoPath of ['.github/workflows/ci.yml', '.github/workflows/README.md', '.github/dependabot.yml', '.github/ISSUE_TEMPLATE/bug.yaml']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })

  it('the repo summary pseudo-document', () => {
    expect(isRepoMapPath(':SUMMARY')).toBe(false)
  })

  it('code files that only start with a map name', () => {
    for (const repoPath of ['src/readme.ts', 'changelog.js', 'scripts/contributing.py', 'READMEGenerator.java']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(false)
    }
  })
})

describe('isRepoMapPath name variants', () => {
  it('accepts suffixed README, CHANGELOG and CONTRIBUTING names', () => {
    for (const repoPath of ['README.de.md', 'CHANGELOG-v1.md', 'contributing_guide.md', 'README.adoc']) {
      expect(isRepoMapPath(repoPath), repoPath).toBe(true)
    }
  })
})
