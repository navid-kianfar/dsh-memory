/**
 * The Memory view's state: which pane it is on, what it is filtered to, what it is editing, and the
 * notice line.
 *
 * A plain observable rather than React state, because the view is a conversation tab: switching to
 * Chat unmounts it, and a filter typed a second ago should still be there when the tab comes back.
 * One controller per session — the tab is session-scoped, and two sessions on two projects sharing a
 * category filter would each be filtering by the other's last choice.
 *
 * @module @achasoft/dsh-memory/client/controller
 */

import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'

/** Which pane of the Memory view is showing. */
export type MemoryPane = 'memories' | 'rules' | 'sessions'

/** The dialog's state: closed, composing a new memory, or editing an existing one. */
export type EditorState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create', readonly category: MemoryCategoryWire }
  | { readonly kind: 'edit', readonly memory: MemoryView }

/** A transient message shown under the view's toolbar. */
export interface Notice {
  readonly id: number
  readonly tone: 'info' | 'error'
  readonly text: string
}

/** Everything the view renders from. */
export interface ManagerState {
  readonly pane: MemoryPane
  readonly editor: EditorState
  /** The live search box text; empty means the listing rather than a ranked search. */
  readonly query: string
  readonly category: MemoryCategoryWire | undefined
  readonly status: MemoryStatusWire | 'all'
  readonly notice: Notice | undefined
  /** Bumped to make the panel refetch without changing any filter. */
  readonly revision: number
  /** The memory whose audit trail is expanded, if any. */
  readonly tracing: string | undefined
}

/** The view as it first opens: on the memories pane, unfiltered. */
const INITIAL: ManagerState = {
  pane: 'memories',
  editor: { kind: 'closed' },
  query: '',
  category: undefined,
  status: 'active',
  notice: undefined,
  revision: 0,
  tracing: undefined,
}

/** Holds one session's view state and notifies its subscribers. */
export class MemoryController {
  #state: ManagerState = INITIAL
  readonly #listeners = new Set<() => void>()
  #nextNoticeId = 1

  /**
   * Current state.
   * @returns the snapshot; its identity changes only when something actually moved.
   */
  getSnapshot(): ManagerState {
    return this.#state
  }

  /**
   * Subscribe to state changes.
   * @param listener - called after every commit.
   * @returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Replace the state and notify, unless nothing moved.
   * @param next - the new state.
   */
  #commit(next: ManagerState): void {
    if (next === this.#state) return
    this.#state = next
    for (const listener of this.#listeners) listener()
  }

  /**
   * Switch panes, clearing the filters that do not apply to the new one.
   * @param pane - the pane to show.
   */
  setPane(pane: MemoryPane): void {
    if (pane === this.#state.pane) return
    this.#commit({ ...this.#state, pane, editor: { kind: 'closed' }, tracing: undefined, category: undefined })
  }

  /**
   * Set the search box text. An empty query means the listing rather than a ranked search.
   * @param query - the raw text.
   */
  setQuery(query: string): void {
    this.#commit({ ...this.#state, query })
  }

  /**
   * Restrict the listing to one category, or clear the restriction.
   * @param category - the category, or undefined for all.
   */
  setCategory(category: MemoryCategoryWire | undefined): void {
    this.#commit({ ...this.#state, category })
  }

  /**
   * Choose which lifecycle states the listing shows.
   * @param status - one status, or `all`.
   */
  setStatus(status: MemoryStatusWire | 'all'): void {
    this.#commit({ ...this.#state, status })
  }

  /**
   * Open the dialog on a new memory.
   * @param category - the category the form starts on.
   */
  compose(category: MemoryCategoryWire): void {
    this.#commit({ ...this.#state, editor: { kind: 'create', category } })
  }

  /**
   * Open the dialog on an existing memory.
   * @param memory - the memory to edit.
   */
  edit(memory: MemoryView): void {
    this.#commit({ ...this.#state, editor: { kind: 'edit', memory } })
  }

  /** Close the dialog without saving. */
  closeEditor(): void {
    if (this.#state.editor.kind === 'closed') return
    this.#commit({ ...this.#state, editor: { kind: 'closed' } })
  }

  /**
   * Expand or collapse one memory's audit trail.
   * @param id - the memory to trace, or the one already tracing to collapse it.
   */
  toggleTrace(id: string): void {
    this.#commit({ ...this.#state, tracing: this.#state.tracing === id ? undefined : id })
  }

  /** Refetch without changing a filter, after a write or on demand. */
  refresh(): void {
    this.#commit({ ...this.#state, revision: this.#state.revision + 1 })
  }

  /**
   * Show a transient message under the toolbar.
   * @param tone - `info` for a completed action, `error` for one that failed.
   * @param text - the message.
   */
  notify(tone: Notice['tone'], text: string): void {
    this.#commit({ ...this.#state, notice: { id: this.#nextNoticeId++, tone, text } })
  }

  /**
   * Withdraw a notice, unless a newer one replaced it in the meantime.
   * @param id - the notice to withdraw.
   */
  dismissNotice(id: number): void {
    if (this.#state.notice?.id !== id) return
    this.#commit({ ...this.#state, notice: undefined })
  }
}
