import { useEffect, useState } from 'react'
import { GEMINI_CHANGED, getGeminiStatus } from '../api/gemini'

/**
 * Whether a Gemini key is in use, for the top bar's Gemini pill (R16), or
 * undefined until it is known. Reloads on reconnecting and after the key is
 * saved or removed. A failed load keeps the last value.
 */
export function useGeminiStatus(online: boolean): boolean | undefined {
  const [configured, setConfigured] = useState<boolean | undefined>(undefined)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChange = (): void => setVersion((n) => n + 1)
    window.addEventListener(GEMINI_CHANGED, onChange)
    return () => window.removeEventListener(GEMINI_CHANGED, onChange)
  }, [])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getGeminiStatus(controller.signal).then(
      (status) => {
        if (!controller.signal.aborted) setConfigured(status.configured)
      },
      () => {},
    )
    return () => controller.abort()
  }, [online, version])

  return configured
}
