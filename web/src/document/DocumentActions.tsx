import { Check, Copy, ExternalLink } from 'lucide-react'
import { useClipboard } from '../hooks/useClipboard'
import { useProfile } from '../profile/profile'
import { obsidianUrl } from './format'

// Copy path and Open in Obsidian, shared by the Document screen and the
// search preview pane (R4, R6).

/** The file path with a button that copies it. */
export function CopyPath({ path }: { path: string }) {
  const [copy, copyText] = useClipboard()
  const onCopy = (): void => copyText(path)

  return (
    <div className="mt-2 flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-muted" title={path}>
        {path}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy file path"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        {copy === 'copied' ? (
          <Check aria-hidden="true" className="size-4 text-success" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copy === 'copied' ? 'Path copied' : copy === 'failed' ? 'Couldn’t copy the path' : ''}
      </span>
    </div>
  )
}

/** Opens the note in the Obsidian app; nothing without a vault name in Profile or for non-Obsidian documents. */
export function OpenInObsidian({ doc }: { doc: { source: { kind: string }; path: string } }) {
  const url = obsidianUrl(useProfile().vaultName, doc)
  if (url === null) return null
  return (
    <a
      href={url}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line px-3 text-sm font-medium text-ink transition-colors hover:bg-raised"
    >
      <ExternalLink aria-hidden="true" className="size-4" />
      Open in Obsidian
    </a>
  )
}
