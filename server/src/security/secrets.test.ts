import { describe, expect, it, vi } from 'vitest'
import {
  containsSecret,
  detectSecretKinds,
  dropSecretChunks,
  isBlockedPath,
  type SecretsDropEvent,
} from './secrets.js'

// Fake secrets are assembled at runtime so this file never contains a literal
// token: that keeps GitHub push protection quiet and keeps the file indexable
// if Pythia ever indexes its own repo.
const fake = {
  awsKeyId: 'AK' + 'IA' + 'Q'.repeat(16),
  awsSecretLine: ['aws', 'secret', 'access', 'key'].join('_') + ' = ' + 'a1B2c3D4/'.repeat(4) + 'e5F6',
  googleKey: 'AI' + 'za' + 'Sy' + 'x'.repeat(33),
  githubClassic: 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4),
  githubFineGrained: 'github' + '_pat_' + '11AB'.repeat(10),
  pemHeader: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  pemOpenSsh: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  pemFooter: '-----END ' + 'PRIVATE KEY-----',
  jwt:
    'ey' +
    'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'ey' +
    'JzdWIiOiIxMjM0NTY3ODkwIn0.' +
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
}

describe('isBlockedPath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'keys/id_rsa',
    'keys/id_rsa.pub',
    'server.pem',
    'tls/private.key',
    'credentials',
    'aws/credentials.json',
    '.git/config',
    'repo/.git/HEAD',
  ])('blocks %s', (path) => {
    expect(isBlockedPath(path)).toBe(true)
  })

  it.each(['Secrets/.ENV.local', 'KEYS\\ID_RSA', 'Server.PEM', 'C:\\vault\\.Git\\index'])(
    'blocks %s regardless of case or separator',
    (path) => {
      expect(isBlockedPath(path)).toBe(true)
    },
  )

  it.each([
    'notes/Daily.md',
    'src/environment.ts',
    'docs/keys.md',
    'src/monkey.ts',
    '.gitignore',
    '.github/workflows/ci.yml',
    'my-credentials-notes/readme.md',
  ])('allows %s', (path) => {
    expect(isBlockedPath(path)).toBe(false)
  })
})

describe('detectSecretKinds', () => {
  it.each([
    ['aws-access-key-id', `key: ${fake.awsKeyId}`],
    ['aws-secret-access-key', fake.awsSecretLine],
    ['google-api-key', `GEMINI_API_KEY=${fake.googleKey}`],
    ['github-token', `token ${fake.githubClassic}`],
    ['github-token', fake.githubFineGrained],
    ['private-key-block', `${fake.pemHeader}\nMIIEow...`],
    ['private-key-block', fake.pemOpenSsh],
    ['jwt', `Authorization: Bearer ${fake.jwt}`],
  ])('finds %s', (kind, text) => {
    expect(detectSecretKinds(text)).toContain(kind)
  })

  it('finds the footer half of a PEM block split across chunks', () => {
    expect(containsSecret(`Zm9vYmFyYmF6\nYmF6cXV4\n${fake.pemFooter}`)).toBe(true)
  })

  it('reports each kind once and never the matched value', () => {
    const kinds = detectSecretKinds(`${fake.githubClassic} and ${fake.githubFineGrained}`)
    expect(kinds).toEqual(['github-token'])
    expect(JSON.stringify(kinds)).not.toContain(fake.githubClassic)
  })

  it('gives the same answer on repeated calls', () => {
    expect(containsSecret(fake.jwt)).toBe(true)
    expect(containsSecret(fake.jwt)).toBe(true)
  })

  it.each([
    '# Meeting notes\n\nDiscussed the -----BEGIN PUBLIC KEY----- format.',
    'Use `process.env.GITHUB_TOKEN` instead of hardcoding the token.',
    'The ghp_ prefix marks a classic GitHub token.',
    'eyJ is how base64 JSON starts.',
    'AKIA keys are 20 characters long.',
  ])('ignores ordinary text: %s', (text) => {
    expect(containsSecret(text)).toBe(false)
  })
})

describe('dropSecretChunks', () => {
  it('drops chunks with secrets and logs only the file and count', () => {
    const log = vi.fn<(event: SecretsDropEvent) => void>()
    const chunks = [
      { content: '# Setup\n\nInstall with pnpm.' },
      { content: `token: ${fake.githubClassic}` },
      { content: `${fake.pemHeader}\nabc` },
      { content: 'Nothing secret here.' },
    ]

    const kept = dropSecretChunks('notes/setup.md', chunks, log)

    expect(kept).toEqual([chunks[0], chunks[3]])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({ file: 'notes/setup.md', droppedCount: 2 })
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).not.toContain(fake.githubClassic)
    expect(logged).not.toContain('PRIVATE KEY')
  })

  it('does not log when nothing is dropped', () => {
    const log = vi.fn<(event: SecretsDropEvent) => void>()
    const chunks = [{ content: 'clean' }]

    expect(dropSecretChunks('a.md', chunks, log)).toEqual(chunks)
    expect(log).not.toHaveBeenCalled()
  })
})
