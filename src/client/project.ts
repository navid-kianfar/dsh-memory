/**
 * Which project a surface is looking at.
 *
 * Memory is per-project, and a Web Client can hold several workspaces at once, so every surface has
 * to answer the same question before it can read anything. The rule lives here once: the named
 * session's own working directory first, its workspace's path as a fallback, and the most recently
 * used workspace when there is no session to name at all — so a surface outside a conversation still
 * lands on the project the person was last in rather than on nothing.
 *
 * @module @achasoft/dsh-memory/client/project
 */

import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Resolve the project directory a surface should read.
 * @param sessions - the session list snapshot.
 * @param workspaces - the workspace list snapshot.
 * @param sessionId - the session whose project is wanted; absent uses the current selection, which
 * is what a surface outside the conversation ring has to fall back to.
 * @returns the absolute directory, or undefined to fall back to the Host's default project.
 */
export function resolveProjectRoot(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  sessionId?: SessionId,
): string | undefined {
  const current = sessionId ?? sessions.current
  if (current !== undefined) {
    const summary = sessions.byId[current as keyof typeof sessions.byId]
    if (summary?.cwd !== undefined) return summary.cwd
    const owner = workspaces.items.find(item => (item.sessionIds as readonly string[]).includes(current))
    if (owner !== undefined) return owner.path
  }
  const recent = workspaces.recentWorkspaceId
  if (recent !== undefined) {
    const workspace = workspaces.items.find(item => item.workspaceId === recent)
    if (workspace !== undefined) return workspace.path
  }
  return workspaces.items[0]?.path
}
