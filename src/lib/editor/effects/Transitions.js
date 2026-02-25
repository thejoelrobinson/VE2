// Transition effects: cross dissolve, dip to black/white, wipe, slide, push
import { effectRegistry } from './EffectRegistry.js';

// Transitions are special effects that operate between two clips
// They receive both outgoing and incoming frames and a progress (0->1)

export const TRANSITION_TYPES = {
  CROSS_DISSOLVE: 'cross-dissolve',
  DIP_TO_BLACK: 'dip-to-black',
  DIP_TO_WHITE: 'dip-to-white',
  WIPE_LEFT: 'wipe-left',
  WIPE_RIGHT: 'wipe-right',
  WIPE_UP: 'wipe-up',
  WIPE_DOWN: 'wipe-down',
  SLIDE_LEFT: 'slide-left',
  PUSH_LEFT: 'push-left'
};

let transitionIdCounter = 0;

export function createTransition(options = {}) {
  return {
    id: options.id || `trans-${++transitionIdCounter}`,
    type: options.type || TRANSITION_TYPES.CROSS_DISSOLVE,
    duration: options.duration || 30, // frames
    clipAId: options.clipAId || null, // outgoing clip
    clipBId: options.clipBId || null, // incoming clip
    alignment: options.alignment || 'center', // 'center' | 'start' | 'end' relative to edit point
    offset: options.offset ?? 0              // custom shift in frames (drag reposition)
  };
}

// Compute the timeline frame range where the transition is active.
// editPoint = frame where clip A ends and clip B starts (their shared boundary).
export function getTransitionZone(trans, editPoint) {
  const half = Math.floor(trans.duration / 2);
  const offset = trans.offset || 0;
  let start, end;
  switch (trans.alignment) {
    case 'start':
      start = editPoint + offset;
      end = start + trans.duration;
      break;
    case 'end':
      end = editPoint + offset;
      start = end - trans.duration;
      break;
    case 'center':
    default:
      start = editPoint - half + offset;
      end = start + trans.duration;
      break;
  }
  // Validate: start must be before end
  if (start >= end) {
    return { start: editPoint, end: editPoint + 1 };
  }
  return { start, end };
}

export const transitions = {
  // Render a transition frame given the two source frames and progress 0-1
  render(ctx, outFrame, inFrame, type, progress, width, height) {
    switch (type) {
      case TRANSITION_TYPES.CROSS_DISSOLVE:
        this._crossDissolve(ctx, outFrame, inFrame, progress, width, height);
        break;
      case TRANSITION_TYPES.DIP_TO_BLACK:
        this._dipToColor(ctx, outFrame, inFrame, progress, width, height, '#000');
        break;
      case TRANSITION_TYPES.DIP_TO_WHITE:
        this._dipToColor(ctx, outFrame, inFrame, progress, width, height, '#fff');
        break;
      case TRANSITION_TYPES.WIPE_LEFT:
        this._wipe(ctx, outFrame, inFrame, progress, width, height, 'left');
        break;
      case TRANSITION_TYPES.WIPE_RIGHT:
        this._wipe(ctx, outFrame, inFrame, progress, width, height, 'right');
        break;
      case TRANSITION_TYPES.WIPE_UP:
        this._wipe(ctx, outFrame, inFrame, progress, width, height, 'up');
        break;
      case TRANSITION_TYPES.WIPE_DOWN:
        this._wipe(ctx, outFrame, inFrame, progress, width, height, 'down');
        break;
      case TRANSITION_TYPES.SLIDE_LEFT:
        this._slide(ctx, outFrame, inFrame, progress, width, height);
        break;
      case TRANSITION_TYPES.PUSH_LEFT:
        this._push(ctx, outFrame, inFrame, progress, width, height);
        break;
      default:
        this._crossDissolve(ctx, outFrame, inFrame, progress, width, height);
    }
  },

  _crossDissolve(ctx, outFrame, inFrame, progress, w, h) {
    // Draw outgoing at decreasing alpha
    ctx.globalAlpha = 1 - progress;
    if (outFrame) ctx.drawImage(outFrame, 0, 0, w, h);
    // Draw incoming at increasing alpha
    ctx.globalAlpha = progress;
    if (inFrame) ctx.drawImage(inFrame, 0, 0, w, h);
    ctx.globalAlpha = 1;
  },

  _dipToColor(ctx, outFrame, inFrame, progress, w, h, color) {
    if (progress < 0.5) {
      // First half: outgoing fades to color
      const p = progress * 2; // 0->1
      if (outFrame) ctx.drawImage(outFrame, 0, 0, w, h);
      ctx.globalAlpha = p;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    } else {
      // Second half: color fades to incoming
      const p = (progress - 0.5) * 2; // 0->1
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = p;
      if (inFrame) ctx.drawImage(inFrame, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  },

  _wipe(ctx, outFrame, inFrame, progress, w, h, direction) {
    // Draw outgoing
    if (outFrame) ctx.drawImage(outFrame, 0, 0, w, h);

    // Clip region for incoming
    ctx.save();
    ctx.beginPath();
    switch (direction) {
      case 'left':
        ctx.rect(0, 0, w * progress, h);
        break;
      case 'right':
        ctx.rect(w * (1 - progress), 0, w * progress, h);
        break;
      case 'up':
        ctx.rect(0, 0, w, h * progress);
        break;
      case 'down':
        ctx.rect(0, h * (1 - progress), w, h * progress);
        break;
    }
    ctx.clip();
    if (inFrame) ctx.drawImage(inFrame, 0, 0, w, h);
    ctx.restore();
  },

  _slide(ctx, outFrame, inFrame, progress, w, h) {
    // Outgoing stays, incoming slides in from right
    if (outFrame) ctx.drawImage(outFrame, 0, 0, w, h);
    const offsetX = w * (1 - progress);
    if (inFrame) ctx.drawImage(inFrame, offsetX, 0, w, h);
  },

  _push(ctx, outFrame, inFrame, progress, w, h) {
    // Both move: outgoing pushed left, incoming pushes from right
    const offset = w * progress;
    if (outFrame) ctx.drawImage(outFrame, -offset, 0, w, h);
    if (inFrame) ctx.drawImage(inFrame, w - offset, 0, w, h);
  }
};

// Register transitions in effect registry for discoverability
for (const [key, type] of Object.entries(TRANSITION_TYPES)) {
  effectRegistry.register({
    id: type,
    name: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    category: 'Transitions',
    type: 'transition',
    params: [
      { id: 'duration', name: 'Duration (frames)', type: 'range', min: 1, max: 120, default: 30, step: 1 }
    ],
    apply() {} // Transitions use their own render path
  });
}
