/**
 * Telling a delegated subagent from an agent a person is talking to.
 *
 * The harness runs one agent per session, and a subagent is a session of its own that inherits its
 * parent's working directory — so it fires `agent/session-start` and calls the memory tools against
 * the very same project. What it must not do is behave like a new top-level session: replace its
 * parent's memory session, receive the project history again, or change the binding rules on the
 * strength of a brief another agent wrote.
 *
 * The signal is the session header the harness persists. `dsh-subagent`'s `childSessionMeta` stamps
 * `origin: 'subagent'` and a `delegationDepth` of at least 1 on every child it creates, and both
 * survive persistence and resume. `parentSession` alone is NOT the signal: a user's fork of a
 * top-level session carries it too, and that fork is a session a person is working in.
 *
 * @module @achasoft/dsh-memory/host/lineage
 */

/** The part of a harness session header this module reads. */
export interface SessionLineage {
  /** `'subagent'` on a delegated child session. */
  readonly origin?: string
  /** Absent or zero for a top-level session, parent depth + 1 for a delegated child. */
  readonly delegationDepth?: number
}

/**
 * Whether a session is a delegated subagent's.
 * @param header - the session header, as `agent.session.header` exposes it.
 * @returns true when either lineage field marks the session as delegated.
 */
export function isSubagentSession(header: SessionLineage): boolean {
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}
