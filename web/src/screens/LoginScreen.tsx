import { LoaderCircle } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { login } from '../api/client'
import { BrandMark } from '../components/BrandMark'
import { loginErrorMessage } from './loginErrors'

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldId = useId()
  const errorId = useId()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || value === '') return
    setBusy(true)
    setError(null)
    try {
      await login(value)
      setValue('')
      onSignedIn()
    } catch (failure) {
      setError(loginErrorMessage(failure))
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="size-14" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Pythia</h1>
          <p className="mt-1 text-sm text-muted">Sign in to search your notes and repos.</p>
        </div>
        <form onSubmit={submit} noValidate className="rounded-card border border-line bg-surface p-6">
          {/* Lets password managers pair the saved entry with this site. */}
          <input type="text" name="username" autoComplete="username" value="pythia" readOnly hidden />
          <label htmlFor={fieldId} className="block text-sm font-medium">
            Password
          </label>
          <input
            id={fieldId}
            type="password"
            name="current-password"
            autoComplete="current-password"
            autoFocus
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            className="mt-2 block min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink transition-colors placeholder:text-muted focus:border-accent aria-invalid:border-danger"
          />
          {error === null ? null : (
            <p id={errorId} role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || value === ''}
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-accent px-4 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  )
}
