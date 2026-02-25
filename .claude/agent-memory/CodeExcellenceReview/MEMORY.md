# Code Excellence Review Memory

## VLC.js Integration Architecture
- C frame server: `VLC_js/build/frame-server/frame_server.c` (new, untracked in VLC_js repo)
- Build: Emscripten with ASYNCIFY, Docker-based cross-compilation
- JS layer: VLCWorker.js -> VLCBridge.js -> VLCDecoder.js -> MediaDecoder.js
- Current JS uses `_wasm_media_player_*` bindings; `_fs_*` API not yet wired up

## Common Review Findings
- **ASYNCIFY + synchronous flag patterns**: Flags set/reset around `stop_async` calls are unsafe if the event fires asynchronously. Move flag reset to the next logical start point (e.g., play).
- **VLC event listener lifecycle**: Must explicitly detach before releasing media player. No built-in dedup on `libvlc_event_attach`.
- **Dead code risk**: New C APIs compiled into WASM but not called from JS are untestable and accumulate without validation.

## Frame Server C API -- Verified Patterns (2026-02-24)
- **`stopping` flag lifecycle**: Set to 1 in fs_open/fs_stop/fs_destroy (before stop_async), reset to 0 only in fs_play. Never reset after stop_async returns. This avoids ASYNCIFY race.
- **`eos_guarded` flag**: Set once in fs_guard_eos, checked in fs_destroy for detach. Never reset (struct freed after destroy). Prevents duplicate event_attach.Is 
- **Detach order in fs_destroy**: event_detach (conditional on eos_guarded) -> stopping=1 -> stop_async -> player_release -> media_release -> vlc_release -> free. Prevents use-after-free.
- **VLC 4.0 uses `libvlc_MediaPlayerStopping`** (not EndReached) for EOS detection. Fires on both natural EOS and programmatic stop; `stopping` flag differentiates.
- **Forward declaration of `_eos_seek_back`** at top of file enables `fs_destroy` to reference it for detach.
- **`libvlc_media_new_location(path)`** in VLC 4.0 takes 1 arg (no instance). Patched by `patch_vlcjs_wrappers.sh`.
- **Null guards in `_eos_seek_back`**: Checks `!fs || !fs->mp` defensively since VLC could invoke callback with stale data.

## Project Test Infrastructure
- Vitest for unit tests (`npm test`), config in `vite.config.js` (test block)
- `tests/vlc-integration-test.html` for manual browser-based VLC testing
- No C-level test harness for frame server (Docker cross-compile only)
- 398 tests across 12 test files (as of 2026-02-25): 67 eos-guard, 23 vlc-perf-fixes, 308 issue-acceptance including 20 issue-11 tests
- Tests needed once JS migrates to `_fs_*` API: programmatic stop vs natural EOS, double-guard idempotency, destroy teardown, re-open while playing, play re-arms stopping flag
- Test pattern: pure-logic simulations with helper functions (no browser APIs, WASM, or VideoFrame)
- Test files map 1:1 to GitHub issues: `tests/issue-{N}-*.test.js`

## EOS Guard Test Review (2026-02-24) -- PASSED on re-review
- `tests/eos-guard.test.js`: 67 tests, pure-logic simulations (no WASM/browser APIs)
- **Simulation fidelity**: All simulation functions match production code. fs_open and fs_guard_eos properly separated. fs_destroy conditionally detaches only when eos_guarded is set.
- **VLCWorker.js fixes verified**: `atEos: false` explicitly initialized in `_media.set()`.
- **Coverage thorough**: boundary values, edge cases (negative duration, zero duration, short media), state machine cycles, multi-media, integrated C+JS scenarios.
- **Minor pre-existing quirk**: `_checkEos` reschedules one unnecessary timer tick when all playing media are marked atEos in same pass (harmless).

## Review Checklist for VLC Changes
1. Verify stopping flag is set BEFORE any `stop_async` call
2. Verify stopping flag is reset ONLY in `fs_play`
3. Verify `eos_guarded` checked before `event_detach` in destroy
4. Verify null guards on all callback functions
5. Verify simulation functions match production guard conditions exactly
6. Cross-check comments against actual threshold values
7. Verify explicit initialization of all boolean state fields (no reliance on undefined falsiness)

## Issue #2 Review (2026-02-24) -- PASSED
- MediaManager.probeMedia: ALL video routes through VLC probe first, HTMLVideoElement fallback on VLC failure
- Rename _mxfProbedBridges -> _vlcProbedBridges complete (production + all test refs)
- **Known transitional gap**: Non-MXF probed bridges stored in _vlcProbedBridges are never consumed by MediaDecoder (since _shouldTryVLC still checks _isMXF). Issue #4 resolves this. Bridges leak until Issue #4 ships.
- **Missing fps in fallback**: HTMLVideoElement fallback doesn't return `fps` field (undefined). Production code handles this via `info.fps || null` in importFiles.
- **cleanup() gap**: mediaManager.cleanup() doesn't release _vlcProbedBridges. Low priority since Issue #4 changes the architecture.
- **predictedId safety**: Relies on sequential `await` in importFiles for-loop. Safe today but fragile if parallelized.
- **Test extension mismatch**: Test SUPPORTED_EXTENSIONS.VIDEO missing 'ogv' and 'm4v' vs production Constants.js.

## Issue #3 Review (2026-02-24) -- FAILED
- JS-level changes (500ms throttle, 2000ms timeout, lightweight recovery, aligned timers): all correct and consistent
- **CRITICAL BUG**: `_module._fs_guard_eos(mp)` passes `libvlc_media_player_t*` (from `_wasm_media_player_new`) to a function expecting `frame_server_t*` (from `fs_create`). Type confusion causes UB in C. Must remove until JS migrates to `_fs_*` API.
- Old timer inconsistency fixed: `_startEosCheck` was 500ms, `_checkEos` compared >400ms. Now both 2000ms.
- Test simulations match production JS logic faithfully. Test gap: cannot catch `_fs_*` vs `_wasm_*` type mismatch.
- Pre-existing quirk: `_checkEos` reschedules one extra timer tick when all media hit EOS in same pass (harmless).

## Issue #5 Review (2026-02-24) -- FAILED
- DecodeWorker removal from RenderAheadManager.js: correct and complete
- MXF branching removed from registerMedia, requestAhead, ensureBuffered, _isFrameBuffered: clean
- markMXFFrameDecoded -> markFrameDecoded rename: complete in production + MediaDecoder caller
- **CRITICAL**: `StreamCopyExtractor.js:16` still calls removed `renderAheadManager.extractPackets()`. Runtime crash on stream-copy export.
- **HIGH**: `ensureBuffered` launches all decodes unbounded (no MAX_CONCURRENT_DECODES). Old DecodeWorker serialized internally; VLC WASM may not handle 30 concurrent seeks.
- **HIGH**: ExportPipeline.js:648 stale DecodeWorker comment.
- **MEDIUM**: requestAhead concurrency limit is advisory, not hard cap (shared `_activeConcurrent` can exceed 4 via overlapping calls).
- **MEDIUM**: Hardcoded 1920x1080 in getFrame calls, project dimensions available but not used.
- **MEDIUM**: No dedup between dispatch and completion -- overlapping requestAhead calls send duplicate VLC decodes.
- Test simulations use different API signatures (mediaId+times vs currentFrame+count); sync/async behavior differs. Concurrency tests can't catch production bugs.

## Common Test Review Pitfalls (2026-02-24)
- **Synchronous mock decoders defeat concurrency tests**: If mock `getFrame` resolves instantly (no delay), concurrency tracking always shows maxConcurrent=1. Must use `decodeDelay > 0`.
- **Tautological namespace tests**: Asserting a local constant equals itself proves nothing about production code. Prefer importing actual constants or scanning source files.
- **Misleading test names**: Test name says "returns true" but assertion is `.toBe(false)`. Always cross-check name vs assertion.
- **Per-instance vs shared-instance modeling**: Testing per-media behavior with separate instances may pass even if the shared-instance implementation is broken (e.g., fs_guard_eos per-media test).
- **Incomplete dead pattern lists**: When removing code, list ALL identifiers that must be absent, not just the module-level names. `_webCodecsDecoders` is different from `WebCodecsDecoder`.
- **Race conditions in timeout tests**: `Promise.race` with decode+timeout means the decode promise continues after timeout wins. Test should verify or document post-timeout state.
- **API signature mismatch in simulations**: Test simulations that accept (mediaId, times[]) when production uses (currentFrame, count) miss all timeline-integration logic and sync/async behavioral differences.
- **Units mismatch**: Test simulation taking ms when production takes seconds (e.g., getFramesBatch). Self-consistent test passes but doesn't validate actual contract.
- **Behavioral mismatch**: Test simulation throws on all-active-no-evict; production silently allows exceeding soft limit. Test models wrong semantics.

## Issue #6 Review (2026-02-24) -- PASSED (with notes)
- PacketExtractWorker: parseAvcC and avccToAnnexB correctness verified via mental trace
- Bit-shift sign overflow guarded by `naluLength <= 0` check (correct for practical H.264 NALU sizes)
- StreamCopyExtractor properly delegates to packetExtractWorker singleton
- ExportPipeline.js imports streamCopyExtractor (not renderAheadManager.extractPackets)
- RenderAheadManager.extractPackets now lazy-imports PacketExtractWorker (circular dep avoidance)
- registerMedia uses mock data (marked for mp4box integration follow-up)
- **Pre-existing**: `ensureBuffered` uses `await` in non-async function (syntax error in strict mode, not introduced here)
- **Pre-existing**: Hardcoded 1920x1080 in getFrame calls

## Issue #7 Review (2026-02-24) -- PASSED
- WebCodecsDecoder.js and DecodeWorker.js confirmed deleted (glob returns no files)
- No stale imports: grep for WebCodecsDecoder, DecodeWorker, _mxfFiles, _mxfProbed, markMXF, isWebCodecsSupported, createWebCodecsDecoder, _webCodecsDecoders, _webCodecsInitPromises, _webCodecsFailCount, _shouldTryWebCodecs, _getFrameWebCodecs -- all clean in src/
- OPFS namespace renamed to 'vlc-frames' in VLCBridge.js (only occurrence in src/)
- Comment updates in VLCDecoder.js, MediaDecoder.js, MediaManager.js: appropriate
- WorkerMediaDecoder.js: WebCodecs references removed, VLC-only path
- **Test limitation**: Issue #7 tests check simulated sources (string constants), not actual production files. Tautological pattern -- CLEAN_SOURCES defined by the test author. Real validation done via grep above.

## Issue #8 Review (2026-02-24) -- PASSED (with notes)
- LRU eviction in VLCWorker.js: correct (soft limit 8, evict inactive LRU, flush pending requests, post media_evicted)
- lastAccessTime updated in get_frame, set_playback, seek handlers
- _evictIfNeeded called before player creation in load_file (correct ordering)
- media_evicted handler in VLCBridge.js: closes all L1 ImageBitmaps, clears cache and sortedKeys
- getFramesBatch: fires all getFrameAt concurrently via Promise.all (no concurrency limit -- acceptable for batch use)
- **MEDIUM**: VLCWorker load_file doesn't check if mediaId already exists, risking handle leak on duplicate load
- **LOW**: getFramesBatch has no concurrency limit; could flood worker with parallel seek+decode for large batches
- **Test note**: LRU simulation throws on all-active, but production silently goes over limit (behavioral mismatch)
- **Test note**: getFramesBatch simulation takes ms, production takes seconds (units mismatch)

## Issue #9 Review (2026-02-25) -- PASSED on re-review
- All 350 tests pass (25 in issue-9 file, including 6 new tests added in re-review)
- **debug_echo**: Confirmed pre-existing from c6007ab (before Issue #9). Correctly out-of-scope.
- **Zero callers**: `setClipBounds`/`clearClipBounds`/`setClipEndCallback` annotated with "NOTE: boundedMode infrastructure — callers ship in a follow-on issue" in both VLCBridge.js (public API) and VLCWorker.js (case handlers). Acceptable as documented infrastructure.
- **Multi-media break**: Added comment documenting pre-existing limitation. Accurate: "in practice only one media plays at a time (timeline playhead drives a single clip)."
- **Sub-200ms clip guard**: `if (clampedEnd - clampedStart < 200) break` added. Uses strict < 200, so exactly-200ms clip is accepted (degenerate but safe — throttle fires on first frame, no infinite loop).
- **durationMs=0 safety**: When durationMs=0, duration throttle has early return `durationMs <= 0`, so throttle is disabled. clampSeek uses raw clipEndMs in boundedMode path (correct).
- **clear_clip_bounds while paused**: Correctly restores unbounded clamping. Post-clear clampSeek(durationMs) uses 500ms media-end guard as expected.
- **Simulation fidelity**: All 5 simulation functions (durationThrottle, clampSeek, setClipBounds, clearClipBounds, checkNearEndRecovery) are exact replicas of production logic. Guard conditions identical.
- **lastSeekMs dead state**: Pre-existing, not in scope.

## Seek Dedup Fix Review (2026-02-25) -- FAILED
- Root cause correct: old dedup compared against initial `lastSeekMs` (never updated during playback), new code tracks VLC's actual decode position via `lastProducedFrameMs`
- `lastProducedFrameMs` updated in `_vlcOnDecoderFrame` callback, reset to -1 on explicit seek/set_playback
- Position-aware dedup: forward within 2s -> skip, behind within 500ms -> skip, else -> seek
- Rapid-fire dedup: 100ms cooldown as safety net
- **HIGH**: 500ms behind-tolerance too generous -- frames >100ms behind VLC decode head are gone from pipeline; causes 8s timeout. Recommend ~100ms.
- **MEDIUM**: Pending frame requests queued before dedup check -- suppressed seeks leave orphaned requests that timeout (pre-existing design)
- **LOW**: `lastSeekMs` field still written but never read for dedup (dead state)
- **NO TESTS**: Dedup logic has zero test coverage. 10 simulation tests needed.
- Attribution heuristic (first-isPlaying media) matches existing frame routing pattern -- acceptable for single-threaded VLC

## Issue #10 Review (2026-02-25) -- PASSED (final re-review)
- Bug 1 fix: `activated` flag on stream entries prevents seek-flood — VERIFIED CORRECT. `makeSSC.advancePlayback` now also includes `!stream.activated` guard (previously missing).
- Bug 2 fix: `_generation` counter checked after every `await _getBridge()` — VERIFIED CORRECT. Stale-removal block runs BEFORE first await, so cannot observe cross-generation state mutation in single-threaded JS.
- Bug 3 fix: SSC stored in `_sequenceStreamController` at init time, cleaned up synchronously in destroyEditor BEFORE eventBus.removeAll() and mediaManager.cleanup() — VERIFIED CORRECT.
- Comment typo at PlaybackEngine.js:267 fixed: `/ renderAheadManager` → proper `// renderAheadManager`.
- `makeSSC.seekPlayback` still omits `activated: false` from paused-path stream entries (line 244) — benign since paused path never calls advancePlayback in tests, but technically imprecise.
- 378 tests pass, lint clean.
- getVLCBridge() in MediaDecoder.js: correct (dec?.getBridge?.() || null)
- destroyEditor ordering: SSC cleanup before renderAheadManager.cleanup() and mediaManager.cleanup() — CORRECT

## Idle Fill Flooding Fix Review (2026-02-24) -- PASSED (with notes)
- MAX_CONCURRENT_DECODES reduced from 4 to 1 (correct for single-threaded VLC WASM)
- requestAhead now async, awaits all decodes (prevents cascading fire-and-forget)
- _failedFrames Map with 30s TTL prevents infinite retry loops
- Idle fill: 4 frames/tick, 200ms base, 2000ms backoff, async tick with gen re-check
- Concurrency control while-loop handles thundering herd correctly with MAX=1
- PlaybackEngine fire-and-forget callers safe (requestAhead cannot reject)
- ensureBuffered intentionally does NOT check _failedFrames (export needs every frame)
- ThumbnailGenerator VLC timeout: confirmed same root cause (shared VLC worker starvation)
- **MEDIUM**: No tests for _failedFrames TTL, idle fill backoff, or async tick sequencing
- **LOW**: ensureBuffered timeout timer leaks (pre-existing, not from this change)
- **LOW**: requestAhead intra-batch dedup at line 196 only checks _decodedSources, not pending dispatches

## Issue #11 Review (2026-02-25) -- PASSED
- pushFrame: async, clones bitmap via createImageBitmap, post-await race check, catch for closed bitmap
- Broadcast callback wired in MediaDecoder._getFrameVLC during VLC decoder init (same pattern as setFrameCachedCallback)
- VLCBridge fires _onBroadcastFrame AFTER _cacheFrame (L1 store) -- both share same ImageBitmap ref but pushFrame clones it
- Eviction uses `size > limit` (not `>=`), so pushFrame cannot add when buffer is at exact capacity -- deliberate opportunistic design
- Pinned state respected: pushFrame silently drops when pinned + at capacity
- _decodedSources updated by both pushFrame and markFrameDecoded (redundant but harmless -- markFrameDecoded fires first via _onFrameCached)
- pushFrame does NOT emit RENDER_BUFFER_CHANGED -- render bar update comes from markFrameDecoded (throttled at 100ms)
- Removed initPlaybackSync() from MediaDecoder -- replaced by SequenceStreamController (Issue #10)
- Added getVLCBridge(mediaId) to MediaDecoder -- used by SequenceStreamController._getBridge()
- Removed startProactiveFill call on CLIP_ADDED -- RenderAheadManager._startIdleFill achieves same result
- 20 tests, simulation fidelity verified (pushFrame, _evict, _capDecodedSources identical to production)
- Test count: 398 total (20 new in issue-11 file)
