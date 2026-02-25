// Clip data model
let clipIdCounter = 0;

export function createClip(options = {}) {
  const clip = {
    id: options.id || `clip-${++clipIdCounter}`,
    mediaId: options.mediaId || null,      // Reference to media bin item
    trackId: options.trackId || null,
    name: options.name || 'Clip',
    // Timeline position (in frames)
    startFrame: options.startFrame ?? 0,
    // Source in/out (in frames, relative to media start)
    sourceInFrame: options.sourceInFrame ?? 0,
    sourceOutFrame: options.sourceOutFrame ?? 0,
    // Derived: duration = sourceOutFrame - sourceInFrame
    speed: options.speed ?? 1,
    // Visual
    color: options.color || null,
    // Effects (includes intrinsic opacity + volume)
    effects: options.effects || [],
    // Audio (kept for backward compat during migration)
    volume: options.volume ?? 1,
    // Masks (separate from effects — bezier/ellipse/rect clip masks)
    masks: options.masks || [],
    // Linked clip (Premiere-style A/V link)
    linkedClipId: options.linkedClipId || null,
    // State
    disabled: false
  };

  // Auto-create intrinsic effects if not already present (handles project load + migration)
  if (!clip.effects.find(fx => fx.id === 'intrinsic-opacity')) {
    clip.effects.unshift({
      id: 'intrinsic-opacity', effectId: 'opacity', name: 'Opacity',
      enabled: true, intrinsic: true,
      params: { opacity: 100 }, keyframes: {}
    });
  }
  if (!clip.effects.find(fx => fx.id === 'intrinsic-volume')) {
    clip.effects.unshift({
      id: 'intrinsic-volume', effectId: 'audio-volume', name: 'Volume',
      enabled: true, intrinsic: true,
      params: { gain: (options.volume ?? 1) * 100 }, keyframes: {}
    });
  }

  // Intrinsic Motion (video clips — always present)
  if (!clip.effects.find(fx => fx.id === 'intrinsic-motion')) {
    const cx = (options.canvasWidth ?? 1920) / 2;
    const cy = (options.canvasHeight ?? 1080) / 2;
    const srcW = options.mediaWidth || options.canvasWidth || 1920;
    const srcH = options.mediaHeight || options.canvasHeight || 1080;
    clip.effects.unshift({
      id: 'intrinsic-motion', effectId: 'motion', name: 'Motion',
      enabled: true, intrinsic: true,
      params: {
        posX: cx, posY: cy, scale: 100, scaleWidth: 100,
        uniformScale: true, rotation: 0,
        anchorX: srcW / 2, anchorY: srcH / 2,
        sourceWidth: srcW, sourceHeight: srcH,
        antiFlicker: 0,
        cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0
      },
      keyframes: {}
    });
  }

  // Intrinsic Time Remapping (starts disabled)
  if (!clip.effects.find(fx => fx.id === 'intrinsic-time-remap')) {
    clip.effects.push({
      id: 'intrinsic-time-remap', effectId: 'time-remap', name: 'Time Remapping',
      enabled: false, intrinsic: true,
      params: { speed: 100 }, keyframes: {}
    });
  }

  // Intrinsic Panner (audio)
  if (!clip.effects.find(fx => fx.id === 'intrinsic-panner')) {
    clip.effects.push({
      id: 'intrinsic-panner', effectId: 'panner', name: 'Panner',
      enabled: true, intrinsic: true,
      params: { pan: 0 }, keyframes: {}
    });
  }

  // Intrinsic Channel Volume (audio L/R)
  if (!clip.effects.find(fx => fx.id === 'intrinsic-channel-volume')) {
    clip.effects.push({
      id: 'intrinsic-channel-volume', effectId: 'channel-volume', name: 'Channel Volume',
      enabled: true, intrinsic: true,
      params: { left: 100, right: 100 }, keyframes: {}
    });
  }

  return clip;
}

export function getIntrinsicEffect(clip, effectId) {
  return clip.effects.find(fx => fx.intrinsic && fx.effectId === effectId);
}

export function getClipDuration(clip) {
  return Math.round((clip.sourceOutFrame - clip.sourceInFrame) / clip.speed);
}

export function getClipEndFrame(clip) {
  return clip.startFrame + getClipDuration(clip);
}

export function clipContainsFrame(clip, frame) {
  return frame >= clip.startFrame && frame < getClipEndFrame(clip);
}

export function getSourceFrameAtPlayhead(clip, playheadFrame) {
  if (!clipContainsFrame(clip, playheadFrame)) return null;
  const offsetInClip = playheadFrame - clip.startFrame;
  return clip.sourceInFrame + Math.round(offsetInClip * clip.speed);
}

export function resetClipIds() {
  clipIdCounter = 0;
}
