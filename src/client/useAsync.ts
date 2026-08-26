/**
 * Reading one Host endpoint into a component.
 *
 * Every panel in the manager does the same three things — start a request, abandon it when its
 * inputs change or the panel closes, and render loading, failed, and loaded distinctly — so the
 * three live here once. A superseded request is aborted rather than ignored: the Host's search can
 * spend an embedding call, and letting an abandoned keystroke finish would pay for a result nobody
 * will see.
 *
 * @module @achasoft/dsh-memory/client/useAsync
 */

import { useEffect, useState } from 'react'

/** What a read is doing right now. */
export type AsyncState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed', readonly message: string }
  | { readonly kind: 'loaded', readonly value: T }

/**
 * Run one cancellable read, re-running it whenever `deps` change.
 *
 * `active` gates the read entirely: a closed panel must not hold the Host open, and a tab nobody is
 * looking at must not refetch on every keystroke elsewhere in the manager.
 * @param read - the request, given the signal that aborts it.
 * @param deps - values whose change supersedes the in-flight request.
 * @param active - whether to read at all; false leaves the state loading and starts nothing.
 * @returns the current state.
 */
export function useAsync<T>(
  read: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  active = true,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ kind: 'loading' })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setState({ kind: 'loading' })
    read(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ kind: 'loaded', value }) },
      (error: unknown) => {
        // An abort is this effect superseding itself, not a failure the user should read about.
        if (controller.signal.aborted) return
        setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { controller.abort() }
    // The reader closes over the deps the caller declares; re-creating it every render is expected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, active])
  return state
}

/**
 * Delay a fast-changing value, so a search box does not spend a request per keystroke.
 * @param value - the live value.
 * @param delayMs - how long the value must hold still before it is reported.
 * @returns the settled value.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => { setSettled(value) }, delayMs)
    return () => { clearTimeout(timer) }
  }, [value, delayMs])
  return settled
}
