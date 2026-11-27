/**
 * One Ollama embed request at a time, with search queries ahead of indexing
 * (T51). Ollama on a CPU-only host works through requests one by one, so a
 * query sent while indexing runs used to queue behind every batch already
 * sent and time out. Through the gate a query waits for the request already
 * running at most: a waiting query always goes before the next index batch.
 * Index batches keep their order among themselves.
 */

export type EmbedPriority = 'query' | 'index'

export interface EmbedGate {
  /**
   * Runs `task` when the gate is free. If `signal` aborts while the task is
   * still waiting, it leaves the queue and the promise rejects with
   * `signal.reason`; once started, the task itself owns the signal.
   */
  run<T>(priority: EmbedPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

interface Waiter {
  start(): void
}

export function createEmbedGate(): EmbedGate {
  let busy = false
  const queries: Waiter[] = []
  const index: Waiter[] = []

  const next = (): void => {
    if (busy) return
    const waiter = queries.shift() ?? index.shift()
    if (waiter === undefined) return
    busy = true
    waiter.start()
  }

  return {
    run<T>(priority: EmbedPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason)
          return
        }
        const queue = priority === 'query' ? queries : index
        const onAbort = (): void => {
          const at = queue.indexOf(waiter)
          if (at < 0) return
          queue.splice(at, 1)
          reject(signal?.reason)
        }
        const waiter: Waiter = {
          start() {
            signal?.removeEventListener('abort', onAbort)
            Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(() => {
                busy = false
                next()
              })
          },
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(waiter)
        next()
      })
    },
  }
}

/** No gate: every request goes straight to Ollama (tests, the eval CLI). */
export const UNGATED: EmbedGate = {
  run: (_priority, task) => task(),
}
