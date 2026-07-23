/**
 * Session lifecycle hook guard — ensures session_start / session_end
 * fire at most once per session, independent of how many times quit is
 * requested (/exit, Ctrl+D, Ctrl+C all funnel through end()).
 */

export type SessionLifecycleEvent = "session_start" | "session_end";

export interface SessionLifecycle {
  /** Fire session_start exactly once. Subsequent calls are no-ops. */
  start(): void;
  /** Fire session_end exactly once. Subsequent calls are no-ops. */
  end(): void;
  readonly started: boolean;
  readonly ended: boolean;
}

/**
 * @param fire callback that runs the configured hooks for the event
 *             (e.g. `(e) => runHooks(e)`). Injected so unit tests can
 *             assert call counts without spawning shells or booting the TUI.
 */
export function createSessionLifecycle(
  fire: (event: SessionLifecycleEvent) => void,
): SessionLifecycle {
  let started = false;
  let ended = false;
  return {
    start() {
      if (started) return;
      started = true;
      fire("session_start");
    },
    end() {
      if (ended) return;
      ended = true;
      fire("session_end");
    },
    get started() { return started; },
    get ended() { return ended; },
  };
}
