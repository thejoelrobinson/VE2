// Audio effects: volume, fade in/out, EQ, compressor
import { effectRegistry } from './EffectRegistry.js';

// Volume
effectRegistry.register({
  id: 'audio-volume',
  name: 'Volume',
  category: 'Audio',
  type: 'audio',
  params: [
    { id: 'gain', name: 'Gain', type: 'range', min: 0, max: 200, default: 100, step: 1, unit: '%' }
  ],
  createNode(audioCtx, params) {
    const gain = audioCtx.createGain();
    gain.gain.value = params.gain / 100;
    return gain;
  },
  apply(audioCtx, params, node) {
    if (node && node.gain) {
      node.gain.value = params.gain / 100;
    }
  }
});

// Fade In
effectRegistry.register({
  id: 'fade-in',
  name: 'Fade In',
  category: 'Audio',
  type: 'audio',
  params: [
    { id: 'duration', name: 'Duration', type: 'range', min: 0, max: 300, default: 30, step: 1, unit: 'frames' }
  ],
  createNode(audioCtx, params) {
    const gain = audioCtx.createGain();
    const dur = (params.duration || 30) / 30;
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + dur);
    return gain;
  },
  apply() {}
});

// Fade Out
effectRegistry.register({
  id: 'fade-out',
  name: 'Fade Out',
  category: 'Audio',
  type: 'audio',
  params: [
    { id: 'duration', name: 'Duration', type: 'range', min: 0, max: 300, default: 30, step: 1, unit: 'frames' }
  ],
  createNode(audioCtx, params) {
    const gain = audioCtx.createGain();
    const dur = (params.duration || 30) / 30;
    gain.gain.setValueAtTime(1, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + dur);
    return gain;
  },
  apply() {}
});

// Low Pass Filter (EQ)
effectRegistry.register({
  id: 'low-pass',
  name: 'Low Pass Filter',
  category: 'Audio EQ',
  type: 'audio',
  params: [
    { id: 'frequency', name: 'Frequency', type: 'range', min: 20, max: 20000, default: 5000, step: 10, unit: 'Hz' },
    { id: 'q', name: 'Q', type: 'range', min: 0.1, max: 20, default: 1, step: 0.1 }
  ],
  createNode(audioCtx, params) {
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = params.frequency;
    filter.Q.value = params.q;
    return filter;
  },
  apply() {}
});

// High Pass Filter
effectRegistry.register({
  id: 'high-pass',
  name: 'High Pass Filter',
  category: 'Audio EQ',
  type: 'audio',
  params: [
    { id: 'frequency', name: 'Frequency', type: 'range', min: 20, max: 20000, default: 200, step: 10, unit: 'Hz' },
    { id: 'q', name: 'Q', type: 'range', min: 0.1, max: 20, default: 1, step: 0.1 }
  ],
  createNode(audioCtx, params) {
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = params.frequency;
    filter.Q.value = params.q;
    return filter;
  },
  apply() {}
});

// Compressor
effectRegistry.register({
  id: 'compressor',
  name: 'Compressor',
  category: 'Audio Dynamics',
  type: 'audio',
  params: [
    { id: 'threshold', name: 'Threshold', type: 'range', min: -100, max: 0, default: -24, step: 1, unit: 'dB' },
    { id: 'knee', name: 'Knee', type: 'range', min: 0, max: 40, default: 30, step: 1, unit: 'dB' },
    { id: 'ratio', name: 'Ratio', type: 'range', min: 1, max: 20, default: 12, step: 1 },
    { id: 'attack', name: 'Attack', type: 'range', min: 0, max: 1, default: 0.003, step: 0.001, unit: 's' },
    { id: 'release', name: 'Release', type: 'range', min: 0, max: 1, default: 0.25, step: 0.01, unit: 's' }
  ],
  createNode(audioCtx, params) {
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = params.threshold;
    comp.knee.value = params.knee;
    comp.ratio.value = params.ratio;
    comp.attack.value = params.attack;
    comp.release.value = params.release;
    return comp;
  },
  apply() {}
});

// Panner (intrinsic stereo pan)
effectRegistry.register({
  id: 'panner',
  name: 'Panner',
  category: 'Audio',
  type: 'audio',
  params: [
    { id: 'pan', name: 'Pan', type: 'range', min: -100, max: 100, default: 0, step: 1 }
  ],
  createNode(audioCtx, params) {
    const panner = audioCtx.createStereoPanner();
    panner.pan.value = (params.pan ?? 0) / 100;
    return panner;
  },
  apply(audioCtx, params, node) {
    if (node && node.pan) {
      node.pan.value = (params.pan ?? 0) / 100;
    }
  }
});

// Channel Volume (intrinsic per-channel L/R gain)
effectRegistry.register({
  id: 'channel-volume',
  name: 'Channel Volume',
  category: 'Audio',
  type: 'audio',
  params: [
    { id: 'left', name: 'Left', type: 'range', min: 0, max: 200, default: 100, step: 1, unit: '%' },
    { id: 'right', name: 'Right', type: 'range', min: 0, max: 200, default: 100, step: 1, unit: '%' }
  ],
  createNode(audioCtx, params) {
    const splitter = audioCtx.createChannelSplitter(2);
    const merger = audioCtx.createChannelMerger(2);
    const gainL = audioCtx.createGain();
    const gainR = audioCtx.createGain();
    gainL.gain.value = (params.left ?? 100) / 100;
    gainR.gain.value = (params.right ?? 100) / 100;
    splitter.connect(gainL, 0);
    splitter.connect(gainR, 1);
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    return { input: splitter, output: merger, _gainL: gainL, _gainR: gainR };
  },
  apply(audioCtx, params, node) {
    if (node && node._gainL) {
      node._gainL.gain.value = (params.left ?? 100) / 100;
      node._gainR.gain.value = (params.right ?? 100) / 100;
    }
  }
});
