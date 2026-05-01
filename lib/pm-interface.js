/**
 * Canonical Pm interface (JSDoc typedef).
 *
 * Both `lib/process-manager.js` (CLI pm) and `lib/process-manager-sdk.js`
 * (SDK pm) implement this. `lib/pm-router.js`'s `createPmRouter()`
 * forwards calls to one or the other based on per-chat policy.
 *
 * Optional methods are marked `?` — the router exposes them too but
 * returns documented sentinels when the routed pm doesn't implement
 * them. Sites that need to feature-detect should call
 * `pm.pickFor(sessionKey)` and probe `typeof X === 'function'` on
 * the returned pm instance, not on the router.
 *
 * @typedef {object} PmEntry
 *   The shape pm.get(sessionKey) returns. Different pms decorate it
 *   with their own internal fields; only the documented fields below
 *   are part of the public contract.
 * @property {string} sessionKey
 * @property {string|null} chatId
 * @property {string|null} threadId
 * @property {boolean} closed
 * @property {boolean} inFlight
 * @property {Array<object>} pendingQueue   — array of pending sends
 *
 * @typedef {object} PmSendResult
 *   The shape pm.send() resolves with on success. Failure rejects.
 * @property {string} text                  — final assistant text (may be '')
 * @property {string|null} sessionId        — Claude session id (for resume)
 * @property {number} cost                  — total cost USD
 * @property {number} duration              — turn duration ms
 * @property {string|null} error            — error string or null on success
 * @property {object} metrics               — token / tool / msg counts
 * @property {number} metrics.inputTokens
 * @property {number} metrics.outputTokens
 * @property {number} metrics.cacheCreationTokens
 * @property {number} metrics.cacheReadTokens
 * @property {number} metrics.numAssistantMessages
 * @property {number} metrics.numToolUses
 * @property {string|null} metrics.resultSubtype
 *
 * @typedef {object} PmSendOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxTurnMs]
 * @property {object} [context]             — opaque per-turn state (streamer, reactor, sourceMsgId)
 *
 * @typedef {object} PmSpawnContext
 *   What polygram passes to spawnFn(sessionKey, ctx). Internal to
 *   each pm but documented here so callers know what's available.
 * @property {string|null} chatId
 * @property {string|null} threadId
 * @property {string} label
 *
 * @typedef {object} Pm
 *   The unified ProcessManager interface. Both CLI and SDK pm
 *   implement these; the router forwards.
 *
 *   Required (every pm has these):
 * @property {(sessionKey: string) => boolean} has
 * @property {(sessionKey: string) => PmEntry|null} get
 * @property {(sessionKey: string, ctx: PmSpawnContext) => Promise<PmEntry>} getOrSpawn
 * @property {(sessionKey: string, prompt: string, opts?: PmSendOptions) => Promise<PmSendResult>} send
 * @property {(sessionKey: string) => Promise<void>} kill
 * @property {(chatId: string|number) => Promise<void>} killChat
 *   — closes ALL sessions belonging to a chat (broadcast across topics).
 * @property {() => Promise<void>} shutdown
 *   — graceful daemon-wide drain + close.
 *
 *   Optional (only one of the two pms implements these — feature-detect):
 * @property {((sessionKey: string, text: string, opts?: object) => boolean)=} steer
 *   — SDK pm only (rc.9 priority='now' direct push, opt-in shouldQuery).
 * @property {((sessionKey: string, opts: {content: string, priority?: 'now'|'next'|'later', shouldQuery?: boolean, parent_tool_use_id?: string|null}) => boolean)=} injectUserMessage
 *   — SDK pm only (rc.42 native autosteer / queue via SDKUserMessage
 *     priority hint). Returns false on CLI pm (no inputController
 *     surface) or when sessionKey not found.
 * @property {((sessionKey: string, model: string) => Promise<boolean>)=} setModel
 *   — SDK pm only (Query.setModel live).
 * @property {((sessionKey: string, settings: {effortLevel?: string}) => Promise<boolean>)=} applyFlagSettings
 *   — SDK pm only (Query.applyFlagSettings live).
 * @property {((sessionKey: string, mode: string) => Promise<boolean>)=} setPermissionMode
 *   — SDK pm only.
 * @property {((sessionKey: string, reason?: string) => {killed: boolean, queued: number})=} requestRespawn
 *   — CLI pm only (drain pending queue then kill; respawn on next send).
 * @property {((sessionKey: string, errCode: string) => number)=} drainQueue
 *   — SDK pm only (reject all queued pendings with errCode).
 * @property {((sessionKey: string) => Promise<void>)=} interrupt
 *   — SDK pm only (Query.interrupt — non-destructive).
 * @property {((sessionKey: string, opts?: {reason?: string}) => Promise<{closed: boolean, drainedPendings: number}>)=} resetSession
 *   — SDK pm only (close Query + clear sessionId from DB).
 *
 *   Lifecycle introspection (for tests / debugging — not required
 *   to be present, but both current pms expose them):
 * @property {() => string[]=} keys      — sessionKey list
 * @property {() => number=} size        — number of live sessions
 */

// This file is JSDoc-only; no runtime exports. It exists so editors
// + the JSDoc-aware test mocks reference a single canonical type.

module.exports = {};
