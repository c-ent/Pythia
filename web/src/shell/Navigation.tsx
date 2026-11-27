import { KeyRound, PanelLeftClose, PanelLeftOpen, SquarePen, Upload } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RecentQueryKind } from '../api/recent'
import { BrandMark } from '../components/BrandMark'
import { followLink, pathFor, settingsPath, type RouteName } from '../router'
import { NAV, TAB_BAR } from './nav'
import { shortcutLabel, startNewSearch } from './newSearch'
import { OfflineCard, OfflineRailButton } from './OfflineCard'
import { RecentQueries } from './RecentQueries'
import { Avatar, OnlinePill } from './TopBar'

/** `aria-current` for a nav item: "page" on its screen, "true" while a document is open over it. */
export type CurrentFor = (route: RouteName) => 'page' | 'true' | undefined

// The navigation is dark in both themes, so its focus ring is lime.
const NAV_FOCUS = '[&_:focus-visible]:outline-accent'

const ICON_BUTTON =
  'size-11 shrink-0 items-center justify-center rounded-control text-nav-muted transition-colors hover:bg-nav-raised hover:text-nav-ink'

function AppLink({
  path,
  current,
  label,
  className,
  children,
}: {
  path: string
  current?: 'page' | 'true'
  label?: string
  className: string
  children: ReactNode
}) {
  return (
    <a
      href={path}
      onClick={(event) => followLink(event, path)}
      aria-current={current}
      aria-label={label}
      className={className}
    >
      {children}
    </a>
  )
}

const SIDEBAR_LINK =
  'flex min-h-11 items-center gap-3 rounded-control px-3 text-sm text-nav-muted transition-colors hover:bg-nav-raised hover:text-nav-ink aria-[current]:bg-nav-raised aria-[current]:font-medium aria-[current]:text-nav-ink'

/** Desktop (lg): logo, New search, the main nav, recent searches or questions, then Gemini access and Import Keep. */
export function Sidebar({
  className,
  current,
  pinned,
  recentKind,
  online,
  onCollapse,
}: {
  className: string
  current: CurrentFor
  pinned: number
  /** Recent questions on the Ask page, recent searches everywhere else. */
  recentKind: RecentQueryKind
  online: boolean
  onCollapse: () => void
}) {
  return (
    <aside
      aria-label="Sidebar"
      data-layout="desktop"
      className={`${className} sticky top-3 h-[calc(100dvh-1.5rem)] w-62 shrink-0 flex-col self-start overflow-y-auto px-1 text-nav-ink ${NAV_FOCUS}`}
    >
      <div className="flex items-center justify-between gap-2 py-1 pl-2">
        <AppLink path={pathFor('search')} className="flex items-center gap-2.5 rounded-control">
          <BrandMark className="size-9" />
          <span className="text-lg font-semibold tracking-tight">Pythia</span>
        </AppLink>
        <button
          id="sidebar-collapse"
          type="button"
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className={`inline-flex ${ICON_BUTTON}`}
        >
          <PanelLeftClose aria-hidden="true" className="size-5" />
        </button>
      </div>

      <button
        type="button"
        onClick={startNewSearch}
        className="mt-4 flex min-h-11 items-center gap-3 rounded-control border border-nav-line bg-nav-raised px-3 text-sm font-medium text-nav-ink transition-colors hover:border-nav-muted"
      >
        <SquarePen aria-hidden="true" className="size-5" />
        <span className="flex-1 text-left">New search</span>
        <kbd className="rounded-md border border-nav-line px-1.5 py-0.5 font-sans text-xs text-nav-muted">
          {shortcutLabel()}
        </kbd>
      </button>

      <nav aria-label="Main" className="mt-4">
        <ul className="space-y-1">
          {NAV.map(({ route, label, icon: Icon }) => (
            <li key={route}>
              <AppLink path={pathFor(route)} current={current(route)} className={SIDEBAR_LINK}>
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                <span className="flex-1">{label}</span>
                {route === 'pinned' && pinned > 0 ? (
                  <span className="text-xs font-normal text-nav-muted">{pinned} offline</span>
                ) : null}
              </AppLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Takes the free height and scrolls itself; the rest of the sidebar stays fixed. */}
      <RecentQueries key={recentKind} kind={recentKind} online={online} />

      <OfflineCard online={online} pinned={pinned} />

      <ul className="mt-6 space-y-1 border-t border-nav-line py-3">
        <li>
          <AppLink path={settingsPath('gemini')} className={SIDEBAR_LINK}>
            <KeyRound aria-hidden="true" className="size-5 shrink-0" />
            Gemini access
          </AppLink>
        </li>
        <li>
          <AppLink path={pathFor('sources')} className={SIDEBAR_LINK}>
            <Upload aria-hidden="true" className="size-5 shrink-0" />
            Import Keep
          </AppLink>
        </li>
      </ul>
    </aside>
  )
}

const RAIL_LINK =
  'flex h-15.5 w-16 flex-col items-center justify-center gap-1 rounded-[1.125rem] text-[0.72rem] font-medium text-nav-muted transition-colors hover:bg-nav-raised hover:text-nav-ink aria-[current]:bg-nav-raised aria-[current]:font-semibold aria-[current]:text-nav-ink'

/** Tablet (md to lg), and desktop with the sidebar collapsed: an icon rail. */
export function Rail({
  className,
  current,
  collapsed,
  online,
  onExpand,
}: {
  className: string
  current: CurrentFor
  collapsed: boolean
  online: boolean
  onExpand: () => void
}) {
  return (
    <aside
      aria-label="Sidebar"
      data-layout="tablet"
      className={`${className} sticky top-3 h-[calc(100dvh-1.5rem)] w-18 shrink-0 flex-col items-center self-start overflow-y-auto py-1 text-nav-ink ${NAV_FOCUS}`}
    >
      <AppLink path={pathFor('search')} label="Pythia home" className="rounded-control">
        <BrandMark className="size-11" />
      </AppLink>
      {collapsed ? (
        <button
          id="sidebar-expand"
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className={`mt-2 hidden lg:inline-flex ${ICON_BUTTON}`}
        >
          <PanelLeftOpen aria-hidden="true" className="size-5" />
        </button>
      ) : null}
      <nav aria-label="Main" className="mt-5">
        <ul className="flex flex-col gap-1.5">
          {NAV.map(({ route, label, icon: Icon }) => (
            <li key={route}>
              <AppLink path={pathFor(route)} current={current(route)} className={RAIL_LINK}>
                <Icon aria-hidden="true" className="size-5" />
                {label}
              </AppLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1" />
      <OfflineRailButton online={online} />
      <Avatar className="mt-4 mb-1" />
    </aside>
  )
}

/** Phones (below md): logo, Online pill and avatar. */
export function MobileTopBar({ online, reachable }: { online: boolean; reachable?: boolean }) {
  return (
    <header
      data-layout="mobile-top"
      className="flex items-center justify-between gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2 md:hidden"
    >
      <AppLink path={pathFor('search')} className="flex items-center gap-2.5 rounded-control">
        <BrandMark className="size-9" />
        <span className="text-xl font-semibold tracking-tight">Pythia</span>
      </AppLink>
      <div className="flex items-center gap-2">
        <OnlinePill online={online} reachable={reachable} />
        <Avatar />
      </div>
    </header>
  )
}

const TAB_LINK =
  'flex h-13 flex-col items-center justify-center gap-0.5 rounded-full text-xs text-nav-muted transition-colors hover:text-nav-ink aria-[current]:bg-accent aria-[current]:font-semibold aria-[current]:text-on-accent'

/** Phones: the floating tab bar, clear of the iPhone home indicator. */
export function MobileTabBar({ current }: { current: CurrentFor }) {
  return (
    <nav
      aria-label="Main"
      data-layout="mobile"
      className={`fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20 rounded-full bg-nav p-1.5 shadow-[0_10px_28px_rgb(15_15_16/0.28)] md:hidden ${NAV_FOCUS}`}
    >
      <ul className="grid grid-cols-5 gap-1">
        {TAB_BAR.map(({ route, label, icon: Icon }) => (
          <li key={route}>
            <AppLink path={pathFor(route)} current={current(route)} className={TAB_LINK}>
              <Icon aria-hidden="true" className="size-5" />
              {label}
            </AppLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
