import { FolderGit2, LogOut, Search, Settings, Upload, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect } from 'react'
import { BrandMark } from '../components/BrandMark'
import { useOnline } from '../hooks/useOnline'
import { useOfflineSync } from '../offline/useOfflineSync'
import { usePinnedRepos } from '../repos/pins'
import { documentIdFromPath, followLink, pathFor, routeFromPath, usePathname, type RouteName } from '../router'
import { DocumentScreen } from '../screens/DocumentScreen'
import { ImportScreen } from '../screens/ImportScreen'
import { ReposScreen } from '../screens/ReposScreen'
import { SearchScreen } from '../screens/SearchScreen'
import { SettingsScreen } from '../screens/SettingsScreen'

const NAV: { route: RouteName; label: string; icon: LucideIcon }[] = [
  { route: 'search', label: 'Search', icon: Search },
  { route: 'repos', label: 'Repos', icon: FolderGit2 },
  { route: 'import', label: 'Import', icon: Upload },
  { route: 'settings', label: 'Settings', icon: Settings },
]

/**
 * Mobile first: a bottom tab bar under 48rem (md), a left sidebar from md up.
 * Content stays in one reading column (max-w-3xl) on every width.
 */
export function AppShell({ onSignOut }: { onSignOut: () => void }) {
  const pathname = usePathname()
  const route = routeFromPath(pathname)
  // `/doc/<id>` opens a document over Search, which stays the active tab.
  const documentId = documentIdFromPath(pathname)
  const online = useOnline()
  const pinnedRepos = usePinnedRepos()
  useOfflineSync(true, pinnedRepos)
  const current = NAV.find((item) => item.route === route) ?? NAV[0]

  useEffect(() => {
    // The document screen sets its own title once the document loads.
    if (documentId === null) document.title = `${current?.label ?? 'Search'} · Pythia`
    else document.title = 'Document · Pythia'
  }, [current, documentId])

  let screen
  switch (route) {
    case 'repos':
      screen = <ReposScreen />
      break
    case 'import':
      screen = <ImportScreen />
      break
    case 'settings':
      screen = <SettingsScreen onSignOut={onSignOut} />
      break
    default:
      // Search stays mounted (hidden) under an open document, so Back returns
      // to the same query, results and answer instead of an empty screen.
      screen = (
        <>
          <div hidden={documentId !== null}>
            <SearchScreen />
          </div>
          {documentId === null ? null : <DocumentScreen key={documentId} id={documentId} />}
        </>
      )
  }

  return (
    <div className="min-h-dvh md:flex">
      <a
        href="#main"
        className="sr-only z-30 rounded-control bg-accent px-4 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-line bg-canvas/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
        <BrandMark className="size-6" />
        <span className="font-semibold tracking-tight">Pythia</span>
      </header>

      <aside className="md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:border-r md:border-line md:bg-surface">
        <div className="hidden h-16 items-center gap-2 px-5 md:flex">
          <BrandMark className="size-7" />
          <span className="text-lg font-semibold tracking-tight">Pythia</span>
        </div>
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:static md:flex-1 md:border-t-0 md:pb-0"
        >
          <ul className="grid grid-cols-4 md:flex md:flex-col md:gap-1 md:px-3 md:py-2">
            {NAV.map(({ route: target, label, icon: Icon }) => {
              // On a document the Search tab stays highlighted but is still a link back.
              const active = target === route && documentId === null
              const section = target === route
              const path = pathFor(target)
              return (
                <li key={target}>
                  <a
                    href={path}
                    onClick={(event) => followLink(event, path)}
                    aria-current={active ? 'page' : section ? 'true' : undefined}
                    className="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-muted transition-colors hover:text-ink aria-[current]:text-accent md:min-h-11 md:flex-row md:justify-start md:gap-3 md:rounded-control md:px-3 md:text-sm md:aria-[current]:bg-raised md:aria-[current]:text-ink"
                  >
                    <Icon aria-hidden="true" className="size-5" />
                    {label}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="hidden border-t border-line p-3 md:block">
          <button
            type="button"
            onClick={onSignOut}
            className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <LogOut aria-hidden="true" className="size-5" />
            Sign out
          </button>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-6 pb-28 outline-none md:px-8 md:pt-10 md:pb-12">
        <div className="mx-auto max-w-3xl">
          {online ? null : (
            <p
              role="status"
              className="mb-6 flex items-center gap-2 rounded-card border border-warning/40 bg-raised px-4 py-3 text-sm text-warning"
            >
              <WifiOff aria-hidden="true" className="size-4 shrink-0" />
              You’re offline. Search and Ask need a connection.
            </p>
          )}
          {screen}
        </div>
      </main>
    </div>
  )
}
