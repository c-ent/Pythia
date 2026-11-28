import { describe, expect, it } from 'vitest'
import { RepoSyncError } from './repoMirror.js'
import { describeRepoFailure } from './startRepos.js'

const TOKEN = ['ghp', '_exampleTokenValue1234567890'].join('')

describe('describeRepoFailure', () => {
  it('keeps git failure details while redacting remote URLs, credentials and tokens', () => {
    expect(describeRepoFailure(new RepoSyncError('git rev-parse failed: fatal: Needed a single revision'))).toBe(
      'git rev-parse failed: fatal: Needed a single revision',
    )
    expect(
      describeRepoFailure(
        new RepoSyncError(`git clone failed: fatal: repository 'https://user:${TOKEN}@github.com/me/whisksmith.git/' not found`),
      ),
    ).toBe("git clone failed: fatal: repository '<remote>' not found")
    expect(
      describeRepoFailure(new RepoSyncError('git fetch failed: Permission denied for git@github.com:me/whisksmith.git')),
    ).toBe('git fetch failed: Permission denied for <remote>')
    expect(describeRepoFailure(new RepoSyncError(`git fetch failed: bad token ${TOKEN}`))).toBe(
      'git fetch failed: bad token <token>',
    )
  })

  it('logs only error class and optional code for non-RepoSyncError failures', () => {
    const err = Object.assign(new Error('EACCES: /home/user/secret/path'), { code: 'EACCES' })
    expect(describeRepoFailure(err)).toBe('Error (EACCES)')
    expect(describeRepoFailure(new TypeError('sensitive message'))).toBe('TypeError')
    expect(describeRepoFailure('raw string')).toBe('unknown error')
  })
})
