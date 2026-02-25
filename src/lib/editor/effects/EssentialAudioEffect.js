// Essential Audio compound effect — Premiere-style clip-type-based audio processing.
// Registers a single 'essential-audio' effect with ~50 params. createNode() builds
// a chained Web Audio graph that bypasses disabled stages.
import { effectRegistry } from './EffectRegistry.js';

const EFFECT_ID = 'essential-audio';

// Reverb preset IR durations (seconds) — synthetic impulse responses
const REVERB_PRESETS = {
  // Dialogue
  'auditorium': 2.5, 'church': 3.5, 'large-reflective': 2.0, 'outside-club': 1.2,
  'warm-room': 1.0, 'warm-voice': 0.6, 'thicken-voice': 0.4,
  // SFX
  'heavy': 3.0, 'light': 0.8, 'outside': 1.5, 'room': 1.0,
  // Ambience
  'large-room-amb': 2.5, 'outside-amb': 1.8, 'room-amb': 1.2, 'wind-effect': 2.0
};

// EQ presets for Clarity section (Dialogue)
const EQ_CLARITY_PRESETS = {
  'none': null,
  'male-voice': { lp: { f: 120, g: 3 }, m1: { f: 250, g: -2, q: 1.5 }, m2: { f: 2500, g: 3, q: 1 }, m3: { f: 5000, g: 2, q: 1 }, hp: { f: 8000, g: -1 } },
  'female-voice': { lp: { f: 150, g: 2 }, m1: { f: 400, g: -2, q: 1.5 }, m2: { f: 3000, g: 4, q: 1 }, m3: { f: 6000, g: 2, q: 1 }, hp: { f: 10000, g: -1 } },
  'podcast': { lp: { f: 100, g: 4 }, m1: { f: 300, g: -3, q: 2 }, m2: { f: 2000, g: 3, q: 0.8 }, m3: { f: 5000, g: 2, q: 1 }, hp: { f: 12000, g: -2 } },
  'broadcast': { lp: { f: 80, g: 3 }, m1: { f: 250, g: -2, q: 1 }, m2: { f: 3500, g: 4, q: 1.2 }, m3: { f: 7000, g: 1, q: 1 }, hp: { f: 10000, g: -2 } },
  'vocal-presence': { lp: { f: 100, g: 0 }, m1: { f: 500, g: -1, q: 1 }, m2: { f: 3000, g: 5, q: 0.8 }, m3: { f: 5000, g: 3, q: 1 }, hp: { f: 12000, g: 0 } },
};

// Generate a synthetic impulse response buffer
function generateIR(audioCtx, duration, sampleRate) {
  const length = Math.ceil(duration * sampleRate);
  const buffer = audioCtx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      // Exponential decay with randomized noise
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
    }
  }
  return buffer;
}

// Build the full processing chain. Always creates ALL nodes (bypass when param=0)
// so apply() can update them live. Returns { input, output, _nodeMap }.
function buildChain(audioCtx, params) {
  const nodeMap = {};  // role → node(s) for live updates
  const sr = audioCtx.sampleRate;
  const chain = [];    // linear chain of AudioNodes

  // Helper: create a BiquadFilter, add to chain, store in nodeMap
  const biquad = (role, type, freq, q, gain) => {
    const f = audioCtx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    if (gain !== undefined) f.gain.value = gain;
    chain.push(f);
    nodeMap[role] = f;
    return f;
  };

  // --- Rumble (always present, bypasses at freq=20) ---
  biquad('rumble', 'highpass',
    params.repair_rumble > 0 ? 40 + params.repair_rumble * 8 : 20,
    0.7);

  // --- DeHum (3 notch filters, bypass at high Q = narrow inaudible notch) ---
  // NOTE: For notch filters, LOW Q = wide bandwidth (removes more). Use HIGH Q for bypass.
  const dehumFreq = params.repair_dehum_freq || 60;
  for (let h = 1; h <= 3; h++) {
    biquad(`dehum${h}`, 'notch',
      dehumFreq * h,
      params.repair_dehum > 0 ? 10 + params.repair_dehum * 5 : 100);
  }

  // --- DeEss (peaking cut at 6.5kHz, bypass at gain=0) ---
  biquad('deess', 'peaking', 6500, 2,
    params.repair_deess > 0 ? -params.repair_deess * 1.5 : 0);

  // --- Noise reduction (HP, bypass at freq=20) ---
  biquad('noise', 'highpass',
    params.repair_noise > 0 ? 80 + params.repair_noise * 20 : 20,
    0.5);

  // --- Reverb reduction (HP + lowshelf, bypass at neutral values) ---
  biquad('revredHP', 'highpass',
    params.repair_reverb > 0 ? 150 + params.repair_reverb * 15 : 20,
    0.5);
  biquad('revredShelf', 'lowshelf', 300, undefined,
    params.repair_reverb > 0 ? -params.repair_reverb * 1.2 : 0);

  // --- Dynamics compressor (bypass at threshold=0, ratio=1) ---
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = params.clarity_dynamics > 0 ? -10 - params.clarity_dynamics * 3 : 0;
  comp.knee.value = 10;
  comp.ratio.value = params.clarity_dynamics > 0 ? 1 + params.clarity_dynamics * 0.5 : 1;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  chain.push(comp);
  nodeMap.dynamics = comp;

  // --- Vocal enhance (peaking boost, bypass at gain=0) ---
  const enhFreq = params.clarity_enhance_tone === 'low' ? 2000 : 4000;
  biquad('enhance', 'peaking', enhFreq, 0.8,
    params.clarity_enhance ? 4 : 0);

  // --- 5-band Parametric EQ (always present, bypass at gain=0) ---
  biquad('eqLP', 'lowshelf', params.eq_lp_freq || 200, undefined,
    params.eq_enabled ? (params.eq_lp_gain || 0) : 0);
  biquad('eqM1', 'peaking', params.eq_m1_freq || 500, params.eq_m1_q || 1,
    params.eq_enabled ? (params.eq_m1_gain || 0) : 0);
  biquad('eqM2', 'peaking', params.eq_m2_freq || 2000, params.eq_m2_q || 1,
    params.eq_enabled ? (params.eq_m2_gain || 0) : 0);
  biquad('eqM3', 'peaking', params.eq_m3_freq || 5000, params.eq_m3_q || 1,
    params.eq_enabled ? (params.eq_m3_gain || 0) : 0);
  biquad('eqHP', 'highshelf', params.eq_hp_freq || 8000, undefined,
    params.eq_enabled ? (params.eq_hp_gain || 0) : 0);

  // --- Creative reverb (ConvolverNode, dry/wet gains) ---
  // Only create the ConvolverNode when reverb is active — the parallel routing
  // with ConvolverNode can cause silent output in some Chrome configurations
  const hasReverb = params.creative_reverb_preset && params.creative_reverb_preset !== 'none' && params.creative_reverb > 0;

  let reverbInput, reverbDry, reverbWet, reverbOut, convolver;
  if (hasReverb) {
    reverbInput = audioCtx.createGain();
    reverbInput.gain.value = 1;
    reverbDry = audioCtx.createGain();
    reverbWet = audioCtx.createGain();
    reverbOut = audioCtx.createGain();
    reverbOut.gain.value = 1;
    const wet = params.creative_reverb / 100;
    reverbDry.gain.value = 1 - wet * 0.5;
    reverbWet.gain.value = wet;
    const decay = REVERB_PRESETS[params.creative_reverb_preset] || params.creative_reverb_decay || 1.5;
    convolver = audioCtx.createConvolver();
    convolver.buffer = generateIR(audioCtx, Math.max(0.1, decay), sr);
    reverbInput.connect(reverbDry);
    reverbInput.connect(convolver);
    convolver.connect(reverbWet);
    reverbDry.connect(reverbOut);
    reverbWet.connect(reverbOut);
    nodeMap.reverbDry = reverbDry;
    nodeMap.reverbWet = reverbWet;
    nodeMap.reverbConvolver = convolver;
  }

  // --- Pan (bypass at 0) ---
  const panner = audioCtx.createStereoPanner();
  panner.pan.value = (params.creative_pan || 0) / 100;
  nodeMap.pan = panner;

  // --- Stereo width (bypass at gain=1) ---
  const widthGain = audioCtx.createGain();
  widthGain.gain.value = 1;
  nodeMap.widthGain = widthGain;

  // --- Loudness gain (LAST stage — post-reverb, post-EQ) ---
  const loudnessGain = audioCtx.createGain();
  loudnessGain.gain.value = (params.loudness_enabled && params.loudness_gain)
    ? Math.pow(10, params.loudness_gain / 20) : 1;
  nodeMap.loudness = loudnessGain;

  // Wire the linear chain (repair → dynamics → enhance → EQ)
  for (let i = 1; i < chain.length; i++) {
    chain[i - 1].connect(chain[i]);
  }

  // After linear chain: → [reverb if active] → panner → width → loudness
  const lastChainNode = chain[chain.length - 1];
  if (hasReverb) {
    lastChainNode.connect(reverbInput);
    reverbOut.connect(panner);
  } else {
    // Skip reverb entirely — direct connection avoids ConvolverNode issues
    lastChainNode.connect(panner);
  }
  panner.connect(widthGain);
  widthGain.connect(loudnessGain);

  const result = {
    input: chain[0],
    output: loudnessGain,
    _nodeMap: nodeMap
  };
  return result;
}

// Smoothly ramp an AudioParam to avoid clicks (10ms ramp)
function smooth(param, value, audioCtx) {
  param.setTargetAtTime(value, audioCtx.currentTime, 0.01);
}

// Update live nodes from new params (called per-frame or on slider change)
function applyParams(audioCtx, params, nodeMap) {
  if (!nodeMap) return;
  const t = audioCtx.currentTime;
  const TAU = 0.01; // 10ms smoothing time constant

  // Rumble
  if (nodeMap.rumble) smooth(nodeMap.rumble.frequency, params.repair_rumble > 0 ? 40 + params.repair_rumble * 8 : 20, audioCtx);

  // DeHum
  const dhFreq = params.repair_dehum_freq || 60;
  for (let h = 1; h <= 3; h++) {
    const n = nodeMap[`dehum${h}`];
    if (n) {
      smooth(n.frequency, dhFreq * h, audioCtx);
      smooth(n.Q, params.repair_dehum > 0 ? 10 + params.repair_dehum * 5 : 100, audioCtx);
    }
  }

  // DeEss
  if (nodeMap.deess) smooth(nodeMap.deess.gain, params.repair_deess > 0 ? -params.repair_deess * 1.5 : 0, audioCtx);

  // Noise
  if (nodeMap.noise) smooth(nodeMap.noise.frequency, params.repair_noise > 0 ? 80 + params.repair_noise * 20 : 20, audioCtx);

  // Reverb reduction
  if (nodeMap.revredHP) smooth(nodeMap.revredHP.frequency, params.repair_reverb > 0 ? 150 + params.repair_reverb * 15 : 20, audioCtx);
  if (nodeMap.revredShelf) smooth(nodeMap.revredShelf.gain, params.repair_reverb > 0 ? -params.repair_reverb * 1.2 : 0, audioCtx);

  // Dynamics
  if (nodeMap.dynamics) {
    smooth(nodeMap.dynamics.threshold, params.clarity_dynamics > 0 ? -10 - params.clarity_dynamics * 3 : 0, audioCtx);
    smooth(nodeMap.dynamics.ratio, params.clarity_dynamics > 0 ? 1 + params.clarity_dynamics * 0.5 : 1, audioCtx);
  }

  // Enhance
  if (nodeMap.enhance) {
    smooth(nodeMap.enhance.frequency, params.clarity_enhance_tone === 'low' ? 2000 : 4000, audioCtx);
    smooth(nodeMap.enhance.gain, params.clarity_enhance ? 4 : 0, audioCtx);
  }

  // EQ bands
  const eqOn = params.eq_enabled;
  if (nodeMap.eqLP) { smooth(nodeMap.eqLP.frequency, params.eq_lp_freq || 200, audioCtx); smooth(nodeMap.eqLP.gain, eqOn ? (params.eq_lp_gain || 0) : 0, audioCtx); }
  if (nodeMap.eqM1) { smooth(nodeMap.eqM1.frequency, params.eq_m1_freq || 500, audioCtx); smooth(nodeMap.eqM1.Q, params.eq_m1_q || 1, audioCtx); smooth(nodeMap.eqM1.gain, eqOn ? (params.eq_m1_gain || 0) : 0, audioCtx); }
  if (nodeMap.eqM2) { smooth(nodeMap.eqM2.frequency, params.eq_m2_freq || 2000, audioCtx); smooth(nodeMap.eqM2.Q, params.eq_m2_q || 1, audioCtx); smooth(nodeMap.eqM2.gain, eqOn ? (params.eq_m2_gain || 0) : 0, audioCtx); }
  if (nodeMap.eqM3) { smooth(nodeMap.eqM3.frequency, params.eq_m3_freq || 5000, audioCtx); smooth(nodeMap.eqM3.Q, params.eq_m3_q || 1, audioCtx); smooth(nodeMap.eqM3.gain, eqOn ? (params.eq_m3_gain || 0) : 0, audioCtx); }
  if (nodeMap.eqHP) { smooth(nodeMap.eqHP.frequency, params.eq_hp_freq || 8000, audioCtx); smooth(nodeMap.eqHP.gain, eqOn ? (params.eq_hp_gain || 0) : 0, audioCtx); }

  // Creative reverb (dry/wet mix)
  const wet = (params.creative_reverb_preset && params.creative_reverb_preset !== 'none') ? (params.creative_reverb || 0) / 100 : 0;
  if (nodeMap.reverbDry) smooth(nodeMap.reverbDry.gain, 1 - wet * 0.5, audioCtx);
  if (nodeMap.reverbWet) smooth(nodeMap.reverbWet.gain, wet, audioCtx);

  // Pan
  if (nodeMap.pan) smooth(nodeMap.pan.pan, (params.creative_pan || 0) / 100, audioCtx);

  // Loudness
  if (nodeMap.loudness) {
    const loudVal = (params.loudness_enabled && params.loudness_gain)
      ? Math.pow(10, params.loudness_gain / 20) : 1;
    smooth(nodeMap.loudness.gain, loudVal, audioCtx);
  }
}

// --- Default params ---
const DEFAULT_PARAMS = {
  // Loudness
  loudness_enabled: false,
  loudness_target: -23,
  loudness_gain: 0,

  // Repair (Dialogue)
  repair_noise: 0,
  repair_rumble: 0,
  repair_dehum: 0,
  repair_dehum_freq: 60,
  repair_deess: 0,
  repair_reverb: 0,

  // Clarity (Dialogue)
  clarity_dynamics: 0,
  clarity_eq_preset: 'none',
  clarity_eq_amount: 0,
  clarity_enhance: false,
  clarity_enhance_tone: 'high',

  // Ducking (Music/Ambience)
  duck_enabled: false,
  duck_against_dialogue: true,
  duck_against_sfx: false,
  duck_against_ambience: false,
  duck_against_untagged: false,
  duck_sensitivity: 5,
  duck_amount: -6,
  duck_fades: 500,
  duck_fade_position: 'outside',

  // Creative
  creative_reverb: 0,
  creative_reverb_preset: 'none',
  creative_reverb_decay: 1.5,
  creative_stereo_width: 100,
  creative_pan: 0,

  // EQ (5-band parametric)
  eq_enabled: false,
  eq_lp_freq: 200,   eq_lp_gain: 0,
  eq_m1_freq: 500,   eq_m1_gain: 0,  eq_m1_q: 1,
  eq_m2_freq: 2000,  eq_m2_gain: 0,  eq_m2_q: 1,
  eq_m3_freq: 5000,  eq_m3_gain: 0,  eq_m3_q: 1,
  eq_hp_freq: 8000,  eq_hp_gain: 0,
};

// Build param definitions for EffectRegistry
const paramDefs = Object.entries(DEFAULT_PARAMS).map(([id, def]) => {
  if (typeof def === 'boolean') return { id, name: id, type: 'checkbox', default: def };
  if (typeof def === 'string') return { id, name: id, type: 'select', default: def };
  // Numeric — determine range by param name
  let min = 0, max = 10, step = 1, unit = '';
  if (id.includes('freq')) { min = 20; max = 20000; step = 10; unit = 'Hz'; }
  else if (id.includes('gain')) { min = -40; max = 40; step = 0.5; unit = 'dB'; }
  else if (id.includes('_q')) { min = 0.1; max = 20; step = 0.1; }
  else if (id === 'loudness_target') { min = -40; max = 0; step = 1; unit = 'LUFS'; }
  else if (id === 'duck_amount') { min = -30; max = 0; step = 1; unit = 'dB'; }
  else if (id === 'duck_fades') { min = 50; max = 3000; step = 50; unit = 'ms'; }
  else if (id === 'duck_sensitivity') { min = 1; max = 10; }
  else if (id.includes('stereo_width')) { min = 0; max = 200; unit = '%'; }
  else if (id === 'creative_pan') { min = -100; max = 100; }
  else if (id === 'creative_reverb') { min = 0; max = 100; unit = '%'; }
  else if (id.includes('decay')) { min = 0.1; max = 10; step = 0.1; unit = 's'; }
  return { id, name: id, type: 'range', min, max, step, default: def, unit };
});

effectRegistry.register({
  id: EFFECT_ID,
  name: 'Essential Audio',
  category: 'Audio',
  type: 'audio',
  params: paramDefs,
  createNode(audioCtx, params) {
    return buildChain(audioCtx, params);
  },
  apply(audioCtx, params, node) {
    // Live-update all node parameters without rebuilding the graph
    if (node && node._nodeMap) {
      applyParams(audioCtx, params, node._nodeMap);
    }
  }
});

export { EFFECT_ID, DEFAULT_PARAMS, REVERB_PRESETS, EQ_CLARITY_PRESETS };
