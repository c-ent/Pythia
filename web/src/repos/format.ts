import { ApiError } from '../api/client'

export const REPOS_OFFLINE_MESSAGE = 'You’re offline. The repo list needs a connection.'

export function repoListErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  // The server registers `/api/repos` only when repo indexing is configured.
  if (error instanceof ApiError && error.status === 404) return 'Repo indexing isn’t set up on the server yet.'
  return 'Couldn’t load repos. Try again.'
}

export function overviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (error instanceof ApiError && error.status === 404) return 'This repo is no longer indexed.'
  return 'Couldn’t load the overview. Try again.'
}

export const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}
