import { ApiError } from '../api/client'

export function formatWait(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/** What the login form says for each failure; never echoes what was typed. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 0:
        return 'Can’t reach the server. Check your connection and try again.'
      case 401:
        return 'Wrong password. Try again.'
      case 429:
        return error.retryAfterSeconds === null
          ? 'Too many attempts. Wait a few minutes and try again.'
          : `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.`
      case 503:
        return 'Sign-in isn’t set up on this server yet. Run pnpm --filter server auth-env and add its lines to .env.'
    }
  }
  return 'Something went wrong. Try again.'
}
