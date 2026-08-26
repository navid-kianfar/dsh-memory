/**
 * Memory plugin, browser half. Three registrations over one Host endpoint: the sidebar-foot trigger,
 * the manager overlay it opens, and the memory card on the plugin settings tab.
 *
 * The three share one controller, which is why they are registered together rather than as separate
 * plugins: the trigger has to know whether the manager is open, and the settings card has to be able
 * to open it. That state is registrant-private — nothing outside this package reads it — so it lives
 * in a plain observable rather than behind a cordis service key.
 *
 * @module @achasoft/dsh-memory/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the SlotMap merges of the three slots these entries occupy.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The generated Host-for-Client contract for this plugin's own endpoint. Importing it here — rather
// than adding a row to the curated api-remotes assembly — is what keeps the capability a plugin: the
// namespace mounts and unmounts with this fiber, and no shipped source names `memory`.
import memoryRemote from '../../generated/typert.remote-client.js'
import type {
  MemoryCreateRequest, MemoryListRequest, MemorySearchRequest, MemorySettings, MemoryUpdateRequest,
} from '../host/types.ts'
import { LOCALE_NS, type ManagerInjected, type SettingsCardInjected, type TriggerInjected } from './contract.ts'
import { MemoryController } from './controller.ts'
import { MemoryManager } from './MemoryManager.tsx'
import { MemorySettingsCard } from './SettingsCard.tsx'
import { MemoryTrigger } from './MemoryTrigger.tsx'
import { en, zh } from './locales.ts'
import { resolveProjectRoot } from './project.ts'

export type { MemoryKey } from './locales.ts'
export type { ManagerState, MemoryTab, Notice } from './controller.ts'
export { MemoryController } from './controller.ts'
export { resolveProjectRoot } from './project.ts'
export type { SettingsScope }

/**
 * Required services of the OUTER plugin: locale and the Remote mount point.
 *
 * Deliberately NOT `remote.memory`. This plugin's apply creates that namespace by mounting its own
 * contribution, so it cannot also wait for it — and Cordis refuses to read a service the fiber did
 * not inject. Both halves of that bind are resolved by the child plugin below, which injects
 * `remote.memory` after the parent has provided it.
 */
export const inject = ['locale', 'remote']

/**
 * Client plugin body: mount this plugin's own Remote namespace, then register the three surfaces.
 * @param ctx - client root context.
 * @returns after the `memory` namespace is callable; its methods are withdrawn when this fiber unloads.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mounted on THIS fiber, so the endpoint's lifetime is the plugin's.
  await ctx.remote.$mount(memoryRemote)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-memory: dictionaries')

  // The surfaces are a child so they can INJECT the namespace their parent just provided. Cordis
  // will not hand a fiber a service it did not declare, and the parent cannot declare one it creates
  // itself; the split is what lets the seats hold a properly injected reference.
  ctx.plugin({
    name: 'memory-surface',
    inject: ['slots', 'settingsScope', 'locale', 'remote', 'remote.memory', 'workspaces', 'sessions'],
    apply: surface,
  })
}

/**
 * Register the sidebar trigger, the manager overlay, and the settings card.
 * @param ctx - the child fiber, with `remote.memory` injected.
 */
function surface(ctx: ClientContext): void {
  const controller = new MemoryController()

  // Every endpoint returns the carrier's RemoteResult envelope. A transport failure is a different
  // fact from a business failure — the Host returns those as values — so it is thrown here and the
  // surfaces show the RPC diagnostic verbatim rather than folding it into the business union.
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
    return result.value
  }
  const remote = ctx.remote.memory

  /**
   * The project the manager is reading, as every endpoint expects it.
   * @returns the `project` field, or nothing when the Host's default is meant.
   */
  const project = (): { project?: string } => {
    const root = controller.getSnapshot().projectRoot
    return root === undefined ? {} : { project: root }
  }

  const managerFace = (): ManagerInjected => ({
    hooks: { manager: controller },
    close: () => { controller.close() },
    refresh: () => { controller.refresh() },
    setTab: (tab) => { controller.setTab(tab) },
    setQuery: (query) => { controller.setQuery(query) },
    setCategory: (category) => { controller.setCategory(category) },
    setStatus: (status) => { controller.setStatus(status) },
    compose: (category) => { controller.compose(category) },
    edit: (memory) => { controller.edit(memory) },
    closeEditor: () => { controller.closeEditor() },
    toggleTrace: (id) => { controller.toggleTrace(id) },
    notify: (tone, text) => { controller.notify(tone, text) },
    dismissNotice: (id) => { controller.dismissNotice(id) },
    describe: () => remote.describe(project()).then(unwrap),
    list: (request: MemoryListRequest) => remote.list({ ...project(), ...request }).then(unwrap),
    search: (request: MemorySearchRequest, signal) =>
      remote.search({ ...project(), ...request }, signal).then(unwrap),
    create: (request: MemoryCreateRequest) => remote.create({ ...project(), ...request }).then(unwrap),
    update: (request: MemoryUpdateRequest) => remote.update({ ...project(), ...request }).then(unwrap),
    discard: async (id, hard) => {
      const result = await remote.discard({ ...project(), id, hard }).then(unwrap)
      return result.ok ? { rulesChanged: result.rulesChanged } : { error: result.message }
    },
    sessions: () => remote.sessions(project()).then(unwrap),
    provenance: id => remote.provenance({ ...project(), id }).then(unwrap),
    importInstructions: (text, source) =>
      remote.importInstructions({ ...project(), text, source }).then(unwrap),
    exportAll: () => remote.exportAll(project()).then(unwrap),
    reembed: () => remote.reembed(project()).then(unwrap),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'memory',
    // After any shipped footer action: this is an addition to the column, not a replacement of
    // whatever a deployment already put there.
    order: 40,
    locale: LOCALE_NS,
    inject: (): TriggerInjected => ({
      hooks: { manager: controller },
      toggle: () => {
        // The trigger resolves the project at the moment it is pressed rather than subscribing to
        // it: the manager pins whatever was current when it opened, so an edit in progress cannot
        // have the memory swapped out from under it by a session switch elsewhere.
        const sessions = ctx.sessions.list.getSnapshot()
        const workspaces = ctx.workspaces.list.getSnapshot()
        controller.toggle(resolveProjectRoot(sessions, workspaces))
      },
    }),
  }, MemoryTrigger))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'memory-manager',
    locale: LOCALE_NS,
    inject: managerFace,
  }, MemoryManager))

  const scope = ctx.settingsScope.bind<MemorySettings>({ namespace: LOCALE_NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: LOCALE_NS,
    locale: LOCALE_NS,
    inject: (): SettingsCardInjected => ({
      hooks: { settings: scope },
      describe: () => remote.describe(project()).then(unwrap),
      setField: (field, value) => scope.set(field, value),
      unsetField: field => scope.unset(field),
      openManager: () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const workspaces = ctx.workspaces.list.getSnapshot()
        controller.open(resolveProjectRoot(sessions, workspaces))
      },
    }),
  }, MemorySettingsCard))
}
