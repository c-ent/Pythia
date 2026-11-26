import { MonitorSmartphone, UserRound } from 'lucide-react'
import { useProfile } from '../profile/profile'
import { plural } from '../repos/format'
import { followLink, settingsPath } from '../router'

export function OnlinePill({ online }: { online: boolean }) {
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-full bg-surface/75 px-3.5 text-sm text-ink">
      <span aria-hidden="true" className={`size-2 rounded-full ${online ? 'bg-success' : 'bg-warning'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

/** The owner's initial (a person icon until Profile has a name); opens Profile. */
export function Avatar({ name, className = '' }: { name?: string; className?: string }) {
  const saved = useProfile().displayName
  const initial = (name ?? saved).trim().charAt(0).toUpperCase()
  const path = settingsPath('profile')
  return (
    <a
      href={path}
      onClick={(event) => followLink(event, path)}
      aria-label="Profile"
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-135 from-glow-pink to-glow-lavender text-base font-semibold text-ink ${className}`}
    >
      {initial === '' ? <UserRound aria-hidden="true" className="size-5" /> : initial}
    </a>
  )
}

/**
 * The main panel's top bar, from md up. The source picker, the device count
 * and the Gemini pill show placeholders until their data exists.
 */
export function TopBar({
  online,
  devices,
  gemini,
  name,
}: {
  online: boolean
  devices?: number
  gemini?: boolean
  name?: string
}) {
  const devicesPath = settingsPath('devices')
  return (
    <header
      data-layout="topbar"
      className="hidden flex-wrap items-center justify-between gap-3 px-7 pt-5 pb-3 md:flex"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex min-h-11 items-center rounded-control bg-surface/70 px-3.5 text-base font-semibold">
          All sources
        </span>
        <a
          href={devicesPath}
          onClick={(event) => followLink(event, devicesPath)}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink hover:underline"
        >
          <MonitorSmartphone aria-hidden="true" className="size-4" />
          {devices === undefined ? 'Personal index' : `Personal index · ${plural(devices, 'device')}`}
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <OnlinePill online={online} />
        {gemini === undefined ? null : (
          <span className="inline-flex h-9 items-center rounded-full bg-surface/75 px-3.5 text-sm text-ink">
            {gemini ? 'Gemini on' : 'Gemini off'}
          </span>
        )}
        <Avatar name={name} />
      </div>
    </header>
  )
}
