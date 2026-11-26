import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { useSession } from './auth/useSession'
import { LoginScreen } from './screens/LoginScreen'
import { AppShell } from './shell/AppShell'

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">{children}</main>
}

export default function App() {
  const session = useSession()

  switch (session.state) {
    case 'checking':
      return (
        <Centered>
          <LoaderCircle aria-hidden="true" className="size-6 animate-spin text-muted" />
          <span className="sr-only" role="status">
            Loading
          </span>
        </Centered>
      )
    case 'unreachable':
      return (
        <Centered>
          <TriangleAlert aria-hidden="true" className="size-8 text-warning" />
          <h1 className="text-lg font-medium">Can’t reach the server</h1>
          <p className="max-w-sm text-sm text-muted">Check your connection or whether the server is running.</p>
          <button
            type="button"
            onClick={session.recheck}
            className="min-h-11 rounded-control bg-accent px-5 font-medium text-on-accent transition-opacity hover:opacity-90"
          >
            Try again
          </button>
        </Centered>
      )
    case 'signed-out':
      return <LoginScreen onSignedIn={session.signedIn} />
    case 'signed-in':
      return <AppShell onSignOut={() => void session.signOut()} />
  }
}
