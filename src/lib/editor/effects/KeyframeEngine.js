// Keyframe interpolation engine (linear, ease-in/out, bezier)

export const EASING = {
  LINEAR: 'linear',
  EASE_IN: 'ease-in',
  EASE_OUT: 'ease-out',
  EASE_IN_OUT: 'ease-in-out',
  BEZIER: 'bezier',
  HOLD: 'hold'
};

// Keyframe: { frame: number, value: number, easing: string, bezier?: [x1,y1,x2,y2] }

export const keyframeEngine = {
  // Get interpolated value at a given frame from a keyframe array
  getValueAtFrame(keyframes, frame) {
    if (!keyframes || keyframes.length === 0) return undefined;

    // keyframes array is kept sorted by addKeyframe()
    // Before first keyframe
    if (frame <= keyframes[0].frame) return keyframes[0].value;

    // After last keyframe
    if (frame >= keyframes[keyframes.length - 1].frame) return keyframes[keyframes.length - 1].value;

    // Find surrounding keyframes
    for (let i = 0; i < keyframes.length - 1; i++) {
      const kf0 = keyframes[i];
      const kf1 = keyframes[i + 1];
      if (frame >= kf0.frame && frame <= kf1.frame) {
        const t = (frame - kf0.frame) / (kf1.frame - kf0.frame);
        const eased = this._applyEasing(t, kf1.easing || EASING.LINEAR, kf1.bezier);
        return this._lerp(kf0.value, kf1.value, eased);
      }
    }

    return keyframes[keyframes.length - 1].value;
  },

  // Add a keyframe to an array (replaces if same frame exists)
  addKeyframe(keyframes, frame, value, easing = EASING.LINEAR) {
    const existing = keyframes.findIndex(kf => kf.frame === frame);
    const kf = { frame, value, easing };
    if (existing >= 0) {
      keyframes[existing] = kf;
    } else {
      keyframes.push(kf);
      keyframes.sort((a, b) => a.frame - b.frame);
    }
    return kf;
  },

  removeKeyframe(keyframes, frame) {
    const idx = keyframes.findIndex(kf => kf.frame === frame);
    if (idx >= 0) {
      keyframes.splice(idx, 1);
    }
  },

  hasKeyframes(keyframes) {
    return keyframes && keyframes.length > 0;
  },

  // Resolve all animated params for an effect instance at a given frame.
  // Returned object may be a direct reference — do not mutate.
  resolveParams(effectInstance, frame) {
    // FAST PATH: No keyframes → return base params directly (no copy).
    // This is safe because callers only read the returned object.
    if (!effectInstance.keyframes || !this._hasAnyKeyframes(effectInstance.keyframes)) {
      return effectInstance.params;
    }

    // Full resolution — spread base params and override with keyframed values.
    // We don't cache same-frame results because external code may mutate
    // effectInstance.params between calls at the same frame (e.g. slider drag).
    const resolvedParams = { ...effectInstance.params };
    for (const [paramId, kfs] of Object.entries(effectInstance.keyframes)) {
      if (kfs.length > 0) {
        const val = this.getValueAtFrame(kfs, frame);
        if (val !== undefined) {
          resolvedParams[paramId] = val;
        }
      }
    }

    return resolvedParams;
  },

  _hasAnyKeyframes(keyframes) {
    for (const key in keyframes) {
      if (keyframes[key] && keyframes[key].length > 0) return true;
    }
    return false;
  },

  _lerp(a, b, t) {
    if (typeof a === 'number' && typeof b === 'number') {
      return a + (b - a) * t;
    }
    // Point arrays: interpolate each point's fields
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
        a.length > 0 && typeof a[0] === 'object' && 'x' in a[0]) {
      return a.map((pa, i) => {
        const pb = b[i];
        const pt = {};
        for (const key of Object.keys(pa)) {
          pt[key] = typeof pa[key] === 'number'
            ? pa[key] + (pb[key] - pa[key]) * t
            : pa[key];
        }
        return pt;
      });
    }
    // For non-numeric, snap at midpoint
    return t < 0.5 ? a : b;
  },

  _applyEasing(t, easing, bezierPoints) {
    switch (easing) {
      case EASING.LINEAR:
        return t;
      case EASING.EASE_IN:
        return t * t;
      case EASING.EASE_OUT:
        return 1 - (1 - t) * (1 - t);
      case EASING.EASE_IN_OUT:
        return t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2;
      case EASING.HOLD:
        return 0;
      case EASING.BEZIER:
        if (bezierPoints && bezierPoints.length === 4) {
          return this._cubicBezier(t, bezierPoints[0], bezierPoints[1], bezierPoints[2], bezierPoints[3]);
        }
        return t;
      default:
        return t;
    }
  },

  _cubicBezier(t, x1, y1, x2, y2) {
    // Evaluate cubic bezier: B(t) = ((a*t + b)*t + c)*t
    const sampleCurve = (p1, p2, t) =>
      (((1 - 3 * p2 + 3 * p1) * t + (3 * p2 - 6 * p1)) * t + 3 * p1) * t;

    // Binary search for parametric t that yields input x
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (sampleCurve(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    const mt = (lo + hi) / 2;
    return sampleCurve(y1, y2, mt);
  }
};

export default keyframeEngine;
