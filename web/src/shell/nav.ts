import { Database, FolderGit2, Map, Pin, Search, Settings, Sparkles, type LucideIcon } from 'lucide-react'
import type { RouteName, SettingsSection } from '../router'

export type NavItem = { route: RouteName; label: string; icon: LucideIcon }

/** Main navigation, in the order of the desktop sidebar and the tablet rail. */
export const NAV: readonly NavItem[] = [
  { route: 'search', label: 'Search', icon: Search },
  { route: 'ask', label: 'Ask', icon: Sparkles },
  { route: 'repos', label: 'Repos', icon: FolderGit2 },
  { route: 'pinned', label: 'Pinned', icon: Pin },
  { route: 'map', label: 'Map', icon: Map },
  { route: 'sources', label: 'Sources', icon: Database },
  { route: 'settings', label: 'Settings', icon: Settings },
]

/** The phone tab bar has room for five; Sources and sync is reached from Settings. */
export const TAB_BAR: readonly NavItem[] = NAV.filter((item) => item.route !== 'sources' && item.route !== 'map')

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  profile: 'Profile',
  gemini: 'Gemini access',
  devices: 'Connect devices',
}

/** Whether the desktop sidebar is collapsed to the rail, kept on this device. */
export const SIDEBAR_KEY = 'pythia.sidebar'

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
  } catch {
    return false
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, 'collapsed')
    else localStorage.removeItem(SIDEBAR_KEY)
  } catch {
    // Private mode or storage full: the choice lasts until reload.
  }
}
