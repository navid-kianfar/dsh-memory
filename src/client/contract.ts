/**
 * The browser half's own contract: what each registration injects into its component, and the full
 * props those components receive.
 *
 * Kept separate from the components so the render side and the wiring side can be read against each
 * other, and so a component's props stay one named type rather than an inline intersection repeated
 * at its definition and at every test.
 *
 * @module @achasoft/dsh-memory/client/contract
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merges of the three slots these entries occupy.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { MemoryKey } from './locales.ts'
import type { MemoryController, MemoryTab } from './controller.ts'
import type {
  MemoryCategoryWire, MemoryCreateRequest, MemoryEmbedResult, MemoryExportResult, MemoryImportResult,
  MemoryListRequest, MemoryListResult, MemoryOverviewResult, MemoryProvenanceResult,
  MemorySearchRequest, MemorySearchResult, MemorySessionsResult, MemorySettings, MemoryStatusWire,
  MemoryUpdateRequest, MemoryView, MemoryWriteResult,
} from '../host/types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the sidebar trigger, the manager overlay, and the settings card. */
    memory: MemoryKey
  }
}

/** The locale namespace this plugin owns; the Host joins its settings card on the same name. */
export const LOCALE_NS = 'memory'

/** Everything the sidebar trigger needs. */
export interface TriggerInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The manager's shared state; the trigger reads whether it is open and writes the toggle. */
    manager: MemoryController
  }
  /** Show or hide the manager for the workspace the sidebar is currently on. */
  toggle: () => void
}

/** Full props of the sidebar-foot trigger. */
export type MemoryTriggerProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'memory'> & InjectFace<TriggerInjected>

/**
 * The manager's own verbs.
 *
 * Flat members rather than the controller itself: `InjectFace` turns the `hooks` compartment into
 * `use<Name>` selector props and passes everything else through untouched, so a component reads
 * state through the hook and changes it through these — it never holds the store. That is what lets
 * every component here render in a test with no controller at all.
 */
export interface ManagerActions {
  /** Hide the manager. */
  close: () => void
  /** Refetch without changing a filter. */
  refresh: () => void
  /** Switch tabs. */
  setTab: (tab: MemoryTab) => void
  /** Set the search box text; empty means the listing rather than a ranked search. */
  setQuery: (query: string) => void
  /** Restrict the listing to one category, or clear the restriction. */
  setCategory: (category: MemoryCategoryWire | undefined) => void
  /** Choose which lifecycle states the listing shows. */
  setStatus: (status: MemoryStatusWire | 'all') => void
  /** Open the editor on a new memory of one category. */
  compose: (category: MemoryCategoryWire) => void
  /** Open the editor on an existing memory. */
  edit: (memory: MemoryView) => void
  /** Close the editor without saving. */
  closeEditor: () => void
  /** Expand or collapse one memory's audit trail. */
  toggleTrace: (id: string) => void
  /** Show a transient message under the header. */
  notify: (tone: 'info' | 'error', text: string) => void
  /** Withdraw a notice, unless a newer one replaced it. */
  dismissNotice: (id: number) => void
}

/** Everything the manager overlay needs. */
export interface ManagerInjected extends ManagerActions {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The manager's shared state: which tab, which filters, what is being edited. */
    manager: MemoryController
  }
  /**
   * Read the project's overview: counts, rules, where the database lives, whether it is enforcing.
   * @returns the overview, or a returned failure.
   */
  describe: () => Promise<MemoryOverviewResult>
  /**
   * Read a filtered page of memories.
   * @param request - the filters and paging.
   * @returns the page, or a returned failure.
   */
  list: (request: MemoryListRequest) => Promise<MemoryListResult>
  /**
   * Rank memories against the search box.
   * @param request - the query and its filters.
   * @param signal - cancellation for the search.
   * @returns the ranked hits, or a returned failure.
   */
  search: (request: MemorySearchRequest, signal: AbortSignal) => Promise<MemorySearchResult>
  /**
   * Write a new memory.
   * @param request - the memory to store.
   * @returns the stored memory, or a returned failure.
   */
  create: (request: MemoryCreateRequest) => Promise<MemoryWriteResult>
  /**
   * Apply an edit.
   * @param request - the fields to change.
   * @returns the updated memory, or a returned failure.
   */
  update: (request: MemoryUpdateRequest) => Promise<MemoryWriteResult>
  /**
   * Archive a memory, or remove it and its audit trail permanently.
   * @param id - the memory.
   * @param hard - true removes it permanently; false archives it.
   * @returns whether the rule set changed, or a returned failure.
   */
  discard: (id: string, hard: boolean) => Promise<{ rulesChanged: boolean } | { error: string }>
  /**
   * Read the project's recent sessions.
   * @returns the sessions, or a returned failure.
   */
  sessions: () => Promise<MemorySessionsResult>
  /**
   * Read one memory's audit trail.
   * @param id - the memory to trace.
   * @returns the entries, or a returned failure.
   */
  provenance: (id: string) => Promise<MemoryProvenanceResult>
  /**
   * Import an instructions file the user picked.
   * @param text - the file's contents.
   * @param source - the file name, recorded as each imported memory's source.
   * @returns what was created, or a returned failure.
   */
  importInstructions: (text: string, source: string) => Promise<MemoryImportResult>
  /**
   * Export every memory as portable JSON.
   * @returns the document, or a returned failure.
   */
  exportAll: () => Promise<MemoryExportResult>
  /**
   * Embed everything still missing a vector.
   * @returns what the pass did, or a returned failure.
   */
  reembed: () => Promise<MemoryEmbedResult>
}

/** Full props of the manager overlay. */
export type MemoryManagerProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'memory'> & InjectFace<ManagerInjected>

/** Everything the settings card needs. */
export interface SettingsCardInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The bound `memory` settings scope: resolved value, layers, revision, and writability. */
    settings: SettingsScope<MemorySettings>
  }
  /**
   * Read the project's overview for the card's status line.
   * @returns the overview, or a returned failure.
   */
  describe: () => Promise<MemoryOverviewResult>
  /**
   * Store one field of the `memory` section; the bound scope owns revision fencing.
   * @param field - the field name inside the namespace.
   * @param value - the JSON-shaped value the control produced.
   * @returns settlement after the write.
   */
  setField: (field: string, value: unknown) => Promise<void>
  /**
   * Clear one optional field back to the composition layer.
   * @param field - the field name inside the namespace.
   * @returns settlement after the write.
   */
  unsetField: (field: string) => Promise<void>
  /** Open the memory manager, so the card is a way in rather than a dead end. */
  openManager: () => void
}

/** Full props of the settings card. */
export type MemorySettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'memory'> & InjectFace<SettingsCardInjected>
