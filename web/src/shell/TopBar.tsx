import { MonitorSmartphone, UserRound } from 'lucide-react'
import type { ServerHealth } from '../api/status'
import { useProfile } from '../profile/profile'
import { plural } from '../repos/format'
import { followLink, settingsPath } from '../router'
import { StatusMenu } from './StatusMenu'

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
 * The main panel's top bar, from md up. Shows the source label, device count,
 * unified status menu (connectivity, server health, API keys), and avatar.
 */
export function TopBar({
  online,
  reachable,
  health,
  brokenChecks,
  devices,
  gemini,
  checkedAt,
  name,
}: {
  online: boolean
  /** From `GET /api/status`; undefined until it answers or fails. */
  reachable?: boolean
  health?: ServerHealth
  brokenChecks?: readonly string[]
  devices?: number
  gemini?: boolean
  checkedAt?: string
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
        <StatusMenu
          online={online}
          reachable={reachable}
          health={health}
          brokenChecks={brokenChecks}
          gemini={gemini}
          checkedAt={checkedAt}
        />
        <Avatar name={name} />
      </div>
    </header>
  )
}
