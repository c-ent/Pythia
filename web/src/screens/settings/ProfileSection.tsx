import { ChevronRight, Database, LoaderCircle, LogOut, WifiOff } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import { MAX_DISPLAY_NAME, MAX_VAULT_NAME, type OpeningMode, type Profile } from '../../api/profile'
import { useOnline } from '../../hooks/useOnline'
import { canonicalTimeZone, loadProfile, saveProfile, timeZoneNames, useProfile } from '../../profile/profile'
import { followLink, pathFor } from '../../router'
import { Avatar } from '../../shell/TopBar'
import { useThemeChoice } from '../../theme/theme'
import { ThemeSwitch } from '../../theme/ThemeSwitch'

const CARD = 'rounded-card border border-line bg-surface p-4'
const INPUT =
  'mt-1.5 block min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted'

function profileErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Try again.'
    if (error.status === 400) return `The server refused it: ${error.message}`
  }
  return 'Couldn’t save your profile. Try again.'
}

/** Settings › Profile (R17): the profile form, Sources and sync on phones, and Sign out. */
export function ProfileSection({ onSignOut }: { onSignOut: () => void }) {
  const profile = useProfile()
  const online = useOnline()
  const [loadFailed, setLoadFailed] = useState(false)
  const sources = pathFor('sources')

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    loadProfile(controller.signal).then(
      () => setLoadFailed(false),
      () => {
        if (!controller.signal.aborted) setLoadFailed(true)
      },
    )
    return () => controller.abort()
  }, [online])

  return (
    <>
      {loadFailed ? (
        <p role="status" className="rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
          Couldn’t load your profile from the server. Showing the copy saved on this device.
        </p>
      ) : null}
      {/* A new form whenever the saved profile changes (loaded, saved here or in another tab). */}
      <ProfileForm key={JSON.stringify(profile)} saved={profile} online={online} />

      {/* Phones have no Sources tab; it is reached from here. */}
      <a
        href={sources}
        onClick={(event) => followLink(event, sources)}
        className="flex min-h-11 items-center justify-between gap-3 rounded-card border border-line bg-surface p-4 transition-colors hover:bg-raised md:hidden"
      >
        <span className="flex items-center gap-2">
          <Database aria-hidden="true" className="size-4 text-muted" />
          <span className="text-base font-medium">Sources and sync</span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted" />
      </a>

      <section className={`flex flex-wrap items-center justify-between gap-3 ${CARD}`}>
        <div>
          <h2 className="text-base font-medium">Account</h2>
          <p className="mt-0.5 text-sm text-muted">Signing out ends this device’s session.</p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised"
        >
          <LogOut aria-hidden="true" className="size-4" />
          Sign out
        </button>
      </section>
    </>
  )
}

type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string }

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string, hintId?: string) => ReactNode }) {
  const id = useId()
  const hintId = hint === undefined ? undefined : `${id}-hint`
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id, hintId)}
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}

function ProfileForm({ saved, online }: { saved: Profile; online: boolean }) {
  const [displayName, setDisplayName] = useState(saved.displayName)
  const [timeZone, setTimeZone] = useState(saved.timeZone)
  const [vaultName, setVaultName] = useState(saved.vaultName)
  const [openingMode, setOpeningMode] = useState<OpeningMode>(saved.openingMode)
  const [notePreviews, setNotePreviews] = useState(saved.notePreviews)
  const [state, setState] = useState<SaveState>({ status: 'idle' })
  // The theme switch applies and keeps the choice on this device at once; Save sends it to the server.
  const theme = useThemeChoice()
  const zonesId = useId()
  const modeName = useId()
  const [zones] = useState(timeZoneNames)

  const changed =
    displayName.trim() !== saved.displayName ||
    timeZone.trim() !== saved.timeZone ||
    vaultName.trim() !== saved.vaultName ||
    theme !== saved.theme ||
    openingMode !== saved.openingMode ||
    notePreviews !== saved.notePreviews

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const zone = canonicalTimeZone(timeZone.trim())
    if (zone === null) {
      setState({ status: 'error', message: 'Pick a time zone from the list, like Asia/Taipei.' })
      return
    }
    setState({ status: 'saving' })
    try {
      // On success the saved profile changes and this form is replaced by a fresh one.
      await saveProfile({
        displayName: displayName.trim(),
        timeZone: zone,
        vaultName: vaultName.trim(),
        theme,
        openingMode,
        notePreviews,
      })
    } catch (error) {
      setState({ status: 'error', message: profileErrorMessage(error) })
    }
  }

  const saving = state.status === 'saving'

  return (
    <section className={CARD} aria-labelledby="profile-heading">
      <div className="flex items-center gap-3">
        <Avatar name={saved.displayName} className="size-12 text-lg" />
        <div className="min-w-0">
          <h2 id="profile-heading" className="text-base font-medium">
            Profile
          </h2>
          <p className="text-sm text-muted">Shared by every device you sign in on.</p>
        </div>
      </div>

      <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-5" noValidate>
        <Field label="Display name" hint="Shown in the greeting and as your initial. Leave empty for just “Hi”.">
          {(id, hintId) => (
            <input
              id={id}
              aria-describedby={hintId}
              value={displayName}
              maxLength={MAX_DISPLAY_NAME}
              autoComplete="nickname"
              onChange={(event) => setDisplayName(event.target.value)}
              className={INPUT}
            />
          )}
        </Field>

        <Field label="Time zone" hint="Used for dates and the greeting.">
          {(id, hintId) => (
            <>
              <input
                id={id}
                aria-describedby={hintId}
                value={timeZone}
                list={zones.length > 0 ? zonesId : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTimeZone(event.target.value)}
                className={INPUT}
              />
              {zones.length > 0 ? (
                <datalist id={zonesId}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              ) : null}
            </>
          )}
        </Field>

        <Field label="Obsidian vault name" hint="Used by Open in Obsidian. Leave empty to hide that button.">
          {(id, hintId) => (
            <input
              id={id}
              aria-describedby={hintId}
              value={vaultName}
              maxLength={MAX_VAULT_NAME}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setVaultName(event.target.value)}
              className={INPUT}
            />
          )}
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium">Theme</p>
          <ThemeSwitch />
          <p className="mt-1 text-sm text-muted">Applies on this device at once; Save keeps it for your other devices.</p>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Opening mode</legend>
          <div className="inline-flex rounded-control bg-raised p-1">
            {(
              [
                ['search', 'Search'],
                ['ask', 'Ask'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-control px-4 text-sm text-muted transition-colors hover:text-ink has-checked:bg-strong has-checked:text-on-strong has-focus-visible:outline-2 has-focus-visible:outline-accent-ink"
              >
                <input
                  type="radio"
                  name={modeName}
                  value={value}
                  checked={openingMode === value}
                  onChange={() => setOpeningMode(value)}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted">What the search box starts in.</p>
        </fieldset>

        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={notePreviews}
            onChange={(event) => setNotePreviews(event.target.checked)}
            className="size-5 accent-accent-ink"
          />
          <span className="text-sm">
            <span className="font-medium">Note previews in results</span>
            <span className="block text-muted">Show a snippet of each note under its title.</span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button
            type="submit"
            disabled={!online || saving || !changed}
            className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-5 text-sm font-semibold text-on-accent transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
            Save
          </button>
          {online ? null : (
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <WifiOff aria-hidden="true" className="size-4" />
              You’re offline. Profile changes need a connection.
            </p>
          )}
          {state.status === 'error' ? (
            <p role="alert" className="text-sm text-danger">
              {state.message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  )
}
