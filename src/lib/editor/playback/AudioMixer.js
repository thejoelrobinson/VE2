// Web Audio API multi-track audio mixing with effects chain
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import {
  clipContainsFrame,
  getSourceFrameAtPlayhead,
  getClipDuration,
  getClipEndFrame
} from '../timeline/Clip.js';
import { frameToSeconds, secondsToFrame } from '../timeline/TimelineMath.js';
import { mediaManager } from '../media/MediaManager.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { getTransitionZone } from '../effects/Transitions.js';
import { clamp } from '../core/MathUtils.js';
import { denoiseBuffer } from '../effects/RNNoiseProcessor.js';
import logger from '../../utils/logger.js';

export const audioMixer = {
  _ctx: null,
  _masterGain: null,
  _masterAnalyser: null,
  _trackGains: new Map(), // trackId -> GainNode
  _trackAnalysers: new Map(), // trackId -> AnalyserNode
  _clipSources: new Map(), // clipId -> { source, gainNode, effectNodes, mediaElement }
  _audioBuffers: new Map(), // mediaId -> AudioBuffer
  _pendingClips: new Set(), // Async guard: prevents duplicate _startClipAudio during _loadAudioBuffer await
  _isPlaying: false,
  _unsubs: [], // Event listener unsub functions

  init() {
    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._masterGain = this._ctx.createGain();

    // Master analyser for metering
    this._masterAnalyser = this._ctx.createAnalyser();
    this._masterAnalyser.fftSize = 256;
    this._masterAnalyser.smoothingTimeConstant = 0.8;
    this._masterGain.connect(this._masterAnalyser);
    this._masterAnalyser.connect(this._ctx.destination);

    this._unsubs.push(eventBus.on(EDITOR_EVENTS.PLAYBACK_START, () => this._onPlayStart()));
    this._unsubs.push(eventBus.on(EDITOR_EVENTS.PLAYBACK_STOP, () => this._onPlayStop()));
    this._unsubs.push(eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, ({ frame }) => this._onSeek(frame)));
    this._unsubs.push(eventBus.on(EDITOR_EVENTS.PLAYBACK_FRAME, ({ frame }) => this._onFrame(frame)));
    this._unsubs.push(eventBus.on(EDITOR_EVENTS.PLAYBACK_SPEED_CHANGED, ({ speed }) => this._onSpeedChanged(speed)));
    this._unsubs.push(
      eventBus.on(EDITOR_EVENTS.CLIP_SPLIT, ({ original, newClip }) => {
        // Tear down stale audio sources for ALL clips affected by the split:
        // 1. The original clip (boundaries shortened)
        // 2. Its linked audio partner (also shortened by the linked split)
        // 3. The new clip's linked partner (freshly created, shouldn't have a source yet but be safe)
        this._teardownClipSource(original.id);
        if (original.linkedClipId) this._teardownClipSource(original.linkedClipId);
        if (newClip?.linkedClipId) this._teardownClipSource(newClip.linkedClipId);
      })
    );

    logger.info('AudioMixer initialized');
  },

  getContext() {
    return this._ctx;
  },

  isPlaying() {
    return this._isPlaying;
  },

  setMasterVolume(value) {
    if (this._masterGain) {
      this._masterGain.gain.setValueAtTime(clamp(value, 0, 1), this._ctx.currentTime);
    }
  },

  setTrackVolume(trackId, value) {
    const gain = this._getTrackGain(trackId);
    gain.gain.setValueAtTime(clamp(value, 0, 1), this._ctx.currentTime);
  },

  _getTrackGain(trackId) {
    let gain = this._trackGains.get(trackId);
    if (!gain) {
      gain = this._ctx.createGain();
      // Insert analyser between track gain and master gain
      const analyser = this._ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      gain.connect(analyser);
      analyser.connect(this._masterGain);
      this._trackAnalysers.set(trackId, analyser);
      this._trackGains.set(trackId, gain);
    }
    return gain;
  },

  getMasterAnalyser() {
    return this._masterAnalyser;
  },

  getTrackAnalyser(trackId) {
    return this._trackAnalysers.get(trackId) || null;
  },

  getTrackAnalysers() {
    return this._trackAnalysers;
  },

  async _loadAudioBuffer(mediaItem) {
    if (this._audioBuffers.has(mediaItem.id)) {
      return this._audioBuffers.get(mediaItem.id);
    }
    // LRU eviction: cap cache at 50 buffers to prevent unbounded memory growth
    if (this._audioBuffers.size >= 50) {
      const firstKey = this._audioBuffers.keys().next().value;
      this._audioBuffers.delete(firstKey);
    }
    try {
      // MXF: use extracted WAV audio; other formats: use media URL directly
      if (mediaItem.name?.toLowerCase().endsWith('.mxf') && !mediaItem.audioUrl) {
        logger.info(`[AudioMixer] MXF audio not yet extracted for ${mediaItem.name}, skipping`);
        return null;
      }
      const audioSrc = mediaItem.audioUrl || mediaItem.url;
      const response = await fetch(audioSrc);
      if (!response.ok) {
        logger.warn(`[AudioMixer] Fetch failed for ${mediaItem.name}: HTTP ${response.status}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this._ctx.decodeAudioData(arrayBuffer);
      this._audioBuffers.set(mediaItem.id, audioBuffer);
      return audioBuffer;
    } catch (err) {
      logger.warn(`[AudioMixer] Audio decode failed for ${mediaItem.name}:`, err);
      return null;
    }
  },

  async _onPlayStart() {
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }
    this._isPlaying = true;
    this._scheduleAudio();
  },

  _onPlayStop() {
    this._isPlaying = false;
    this._stopAllSources();
  },

  _onSeek() {
    // AudioBufferSourceNode can't seek — teardown and restart at new position
    if (this._isPlaying) {
      this._stopAllSources();
      this._scheduleAudio();
    }
  },

  _onFrame(frame) {
    if (!this._isPlaying) return;
    this._updateActiveSources(frame);
  },

  _onSpeedChanged(speed) {
    for (const [clipId, info] of this._clipSources) {
      const clip = timelineEngine.getClip(clipId);
      if (!clip) continue;
      const rate = speed * clip.speed;
      // AudioBufferSourceNode uses .playbackRate AudioParam
      if (info.source.playbackRate) {
        info.source.playbackRate.value = rate;
      }
    }
  },

  _scheduleAudio() {
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const tracks = timelineEngine.getTracks();

    for (const track of tracks) {
      if (track.type !== TRACK_TYPES.AUDIO) continue;
      if (track.muted) continue;

      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;

        this._startClipAudio(clip, track, frame);
      }
    }
  },

  async _startClipAudio(clip, track, currentFrame) {
    if (this._ctx.state === 'closed') {
      logger.warn('[AudioMixer] AudioContext closed, cannot start clip audio');
      return;
    }
    const mediaItem = mediaManager.getItem(clip.mediaId);
    if (!mediaItem) return;

    // If this clip already has a live source or is being started, skip
    if (this._clipSources.has(clip.id) || this._pendingClips.has(clip.id)) return;

    this._pendingClips.add(clip.id);
    try {
      // Decode audio via fetch + decodeAudioData (bypasses CORS/COEP issues
      // that plague createMediaElementSource under COEP: require-corp headers)
      const audioBuffer = await this._loadAudioBuffer(mediaItem);
      if (!audioBuffer) {
        logger.warn(`[AudioMixer] No audio buffer for clip ${clip.id}`);
        return;
      }

      // Re-read the current frame AFTER the async load. The playhead may have
      // advanced significantly during fetch + decodeAudioData (100-1000 ms for
      // large files), so using the original `currentFrame` would start audio at
      // the wrong position and cause A/V desync.
      const liveFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

      // If clip was torn down, context closed, or playhead left the clip, abort
      if (!this._isPlaying || this._ctx.state === 'closed' || this._clipSources.has(clip.id)) return;
      if (!clipContainsFrame(clip, liveFrame)) return;

      const sourceFrame = getSourceFrameAtPlayhead(clip, liveFrame);
      const sourceTime = frameToSeconds(sourceFrame);
      const speed = editorState.get(STATE_PATHS.PLAYBACK_SPEED) * clip.speed;

      const source = this._ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = speed;

      const gainNode = this._ctx.createGain();
      const volFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
      gainNode.gain.value = volFx ? volFx.params.gain / 100 : (clip.volume ?? 1);

      // Build audio effect chain: source -> [effects] -> gain -> [intrinsics] -> trackGain
      const { nodes: effectNodes, nodesByEffectId } = this._buildAudioEffectChain(clip, this._ctx, currentFrame);
      let lastNode = source;
      for (const node of effectNodes) {
        if (node.input && node.output) {
          lastNode.connect(node.input);
          lastNode = node.output;
        } else {
          lastNode.connect(node);
          lastNode = node;
        }
      }
      lastNode.connect(gainNode);

      // Wire intrinsic audio effects (panner, channel-volume) after gain
      const intrinsicAudioNodes = this._buildIntrinsicAudioChain(clip, this._ctx, currentFrame);
      lastNode = gainNode;
      for (const node of intrinsicAudioNodes) {
        if (node.input && node.output) {
          lastNode.connect(node.input);
          lastNode = node.output;
        } else {
          lastNode.connect(node);
          lastNode = node;
        }
      }
      lastNode.connect(this._getTrackGain(track.id));

      // Store effect count and param hash for change detection
      const effectCount = (clip.effects || []).length;
      const effectHash = this._hashEffectParams(clip);

      const sourceInfo = {
        source,
        gainNode,
        effectNodes,
        nodesByEffectId,
        intrinsicAudioNodes,
        mediaElement: source, // BufferSource (for compat with teardown)
        effectCount,
        effectHash
      };
      this._clipSources.set(clip.id, sourceInfo);

      // Start playback at the correct offset
      const clipDuration = audioBuffer.duration - sourceTime;
      if (clipDuration > 0) {
        source.start(0, sourceTime);
      }
    } catch (err) {
      logger.warn(`Failed to start audio for clip ${clip.id}:`, err);
    } finally {
      this._pendingClips.delete(clip.id);
    }
  },

  _buildAudioEffectChain(clip, audioCtx, frame) {
    const nodes = [];
    const nodesByEffectId = new Map(); // fx.id -> node (for apply() lookup)
    const effects = (clip.effects || []).filter(fx => fx.enabled && !fx.intrinsic);
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;

    for (const fx of effects) {
      const def = effectRegistry.get(fx.effectId);
      if (!def || def.type !== 'audio') continue;

      const params = keyframeEngine.resolveParams(fx, frame);
      params.frameRate = fps;

      if (def.createNode) {
        try {
          const node = def.createNode(audioCtx, params);
          if (node) {
            nodes.push(node);
            nodesByEffectId.set(fx.id, node); // Use fx.id (unique instance id)
          }
        } catch (err) {
          logger.warn(`[AudioMixer] createNode failed for ${fx.effectId}:`, err);
        }
      }
    }

    return { nodes, nodesByEffectId };
  },

  _getIntrinsicAudioEffects(clip) {
    return (clip.effects || []).filter(
      fx =>
        fx.enabled &&
        fx.intrinsic &&
        fx.effectId !== 'audio-volume' &&
        fx.effectId !== 'opacity' &&
        fx.effectId !== 'motion' &&
        fx.effectId !== 'time-remap'
    );
  },

  _buildIntrinsicAudioChain(clip, audioCtx, frame) {
    const nodes = [];
    const nodeMap = new Map(); // effectId -> node, for per-frame automation
    const intrinsics = this._getIntrinsicAudioEffects(clip);

    for (const fx of intrinsics) {
      const def = effectRegistry.get(fx.effectId);
      if (!def || def.type !== 'audio' || !def.createNode) continue;

      const params = keyframeEngine.resolveParams(fx, frame);
      const node = def.createNode(audioCtx, params);
      if (node) {
        nodes.push(node);
        nodeMap.set(fx.effectId, node);
      }
    }

    // Attach map for automation lookups
    nodes._nodeMap = nodeMap;
    return nodes;
  },

  _updateActiveSources(frame) {
    const tracks = timelineEngine.getTracks();

    // Teardown clips that are no longer active (prevents source accumulation)
    const toTeardown = [];
    for (const [clipId] of this._clipSources) {
      const clip = timelineEngine.getClip(clipId);
      if (!clip || !clipContainsFrame(clip, frame)) {
        toTeardown.push(clipId);
      }
    }
    for (const clipId of toTeardown) {
      this._teardownClipSource(clipId);
    }

    // Start clips that should be playing
    for (const track of tracks) {
      if (track.type !== TRACK_TYPES.AUDIO) continue;
      if (track.muted) continue;
      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;
        if (!this._clipSources.has(clip.id)) {
          this._startClipAudio(clip, track, frame);
        }
      }
    }

    // Detect effect list OR parameter changes and rebuild audio graph if needed
    const toRebuild = [];
    for (const [clipId, info] of this._clipSources) {
      const clip = timelineEngine.getClip(clipId);
      if (!clip || !clipContainsFrame(clip, frame)) continue;

      // Check effect count change
      const currentCount = (clip.effects || []).length;
      if (currentCount !== info.effectCount) {
        toRebuild.push({ clipId, clip });
        continue;
      }

      // Check effect parameter hash change (for live Essential Audio updates)
      const currentHash = this._hashEffectParams(clip);
      if (currentHash !== info.effectHash) {
        toRebuild.push({ clipId, clip });
      }
    }
    for (const { clipId, clip } of toRebuild) {
      const track = timelineEngine.getTrack(clip.trackId);
      this._teardownClipSource(clipId);
      if (track) this._startClipAudio(clip, track, frame);
    }

    // Per-frame intrinsic audio updates (keyframe automation)
    for (const [clipId, info] of this._clipSources) {
      const clip = timelineEngine.getClip(clipId);
      if (!clip || !clipContainsFrame(clip, frame)) continue;

      // Volume
      const volFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
      if (volFx) {
        const params = keyframeEngine.resolveParams(volFx, frame);
        info.gainNode.gain.value = params.gain / 100;
      }

      // Panner + Channel Volume automation on intrinsic nodes (map-based lookup)
      if (info.intrinsicAudioNodes?._nodeMap) {
        const nodeMap = info.intrinsicAudioNodes._nodeMap;
        const intrinsics = this._getIntrinsicAudioEffects(clip);
        for (const fx of intrinsics) {
          const def = effectRegistry.get(fx.effectId);
          if (!def || def.type !== 'audio' || !def.apply) continue;
          const node = nodeMap.get(fx.effectId);
          if (!node) continue;
          const params = keyframeEngine.resolveParams(fx, frame);
          def.apply(this._ctx, params, node);
        }
      }

      // Per-frame user audio effect updates (live slider feedback)
      if (info.nodesByEffectId) {
        const userEffects = (clip.effects || []).filter(fx => fx.enabled && !fx.intrinsic);
        for (const fx of userEffects) {
          const def = effectRegistry.get(fx.effectId);
          if (!def || def.type !== 'audio' || !def.apply) continue;
          const node = info.nodesByEffectId.get(fx.id);
          if (node) {
            const params = keyframeEngine.resolveParams(fx, frame);
            def.apply(this._ctx, params, node);
          }
        }
      }
    }

    // Audio crossfade during transitions (constant power)
    for (const track of tracks) {
      if (!track.transitions) continue;
      for (const trans of track.transitions) {
        const clipA = track.clips.find(c => c.id === trans.clipAId);
        const clipB = track.clips.find(c => c.id === trans.clipBId);
        if (!clipA || !clipB) continue;
        const editPoint = getClipEndFrame(clipA);
        const { start, end } = getTransitionZone(trans, editPoint);
        if (frame < start || frame >= end) continue;
        const progress = clamp((frame - start) / trans.duration, 0, 1);
        const fadeA = Math.cos((progress * Math.PI) / 2);
        const fadeB = Math.sin((progress * Math.PI) / 2);
        const now = this._ctx.currentTime;
        const smoothing = 0.005; // 5ms time constant to avoid zipper noise
        const infoA = this._clipSources.get(trans.clipAId);
        const infoB = this._clipSources.get(trans.clipBId);
        if (infoA) {
          infoA.gainNode.gain.setTargetAtTime(infoA.gainNode.gain.value * fadeA, now, smoothing);
        }
        if (infoB) {
          infoB.gainNode.gain.setTargetAtTime(infoB.gainNode.gain.value * fadeB, now, smoothing);
        }
        // Linked audio partners
        if (clipA?.linkedClipId) {
          const linked = this._clipSources.get(clipA.linkedClipId);
          if (linked)
            linked.gainNode.gain.setTargetAtTime(
              linked.gainNode.gain.value * fadeA,
              now,
              smoothing
            );
        }
        if (clipB?.linkedClipId) {
          const linked = this._clipSources.get(clipB.linkedClipId);
          if (linked)
            linked.gainNode.gain.setTargetAtTime(
              linked.gainNode.gain.value * fadeB,
              now,
              smoothing
            );
        }
      }
    }
  },

  _hashEffectParams(clip) {
    // Create a hash of audio effect IDs and enable states (not params)
    // Essential Audio params are updated live via apply(), so only rebuild
    // the graph when effects are added/removed/enabled/disabled
    const audioEffects = (clip.effects || []).filter(fx => {
      const def = effectRegistry.get(fx.effectId);
      return def && def.type === 'audio';
    });
    // Use string concatenation instead of JSON.stringify for performance
    return audioEffects.map(fx => `${fx.effectId}:${fx.enabled ? '1' : '0'}`).join('|');
  },

  _teardownClipSource(clipId) {
    const info = this._clipSources.get(clipId);
    if (!info) return;
    try {
      // Stop the source (AudioBufferSourceNode uses stop(), HTMLAudioElement uses pause())
      if (info.source.stop) {
        try { info.source.stop(); } catch (_) {} // stop() throws if already stopped
      } else if (info.mediaElement?.pause) {
        info.mediaElement.pause();
      }
      info.source.disconnect();
      if (info.effectNodes) {
        for (const node of info.effectNodes) this._disconnectNode(node);
      }
      info.gainNode.disconnect();
      if (info.intrinsicAudioNodes) {
        for (const node of info.intrinsicAudioNodes) this._disconnectNode(node);
      }
    } catch (e) {
      logger.warn('[AudioMixer] Teardown error:', e.message);
    }
    this._clipSources.delete(clipId);
  },

  _stopAllSources() {
    this._pendingClips.clear();
    for (const clipId of [...this._clipSources.keys()]) {
      this._teardownClipSource(clipId);
    }
  },

  _disconnectNode(node) {
    if (node.input && node.output) {
      try {
        node.input.disconnect();
      } catch (_) {}
      try {
        node.output.disconnect();
      } catch (_) {}
      // Disconnect internal nodes from compound chains (channel-volume, essential-audio)
      if (node._gainL)
        try {
          node._gainL.disconnect();
        } catch (_) {}
      if (node._gainR)
        try {
          node._gainR.disconnect();
        } catch (_) {}
      if (node._nodeMap) {
        for (const [key, n] of Object.entries(node._nodeMap)) {
          if (key === '_denoiser' && n && typeof n.destroy === 'function') {
            try {
              n.node.disconnect();
            } catch (_) {}
            n.destroy();
          } else {
            try {
              if (n && typeof n.disconnect === 'function') n.disconnect();
            } catch (_) {}
          }
        }
      }
    } else {
      try {
        node.disconnect();
      } catch (_) {}
    }
  },

  // Render audio mixdown to a buffer (for export)
  async mixdownToBuffer(startFrame, endFrame) {
    if (!this._ctx) {
      logger.warn('AudioMixer not initialized — cannot mix audio for export');
      return null;
    }

    // Ensure AudioContext is alive (may be suspended if user never played)
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
    const duration = frameToSeconds(endFrame - startFrame);
    const sampleRate = this._ctx.sampleRate;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

    const tracks = timelineEngine.getTracks();
    const clipGainNodes = new Map(); // clipId -> gainNode for crossfade
    let audioClipCount = 0;
    let decodedClipCount = 0;

    // Parallel pre-load: fetch + decode all unique audio sources at once
    const neededMedia = new Map();
    for (const track of tracks) {
      if (track.type !== TRACK_TYPES.AUDIO || track.muted) continue;
      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (getClipEndFrame(clip) <= startFrame || clip.startFrame >= endFrame) continue;
        const item = mediaManager.getItem(clip.mediaId);
        if (item && !neededMedia.has(item.id)) neededMedia.set(item.id, item);
      }
    }
    await Promise.all(Array.from(neededMedia.values()).map(item => this._loadAudioBuffer(item)));

    for (const track of tracks) {
      if (track.type !== TRACK_TYPES.AUDIO) continue;
      if (track.muted) continue;

      for (const clip of track.clips) {
        if (clip.disabled) continue;
        const clipStart = clip.startFrame;
        const clipEnd = getClipEndFrame(clip);

        // Check overlap with render range
        if (clipEnd <= startFrame || clipStart >= endFrame) continue;

        audioClipCount++;
        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem) {
          logger.warn(`Audio mixdown: clip ${clip.id} has no media item`);
          continue;
        }

        let buffer = await this._loadAudioBuffer(mediaItem);
        if (!buffer) {
          logger.warn(`Audio mixdown: failed to decode audio for "${mediaItem.name}"`);
          continue;
        }
        decodedClipCount++;

        // Apply AI noise suppression for export if Enhance Speech is enabled
        const eaFx = (clip.effects || []).find(
          fx => fx.effectId === 'essential-audio' && fx.enabled
        );
        if (eaFx && eaFx.params.clarity_enhance) {
          try {
            buffer = await denoiseBuffer(offlineCtx, buffer);
          } catch (e) {
            logger.warn(
              `[AudioMixer] RNNoise export denoise failed for "${mediaItem.name}":`,
              e.message
            );
          }
        }

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;

        // Use intrinsic volume effect
        const volFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
        const gainNode = offlineCtx.createGain();
        const baseGain = volFx ? volFx.params.gain / 100 : (clip.volume ?? 1);
        gainNode.gain.value = baseGain;

        // Schedule volume keyframe ramps (anchor required before linearRamp per Web Audio spec)
        if (volFx?.keyframes?.gain?.length > 0) {
          const kfs = [...volFx.keyframes.gain].sort((a, b) => a.frame - b.frame);
          const renderStart = Math.max(0, frameToSeconds(clipStart - startFrame));
          gainNode.gain.setValueAtTime(baseGain, renderStart);
          for (const kf of kfs) {
            const kfTime = renderStart + frameToSeconds(kf.frame - clipStart);
            if (kfTime >= 0 && kfTime <= duration) {
              gainNode.gain.linearRampToValueAtTime(kf.value / 100, kfTime);
            }
          }
        }

        // Wire audio effects into export chain (resolve at clip start frame)
        const { nodes: effectNodes } = this._buildAudioEffectChain(clip, offlineCtx, clip.startFrame);
        let lastNode = source;
        for (const node of effectNodes) {
          if (node.input && node.output) {
            lastNode.connect(node.input);
            lastNode = node.output;
          } else {
            lastNode.connect(node);
            lastNode = node;
          }
        }
        lastNode.connect(gainNode);

        // Wire intrinsic audio effects (panner, channel-volume) after gain
        const intrinsicNodes = this._buildIntrinsicAudioChain(clip, offlineCtx, clip.startFrame);
        lastNode = gainNode;
        for (const node of intrinsicNodes) {
          if (node.input && node.output) {
            lastNode.connect(node.input);
            lastNode = node.output;
          } else {
            lastNode.connect(node);
            lastNode = node;
          }
        }
        lastNode.connect(offlineCtx.destination);
        clipGainNodes.set(clip.id, gainNode);

        // Calculate timing
        const renderStart = Math.max(0, frameToSeconds(clipStart - startFrame));
        const sourceOffset = frameToSeconds(clip.sourceInFrame);
        const clipDuration = frameToSeconds(getClipDuration(clip));

        source.start(renderStart, sourceOffset, clipDuration);
      }

      // Schedule crossfade ramps for transitions on this track
      if (track.transitions) {
        for (const trans of track.transitions) {
          const gainA = clipGainNodes.get(trans.clipAId);
          const gainB = clipGainNodes.get(trans.clipBId);
          if (!gainA || !gainB) continue;

          const clipA = track.clips.find(c => c.id === trans.clipAId);
          const clipB = track.clips.find(c => c.id === trans.clipBId);
          if (!clipA || !clipB) continue;

          const editPoint = getClipEndFrame(clipA);
          const { start } = getTransitionZone(trans, editPoint);
          const transStart = frameToSeconds(start - startFrame);
          const transDur = frameToSeconds(trans.duration);
          const transEnd = transStart + transDur;

          // Constant-power crossfade using cos/sin curve (matches playback)
          const steps = 64;
          const curveA = new Float32Array(steps);
          const curveB = new Float32Array(steps);
          const baseA = gainA.gain.value;
          const baseB = gainB.gain.value;
          for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            curveA[i] = baseA * Math.cos((t * Math.PI) / 2);
            curveB[i] = baseB * Math.sin((t * Math.PI) / 2);
          }
          gainA.gain.setValueCurveAtTime(curveA, transStart, transDur);
          gainB.gain.setValueCurveAtTime(curveB, transStart, transDur);
        }
      }
    }

    if (audioClipCount === 0) {
      logger.warn('Audio mixdown: no audio clips found in render range');
    } else if (decodedClipCount === 0) {
      logger.warn(`Audio mixdown: ${audioClipCount} clips found but none decoded successfully`);
    } else {
      logger.info(`Audio mixdown: ${decodedClipCount}/${audioClipCount} clips decoded`);
    }

    return offlineCtx.startRendering();
  },

  cleanup() {
    // Unsubscribe from all events
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch (err) {
        logger.warn('Error unsubscribing from AudioMixer event:', err);
      }
    }
    this._unsubs = [];

    this._stopAllSources();
    this._audioBuffers.clear();
    this._trackGains.clear();
    this._trackAnalysers.clear();
    this._masterAnalyser = null;
    if (this._ctx && this._ctx.state !== 'closed') {
      this._ctx.close().catch(() => {});
    }
  }
};

export default audioMixer;
