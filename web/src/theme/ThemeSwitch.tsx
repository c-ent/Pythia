import { Monitor, Moon, Sun } from 'lucide-react'
import { setThemeChoice, useThemeChoice, type ThemeChoice } from './theme'

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

/**
 * Light / Dark / System as a radio group in a segmented control. `onChange`
 * runs after the choice is saved on this device (Profile also saves it on the
 * server).
 */
export function ThemeSwitch({ onChange }: { onChange?: (choice: ThemeChoice) => void }) {
  const choice = useThemeChoice()
  return (
    <fieldset>
      <legend className="sr-only">Theme</legend>
      <div className="inline-flex rounded-control bg-raised p-1">
        {OPTIONS.map(({ value, label, Icon }) => (
          <label
            key={value}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-control px-3.5 text-sm text-muted transition-colors hover:text-ink has-checked:bg-strong has-checked:text-on-strong has-focus-visible:outline-2 has-focus-visible:outline-accent-ink"
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={choice === value}
              onChange={() => {
                setThemeChoice(value)
                onChange?.(value)
              }}
              className="sr-only"
            />
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
