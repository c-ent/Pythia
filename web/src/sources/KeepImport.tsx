import { CheckCircle2, FileArchive, LoaderCircle, TriangleAlert, Upload } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'
import { importKeepZip, type KeepImportResult } from '../api/imports'
import { plural } from '../repos/format'
import { importErrorMessage, importSummary } from '../screens/importMessages'

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; result: KeepImportResult }
  | { status: 'error'; message: string }

/** Anchor of the import form, for the Keep card's "Import a zip" link. */
export const KEEP_IMPORT_ID = 'keep-import'

/**
 * The Google Keep Takeout upload (R5), moved from the old Import page onto
 * Sources and sync. `onImported` runs after a successful import.
 */
export function KeepImport({ online, onImported }: { online: boolean; onImported: () => void }) {
  const inputId = useId()
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [upload, setUpload] = useState<UploadState>({ status: 'idle' })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (file === null || upload.status === 'uploading') return
    setUpload({ status: 'uploading' })
    importKeepZip(file)
      .then((result) => {
        setUpload({ status: 'done', result })
        setFile(null)
        if (input.current !== null) input.current.value = ''
        onImported()
      })
      .catch((error: unknown) => setUpload({ status: 'error', message: importErrorMessage(error) }))
  }

  const busy = upload.status === 'uploading'

  return (
    <section
      id={KEEP_IMPORT_ID}
      tabIndex={-1}
      aria-labelledby={`${inputId}-heading`}
      className="scroll-mt-4 rounded-card border border-line bg-surface p-4 outline-none"
    >
      <h2 id={`${inputId}-heading`} className="text-base font-semibold">
        Import a file
      </h2>
      <div className="mt-3 rounded-control border border-dashed border-line bg-raised/50 p-4 text-center">
        <FileArchive aria-hidden="true" className="mx-auto size-6 text-muted" />
        <p id={hintId} className="mt-2 text-sm text-muted">
          The Google Keep <span className="font-mono">.zip</span> from Google Takeout. Each upload replaces all Keep
          notes. Like Obsidian notes, Keep notes can be used by Gemini to answer questions.
        </p>
      </div>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className="sr-only">
          Keep Takeout zip
        </label>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".zip,application/zip"
          aria-describedby={hintId}
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setUpload({ status: 'idle' })
          }}
          className="min-h-11 max-w-full min-w-0 flex-1 text-sm text-muted file:mr-3 file:min-h-11 file:rounded-control file:border file:border-line file:bg-raised file:px-4 file:text-sm file:font-medium file:text-ink"
        />
        <button
          type="submit"
          disabled={file === null || busy || !online}
          className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-medium text-on-accent transition-opacity disabled:opacity-50"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Upload aria-hidden="true" className="size-4" />
          )}
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>
      {!online ? <p className="mt-3 text-sm text-muted">You’re offline. Importing needs a connection.</p> : null}
      <div aria-live="polite">
        {upload.status === 'done' ? (
          <p className="mt-3 flex items-start gap-2 text-sm text-ink">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-ink" />
            <span>
              {importSummary(upload.result)}
              {upload.result.failed > 0
                ? ` ${plural(upload.result.failed, 'note')} could not be indexed and will be retried on the next import.`
                : ''}
            </span>
          </p>
        ) : null}
        {upload.status === 'uploading' ? (
          <p className="mt-3 text-sm text-muted">Reading and indexing notes. Large exports take a few minutes.</p>
        ) : null}
      </div>
      {upload.status === 'error' ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {upload.message}
        </p>
      ) : null}
    </section>
  )
}
