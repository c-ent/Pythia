import { WifiOff } from 'lucide-react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useOnline } from '../hooks/useOnline'
import { useOfflineSync } from '../offline/useOfflineSync'
import { loadProfile } from '../profile/profile'
import { usePinnedRepos } from '../repos/pins'
import {
  documentIdFromPath,
  isSourcesActivityPath,
  redirect,
  redirectFor,
  repoNameFromPath,
  routeFromPath,
  settingsSectionFromPath,
  sourceKindFromPath,
  usePathname,
} from '../router'
import { ActivityScreen } from '../screens/ActivityScreen'
import { AskScreen } from '../screens/AskScreen'
import { BrowseFilesScreen } from '../screens/BrowseFilesScreen'
import { DocumentScreen } from '../screens/DocumentScreen'
import { ReposScreen } from '../screens/ReposScreen'
import { SearchScreen } from '../screens/SearchScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { SourcesScreen } from '../screens/SourcesScreen'
import { PinnedScreen } from '../screens/PinnedScreen'
import { MapScreen } from '../screens/MapScreen'
import { overallSyncPercent } from '../sources/format'
import { serverSyncing, useServerStatus } from '../sources/useServerStatus'
import { NAV, SETTINGS_SECTION_LABELS, readSidebarCollapsed, saveSidebarCollapsed } from './nav'
import { MobileTabBar, MobileTopBar, Rail, Sidebar, type CurrentFor } from './Navigation'
import { isNewSearchShortcut, startNewSearch } from './newSearch'
import { TopBar } from './TopBar'
import { useBrokenChecks } from './useBrokenChecks'
import { useDeviceCount } from './useDeviceCount'
import { useGeminiStatus } from './useGeminiStatus'

/** How often the shell rereads `GET /api/status` while online, so the top bar's pills stay current. */
export const STATUS_REFRESH_MS = 60_000

/**
 * Mobile first (ui.md, Layout): below md a top bar and a floating tab bar; md
 * to lg an icon rail; from lg the full sidebar (collapsible to the rail). The
 * main panel sits in a frame of the `nav` color from md up.
 */
export function AppShell({ onSignOut }: { onSignOut: () => void }) {
  const address = usePathname()
  // Old and partial addresses render their new screen at once; the address
  // bar is corrected just after, without a new history entry.
  const target = redirectFor(address)
  const pathname = target ?? address
  const route = routeFromPath(pathname)
  // `/doc/<id>` opens a document over Search, which stays the active tab.
  const documentId = documentIdFromPath(pathname)
  const repoName = repoNameFromPath(pathname)
  const browseSource = sourceKindFromPath(pathname)
  const activityOpen = isSourcesActivityPath(pathname)
  const section = settingsSectionFromPath(pathname)
  const online = useOnline()
  const devices = useDeviceCount(online)
  const geminiConfigured = useGeminiStatus(online)
  // The status says whether Gemini is usable (a key is set and the last call
  // did not fail on it); until it arrives, or if it fails, the key status stands in.
  const server = useServerStatus(online, { refreshMs: STATUS_REFRESH_MS })
  const broken = online && server.reachable !== false && server.status?.health === 'broken'
  const brokenChecks = useBrokenChecks(broken, server.status?.checkedAt)
  const gemini = server.status?.gemini.available ?? geminiConfigured
  const pinnedRepos = usePinnedRepos()
  useOfflineSync(true, pinnedRepos)
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)

  // The profile (name, theme, opening mode) is shared by every device: load it
  // on sign-in and on reconnecting. Offline, or if it fails, the copy cached on
  // this device keeps applying.
  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    loadProfile(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [online])

  useLayoutEffect(() => {
    if (target !== null) redirect(target)
  }, [target])

  useEffect(() => {
    // The document screen sets its own title once the document loads.
    if (documentId !== null) document.title = 'Document · Pythia'
    else if (repoName !== null) document.title = `${repoName} · Repos · Pythia`
    else if (browseSource !== null) document.title = `${NAV.find((item) => item.route === 'sources')?.label ?? 'Sources'} · Pythia`
    else if (activityOpen) document.title = 'Recent activity · Sources · Pythia'
    else if (route === 'settings') document.title = `${SETTINGS_SECTION_LABELS[section]} · Settings · Pythia`
    else document.title = `${NAV.find((item) => item.route === route)?.label ?? 'Search'} · Pythia`
  }, [route, section, documentId, repoName, browseSource, activityOpen])

  // Ctrl K / ⌘ K starts a new search from anywhere, also from inside a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isNewSearchShortcut(event)) return
      event.preventDefault()
      startNewSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const collapse = (next: boolean): void => {
    saveSidebarCollapsed(next)
    setCollapsed(next)
    // The button that was clicked goes away; keep focus on its counterpart.
    requestAnimationFrame(() => document.getElementById(next ? 'sidebar-expand' : 'sidebar-collapse')?.focus())
  }

  const subpageOpen = documentId !== null || repoName !== null || browseSource !== null || activityOpen
  const current: CurrentFor = (item) => (item !== route ? undefined : !subpageOpen ? 'page' : 'true')

  let screen
  // Search results get the full panel width for the preview pane (xl up);
  // SearchScreen narrows itself otherwise.
  let width = 'max-w-4xl'
  switch (route) {
    case 'ask':
      // The answer and its side panels; AskScreen narrows itself before a question.
      width = 'max-w-6xl'
      screen = <AskScreen />
      break
    case 'repos':
      if (repoName !== null) {
        width = 'max-w-5xl'
        screen = <BrowseFilesScreen key={`repo:${repoName}`} source="repo" repoName={repoName} />
      } else {
        screen = <ReposScreen />
      }
      break
    case 'pinned':
      // Pinned repos beside the storage card from lg.
      width = 'max-w-5xl'
      screen = <PinnedScreen />
      break
    case 'map':
      screen = <MapScreen />
      break
    case 'sources':
      if (browseSource !== null) {
        width = 'max-w-5xl'
        screen = <BrowseFilesScreen key={`source:${browseSource}`} source={browseSource} />
      } else if (activityOpen) {
        screen = <ActivityScreen />
      } else {
        // The sources list and the activity side by side from lg.
        width = 'max-w-6xl'
        screen = <SourcesScreen />
      }
      break
    case 'settings':
      screen = <SettingsScreen key={section} section={section} onSignOut={onSignOut} />
      break
    default:
      // Search stays mounted (hidden) under an open document, so Back returns
      // to the same query, results and answer instead of an empty screen.
      width = documentId === null ? 'max-w-[90rem]' : 'max-w-5xl'
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
    <div className="min-h-dvh md:flex md:items-start md:gap-3 md:bg-nav md:p-3 md:pl-[max(0.75rem,env(safe-area-inset-left))]">
      <a
        href="#main"
        className="sr-only z-30 rounded-control bg-accent px-4 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <Sidebar
        className={collapsed ? 'hidden' : 'hidden lg:flex'}
        current={current}
        pinned={pinnedRepos.length}
        recentKind={route === 'ask' ? 'ask' : 'search'}
        online={online}
        syncing={serverSyncing(server.status)}
        syncProgress={
          server.status === null
            ? null
            : (() => {
                const pct = overallSyncPercent(server.status.sources)
                return pct === null ? null : `Syncing the server… ${pct}%`
              })()
        }
        onCollapse={() => collapse(true)}
      />
      <Rail
        className={collapsed ? 'hidden md:flex' : 'hidden md:flex lg:hidden'}
        current={current}
        collapsed={collapsed}
        online={online}
        syncing={serverSyncing(server.status)}
        onExpand={() => collapse(false)}
      />

      <div className="panel-glow flex min-h-dvh min-w-0 flex-1 flex-col md:min-h-[calc(100dvh-1.5rem)] md:rounded-panel">
        <MobileTopBar
          online={online}
          reachable={server.reachable}
          health={server.status?.health}
          brokenChecks={brokenChecks}
          sources={server.status?.sources}
          syncing={serverSyncing(server.status)}
          gemini={gemini}
          checkedAt={server.status?.checkedAt}
        />
        <TopBar
          online={online}
          reachable={server.reachable}
          health={server.status?.health}
          brokenChecks={brokenChecks}
          sources={server.status?.sources}
          syncing={serverSyncing(server.status)}
          devices={devices}
          gemini={gemini}
          checkedAt={server.status?.checkedAt}
        />
        <main
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 pt-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))] outline-none md:px-7 md:pt-4 md:pb-10"
        >
          <div className={`mx-auto ${width}`}>
            {online ? null : (
              <p
                role="status"
                className="mx-auto mb-6 flex max-w-4xl items-center gap-2 rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning"
              >
                <WifiOff aria-hidden="true" className="size-4 shrink-0" />
                You’re offline. Search and Ask need a connection.
              </p>
            )}
            {screen}
          </div>
        </main>
      </div>

      <MobileTabBar current={current} />
    </div>
  )
}
