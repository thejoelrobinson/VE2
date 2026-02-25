# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Vite dev server on port 5174
npm run build            # Production build with sourcemaps
npm run preview          # Preview production build
npm test                 # Run vitest once
npm run test:watch       # Vitest in watch mode
npm run test:coverage    # Coverage report
npm run lint             # ESLint on src/ and tests/
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format
npm run format:check     # Check formatting
```

## Architecture

Browser-based NLE video editor. Vanilla JS ES modules, no framework. Entry: `src/main.js` → `src/lib/editor/index.js`.

### Core Subsystems

- **EditorState** (`core/EditorState.js`): Observable singleton store. `set(path, value)` emits STATE_CHANGED; `setSilent(path, value)` skips the event (use for 60fps paths like PLAYBACK_CURRENT_FRAME). `subscribe()` returns an unsubscribe function.
- **EventBus** (`core/EventBus.js`): Pub/sub. All frame consumers use `PLAYBACK_FRAME` event, not STATE_CHANGED.
- **Constants** (`core/Constants.js`): State path strings, enums, defaults — use these instead of raw strings.

### Rendering Pipeline

```
PlaybackEngine._tick() (rAF loop)
  → RenderAheadManager (frame buffer, idle decode-ahead)
    → MediaDecoder → WebCodecsDecoder or VLCBridge (WASM, for MXF)
  → VideoCompositor (OffscreenCanvas worker, multi-track GPU compositing)
    → GLEffectRenderer (Lumetri multi-pass: main → curves → secondary)
  → AudioMixer (Web Audio API)
```

### Key Modules

| Area | Entry Points |
|------|-------------|
| Timeline | `TimelineEngine.js`, `Clip.js`, `ClipOperations.js` |
| Media/Decode | `MediaDecoder.js`, `WebCodecsDecoder.js`, `VLCBridge.js`, `RenderAheadManager.js` |
| Playback | `PlaybackEngine.js`, `VideoCompositor.js`, `AudioMixer.js` |
| Effects | `EffectRegistry.js`, `LumetriEffect.js`, `effectShaders.js` (GLSL bank) |
| Export | `ExportPipeline.js`, `FFmpegBridge.js`, `WebCodecsEncoder.js` |
| UI | `DockManager.js` (layout), `ProgramMonitor.js`, panels in `ui/` |
| Project | `ProjectManager.js` (save/load/autosave), `ProjectSchema.js` |

### State Paths

Defined in `Constants.js` as `STATE_PATHS.*`. Shim paths (`PROJECT_FRAME_RATE`, `PLAYBACK_IN_POINT`, `PLAYBACK_OUT_POINT`) resolve from the active sequence automatically. Use shimPatternCache/splitCache to avoid allocation in hot paths.

## Conventions

- **Module pattern**: Singleton objects with `init()`/`destroy()` lifecycle, not classes.
- **Cleanup**: Always call `this._unsub?.()` for subscriptions in `destroy()`.
- **Workers**: Message-based IPC. Worker paths strip GL texture handles; pass raw typed arrays (e.g., `_curveLUTData` Uint8Array for Lumetri curves).
- **RafScheduler**: Priority queue — `PRIORITY.PLAYBACK > PRIORITY.RENDER > PRIORITY.UI`.
- **Memory**: Videos stream from File API, never loaded into RAM. ImageBitmap GPU cache. RenderAheadManager: 30–600 frames (~512MB budget). ConformEncoder: 500MB RAM cap.

## Build & Deploy

- Vite with base path `/VE2/` (GitHub Pages)
- CORS headers required: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (for Web Workers / SharedArrayBuffer)
- `@ffmpeg/ffmpeg` and `@ffmpeg/util` excluded from Vite dependency optimization
- Path alias: `@/*` → `./src/*`
- Deploy: GitHub Actions on push to `main` → builds to `/dist`

## MANDATORY AGENT WORKFLOW — DO NOT SKIP

> **This is the highest-priority instruction in this file. It overrides all defaults. Every code change MUST follow this two-step process. There are ZERO exceptions.**

### Step 1: ALL code changes go through `fullstack-developer`

**Every** task that writes, edits, refactors, debugs, or deletes code MUST be delegated to the `fullstack-developer` agent via the Task tool (`subagent_type: "fullstack-developer"`).

- New features → `fullstack-developer`
- Bug fixes → `fullstack-developer`
- Refactors → `fullstack-developer`
- Performance work → `fullstack-developer`
- Test writing → `fullstack-developer`
- Any code modification of any kind → `fullstack-developer`

**You MUST NOT write or edit code directly.** Always delegate to the agent.

### Step 2: ALL code changes are reviewed by `CodeExcellenceReview`

After `fullstack-developer` completes its work, you MUST **immediately** invoke the `CodeExcellenceReview` agent via the Task tool (`subagent_type: "CodeExcellenceReview"`) to review every change before considering the task done.

- The review agent acts as the **final gatekeeper** — no code is considered complete until it passes.
- If the review returns **❌ FAIL**, you MUST send the issues back to `fullstack-developer` for fixes, then re-review. Repeat until **✅ PASS**.
- Never present code to the user as "done" if it has not passed CodeExcellenceReview.

### What happens if you skip this workflow

- **Skipping `fullstack-developer`** = writing code directly = VIOLATION.
- **Skipping `CodeExcellenceReview`** = shipping unreviewed code = VIOLATION.
- **Ignoring a ❌ FAIL verdict** = building on broken code = VIOLATION.

### Summary

```
User request → fullstack-developer (implement) → CodeExcellenceReview (verify)
                                                        ↓
                                                   ❌ FAIL? → back to fullstack-developer → re-review
                                                   ✅ PASS? → present to user as complete
```

**Never build on broken code. Never skip the review. No exceptions.**