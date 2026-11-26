import { Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { Placeholder, ScreenHeader } from '../components/Screen'
import { followLink, pathFor, settingsPath } from '../router'

// Stand-in for the Pinned page (T45), so its address and nav item work from
// the new shell on.

function TextLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={path}
      onClick={(event) => followLink(event, path)}
      className="font-medium text-accent-ink underline underline-offset-4"
    >
      {children}
    </a>
  )
}

export function PinnedPlaceholder() {
  return (
    <>
      <ScreenHeader title="Pinned" description="Repos and notes kept on this device for offline search." />
      <Placeholder icon={Pin} title="The Pinned page is on its way">
        For now, pin repos on the <TextLink path={pathFor('repos')}>Repos</TextLink> page and check offline storage
        in <TextLink path={settingsPath('storage')}>Settings, Storage</TextLink>.
      </Placeholder>
    </>
  )
}
