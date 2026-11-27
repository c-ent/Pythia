import { useEffect, useState } from 'react'
import { DEVICES_CHANGED, getDevices } from '../api/devices'

/**
 * The number of signed-in devices for the top bar (R15), or undefined until it
 * is known. Reloads on reconnecting and after a device is renamed or signed out.
 * A failed load keeps the last count.
 */
export function useDeviceCount(online: boolean): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChange = (): void => setVersion((n) => n + 1)
    window.addEventListener(DEVICES_CHANGED, onChange)
    return () => window.removeEventListener(DEVICES_CHANGED, onChange)
  }, [])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getDevices(controller.signal).then(
      (devices) => {
        if (!controller.signal.aborted) setCount(devices.length)
      },
      () => {},
    )
    return () => controller.abort()
  }, [online, version])

  return count
}
