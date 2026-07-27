/**
 * Canonical Pm interface (JSDoc typedef).
 *
 * Implemented by `lib/sdk/process-manager.js` (the only pm impl
 * post-0.9.0). `lib/sdk/router.js`'s `createPmRouter()` wraps the
 * pm and is currently an identity passthrough — kept as a forward-
 * compat seam for future alternate pm impls (a pi-agent-core
 * adapter, a synthetic test pm). When that lands, the router
 * becomes the per-chat dispatch layer again; this interface stays
 * the contract.
 *
 * Optional methods are marked `?`. SDK pm currently exposes ALL
 * of them, so post-0.9.0 polygram.js can call them directly
 * without `typeof === 'function'` guards. Future alternate impls
 * may opt out of an optional method; if they do, callers will
 * need to feature-detect at the call site.
 *
 * @typedef {object} PmEntry
 *   The shape pm.get(sessionKey) returns. The pm impl decorates it
 *   with its own internal fields; only the documented fields below
 *   are part of the public contract.
 * @property {string} sessionKey
 * @property {string|null} chatId
 * @property {string|null} threadId
 * @property {string} label
 * @property {'claude'|'codex'} runtime
 * @property {string} backend
 * @property {string|null} spawnProfileId
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
 *   the pm but documented here so callers know what's available.
 * @property {string|null} chatId
 * @property {string|null} threadId
 * @property {string} label
 * @property {'claude'|'codex'} runtime
 *   Canonical runtime selected before process creation. Explicit Codex
 *   selection reaches Orchestra through this field; it is not passed to
 *   Claude's pickBackend() compatibility resolver.
 * @property {string} backend
 *   Canonical provider backend (`sdk`, `cli`, or `codex`).
 * @property {string|null} spawnProfileId
 *   Opaque identity from the successful runtime preflight. Codex process
 *   creation must receive the exact profile it was preflighted with.
 * @property {string} [runtimeConfigIdentity]
 *   Polygram-owned identity of its resolved configuration. Orchestra ignores
 *   this field and enforces runtime/backend/spawnProfileId with its own
 *   identity; Polygram may use it for config audit or UI comparisons.
 * @property {string|null} [cwd]
 *   Resolved topic/chat/default working directory included in spawn identity.
 * @property {string|null} [agent]
 *   Resolved Claude agent. Always null for Codex; Codex instructions are
 *   attested independently and must not reuse Claude's named-agent bundle.
 *
 * @typedef {object} Pm
 *   The unified ProcessManager interface.
 *
 *   Required:
 * @property {(sessionKey: string) => boolean} has
 * @property {(sessionKey: string) => PmEntry|null} get
 * @property {(sessionKey: string, ctx: PmSpawnContext) => Promise<PmEntry>} getOrSpawn
 * @property {(sessionKey: string, ctx: PmSpawnContext) => Promise<PmEntry>} replaceRuntime
 *   — strict serialized replacement. Same identity returns the current entry.
 *   Live/pinned/blocked or conflicting replacement throws
 *   `RUNTIME_SWITCH_IN_FLIGHT`; unsafe retirement throws
 *   `RUNTIME_SWITCH_EVICTION_FAILED`; unknown runtime throws
 *   `RUNTIME_UNKNOWN`; provider lease/config errors propagate.
 * @property {(sessionKey: string, prompt: string, opts?: PmSendOptions) => Promise<PmSendResult>} send
 * @property {(sessionKey: string) => Promise<void>} kill
 * @property {(chatId: string|number) => Promise<void>} killChat
 *   — closes ALL sessions belonging to a chat (broadcast across topics).
 * @property {() => Promise<void>} shutdown
 *   — graceful daemon-wide drain + close.
 *
 *   Optional (SDK pm exposes all of these; future alt impls may not):
 * @property {((sessionKey: string, text: string, opts?: object) => boolean)=} steer
 *   — priority='now' direct push, opt-in shouldQuery.
 * @property {((sessionKey: string, opts: {content: string, priority?: 'now'|'next'|'later', shouldQuery?: boolean, parent_tool_use_id?: string|null}) => boolean)=} injectUserMessage
 *   — native autosteer / queue via SDKUserMessage priority hint.
 *     Returns false when sessionKey not found.
 * @property {((sessionKey: string, model: string) => Promise<boolean>)=} setModel
 *   — Query.setModel live (no respawn).
 * @property {((sessionKey: string, settings: {model: string, effort: string}) => Promise<object>)=} selectModelSettings
 * @property {((sessionKey: string) => Promise<object>)=} getModelSettingsStatus
 *   — Atomically select the complete Codex pair for the next admitted turn.
 *     Expected lifecycle states return a discriminated `outcome`; malformed
 *     inputs and unexpected internal failures reject.
 * @property {((sessionKey: string, settings: {effortLevel?: string}) => Promise<boolean>)=} applyFlagSettings
 *   — Query.applyFlagSettings live (no respawn).
 * @property {((sessionKey: string, mode: string) => Promise<boolean>)=} setPermissionMode
 * @property {((sessionKey: string, errCode: string) => number)=} drainQueue
 *   — reject all queued pendings with errCode.
 * @property {((sessionKey: string) => Promise<void>)=} interrupt
 *   — Query.interrupt (non-destructive — preserves session for resume).
 * @property {((sessionKey: string, opts?: {reason?: string}) => Promise<{closed: boolean, drainedPendings: number}>)=} resetSession
 *   — close Query + clear sessionId from DB.
 *
 *   Lifecycle introspection (for tests / debugging):
 * @property {() => string[]=} keys      — sessionKey list
 * @property {() => number=} size        — number of live sessions
 */

// This file is JSDoc-only; no runtime exports. It exists so editors
// + the JSDoc-aware test mocks reference a single canonical type.

module.exports = {};
