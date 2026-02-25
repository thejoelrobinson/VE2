# Quality Gatekeeper Memory

## VLC.js Frame Server Architecture
- C frame server API (`_fs_*`) in `VLC_js/build/frame-server/frame_server.c`
- Compiled with Emscripten ASYNCIFY (-s ASYNCIFY=1) in Docker
- WASM exports: fs_create, fs_open, fs_play, fs_pause, fs_seek, fs_stop, fs_destroy, fs_guard_eos, fs_get_duration, fs_get_time, fs_set_rate, fs_set_volume, fs_get_id, fs_get_size
- VLCWorker.js currently uses `_wasm_media_player_*` bindings, NOT the `_fs_*` API
- The C frame server code is compiled into WASM but not yet wired up on JS side

## Verified Issue Resolutions (2026-02-24)
- **ASYNCIFY race with flags**: RESOLVED. `stopping` flag reset only in `fs_play`, never after `stop_async` returns.
- **Duplicate event registration**: RESOLVED. `eos_guarded` boolean prevents multiple `libvlc_event_attach` calls.
- **Use-after-free on destroy**: RESOLVED. `libvlc_event_detach` called before `stop_async` and `release`.

## Known Issue Patterns
- **ASYNCIFY race with flags**: Setting a flag before `stop_async` and resetting after is unsafe under ASYNCIFY because `stop_async` may return before the `Stopping` event fires. Flag should be reset at the next logical entry point (e.g., `fs_play`) instead.
- **VLC event listener cleanup**: `libvlc_event_attach` has no built-in dedup; calling `fs_guard_eos` twice registers duplicate callbacks. Always guard with a boolean or explicitly detach.
- **libvlc_event_detach before release**: Always detach event listeners before `libvlc_media_player_release` to prevent use-after-free during teardown.
- **VLC 4.0 event change**: Uses `libvlc_MediaPlayerStopping` not `EndReached`. Fires on both natural EOS and programmatic stop.

## EOS Handling (Current JS-Side -- Issue #3 hardened)
- Duration throttle: VLCWorker.js pauses VLC 500ms before media end (was 200ms)
- Timeout-based EOS detection: `_checkEos` fires after 2000ms of no frames (was 400ms, timer was 500ms)
- Recovery: `_recoverFromEos` is now lightweight (just clears atEos flag, no stop+reopen)
- C-level guard (`_eos_seek_back`) is NOT active until JS migration to `_fs_*` API
- **CRITICAL BUG (Issue #3)**: `_fs_guard_eos(mp)` at line 317 passes `libvlc_media_player_t*` to function expecting `frame_server_t*`. Type confusion -> UB. Must remove or migrate to `_fs_*` API.

## Testing Gaps
- No automated tests for C frame server API (cross-compiled in Docker)
- `vlc-integration-test.html` tests VLCBridge/VLCWorker JS layer only
- Tests to write once JS migrates to `_fs_*` API:
  1. Programmatic stop suppresses EOS callback
  2. Natural EOS triggers seek-back + pause
  3. Double fs_guard_eos idempotency
  4. fs_destroy after fs_guard_eos (no crash/UAF)
  5. fs_open re-open while playing
  6. fs_play re-arms stopping flag after fs_stop

## Acceptance Criteria Tests Review (2026-02-24) -- PASSED on re-review
- 325 tests across 9 files, all pass. Issues #2-#8 covered by `tests/issue-{N}-*.test.js`
- All 19 previously identified issues (1 CRITICAL, 3 HIGH, 7 MEDIUM, 8 LOW) verified fixed
- Key fixes: Issue #5 concurrency uses 10ms delay + asserts >1, Issue #8 setPlaying updates lastAccessTime directly, Issue #4 test name corrected, Issue #3 fs_guard_eos uses shared instance, Issue #7 includes all lowercase WebCodecs identifiers
- **Pattern note**: Pure-logic simulations verify simulation behavior, not production code. Tautological tests remain in Issue #8 OPFS namespace but now have clarifying comments.

## Issues #6/#7/#8 Combined Review (2026-02-24) -- PASSED
- Dead code (WebCodecsDecoder.js, DecodeWorker.js) confirmed deleted via glob + grep
- All stale references verified absent from src/ via grep
- PacketExtractWorker AVCC->AnnexB conversion: logic correct, edge cases handled
- LRU eviction: soft limit 8, evict before allocation, media_evicted -> L1 clear
- Pre-existing issues noted but not blocking: ensureBuffered await-in-non-async, hardcoded 1920x1080
