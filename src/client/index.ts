/**
 * Memory plugin, browser half. Two registrations over one Host endpoint: the Memory view in the
 * conversation ring, and the memory card on the plugin settings tab.
 *
 * The view is a tab beside Chat rather than an overlay opened from the sidebar. Memory is per
 * project, and a session IS the project you are in — so the tab already names what it is a view of,
 * where a sidebar button had to resolve a project of its own and pin it against the session
 * switching underneath.
 *
 * Both seats are registered through `ctx.slots.inject`, because apply order between packages is
 * unconstrained and a bare `register` into a slot another package declares is an error when this
 * plugin happens to load first.
 *
 * @module @achasoft/dsh-memory/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext, SessionId, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ui-conversation's SlotMap merge, which declares 'conversation.view'.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-settings' ctx.settingsScope merge, and ui-settings-plugins' card slot.
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
import { LOCALE_NS, type MemoryScreenInjected, type SettingsCardInjected } from './contract.ts'
import { MemoryController } from './controller.ts'
import { MemoryScreen } from './MemoryScreen.tsx'
import { MemorySettingsCard } from './SettingsCard.tsx'
import { en, zh } from './locales.ts'
import { resolveProjectRoot } from './project.ts'

export type { MemoryKey } from './locales.ts'
export type { ManagerState, MemoryPane, Notice } from './controller.ts'
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
 * Client plugin body: mount this plugin's own Remote namespace, then register the two surfaces.
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
 * Register the Memory view and the settings card.
 * @param ctx - the child fiber, with `remote.memory` injected.
 */
function surface(ctx: ClientContext): void {
  // One controller per session: the view is session-scoped, and two sessions on two projects
  // sharing a category filter would each be filtering by the other's last choice. Entries are keyed
  // by session so a tab switched away from and back to comes back where it was left.
  const controllers = new Map<SessionId, MemoryController>()

  /**
   * This session's view state, created on first sight of the session.
   * @param sessionId - the session the view was registered for.
   * @returns its controller.
   */
  const controllerFor = (sessionId: SessionId): MemoryController => {
    const existing = controllers.get(sessionId)
    if (existing !== undefined) return existing
    const created = new MemoryController()
    controllers.set(sessionId, created)
    return created
  }

  // Every endpoint returns the carrier's RemoteResult envelope. A transport failure is a different
  // fact from a business failure — the Host returns those as values — so it is thrown here and the
  // surfaces show the RPC diagnostic verbatim rather than folding it into the business union.
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
    return result.value
  }
  const remote = ctx.remote.memory
  const t = ctx.locale.bind(LOCALE_NS)

  /**
   * The project one session is bound to, as every endpoint expects it.
   *
   * Resolved at call time rather than captured at registration: a session's working directory can
   * arrive after its view first rendered, and a captured project would keep reading the wrong one.
   * @param sessionId - the session whose project is wanted; absent asks for the current selection.
   * @returns the `project` field, or nothing when the Host's default is meant.
   */
  const project = (sessionId?: SessionId): { project?: string } => {
    const root = resolveProjectRoot(
      ctx.sessions.list.getSnapshot(),
      ctx.workspaces.list.getSnapshot(),
      sessionId,
    )
    return root === undefined ? {} : { project: root }
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'memory',
    // After the shipped chat (0) and trajectory (10) tabs, and after a board a deployment may also
    // compose: memory is a place you go to, not the one you land in.
    order: 30,
    locale: LOCALE_NS,
    // A thunk, so the tab label follows a locale change without re-registering the entry.
    label: () => t('view.memory'),
    inject: (sessionId: SessionId): MemoryScreenInjected => {
      const controller = controllerFor(sessionId)
      const scope = (): { project?: string } => project(sessionId)
      return {
        hooks: { manager: controller },
        refresh: () => { controller.refresh() },
        setPane: (pane) => { controller.setPane(pane) },
        setQuery: (query) => { controller.setQuery(query) },
        setCategory: (category) => { controller.setCategory(category) },
        setStatus: (status) => { controller.setStatus(status) },
        compose: (category) => { controller.compose(category) },
        edit: (memory) => { controller.edit(memory) },
        closeEditor: () => { controller.closeEditor() },
        toggleTrace: (id) => { controller.toggleTrace(id) },
        notify: (tone, text) => { controller.notify(tone, text) },
        dismissNotice: (id) => { controller.dismissNotice(id) },
        describe: () => remote.describe(scope()).then(unwrap),
        list: (request: MemoryListRequest) => remote.list({ ...scope(), ...request }).then(unwrap),
        search: (request: MemorySearchRequest, signal) =>
          remote.search({ ...scope(), ...request }, signal).then(unwrap),
        create: (request: MemoryCreateRequest) => remote.create({ ...scope(), ...request }).then(unwrap),
        update: (request: MemoryUpdateRequest) => remote.update({ ...scope(), ...request }).then(unwrap),
        discard: async (id, hard) => {
          const result = await remote.discard({ ...scope(), id, hard }).then(unwrap)
          return result.ok ? { rulesChanged: result.rulesChanged } : { error: result.message }
        },
        sessions: () => remote.sessions(scope()).then(unwrap),
        provenance: id => remote.provenance({ ...scope(), id }).then(unwrap),
        importInstructions: (text, source) =>
          remote.importInstructions({ ...scope(), text, source }).then(unwrap),
        exportAll: () => remote.exportAll(scope()).then(unwrap),
        reembed: () => remote.reembed(scope()).then(unwrap),
      }
    },
  }, MemoryScreen))

  const scope = ctx.settingsScope.bind<MemorySettings>({ namespace: LOCALE_NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // The key IS the host settings namespace: the plugins tab renders the intersection of
    // registered cards and the namespaces the host reports, so the two halves join on this string.
    key: LOCALE_NS,
    locale: LOCALE_NS,
    inject: (): SettingsCardInjected => ({
      hooks: { settings: scope },
      // No session to name from the settings dialog, so this reads the current selection's project —
      // the same one the Memory tab would open on if you switched to it now.
      describe: () => remote.describe(project()).then(unwrap),
      setField: (field, value) => scope.set(field, value),
      unsetField: field => scope.unset(field),
    }),
  }, MemorySettingsCard))
}
