/**
 * The manager's cross-registration state: whether it is open, which tab it is on, what it is
 * editing, and the notice line.
 *
 * A plain observable rather than a cordis service — the sidebar trigger, the overlay, and the
 * settings card are the only readers, and a service key would be a public name for something
 * private to three registrations.
 *
 * @module @achasoft/dsh-memory/client/controller
 */

import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'

/** Which tab of the manager is showing. */
export type MemoryTab = 'memories' | 'rules' | 'sessions'

/** The editor's state: closed, composing a new memory, or editing an existing one. */
export type EditorState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create', readonly category: MemoryCategoryWire }
  | { readonly kind: 'edit', readonly memory: MemoryView }

/** A transient message shown under the manager's header. */
export interface Notice {
  readonly id: number
  readonly tone: 'info' | 'error'
  readonly text: string
}

/** Everything the manager renders from. */
export interface ManagerState {
  readonly open: boolean
  readonly tab: MemoryTab
  /** The project directory being managed; absent means the Host's default project. */
  readonly projectRoot: string | undefined
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

/** The manager as it opens: closed, on the memories tab, unfiltered. */
const INITIAL: ManagerState = {
  open: false,
  tab: 'memories',
  projectRoot: undefined,
  editor: { kind: 'closed' },
  query: '',
  category: undefined,
  status: 'active',
  notice: undefined,
  revision: 0,
  tracing: undefined,
}

/** Holds the manager's state and notifies its subscribers. */
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
   * Show the manager for one project.
   * @param projectRoot - the project directory to manage; absent uses the Host's default.
   */
  open(projectRoot: string | undefined): void {
    this.#commit({ ...this.#state, open: true, projectRoot, editor: { kind: 'closed' } })
  }

  /** Hide the manager, discarding an in-progress edit. */
  close(): void {
    if (!this.#state.open) return
    this.#commit({ ...this.#state, open: false, editor: { kind: 'closed' }, tracing: undefined })
  }

  /**
   * Show the manager, or hide it when it is already showing this project.
   * @param projectRoot - the project directory the trigger names.
   */
  toggle(projectRoot: string | undefined): void {
    if (this.#state.open && this.#state.projectRoot === projectRoot) { this.close(); return }
    this.open(projectRoot)
  }

  /**
   * Switch tabs, clearing the filters that do not apply to the new one.
   * @param tab - the tab to show.
   */
  setTab(tab: MemoryTab): void {
    if (tab === this.#state.tab) return
    this.#commit({ ...this.#state, tab, editor: { kind: 'closed' }, tracing: undefined, category: undefined })
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
   * Open the editor on a new memory.
   * @param category - the category the form starts on.
   */
  compose(category: MemoryCategoryWire): void {
    this.#commit({ ...this.#state, editor: { kind: 'create', category } })
  }

  /**
   * Open the editor on an existing memory.
   * @param memory - the memory to edit.
   */
  edit(memory: MemoryView): void {
    this.#commit({ ...this.#state, editor: { kind: 'edit', memory } })
  }

  /** Close the editor without saving. */
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
   * Show a transient message under the header.
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
