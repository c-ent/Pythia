import { ScreenHeader } from '../components/Screen'
import { ScrollRow } from '../components/ScrollRow'
import { followLink, SETTINGS_SECTIONS, settingsPath, type SettingsSection } from '../router'
import { SETTINGS_SECTION_LABELS } from '../shell/nav'
import { ConnectSection } from './settings/ConnectSection'
import { GeminiSection } from './settings/GeminiSection'
import { ProfileSection } from './settings/ProfileSection'

/**
 * Settings opens one section at a time, each at `/settings/<section>`. Offline
 * storage moved to the Pinned page (T45); `/settings/storage` redirects there.
 */
export function SettingsScreen({ section, onSignOut }: { section: SettingsSection; onSignOut: () => void }) {
  return (
    <>
      <ScreenHeader title="Settings" />
      <nav aria-label="Settings" className="mb-5">
        {/* One line of tabs; on narrow screens it scrolls sideways with faded edges, no scrollbar. */}
        <ScrollRow className="-m-1 p-1">
          <ul className="flex w-max gap-1.5">
            {SETTINGS_SECTIONS.map((item) => {
              const path = settingsPath(item)
              return (
                <li key={item} className="shrink-0">
                  <a
                    href={path}
                    onClick={(event) => followLink(event, path)}
                    aria-current={item === section ? 'page' : undefined}
                    className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm whitespace-nowrap text-muted transition-colors hover:text-ink aria-[current]:border-strong aria-[current]:bg-strong aria-[current]:text-on-strong"
                  >
                    {SETTINGS_SECTION_LABELS[item]}
                  </a>
                </li>
              )
            })}
          </ul>
        </ScrollRow>
      </nav>
      <div className="space-y-4">
        {section === 'profile' ? <ProfileSection onSignOut={onSignOut} /> : null}
        {section === 'gemini' ? <GeminiSection /> : null}
        {section === 'devices' ? <ConnectSection onSignedOut={onSignOut} /> : null}
      </div>
    </>
  )
}
