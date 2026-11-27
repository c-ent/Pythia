import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  LogOut,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import {
  devicesChanged,
  getDevices,
  getMcpTokenStatus,
  MAX_DEVICE_NAME,
  renameDevice,
  rotateMcpToken,
  signOutDevice,
  signOutEverywhere,
  type Device,
  type McpTokenStatus,
  type RotatedMcpToken,
} from '../../api/devices'
import { useClipboard } from '../../hooks/useClipboard'
import { useOnline } from '../../hooks/useOnline'
import { formatDate } from '../../repos/format'
import { claudeCodeCommand, formatLastSeen, MCP_TOOLS, mcpServerUrl } from './connect'

const CARD = 'rounded-card border border-line bg-surface p-4'
const BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50'
const DANGER_BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-danger px-4 text-sm font-semibold text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD =
  'block min-h-11 w-full min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 font-mono text-sm text-ink'
const DARK_BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control border border-nav-line px-4 text-sm font-medium text-nav-ink transition-colors hover:bg-nav-raised'
const DARK_CODE = 'rounded bg-nav-raised px-1 py-0.5 font-mono text-xs'

function errorMessage(error: unknown, what: string): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Try again.'
  return `Couldn’t ${what}. Try again.`
}

function CopyButton({ text, label, className = BUTTON }: { text: string; label: string; className?: string }) {
  const [state, copy] = useClipboard()
  return (
    <>
      <button type="button" onClick={() => copy(text)} aria-label={label} className={className}>
        {state === 'copied' ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  )
}

/** Settings › Connect devices (R15): the MCP server, its token, and the signed-in devices. */
export function ConnectSection({ onSignedOut }: { onSignedOut: () => void }) {
  const online = useOnline()
  return (
    <>
      <header>
        <h2 className="text-lg font-semibold">Connect devices</h2>
        <p className="mt-0.5 text-sm text-muted">
          Install the app on each device and connect AI tools through the MCP server.
        </p>
      </header>
      {online ? null : (
        <p className="flex items-center gap-2 rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
          <WifiOff aria-hidden="true" className="size-4 shrink-0" />
          You’re offline. Devices and the MCP token need a connection.
        </p>
      )}
      <McpServerCard online={online} />
      <DevicesCard online={online} onSignedOut={onSignedOut} />
    </>
  )
}

type TokenState =
  | { status: 'loading' }
  | { status: 'ready'; token: McpTokenStatus }
  | { status: 'error'; message: string }

function tokenNote(token: McpTokenStatus): string {
  if (token.source === 'none') return 'No token is set, so MCP clients are refused. Rotate makes one.'
  if (token.source === 'env') return 'This is the token from PYTHIA_MCP_TOKEN in .env. After the first rotation it stops working.'
  return token.rotatedAt === null ? 'Made by the last rotation.' : `Made on ${formatDate(token.rotatedAt)}.`
}

function McpServerCard({ online }: { online: boolean }) {
  const url = mcpServerUrl()
  const urlId = useId()
  const tokenId = useId()
  const [state, setState] = useState<TokenState>({ status: 'loading' })
  // The new token lives only here, in memory, until the page is left.
  const [fresh, setFresh] = useState<RotatedMcpToken | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [rotateError, setRotateError] = useState<string | null>(null)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getMcpTokenStatus(controller.signal).then(
      (token) => {
        if (!controller.signal.aborted) setState({ status: 'ready', token })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: errorMessage(error, 'load the token') }))
      },
    )
    return () => controller.abort()
  }, [online])

  const rotate = (): void => {
    setRotating(true)
    setRotateError(null)
    rotateMcpToken()
      .then(
        (rotated) => {
          setFresh(rotated)
          setConfirming(false)
          setState({ status: 'ready', token: { source: 'database', last4: rotated.last4, rotatedAt: rotated.rotatedAt } })
        },
        (error: unknown) => setRotateError(errorMessage(error, 'rotate the token')),
      )
      .finally(() => setRotating(false))
  }

  const token = state.status === 'ready' ? state.token : null
  const masked = token?.last4 == null ? '' : `${'•'.repeat(12)}${token.last4}`
  const command = claudeCodeCommand(url, fresh?.token)

  return (
    <>
      <section className={`space-y-4 ${CARD}`} aria-labelledby="mcp-heading">
        <div className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-4 text-muted" />
          <h3 id="mcp-heading" className="text-base font-medium">
            MCP server
          </h3>
        </div>

        <div>
          <label htmlFor={urlId} className="text-sm font-medium">
            Server URL
          </label>
          <div className="mt-1.5 flex gap-2">
            <input id={urlId} readOnly value={url} className={FIELD} onFocus={(event) => event.target.select()} />
            <CopyButton text={url} label="Copy server URL" />
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-control border border-line bg-raised p-3 text-sm">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
            <p>
              <span className="font-medium">Only over Tailscale.</span>{' '}
              <span className="text-muted">
                The web app is public through Tailscale Funnel, but this address answers MCP clients only on your
                tailnet. From anywhere else it returns 403, even with the right token.
              </span>
            </p>
          </div>
        </div>

        <div>
          <label htmlFor={tokenId} className="text-sm font-medium">
            Access token
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2 sm:flex-nowrap">
            <input
              id={tokenId}
              readOnly
              value={state.status === 'ready' ? (masked === '' ? 'Not set' : masked) : state.status === 'loading' ? '' : '—'}
              placeholder={state.status === 'loading' ? (online ? 'Loading…' : 'Needs a connection') : undefined}
              aria-describedby={`${tokenId}-note`}
              className={FIELD}
            />
            <button
              type="button"
              onClick={() => {
                setRotateError(null)
                setConfirming(true)
              }}
              disabled={!online || rotating || confirming}
              className={BUTTON}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Rotate
            </button>
          </div>
          <p id={`${tokenId}-note`} className="mt-1.5 text-sm text-muted">
            {state.status === 'error' ? state.message : token === null ? 'Only the last 4 characters are shown.' : tokenNote(token)}
          </p>
        </div>

        {confirming ? (
          <div role="alertdialog" aria-labelledby="rotate-heading" className="rounded-control border border-warning/40 bg-raised p-3">
            <p id="rotate-heading" className="flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              The current token stops working at once. Every MCP client needs the new one.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={rotate} disabled={!online || rotating} className={DANGER_BUTTON}>
                {rotating ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                Rotate now
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={rotating} className={BUTTON}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {rotateError === null ? null : (
          <p role="alert" className="text-sm text-danger">
            {rotateError}
          </p>
        )}

        {fresh === null ? null : (
          <div role="status" className="rounded-control border border-success/40 bg-raised p-3">
            <p className="text-sm font-medium">New token. Copy it now: it is not shown again.</p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={fresh.token}
                aria-label="New MCP token"
                className={FIELD}
                onFocus={(event) => event.target.select()}
              />
              <CopyButton text={fresh.token} label="Copy new token" />
            </div>
            <p className="mt-2 text-sm text-muted">The old token no longer works. The command below includes the new one.</p>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-card bg-nav p-4 text-nav-ink" aria-labelledby="claude-heading">
        <h3 id="claude-heading" className="text-base font-medium">
          Set up Claude Code on a computer
        </h3>
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>Install the Tailscale app and sign in to the same Tailscale account as this server.</li>
          <li>
            Check that this server shows up in Tailscale: run <code className={DARK_CODE}>tailscale status</code>, or
            look in the app’s device list.
          </li>
          <li>
            {fresh === null
              ? 'Run this command in a terminal, with your token in place of <your token>:'
              : 'Run this command in a terminal. It holds your new token, so don’t paste it anywhere public:'}
            <div className="mt-2 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-control bg-nav-raised p-3 font-mono text-xs leading-relaxed">
                {command}
              </pre>
              <CopyButton text={command} label="Copy Claude Code command" className={DARK_BUTTON} />
            </div>
          </li>
          <li>
            If Claude Code reports <span className="font-semibold">403</span>, the request did not go over Tailscale: turn
            Tailscale on and try again. If it reports <span className="font-semibold">401</span>, the token is wrong or
            was rotated: use the current one.
          </li>
        </ol>
        <p className="text-sm text-nav-muted">
          The command keeps the token in your Claude settings, not in a project folder, so it can’t end up in a commit.
          Phones and tablets need none of this: the web app works without Tailscale.
        </p>
      </section>

      <section className={CARD} aria-labelledby="tools-heading">
        <h3 id="tools-heading" className="text-base font-medium">
          Tools exposed
        </h3>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="rounded-full bg-raised px-2.5 py-1 font-mono text-xs">
              {tool.name}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted">
          list_repos and get_repo_overview are there only when repo indexing is set up. Locked notes come back as withheld
          text.
        </p>
      </section>
    </>
  )
}

type DevicesState = { status: 'loading' } | { status: 'ready'; devices: Device[] } | { status: 'error'; message: string }

/** This device first, then the most recently seen. */
function sortDevices(devices: Device[]): Device[] {
  return [...devices].sort((a, b) =>
    a.current !== b.current ? (a.current ? -1 : 1) : Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
  )
}

function DevicesCard({ online, onSignedOut }: { online: boolean; onSignedOut: () => void }) {
  const [state, setState] = useState<DevicesState>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getDevices(controller.signal).then(
      (devices) => {
        if (!controller.signal.aborted) setState({ status: 'ready', devices: sortDevices(devices) })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: errorMessage(error, 'load your devices') }))
      },
    )
    return () => controller.abort()
  }, [online, version])

  const changed = (): void => {
    setVersion((n) => n + 1)
    devicesChanged()
  }

  const signOut = (device: Device): void => {
    setActionError(null)
    setBusy(true)
    signOutDevice(device.id)
      .then(
        () => {
          // Signing out this device works like Sign out: back to Login.
          if (device.current) onSignedOut()
          else changed()
        },
        (error: unknown) => setActionError(errorMessage(error, `sign out ${device.name}`)),
      )
      .finally(() => setBusy(false))
  }

  const signOutAll = (): void => {
    setActionError(null)
    setBusy(true)
    signOutEverywhere()
      .then(onSignedOut, (error: unknown) => setActionError(errorMessage(error, 'sign out everywhere')))
      .finally(() => setBusy(false))
  }

  return (
    <section className={CARD} aria-labelledby="devices-heading">
      <div className="flex items-center gap-2">
        <MonitorSmartphone aria-hidden="true" className="size-4 text-muted" />
        <h3 id="devices-heading" className="text-base font-medium">
          Devices
        </h3>
      </div>
      <p className="mt-0.5 text-sm text-muted">Every browser signed in to Pythia. Signing one out ends its session at once.</p>

      {state.status === 'loading' ? (
        <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted">
          {online ? (
            <>
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Loading devices…
            </>
          ) : (
            'The device list needs a connection.'
          )}
        </p>
      ) : state.status === 'error' ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {state.message}
        </p>
      ) : state.devices.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No signed-in devices.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {state.devices.map((device) => (
            <DeviceRow
              key={`${device.id}:${device.name}`}
              device={device}
              online={online}
              busy={busy}
              onChanged={changed}
              onSignOut={() => signOut(device)}
            />
          ))}
        </ul>
      )}

      {actionError === null ? null : (
        <p role="alert" className="mt-3 text-sm text-danger">
          {actionError}
        </p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        {confirmAll ? (
          <div role="alertdialog" aria-labelledby="sign-out-all-heading">
            <p id="sign-out-all-heading" className="text-sm">
              Every device is signed out, this one too. You sign in again on each.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={signOutAll} disabled={!online || busy} className={DANGER_BUTTON}>
                {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                Sign out all devices
              </button>
              <button type="button" onClick={() => setConfirmAll(false)} disabled={busy} className={BUTTON}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmAll(true)} disabled={!online || busy} className={BUTTON}>
            <LogOut aria-hidden="true" className="size-4" />
            Sign out everywhere
          </button>
        )}
      </div>
    </section>
  )
}

function DeviceRow({
  device,
  online,
  busy,
  onChanged,
  onSignOut,
}: {
  device: Device
  online: boolean
  busy: boolean
  onChanged: () => void
  onSignOut: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const next = name.trim()
    if (next === '') {
      setError('Give the device a name.')
      return
    }
    if (next === device.name) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    renameDevice(device.id, next)
      .then(
        () => {
          setEditing(false)
          onChanged()
        },
        (failure: unknown) => {
          // Signed out on another device meanwhile: reload the list.
          if (failure instanceof ApiError && failure.status === 404) onChanged()
          else setError(errorMessage(failure, 'rename it'))
        },
      )
      .finally(() => setSaving(false))
  }

  if (editing) {
    return (
      <li className="py-3">
        <form onSubmit={submit} noValidate>
          <label htmlFor={inputId} className="text-sm font-medium">
            Device name
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2 sm:flex-nowrap">
            <input
              id={inputId}
              value={name}
              maxLength={MAX_DEVICE_NAME}
              autoComplete="off"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              className="block min-h-11 w-full min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink"
            />
            <button
              type="submit"
              disabled={!online || saving}
              className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setName(device.name)
                setError(null)
              }}
              disabled={saving}
              className={BUTTON}
            >
              Cancel
            </button>
          </div>
          {error === null ? null : (
            <p role="alert" className="mt-1.5 text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      </li>
    )
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="break-words">{device.name}</span>
          {device.current ? (
            <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-normal text-muted">This device</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-sm text-muted">
          Last seen <time dateTime={device.lastSeenAt}>{formatLastSeen(device.lastSeenAt)}</time>
          {' · '}signed in <time dateTime={device.createdAt}>{formatDate(device.createdAt)}</time>
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={!online || busy}
          aria-label={`Rename ${device.name}`}
          className={BUTTON}
        >
          <Pencil aria-hidden="true" className="size-4" />
          Rename
        </button>
        <button
          type="button"
          onClick={onSignOut}
          disabled={!online || busy}
          aria-label={`Sign out ${device.name}`}
          className={BUTTON}
        >
          <LogOut aria-hidden="true" className="size-4" />
          Sign out
        </button>
      </div>
    </li>
  )
}
