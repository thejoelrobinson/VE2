# Fullstack Developer Agent Memory

## RenderAheadManager (Issue #5 refactor + VLC idle-fill fix)
- DecodeWorker removed. All frame decoding now routes through `mediaDecoder.getFrame()` directly.
- No MXF special cases remain -- all formats use unified code paths.
- `MAX_CONCURRENT_DECODES` = 1 (VLC WASM is single-threaded; was 4 when using WebCodecs DecodeWorker).
- `requestAhead(currentFrame, count)` is now async -- awaits all decode promises before returning (was fire-and-forget).
- `_failedFrames` Map tracks decode failures with 30s TTL to prevent infinite retry loops.
- Idle fill tuned for VLC: 4 frames/tick (was 30), 200ms interval (was 50ms), 2000ms backoff when no frames sent.
- `_idleFillTick` is async -- awaits `requestAhead` before scheduling next tick (prevents unbounded cascading).
- `_failedFrames` cleared in `cleanup()` and `_invalidateAll()`.
- `ensureBuffered(startFrame, count)` uses `Promise.all` + `Promise.race` timeout (5s).
- `markFrameDecoded(mediaId, timeMs)` -- renamed from `markMXFFrameDecoded`. Caller in MediaDecoder.js updated.
- `_renderBarThrottle` -- renamed from `_mxfRenderBarThrottle`.
- `extractPackets()` now delegates to `PacketExtractWorker.js` via lazy import (Issue #6 complete).

## PacketExtractWorker (Issue #6)
- Location: `src/lib/editor/media/PacketExtractWorker.js`
- Exports: `parseAvcC(avcCData)`, `avccToAnnexB(avccData, naluLengthSize, options)`, `createPacketExtractWorker()`, `packetExtractWorker` (singleton)
- `parseAvcC` returns `{ spsNalus, ppsNalus, naluLengthSize }` from raw avcC box data.
- `avccToAnnexB` converts AVCC (length-prefixed) NALUs to Annex B (00 00 00 01 start codes). Supports 3/4-byte length prefixes, optional SPS/PPS prepend.
- `createPacketExtractWorker()` returns instance with `registerMedia`, `extractPackets`, `close`, `_media` (Map).
- MXF files rejected gracefully in `registerMedia` (mp4box cannot parse).
- `StreamCopyExtractor.js` updated to import `packetExtractWorker` directly (no longer routes through RenderAheadManager).
- `RenderAheadManager.extractPackets()` kept as lazy-import delegate for backward compat.

## MediaDecoder
- All media routes through VLC.js WASM backend (Issue #4).
- `_getFrameVLC()` calls `ram.markFrameDecoded()` via bridge callback.
- Lazy-import of RenderAheadManager to break circular dependency.
- `getVLCBridge(mediaId)` — public accessor added in Issue #10 for SSC.
- `initPlaybackSync()` removed (Issue #10); replaced by SequenceStreamController.

## SequenceStreamController (Issue #10)
- Location: `src/lib/editor/playback/SequenceStreamController.js`
- Singleton with `init()` / `cleanup()` lifecycle matching CLAUDE.md conventions.
- Replaces `MediaDecoder.initPlaybackSync()` — timeline-aware, per-clip VLC stream orchestration.
- `_activeStreams: Map<trackId_clipId, StreamEntry>` — live stream registry.
- `buildClipSchedule(currentFrame, lookahead=60)` — pure function; returns active + pre-roll entries.
- `startPlayback(frame)` — teardown all, rebuild, activate active clips + pre-roll upcoming ones.
- `advancePlayback(currentFrame)` — called every 5 frames from PlaybackEngine._tick(); deactivates stale, promotes pre-roll to active.
- `seekPlayback(frame)` — playing → startPlayback; paused → bounds + syncSeek.
- `stopPlayback()` / `onClipEndReached(trackId, clipId)` — stream teardown.
- Same-mediaId conflict: second clip gets `bridge: null`, falls back to RenderAheadManager.
- Lazy import of MediaDecoder via `_getMediaDecoder()` to break circular dep chain.
- `ADVANCE_INTERVAL = 5` exported — matches PlaybackEngine's requestAhead throttle cadence.
- `_teardownAll()` collects stale keys before deletion to avoid mutating Map during iteration.
- PlaybackEngine._tick() wires: `_getSSC()?.advancePlayback(targetFrame)` before `requestAhead`.
- index.js: SSC `init()` on startup, `cleanup()` on `destroyEditor()`.
- 25 pure-logic tests in `tests/issue-10-sequence-stream-controller.test.js`.

## Broadcast Frame Routing (Issue #11)
- VLCBridge: `_onBroadcastFrame` callback fires on every 'frame' message, after `_cacheFrame` but before OPFS.
- `setBroadcastFrameCallback(fn)` on VLCBridge public API.
- RenderAheadManager: `pushFrame(mediaId, timeMs, bitmap)` -- async, clones bitmap via `createImageBitmap`.
- pushFrame is opportunistic: silently drops frames when buffer is at capacity (`_evict` uses `size > limit`, not `>=`).
- Race safety: post-await re-check of `_frameBuffer.has(key)`, closes clone if race lost.
- MediaDecoder wires the callback in `_getFrameVLC()` init block, reusing `capturedId` closure.
- 20 pure-logic tests in `tests/issue-11-broadcast-frame-routing.test.js`.
