/**
 * One engine per origin, shared across every open tab.
 *
 * OPFS's SAH-pool VFS takes an **exclusive** lock per origin, so exactly one
 * context can hold the database open. Before this, the second tab simply failed
 * to boot — the worker detected the `NoModificationAllowedError` and said so in
 * plain language, which is honest but is not a working app.
 *
 * The fix is not to make SQLite shareable, which it is not. It is to make one tab
 * the **leader** — the only one with a worker and therefore the only one touching
 * OPFS — and have the others call it. The Web Locks API does the election, and it
 * does the part that is genuinely hard for free: when the leader's tab closes,
 * the browser releases its lock and the next queued waiter is promoted. Nothing
 * has to detect a crash or time anything out.
 *
 * The messages are deliberately the same RPC the worker already speaks, so the
 * follower path is a different transport rather than a different protocol.
 */

/** The lock whose holder owns the database. */
const LOCK = "daybook.engine";

/** The channel followers call the leader on. */
const CHANNEL = "daybook.engine.rpc";

export type Role = "leader" | "follower";

export interface Call {
  kind: "call";
  tab: string;
  id: number;
  method: string;
  args: unknown[];
}

export interface Reply {
  kind: "reply";
  tab: string;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Broadcast after a write so every other tab knows to re-read. */
export interface Changed {
  kind: "changed";
  tab: string;
}

export type Message = Call | Reply | Changed;

/** A per-tab id, so a leader's replies reach the tab that asked. */
export function tabId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

export function channel(): BroadcastChannel {
  return new BroadcastChannel(CHANNEL);
}

/**
 * Run the election.
 *
 * `onLeader` fires when this tab owns the database — immediately if the lock was
 * free, or later if it was held and the holder went away. `onFollower` fires once
 * if the lock was already taken. Never both at once, and `onLeader` may fire
 * after `onFollower` when a promotion happens.
 *
 * Where the Web Locks API is missing, the caller is made leader: a browser
 * without it also cannot coordinate, and refusing to start would be worse than
 * the single-tab behaviour that shipped before.
 */
export function elect(onLeader: () => void, onFollower: () => void): void {
  if (!navigator.locks) {
    onLeader();
    return;
  }

  /** Held for the lifetime of the tab — releasing it means giving up the DB. */
  const holdForever = () => new Promise<never>(() => {});

  void (async () => {
    // `ifAvailable` makes the lock argument nullable, and returning `false` is
    // how "someone else has it" gets back out of the callback. `await` rather
    // than `.then`, because the lib types nest the promise a level otherwise.
    const taken = await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      onLeader();
      await holdForever();
      return true;
    });
    if (taken) return;

    onFollower();
    // Queue behind the current leader. This resolves only when that tab closes
    // or crashes, at which point the browser hands the lock over and this tab
    // takes the database on.
    void navigator.locks.request(LOCK, async () => {
      onLeader();
      await holdForever();
    });
  })();
}
