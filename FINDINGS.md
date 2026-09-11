# Findings — protocol gaps & known issues

Gap analysis of pi-acp against the ACP protocol (as of `@agentclientprotocol/sdk` 0.26.0)
and pi's RPC surface (as of pi 0.84.4). Audited 2026-09-04.

Each item has an ID, priority, and status. Update the status as work happens;
add evidence/notes inline. Don't delete items — mark them `done` or `wontfix` with a note.

Status values: `open` · `in-progress` · `done` · `wontfix`

## P0 — bugs / dead code

- [x] **B1 — Compaction events are dead code** `done`
      `session.ts` handles `auto_compaction_start`/`auto_compaction_end`, but current pi emits
      `compaction_start`/`compaction_end` (payload: `reason`, `result`, `aborted`, `errorMessage`,
      `willRetry`). Auto-compaction is invisible to ACP clients. Manual `/compact` works only because
      it uses the RPC response, not events.
      Fix: rename the cases; consider richer messaging using `reason` and `errorMessage`.

  Done: cases renamed to `compaction_start`/`compaction_end`; start message varies by `reason`
  (manual/threshold/overflow), end message distinguishes success/aborted/`errorMessage`.
  Tests: `test/component/session-compaction.test.ts`.

- [x] **B2 — Errors masked as normal completion** `done`
      `agent.ts prompt()` maps pi failure to `stopReason: 'end_turn'` (unless cancel was requested).
      ACP `stopReason` also has `refusal`, `max_tokens`, `max_turn_requests` — none ever emitted.
      Clients render crashes as a normal end of turn.
      Fix: distinguish error (emit an explicit error chunk + consider `refusal` where appropriate),
      map pi stop reasons when available.

      Done: session.ts emits an explicit `Turn failed: <message>` chunk (delivered before the
      prompt resolves; skipped for cancel and AUTH_REQUIRED paths), and `agent.ts` now maps a
      failed turn to `stopReason: 'refusal'` instead of `'end_turn'`. `max_tokens`/`max_turn_requests`
      remain impossible until pi exposes stop reasons (tracked as C6). Tests:
      `test/component/session-turn-error.test.ts`, `test/component/agent-prompt-stop-reason.test.ts`.

- [x] **B3 — Bash "terminals" are a Zed-only `_meta` hack** `done` (fallback-only; real delegation remains D3)
      Bash tool calls emit `{type:'terminal', terminalId}` content whose ID was never created via
      `terminal/create`, plus Zed-specific `_meta.terminal_info/terminal_output/terminal_exit`
      (`translate/bash.ts`). Works only because Zed renders display-only terminals from that
      convention; breaks the ACP terminal contract for conforming clients.
      Fix (P3-scale): real `terminal/create`+`output`+`wait_for_exit` delegation when the client
      advertises `terminal: true`; keep the `_meta` path only as a fallback for Zed.

      Done (bug scope): the hack is now gated on client capabilities. Clients advertising
      `clientCapabilities.terminal: true` get plain-text bash output as tool-call content
      (content replaces, so full accumulated text) instead of fake terminal content/_meta;
      clients without terminal support (Zed) keep the working fallback. Real delegation
      stays open as D3 — it needs pi-side tool interception, not just adapter work.
      Tests: `test/unit/zed-terminal-fallback.test.ts`,
      `test/component/session-bash-fallback.test.ts`,
      `test/component/agent-terminal-capability.test.ts`.

- [x] **B4 — `extension_error` events dropped** `done`
      Pi emits `extension_error`; adapter's event switch has no case, so extension failures
      disappear silently in ACP clients.
      Fix: surface as an agent message chunk (or dedicated rendering).

      Done: surfaced as an agent message chunk
      `Extension error in <path> during '<event>': <error>` (event omitted when absent,
      generic fallback when the payload is empty). Tests:
      `test/component/session-extension-error.test.ts`.

## P1 — cheap, high-value protocol wins

- [x] **C1 — Token usage & cost unexposed** `done`
      Pi's `message_update` events carry a `usage` object; `get_session_stats` has cost.
      ACP offers `session/update` → `usage_update` (`{used, size, cost?}`) and unstable
      `usage` field on the `session/prompt` response. Adapter drops all of it; client
      context/cost meters can't work.

      Done: at `agent_settled` the session fetches `get_session_stats` (best-effort, never
      blocks turn completion) and emits `usage_update` with `used`/`size` from
      `contextUsage` plus `cost` as `{amount, currency: 'USD'}`; the same stats feed the
      unstable `usage` field on the `session/prompt` response via `session.lastTurnUsage`.
      `session/load` also emits `usage_update` so restored sessions show correct meters
      before the first prompt. Mapping lives in `translate/usage.ts`; when pi can't
      determine context tokens (e.g. right after compaction) the update is skipped.
      Tests: `test/unit/usage-mapping.test.ts`, `test/component/session-usage.test.ts`,
      `test/component/agent-prompt-usage.test.ts`.

- [x] **C2 — Pi-initiated state changes dropped** `done`
      Pi events `session_info_changed` (session name), `thinking_level_changed`, `entry_appended`
      fall into the default case. Map to `session_info_update` (title), `current_mode_update`,
      and `config_option_update` respectively so client UI doesn't drift.

      Done: `session_info_changed` → `session_info_update` (title; missing name maps to
      `title: null` to clear, plus `updatedAt`, matching the `/name` path);
      `thinking_level_changed` → `current_mode_update` plus a `config_option_update` refresh so
      the thought_level selector's `currentValue` stays in sync; `entry_appended` →
      `config_option_update` with the entry forwarded via `_meta.piAcp.entryAppended` (pi only
      emits this for extension `appendEntry`, i.e. `custom` entries). Config-option computation
      (`getSessionConfiguration`, `setSessionModel`, etc.) extracted from `agent.ts` into shared
      `src/acp/session-config.ts` so the session event path can recompute the full option set.
      Tests: `test/component/session-state-changes.test.ts`.

- [x] **C3 — Extension UI `setTitle` unmapped** `done`
      Pi extension UI request `setTitle` should map to `session_info_update` with `title`.
      (`setStatus`/`setWidget`/`set_editor_text` remain auto-cancelled — see D6.)

      Done: `setTitle` in `handleExtensionUiRequest` emits `session_info_update` with the
      title (missing title → `title: null` to clear, matching the `/name` path) and responds
      `cancelled` (pi treats setTitle as fire-and-forget, so the response is a harmless no-op).
      Tests: `test/component/session-state-changes.test.ts`.

- [x] **C4 — Thinking levels hardcoded** `done`
      `agent.ts` hardcodes `off|minimal|low|medium|high|xhigh` instead of calling pi's
      `get_available_thinking_levels`. Will drift if pi adds/renames levels.

      Done: `PiRpcProcess.getAvailableThinkingLevels()` calls pi's
      `get_available_thinking_levels` (per-model levels, e.g. `max` only when the model
      supports it); the thought_level config option and `setSessionMode` validation now
      resolve against pi's advertised set (`resolveThinkingLevel` in
      `src/acp/session-config.ts`) instead of a static list, with pi's
      `THINKING_LEVEL_OPTIONS` kept only as a fallback when the RPC fails.
      Tests: `test/unit/session-config-options.test.ts`.

- [x] **C5 — `embeddedContext` off by default** `done`
      `promptCapabilities.embeddedContext` was gated behind `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`,
      but `translate/prompt.ts` already fully handles `resource` blocks.

      Done: `embeddedContext` now defaults to `true`; `PI_ACP_ENABLE_EMBEDDED_CONTEXT=false`
      opts out (any other value, including unset, keeps it enabled).
      Tests: `test/unit/pi-enable-embed-context-flag.test.ts`.

- [ ] **C6 — Stop reason fidelity** `open`
      Companion to B2: pi's RPC prompt response carries no stop reason, so `max_tokens` etc.
      can't be surfaced today. Requires pi-side support — file upstream, then map.

## P2 — ACP client→agent methods to implement

- [x] **A1 — `session/close`** `done`
      Capability `sessionCapabilities.close`. No way for a client to release a pi subprocess.
      Related policy issue: `closeAllExcept` silently kills sibling sessions (one live subprocess
      per connection) — revisit whether multi-session clients should be allowed.

      Done: `closeSession` cancels ongoing work (queued turns resolved as cancelled, pi aborted;
      bounded by a 5s timeout so a wedged pi can't hang the close) and disposes the subprocess;
      idempotent `{}` for sessions that aren't live in this connection. Policy revisit: clients
      that manage session lifecycles themselves can opt out of the single-subprocess policy via
      `PI_ACP_ALLOW_MULTIPLE_SESSIONS=true`; the default remains one live subprocess per
      connection, now with an explicit release path. The duplicated slash-command advertisement
      blocks (new/load) were extracted into `advertiseAvailableCommands` so resume reuses it.
      Tests: `test/component/agent-session-close.test.ts`.

- [x] **A2 — `session/resume`** `done`
      Capability `sessionCapabilities.resume`. Load without history replay; trivial given
      `loadSession` already exists.

      Done: `resumeSession` restores the stored session without replaying history — reusing the
      live subprocess when one exists, otherwise spawning pi against the stored session file —
      and returns `configOptions`/`modes`. Emits `usage_update` and (async, after the response)
      `available_commands_update` like `session/load`. Tests:
      `test/component/agent-session-resume.test.ts`.

- [x] **A3 — `session/fork`** `done`
      Unstable capability. Pi RPC already has `fork`/`clone`/`get_fork_messages` — backend ready.

      Done: `agentCapabilities.sessionCapabilities.fork` advertised and `unstable_forkSession`
      implemented via pi's `clone` (fork at leaf; `fork` is the interactive branch-at-entry UX and
      stays unused). Design is ownership transfer, per the investigation notes below: pi's clone
      rebinds the SOURCE subprocess to the branched session, so the new ACP session adopts the
      existing `PiRpcProcess` (`SessionManager.getOrCreate`) while the source mapping is demoted
      via the new `SessionManager.release()` (detach without dispose; `PiAcpSession` now keeps its
      event-unsubscribe handle and `detach()`s, preventing post-fork event misattribution). The
      new `sessionId`/`sessionFile` come from `get_state` after the clone response; the source
      stays restorable from disk via the existing lazy-spawn path. Forking a session with a
      running/queued turn is rejected (`invalidRequest`) since pi would abort it mid-rebind.
      Clone failure, extension veto (`session_before_fork` → `cancelled`), and a missing new
      session id all map to ACP errors without demoting the source. Responds with
      `configOptions`/`modes`, emits `usage_update` and async `available_commands_update`.
      `PiRpcProcess.cloneSession()` added. Tests:
      `test/component/agent-session-fork.test.ts`.

      Investigation (2026-09-05, pi 0.84.4, SDK 0.26.0): ACP surface is
      `sessionCapabilities.fork: {}` + handler `unstable_forkSession({sessionId, cwd}) →
      {sessionId, modes?, configOptions?}` (connection dispatches to `agent.unstable_forkSession`;
      optional method, no interface change needed). Pi mapping: `clone` (fork at leaf) is the
      right primitive — `fork` is the interactive branch-at-user-message UX (needs
      `get_fork_messages` + entryId). Critical semantic: pi's `clone`/`fork` REBIND the current
      subprocess to the branched session (`teardownCurrent` aborts+persists any active turn,
      `rebindSession()` resubscribes; same stdout stream keeps flowing) — no second process is
      spawned. New branched file (new session id, `parentSession` link) is discoverable via
      `get_state` (`sessionId`/`sessionFile`) after the clone response. Original session file is
      untouched. Consequence: ownership-transfer design — the new ACP session takes over the
      source session's `PiRpcProcess`; the source session is demoted to not-live and lazily
      respawns via `restoreSession` on next use. Wrinkle: `PiAcpSession` subscribes to proc
      events in its constructor without keeping the unsubscribe fn, so a detach/transfer path is
      required or post-fork pi events get misattributed to the source session. Plan in
      session notes: add `clone()` to `PiRpcProcess`, `release()`/detach to SessionManager,
      `unstable_forkSession` to agent, reject fork while source session has a turn queued.

- [x] **A4 — `logout`** `done`
      Capability `agentCapabilities.auth.logout`. Terminal login exists; no logout path.

      Done: `auth: { logout: {} }` advertised; `logout()` clears pi's stored credentials by
      atomically replacing `<agentDir>/auth.json` (respecting `PI_CODING_AGENT_DIR`) with `{}`
      via `clearPiCredentials()` in `src/acp/auth.ts`. pi guards the file with proper-lockfile,
      which the adapter deliberately doesn't depend on; the atomic replace races only with a
      concurrent login in another live pi process. Subsequent `session/new` reports
      `authRequired` as usual once credentials are gone.
      Tests: `test/component/agent-logout.test.ts`.

- [x] **A5 — `additionalDirectories`** `done`
      Ignored on `session/new`/`session/load`; also missing from `SessionInfo` in `session/list`.

      Done: `sessionCapabilities.additionalDirectories: {}` advertised. All four lifecycle
      methods (`new`/`load`/`resume`/`fork`) validate absolute paths (`invalidParams` otherwise)
      and carry the list into `PiAcpSession` + the persistent `SessionStore` (omitted/empty on
      load = clear, per spec; fork inherits the source list unless overridden). `restoreSession`
      preserves a previously stored list on prompt-path lazy restores; explicit opts replace it.
      `session/list` reports stored `additionalDirectories` in `SessionInfo`. pi tools are not
      sandboxed to cwd, so the list is bookkeeping only (consistent with the mcpServers stance).
      Tests: `test/component/agent-additional-directories.test.ts`.

- [ ] **D1 — Permission flow for core tools** `open`
      `session/request_permission` is used only for extension UI select/confirm. Pi RPC has no
      tool-approval hook, so core tool confirmation requires pi-side support first — file upstream,
      then interpose approval via ACP.

- [x] **D2 — Elicitation for extension `input`/`editor` UI requests** `done`
      Currently auto-cancelled with "not supported in ACP yet" (`session.ts`). ACP's unstable
      `elicitation/create` (form mode) is the correct mapping.

      Done: when the client advertises `clientCapabilities.elicitation.form`, `input` and
      `editor` map to a single-string form elicitation (`unstable_createElicitation`):
      `input` uses the placeholder as the field description; `editor` prefills via the schema
      `default`. Accept resolves pi with the submitted text (missing content → empty string);
      decline/cancel and RPC failure map to pi `cancelled`. Without the capability the old
      auto-cancel-with-notice fallback stays. Tests:
      `test/component/session-elicitation.test.ts`.

- [ ] **D3 — Real terminal delegation** `open`
      See B3.

- [x] **D4 — Native steering/queue semantics** `done`
      Pi RPC `steer`/`follow_up`/`clear_queue` (+ `prompt.streamingBehavior`) vs the adapter's
      ACP-side turn queue. Pi-side queue would give true mid-turn steering; today queue depth is
      published only via `_meta` that clients don't render. Also consider pi's `queue_update`
      event and `get_state().pendingMessageCount`.

      Done: mid-turn prompts are forwarded to pi via `follow_up` (`PiRpcProcess.followUp()`;
      `steer()`/`clearQueue()` also added) and resolve at the same final `agent_settled` as the
      running turn with the same stopReason — pi only settles after its queue drains. The local
      `turnQueue` remains as fallback when the follow_up RPC fails (old pi, extension commands
      pi refuses to queue) with unchanged sequential semantics. `cancel()` resolves forwarded
      turns as cancelled and best-effort purges pi's queue via `clear_queue`; a cancel/enqueue
      race is handled by re-purging. `queue_update` events drive `queueDepth`/`running` `_meta`
      from pi's reported `steering`/`followUp` counts. `hasActiveWork()` includes forwarded
      turns so fork still rejects while pi holds queued work. Verified pi 0.84.4 relays
      `queue_update` through `toJsonEvent` verbatim. Tests:
      `test/component/session-events.test.ts` (forwarding, fallback, queue_update),
      `test/component/session-queue-cancel.test.ts`.

      Feasibility (assessed 2026-06): small change. Verified against installed pi 0.84.4 that
      RPC `steer`/`follow_up`/`clear_queue` all exist; `steer` delivers after the current
      assistant turn finishes tool calls, before the next LLM call; `agent_settled` fires only
      after the queue drains, so the existing wait-for-`agent_settled` logic needs no change.
      Plan: add `steer()`/`clearQueue()` to `PiRpcProcess`; forward mid-turn prompts to pi
      instead of the local `turnQueue` (keep the local queue as fallback when the steer RPC
      errors, e.g. old pi or extension commands, which pi refuses to queue); resolve all
      outstanding `session/prompt` requests at the same final `agent_settled` with the same
      stopReason; `cancel()` also calls `clear_queue`; drive queueDepth `_meta` from
      `queue_update`.

      Client caveat: Zed queues messages client-side while an external ACP agent is running and
      sends the next `session/prompt` only after the previous response completes — its queued-
      message "Steer" toggle works only with Zed's native agent (Zed cannot detect turn
      boundaries for external agents). So through Zed this work changes nothing visible today;
      the payoff is other ACP clients that send concurrent prompts, plus readiness if Zed/ACP
      ever expose steering for external agents.

- [ ] **D5 — Session tree / branching UI** `open`
      Pi RPC `new_session(parentSession)`, `get_tree`, `get_entries(since)` unexposed; maps to
      ACP `session/fork` (A3) and a richer session list over time.

- [ ] **D6 — Remaining extension UI requests** `open`
      `setStatus`/`setWidget`/`set_editor_text` have no ACP counterpart today; keep cancelling
      explicitly. Revisit as the protocol evolves.

- [ ] **D7 — Direct bash RPC** `open`
      Pi `bash`/`abort_bash` commands unused; could power a `/bash` builtin command or a
      client-side "run command" affordance.

- [ ] **D8 — Auto-retry controls** `open`
      Pi `set_auto_retry`/`abort_retry` unexposed (retry _events_ are surfaced as text).
      Also unhandled: `summarization_retry_*` events, `user_bash`, `bash_execution_update`.

- [ ] **D9 — Newer unstable ACP surface** `open`
      Tracked, not planned: `providers/*`, `nes/*` + document sync, MCP delegation
      (`mcp/connect` etc.), plan files (`plan_update`/`plan_removed`), `session/set_mode`-style
      plan capabilities.

## P3 — bigger designs / needs upstream support

- [x] **D10 — Client-side file-tool delegation (`fs/read_text_file` / `fs/write_text_file`)** `done`
      Previously a deliberate non-goal ("pi does local IO itself"), enabled 2026-09-06 after an
      investigation showed it is possible WITHOUT modifying pi. Goose (native ACP agent) routes
      its tool executions through the client; Zed tracks `fs/write_text_file` writes in its
      "edited files" review UI (diff + accept/reject). Adapter-only agents (claude-agent-acp)
      render diffs in tool cards but do not delegate; this adapter now does real delegation.

      Mechanism: pi extensions can register a tool with the SAME name as a built-in and pi's
      `_refreshToolRegistry` (agent-session.js) stores extension tools after built-ins in the
      registry map, so a same-name registration silently overrides `read`/`write`/`edit` while
      keeping the tool name (and pi's session log) unchanged. The bundled extension
      (`src/extension/pi-fs-delegate.ts`, built to `dist/pi-fs-delegate.js`) registers those
      overrides when the adapter spawns pi with `-e <ext>` plus `PI_ACP_DELEGATE_*` env vars
      (socket path/token + per-capability flags). Tool executions round-trip over a private
      local socket (`src/pi-rpc/delegate-server.ts`) to the adapter, which maps them to
      `conn.readTextFile`/`conn.writeTextFile` (`src/acp/fs-delegate.ts`).

      Behavior: `write` reads the pre-state via the client (unsaved buffer visibility,
      oldText=null when absent), mkdirs locally (ACP has no mkdir), then delegates the write;
      `edit` ports pi's exact edit semantics (BOM/CRLF/fuzzy matching, error strings,
      `details.diff`) and delegates a whole-file write; `read` delegates text (offset/limit/
      truncation applied locally, faithful continuation notices) and reads images locally
      (ACP reads are text-only). `bash` stays local. Delegated write/edit results carry
      `details.fsDelegated` with before/after content; `session.ts` emits `{type:'diff'}`
      content from those (the old disk-snapshot path would race the client's buffer flush)
      and skips the snapshot when delegation is on.

      Gating: enabled when the client advertises `fs.readTextFile`/`fs.writeTextFile`
      (capability-gated like the B3 terminal fallback); `PI_ACP_FS_DELEGATE=false` opts out;
      `PI_ACP_FS_DELEGATE_EXTENSION` overrides the extension path (falls back to local tools
      when missing). Fork ownership transfer re-attaches the bridge handler to the forked
      session id; dispose/exit tears the socket down (graceful FIN + delayed destroy — a
      synchronous destroy with unread inbound data sends RST, which surfaces as a spurious
      ECONNRESET on the pi side).

      Tests: `test/unit/fs-delegate-server.test.ts`, `test/unit/fs-delegate-config.test.ts`,
      `test/unit/fs-delegate-extension.test.ts`, `test/component/session-fs-delegate.test.ts`.
      End-to-end: `npm run smoke:fs-delegate` (real adapter + real pi + stub ACP client that
      answers `fs/write_text_file`).

      Not covered: deletions (bash territory, untracked — see D3), permission flow for
      delegated tools (see D1 — the extension `tool_call` event could interpose
      `session/request_permission` without upstream changes), pi-side approval UX for
      other extensions' tools.

## Non-goals (deliberate, per AGENTS.md)

- `mcpServers` accepted and stored, not implemented.
- `audio` prompt blocks: marker text, not supported by pi.

## Audit sources

- Repo: `src/acp/*`, `src/pi-rpc/*` (full read), test tree listing.
- Protocol: `@agentclientprotocol/sdk` 0.26.0 — `schema/schema.json`, `dist/acp.d.ts`, `dist/acp.js`.
- Pi: 0.84.4 — `dist/modes/rpc/rpc-types.d.ts` (command surface),
  `dist/core/agent-session.d.ts` + `@earendil-works/pi-agent-core/dist/types.d.ts` (event surface),
  `dist/modes/rpc/rpc-mode.js` (extension UI requests).
