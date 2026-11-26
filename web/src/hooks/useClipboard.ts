import { useCallback, useEffect, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies text to the clipboard. The state reads `copied` or `failed` for two
 * seconds, then goes back to `idle`. `navigator.clipboard` exists only in
 * secure contexts (HTTPS, localhost); without it the copy fails.
 */
export function useClipboard(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [state])

  const copy = useCallback((text: string): void => {
    const clipboard = typeof navigator.clipboard?.writeText === 'function' ? navigator.clipboard : null
    if (clipboard === null) {
      setState('failed')
      return
    }
    clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  }, [])

  return [state, copy]
}
