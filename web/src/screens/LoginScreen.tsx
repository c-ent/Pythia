import { Eye, EyeOff, LoaderCircle, Lock } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { login } from '../api/client'
import { BrandMark } from '../components/BrandMark'
import { loginErrorMessage } from './loginErrors'

/**
 * Sign-in (R6, R13): one password field on the glow background of the main
 * panel, in both themes. Errors and the rate-limit wait show under the field.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
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
    <main className="panel-glow flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="size-14" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Pythia</h1>
          <p className="mt-1 text-sm text-muted">Sign in to search your notes, repos and Keep.</p>
        </div>
        <form
          onSubmit={submit}
          noValidate
          className="rounded-panel border border-line/60 bg-surface p-6 shadow-[0_1px_2px_rgb(15_15_16/0.06),0_12px_40px_rgb(15_15_16/0.08)]"
        >
          {/* Lets password managers pair the saved entry with this site. */}
          <input type="text" name="username" autoComplete="username" value="pythia" readOnly hidden />
          <label htmlFor={fieldId} className="block text-sm font-medium">
            Password
          </label>
          <div className="mt-2 flex items-center gap-1 rounded-control border border-line bg-canvas pr-0.5 transition-colors focus-within:border-accent-ink has-aria-invalid:border-danger">
            <input
              id={fieldId}
              type={shown ? 'text' : 'password'}
              name="current-password"
              autoComplete="current-password"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={error === null ? undefined : errorId}
              className="block min-h-11 min-w-0 flex-1 rounded-control bg-transparent px-3 text-base text-ink outline-none placeholder:text-muted"
            />
            <button
              type="button"
              aria-label="Show password"
              aria-pressed={shown}
              onClick={() => setShown((next) => !next)}
              className="grid size-11 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>
          {error === null ? null : (
            <p id={errorId} role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || value === ''}
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-strong px-4 font-medium text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-6 flex items-start justify-center gap-2 text-center text-[0.8125rem] leading-snug text-muted">
          <Lock aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-ink" />
          Your personal index. This device stays signed in for 30 days.
        </p>
      </div>
    </main>
  )
}
