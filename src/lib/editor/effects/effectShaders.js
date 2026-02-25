// GLSL shader sources for WebGL 2.0 effect rendering

// sRGB ↔ linear conversion functions (GLSL).
// Used by shaders that need to operate in linear light.
// sRGB EOTF (decode): sRGB gamma → linear
// sRGB OETF (encode): linear → sRGB gamma
export const GLSL_SRGB_UTILS = `
// sRGB → linear (EOTF)
vec3 srgbToLinear(vec3 srgb) {
  vec3 lo = srgb / 12.92;
  vec3 hi = pow((srgb + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), srgb));
}
// linear → sRGB (OETF)
vec3 linearToSrgb(vec3 lin) {
  vec3 lo = lin * 12.92;
  vec3 hi = 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), lin));
}
`;

// BT.709 luma coefficients (use these consistently, not Rec.601)
export const GLSL_LUMA_BT709 = 'const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);';

// Camera log curve transfer functions: log-encoded → linear light
// Approximations of official curves — acceptable for browser NLE, production uses manufacturer LUTs
export const GLSL_LOG_CURVES = `
// Sony S-Log3 -> linear (S-Gamut3)
float slog3ToLinear(float x) {
  if (x >= 171.2102946929 / 1023.0) {
    return pow(10.0, (x * 1023.0 - 420.0) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return (x * 1023.0 - 95.0) * 0.01125000 / (171.2102946929 - 95.0);
}
vec3 slog3ToLinearV(vec3 v) { return vec3(slog3ToLinear(v.r), slog3ToLinear(v.g), slog3ToLinear(v.b)); }

// Canon C-Log -> linear
float clogToLinear(float x) {
  if (x < 0.0730597) {
    return -(pow(10.0, (0.0730597 - x) / 0.529136) - 1.0) / 10.1596;
  }
  return (pow(10.0, (x - 0.0730597) / 0.529136) - 1.0) / 10.1596;
}
vec3 clogToLinearV(vec3 v) { return vec3(clogToLinear(v.r), clogToLinear(v.g), clogToLinear(v.b)); }

// Canon C-Log3 -> linear
float clog3ToLinear(float x) {
  if (x < 0.097465473) {
    return -(pow(10.0, (0.12783901 - x) / 0.36726845) - 1.0) / 14.98325;
  }
  return (pow(10.0, (x - 0.12783901) / 0.36726845) - 1.0) / 14.98325;
}
vec3 clog3ToLinearV(vec3 v) { return vec3(clog3ToLinear(v.r), clog3ToLinear(v.g), clog3ToLinear(v.b)); }

// Panasonic V-Log -> linear
float vlogToLinear(float x) {
  if (x < 0.181) {
    return (x - 0.125) / 5.6;
  }
  return pow(10.0, (x - 0.598206) / 0.241514) - 0.00873;
}
vec3 vlogToLinearV(vec3 v) { return vec3(vlogToLinear(v.r), vlogToLinear(v.g), vlogToLinear(v.b)); }

// ARRI LogC3 (EI 800) -> linear (ALEXA Wide Gamut)
float logc3ToLinear(float x) {
  float cut = 0.010591;
  float a = 5.555556;
  float b = 0.052272;
  float c = 0.247190;
  float d = 0.385537;
  float e = 5.367655;
  float f = 0.092809;
  if (x > e * cut + f) {
    return (pow(10.0, (x - d) / c) - b) / a;
  }
  return (x - f) / e;
}
vec3 logc3ToLinearV(vec3 v) { return vec3(logc3ToLinear(v.r), logc3ToLinear(v.g), logc3ToLinear(v.b)); }

// ARRI LogC4 -> linear (ALEXA Wide Gamut 4)
float logc4ToLinear(float x) {
  float a = 2231.826309;
  float b = 64.0;
  float c = 0.0740718;
  float s = 7.0;
  float t = 1.0 / 14.0;
  if (x >= 0.0) {
    return (pow(2.0, (x - c) * s) - b) / a;
  }
  return (x - c) * t;
}
vec3 logc4ToLinearV(vec3 v) { return vec3(logc4ToLinear(v.r), logc4ToLinear(v.g), logc4ToLinear(v.b)); }

// Nikon N-Log -> linear
float nlogToLinear(float x) {
  float cut = 328.0 / 1023.0;
  if (x >= cut) {
    return pow(2.0, (1023.0 * x - 150.0) / 619.0);
  }
  // Linear segment for low range (continuous at threshold)
  float cutLinear = pow(2.0, (1023.0 * cut - 150.0) / 619.0);
  return cutLinear * (x / cut);
}
vec3 nlogToLinearV(vec3 v) { return vec3(nlogToLinear(v.r), nlogToLinear(v.g), nlogToLinear(v.b)); }
`;

// Tone mapping functions: HDR linear light → SDR display range
export const GLSL_TONE_MAPPING = `
// Reinhard tone mapping (simple, preserves midtones)
vec3 tonemapReinhard(vec3 color) {
  return color / (color + vec3(1.0));
}

// ACES filmic tone mapping (approximation by Krzysztof Narkowicz)
// Good perceptual mapping, preserves highlight rolloff
vec3 tonemapACES(vec3 color) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}

// Exposure adjustment in linear light (stops)
vec3 applyExposure(vec3 linear, float stops) {
  return linear * pow(2.0, stops);
}
`;

// Shared fullscreen quad vertex shader
export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

// Fragment shaders keyed by effect ID
export const FRAGMENT_SHADERS = {
  'brightness-contrast': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_brightness;
uniform float u_contrast;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  // Brightness (additive)
  color.rgb += u_brightness;
  // Contrast (scale around 0.5)
  color.rgb = (color.rgb - 0.5) * u_contrast + 0.5;
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  'saturation': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  color.rgb = mix(vec3(lum), color.rgb, u_amount);
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  'hue-rotate': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_angle;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 hsv = rgb2hsv(color.rgb);
  hsv.x = fract(hsv.x + u_angle / 360.0);
  color.rgb = hsv2rgb(hsv);
  fragColor = vec4(color.rgb, color.a);
}`,

  'gaussian-blur-h': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_radius;
uniform vec2 u_texelSize;

void main() {
  if (u_radius <= 0.0) { fragColor = texture(u_source, v_texCoord); return; }
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  int r = int(ceil(u_radius));
  for (int i = -r; i <= r; i++) {
    float x = float(i);
    float weight = exp(-0.5 * (x * x) / max(u_radius * u_radius * 0.25, 0.001));
    sum += texture(u_source, v_texCoord + vec2(x * u_texelSize.x, 0.0)) * weight;
    weightSum += weight;
  }
  fragColor = sum / weightSum;
}`,

  'gaussian-blur-v': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_radius;
uniform vec2 u_texelSize;

void main() {
  if (u_radius <= 0.0) { fragColor = texture(u_source, v_texCoord); return; }
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  int r = int(ceil(u_radius));
  for (int i = -r; i <= r; i++) {
    float y = float(i);
    float weight = exp(-0.5 * (y * y) / max(u_radius * u_radius * 0.25, 0.001));
    sum += texture(u_source, v_texCoord + vec2(0.0, y * u_texelSize.y)) * weight;
    weightSum += weight;
  }
  fragColor = sum / weightSum;
}`,

  'invert': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 inverted = 1.0 - color.rgb;
  color.rgb = mix(color.rgb, inverted, u_amount);
  fragColor = vec4(color.rgb, color.a);
}`,

  'grayscale': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  color.rgb = mix(color.rgb, vec3(lum), u_amount);
  fragColor = vec4(color.rgb, color.a);
}`,

  'sepia': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 sepia = vec3(
    dot(color.rgb, vec3(0.393, 0.769, 0.189)),
    dot(color.rgb, vec3(0.349, 0.686, 0.168)),
    dot(color.rgb, vec3(0.272, 0.534, 0.131))
  );
  color.rgb = mix(color.rgb, sepia, u_amount);
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  'sharpen': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
uniform vec2 u_texelSize;
void main() {
  vec4 center = texture(u_source, v_texCoord);
  vec4 top    = texture(u_source, v_texCoord + vec2(0.0, -u_texelSize.y));
  vec4 bottom = texture(u_source, v_texCoord + vec2(0.0, u_texelSize.y));
  vec4 left   = texture(u_source, v_texCoord + vec2(-u_texelSize.x, 0.0));
  vec4 right  = texture(u_source, v_texCoord + vec2(u_texelSize.x, 0.0));
  vec4 sharpened = center * 5.0 - top - bottom - left - right;
  fragColor = vec4(mix(center.rgb, clamp(sharpened.rgb, 0.0, 1.0), u_amount), center.a);
}`,

  'levels': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_inputBlack;
uniform float u_inputWhite;
uniform float u_gamma;
uniform float u_outputBlack;
uniform float u_outputWhite;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  float inRange = max(u_inputWhite - u_inputBlack, 1.0 / 255.0);
  float outRange = u_outputWhite - u_outputBlack;
  // Input levels
  color.rgb = clamp((color.rgb - u_inputBlack) / inRange, 0.0, 1.0);
  // Gamma
  color.rgb = pow(color.rgb, vec3(1.0 / u_gamma));
  // Output levels
  color.rgb = color.rgb * outRange + u_outputBlack;
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  'hsl-adjust': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_hue;
uniform float u_saturation;
uniform float u_lightness;

vec3 rgb2hsl(vec3 c) {
  float maxC = max(max(c.r, c.g), c.b);
  float minC = min(min(c.r, c.g), c.b);
  float l = (maxC + minC) * 0.5;
  float s = 0.0;
  float h = 0.0;
  if (maxC != minC) {
    float d = maxC - minC;
    s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s == 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hue2rgb(p, q, h + 1.0/3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0/3.0)
  );
}

void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 hsl = rgb2hsl(color.rgb);
  hsl.x = fract(hsl.x + u_hue / 360.0);
  hsl.y = clamp(hsl.y + u_saturation, 0.0, 1.0);
  hsl.z = clamp(hsl.z + u_lightness, 0.0, 1.0);
  color.rgb = hsl2rgb(hsl);
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  'vignette': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_amount;
uniform float u_size;
void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec2 center = v_texCoord - 0.5;
  float dist = length(center) / 0.7071;
  float vig = smoothstep(u_size, u_size - 0.3, dist);
  color.rgb *= mix(1.0, vig, u_amount);
  fragColor = vec4(color.rgb, color.a);
}`,

  // === Lumetri Color: Pass 1 — Basic Correction + Creative + Color Wheels + Vignette ===
  'lumetri-color-main': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;

// Basic Correction
uniform int u_basic_enabled;
uniform float u_temperature;
uniform float u_tint;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_saturation;
uniform float u_vibrance;

// Creative
uniform int u_creative_enabled;
uniform float u_faded_film;
uniform float u_creative_vibrance;
uniform float u_creative_saturation;
uniform vec3 u_shadow_tint;
uniform vec3 u_highlight_tint;
uniform float u_tint_balance;

// Color Wheels
uniform int u_wheels_enabled;
uniform float u_shadow_wheel_r;
uniform float u_shadow_wheel_g;
uniform float u_shadow_wheel_b;
uniform float u_shadow_luma;
uniform float u_midtone_wheel_r;
uniform float u_midtone_wheel_g;
uniform float u_midtone_wheel_b;
uniform float u_midtone_luma;
uniform float u_highlight_wheel_r;
uniform float u_highlight_wheel_g;
uniform float u_highlight_wheel_b;
uniform float u_highlight_luma;

// Vignette
uniform int u_vignette_enabled;
uniform float u_vignette_amount;
uniform float u_vignette_midpoint;
uniform float u_vignette_roundness;
uniform float u_vignette_feather;

vec3 whiteBalance(vec3 color, float temp, float tintVal) {
  // Attempt color temperature shift (blue-orange axis via temp, green-magenta via tint)
  float t = temp / 100.0;
  float ti = tintVal / 100.0;
  color.r += t * 0.1;
  color.b -= t * 0.1;
  color.g += ti * 0.1;
  return color;
}

void main() {
  vec4 color = texture(u_source, v_texCoord);

  // --- Basic Correction ---
  if (u_basic_enabled != 0) {
    // White balance
    color.rgb = whiteBalance(color.rgb, u_temperature, u_tint);

    // Exposure: multiply by 2^exposure
    color.rgb *= pow(2.0, u_exposure);

    // Contrast: scale around midgray
    color.rgb = (color.rgb - 0.5) * (u_contrast / 100.0 + 1.0) + 0.5;

    // Luminance for zone-based adjustments
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

    // Highlights / Shadows / Whites / Blacks
    float shadowMask = 1.0 - smoothstep(0.0, 0.5, luma);
    float highlightMask = smoothstep(0.5, 1.0, luma);
    float blacksMask = 1.0 - smoothstep(0.0, 0.25, luma);
    float whitesMask = smoothstep(0.75, 1.0, luma);

    color.rgb += shadowMask * (u_shadows / 100.0) * 0.5;
    color.rgb += highlightMask * (u_highlights / 100.0) * 0.5;
    color.rgb += blacksMask * (u_blacks / 100.0) * 0.25;
    color.rgb += whitesMask * (u_whites / 100.0) * 0.25;

    // Saturation
    float lumaPost = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color.rgb = mix(vec3(lumaPost), color.rgb, u_saturation / 100.0);

    // Vibrance (boost low-saturation pixels more)
    float curSat = length(color.rgb - vec3(lumaPost));
    float vibWeight = 1.0 - clamp(curSat * 3.0, 0.0, 1.0);
    float vibAmount = u_vibrance / 100.0;
    color.rgb = mix(vec3(lumaPost), color.rgb, max(0.0, 1.0 + vibAmount * vibWeight));
  }

  // --- Creative ---
  if (u_creative_enabled != 0) {
    // Faded film: lift blacks linearly
    float fade = u_faded_film / 100.0;
    color.rgb += fade * 0.15;
    color.rgb = max(color.rgb, vec3(fade * 0.1));

    // Creative vibrance + saturation
    float lumaC = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float curSatC = length(color.rgb - vec3(lumaC));
    float vibWeightC = 1.0 - clamp(curSatC * 3.0, 0.0, 1.0);
    color.rgb = mix(vec3(lumaC), color.rgb, max(0.0, 1.0 + (u_creative_vibrance / 100.0) * vibWeightC));
    color.rgb = mix(vec3(lumaC), color.rgb, u_creative_saturation / 100.0);

    // Shadow/highlight tinting — additive blend to avoid darkening at defaults
    float lumaT = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float balance = (u_tint_balance + 100.0) / 200.0; // 0..1
    float shadowTintMask = 1.0 - smoothstep(0.0, balance, lumaT);
    float highlightTintMask = smoothstep(balance, 1.0, lumaT);
    // Tint offset: subtract white (neutral) so default tint colors produce zero offset
    vec3 shadowTintOffset = u_shadow_tint - vec3(0.5);
    vec3 highlightTintOffset = u_highlight_tint - vec3(0.5);
    color.rgb += shadowTintMask * shadowTintOffset * 0.6;
    color.rgb += highlightTintMask * highlightTintOffset * 0.6;
  }

  // --- Color Wheels (3-way) ---
  if (u_wheels_enabled != 0) {
    float lumaW = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float sMask = 1.0 - smoothstep(0.0, 0.5, lumaW);
    float mMask = 1.0 - abs(lumaW - 0.5) * 2.0;
    mMask = max(0.0, mMask);
    float hMask = smoothstep(0.5, 1.0, lumaW);

    vec3 shadowOffset = vec3(u_shadow_wheel_r, u_shadow_wheel_g, u_shadow_wheel_b);
    vec3 midtoneOffset = vec3(u_midtone_wheel_r, u_midtone_wheel_g, u_midtone_wheel_b);
    vec3 highlightOffset = vec3(u_highlight_wheel_r, u_highlight_wheel_g, u_highlight_wheel_b);

    color.rgb += sMask * shadowOffset * 0.5;
    color.rgb += mMask * midtoneOffset * 0.5;
    color.rgb += hMask * highlightOffset * 0.5;

    // Luminance offsets
    color.rgb += sMask * (u_shadow_luma / 100.0) * 0.5;
    color.rgb += mMask * (u_midtone_luma / 100.0) * 0.5;
    color.rgb += hMask * (u_highlight_luma / 100.0) * 0.5;
  }

  // --- Vignette ---
  if (u_vignette_enabled != 0) {
    vec2 center = v_texCoord - 0.5;
    float roundness = u_vignette_roundness / 100.0;
    // Roundness controls ellipse vs circle: 0=wide ellipse, 1=circle
    float aspect = mix(1.7777, 1.0, roundness); // 16:9 aspect at 0, circle at 1
    float dist = length(center / vec2(aspect, 1.0));
    float midpt = u_vignette_midpoint / 100.0;
    float feath = max(0.01, u_vignette_feather / 100.0);
    float vig = smoothstep(midpt - feath * 0.5, midpt + feath * 0.5, dist);
    float amount = u_vignette_amount / 100.0;
    color.rgb *= 1.0 - vig * amount;
  }

  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  // === Lumetri Color: Pass 2 — Curve LUT lookups ===
  'lumetri-color-curves': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform sampler2D u_curveLUT;     // 256x1 RGBA: R=red curve, G=green curve, B=blue curve
uniform sampler2D u_hslCurveLUT;  // 256x5: packed HSL curves (row-wise)

uniform int u_hsl_curves_active;

vec3 rgb2hsl(vec3 c) {
  float maxC = max(max(c.r, c.g), c.b);
  float minC = min(min(c.r, c.g), c.b);
  float l = (maxC + minC) * 0.5;
  float s = 0.0;
  float h = 0.0;
  if (maxC != minC) {
    float d = maxC - minC;
    s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s == 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hue2rgb(p, q, h + 1.0/3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0/3.0)
  );
}

void main() {
  vec4 color = texture(u_source, v_texCoord);

  // RGB curve lookup — each channel remapped through its LUT
  vec4 lutSample = texture(u_curveLUT, vec2(color.r, 0.5));
  color.r = lutSample.r;
  lutSample = texture(u_curveLUT, vec2(color.g, 0.5));
  color.g = lutSample.g;
  lutSample = texture(u_curveLUT, vec2(color.b, 0.5));
  color.b = lutSample.b;

  // HSL-domain curves
  if (u_hsl_curves_active != 0) {
    vec3 hsl = rgb2hsl(color.rgb);

    // Row 0: Hue vs Saturation — adjust sat based on hue
    float hueVsSat = texture(u_hslCurveLUT, vec2(hsl.x, 0.1)).r;
    float satOffset0 = (hueVsSat - 128.0/255.0) * 2.0;
    hsl.y = clamp(hsl.y + satOffset0, 0.0, 1.0);

    // Row 1: Hue vs Hue — adjust hue based on hue
    float hueVsHue = texture(u_hslCurveLUT, vec2(hsl.x, 0.3)).r;
    float hueOffset = (hueVsHue - 128.0/255.0) * 2.0;
    hsl.x = fract(hsl.x + hueOffset);

    // Row 2: Hue vs Luma — adjust luma based on hue
    float hueVsLuma = texture(u_hslCurveLUT, vec2(hsl.x, 0.5)).r;
    float lumaOffset = (hueVsLuma - 128.0/255.0) * 2.0;
    hsl.z = clamp(hsl.z + lumaOffset * 0.5, 0.0, 1.0);

    // Row 3: Luma vs Saturation — adjust sat based on luma
    float lumaVsSat = texture(u_hslCurveLUT, vec2(hsl.z, 0.7)).r;
    float satOffset3 = (lumaVsSat - 128.0/255.0) * 2.0;
    hsl.y = clamp(hsl.y + satOffset3, 0.0, 1.0);

    // Row 4: Sat vs Saturation — adjust sat based on sat
    float satVsSat = texture(u_hslCurveLUT, vec2(hsl.y, 0.9)).r;
    float satOffset4 = (satVsSat - 128.0/255.0) * 2.0;
    hsl.y = clamp(hsl.y + satOffset4, 0.0, 1.0);

    color.rgb = hsl2rgb(hsl);
  }

  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  // === Lumetri Color: Pass 3 — HSL Secondary isolation + correction ===
  'lumetri-color-secondary': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;

// Key controls
uniform float u_hsl_hue_center;
uniform float u_hsl_hue_range;
uniform float u_hsl_sat_center;
uniform float u_hsl_sat_range;
uniform float u_hsl_luma_center;
uniform float u_hsl_luma_range;
uniform float u_hsl_denoise;

// Correction
uniform float u_hsl_temperature;
uniform float u_hsl_tint;
uniform float u_hsl_contrast;
uniform float u_hsl_saturation;
uniform float u_hsl_sharpen;
uniform vec2 u_texelSize;

// Mask preview
uniform int u_hsl_show_mask;

vec3 rgb2hsl(vec3 c) {
  float maxC = max(max(c.r, c.g), c.b);
  float minC = min(min(c.r, c.g), c.b);
  float l = (maxC + minC) * 0.5;
  float s = 0.0;
  float h = 0.0;
  if (maxC != minC) {
    float d = maxC - minC;
    s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 hsl = rgb2hsl(color.rgb);

  // Hue mask (wrapping at 360 degrees)
  float hDeg = hsl.x * 360.0;
  float hueDist = abs(mod(hDeg - u_hsl_hue_center + 180.0, 360.0) - 180.0);
  float hueRange = max(1.0, u_hsl_hue_range);
  float hueMask = 1.0 - smoothstep(hueRange * 0.8, hueRange, hueDist);

  // Saturation mask
  float sPct = hsl.y * 100.0;
  float satDist = abs(sPct - u_hsl_sat_center);
  float satRange = max(1.0, u_hsl_sat_range);
  float satMask = 1.0 - smoothstep(satRange * 0.8, satRange, satDist);

  // Luminance mask
  float lPct = hsl.z * 100.0;
  float lumDist = abs(lPct - u_hsl_luma_center);
  float lumRange = max(1.0, u_hsl_luma_range);
  float lumMask = 1.0 - smoothstep(lumRange * 0.8, lumRange, lumDist);

  // Combined mask
  float mask = hueMask * satMask * lumMask;

  // Denoise: threshold low-confidence pixels
  float denoise = u_hsl_denoise / 100.0;
  mask = smoothstep(denoise, denoise + 0.1, mask);

  // Show mask mode
  if (u_hsl_show_mask != 0) {
    fragColor = vec4(vec3(mask), color.a);
    return;
  }

  // Apply corrections weighted by mask
  vec3 corrected = color.rgb;

  // Temperature/tint shift
  float t = u_hsl_temperature / 100.0;
  float ti = u_hsl_tint / 100.0;
  corrected.r += t * 0.1;
  corrected.b -= t * 0.1;
  corrected.g += ti * 0.1;

  // Contrast
  float contrastF = u_hsl_contrast / 100.0 + 1.0;
  corrected = (corrected - 0.5) * contrastF + 0.5;

  // Saturation
  float lum = dot(corrected, vec3(0.2126, 0.7152, 0.0722));
  corrected = mix(vec3(lum), corrected, u_hsl_saturation / 100.0);

  // Sharpen (3x3 unsharp mask on source, applied to corrected)
  if (u_hsl_sharpen > 0.0) {
    vec4 cen = texture(u_source, v_texCoord);
    vec4 t2 = texture(u_source, v_texCoord + vec2(0.0, -u_texelSize.y));
    vec4 b2 = texture(u_source, v_texCoord + vec2(0.0, u_texelSize.y));
    vec4 l2 = texture(u_source, v_texCoord + vec2(-u_texelSize.x, 0.0));
    vec4 r2 = texture(u_source, v_texCoord + vec2(u_texelSize.x, 0.0));
    vec3 sharp = cen.rgb * 5.0 - t2.rgb - b2.rgb - l2.rgb - r2.rgb;
    corrected = mix(corrected, clamp(sharp, 0.0, 1.0), u_hsl_sharpen / 100.0);
  }

  // Blend corrected with original using mask
  color.rgb = mix(color.rgb, clamp(corrected, 0.0, 1.0), mask);

  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,

  // === Input color space linearization (log curves + sRGB) ===
  '_input-linearize': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform int u_curveType; // 0=sRGB, 1=S-Log3, 2=C-Log, 3=C-Log3, 4=V-Log, 5=LogC3, 6=LogC4, 7=N-Log
${GLSL_SRGB_UTILS}
${GLSL_LOG_CURVES}
void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 lin;
  if (u_curveType == 1) lin = slog3ToLinearV(color.rgb);
  else if (u_curveType == 2) lin = clogToLinearV(color.rgb);
  else if (u_curveType == 3) lin = clog3ToLinearV(color.rgb);
  else if (u_curveType == 4) lin = vlogToLinearV(color.rgb);
  else if (u_curveType == 5) lin = logc3ToLinearV(color.rgb);
  else if (u_curveType == 6) lin = logc4ToLinearV(color.rgb);
  else if (u_curveType == 7) lin = nlogToLinearV(color.rgb);
  else lin = srgbToLinear(color.rgb); // 0 = sRGB
  fragColor = vec4(lin, color.a);
}`,

  // === Tone mapping (linear HDR -> SDR display) ===
  '_tone-map': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform int u_toneMapType; // 0=Reinhard, 1=ACES
uniform float u_exposure;  // stops
${GLSL_TONE_MAPPING}
${GLSL_SRGB_UTILS}
void main() {
  vec4 color = texture(u_source, v_texCoord);
  vec3 lin = applyExposure(color.rgb, u_exposure);
  vec3 mapped;
  if (u_toneMapType == 1) mapped = tonemapACES(lin);
  else mapped = tonemapReinhard(lin);
  // Output stays linear — pipeline's delinearize pass handles sRGB encoding
  fragColor = vec4(mapped, color.a);
}`,

  'drop-shadow': `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_offsetX;
uniform float u_offsetY;
uniform float u_blur;
uniform vec3 u_color;
uniform vec2 u_texelSize;
void main() {
  vec4 original = texture(u_source, v_texCoord);
  // Sample shadow from offset position with blur
  vec2 shadowCoord = v_texCoord - vec2(u_offsetX, u_offsetY) * u_texelSize;
  vec4 shadowSample = vec4(0.0);
  float weightSum = 0.0;
  int r = int(ceil(u_blur));
  if (r < 1) r = 1;
  for (int y = -r; y <= r; y++) {
    for (int x = -r; x <= r; x++) {
      float d = float(x * x + y * y);
      float w = exp(-0.5 * d / max(u_blur * u_blur * 0.25, 0.001));
      vec2 coord = shadowCoord + vec2(float(x), float(y)) * u_texelSize;
      shadowSample += texture(u_source, coord) * w;
      weightSum += w;
    }
  }
  shadowSample /= weightSum;
  float shadowAlpha = shadowSample.a * (1.0 - original.a);
  vec3 result = original.rgb * original.a + u_color * shadowAlpha;
  fragColor = vec4(result, max(original.a, shadowAlpha));
}`,
};

// Map effect IDs to their uniform setter functions
// Each returns an object: { uniforms: {name: value}, passes: ['shader-id', ...] }
export function getEffectConfig(effectId, params) {
  switch (effectId) {
    case 'brightness-contrast':
      return {
        passes: ['brightness-contrast'],
        uniforms: {
          u_brightness: params.brightness / 100,
          u_contrast: (params.contrast + 100) / 100
        }
      };
    case 'saturation':
      return {
        passes: ['saturation'],
        uniforms: { u_amount: (params.amount + 100) / 100 }
      };
    case 'hue-rotate':
      return {
        passes: ['hue-rotate'],
        uniforms: { u_angle: params.angle }
      };
    case 'gaussian-blur':
      if (params.radius <= 0) return null;
      return {
        passes: ['gaussian-blur-h', 'gaussian-blur-v'],
        uniforms: { u_radius: Math.max(0, params.radius) }
      };
    case 'invert':
      if (params.amount <= 0) return null;
      return {
        passes: ['invert'],
        uniforms: { u_amount: params.amount / 100 }
      };
    case 'grayscale':
      if (params.amount <= 0) return null;
      return {
        passes: ['grayscale'],
        uniforms: { u_amount: params.amount / 100 }
      };
    case 'sepia':
      if (params.amount <= 0) return null;
      return {
        passes: ['sepia'],
        uniforms: { u_amount: params.amount / 100 }
      };
    case 'sharpen':
      if (params.amount <= 0) return null;
      return {
        passes: ['sharpen'],
        uniforms: { u_amount: params.amount / 100 }
      };
    case 'levels':
      return {
        passes: ['levels'],
        uniforms: {
          u_inputBlack: params.inputBlack / 255,
          u_inputWhite: params.inputWhite / 255,
          u_gamma: Math.max(0.01, params.gamma || 1),
          u_outputBlack: params.outputBlack / 255,
          u_outputWhite: params.outputWhite / 255
        }
      };
    case 'hsl-adjust':
      if (params.hue === 0 && params.saturation === 0 && params.lightness === 0) return null;
      return {
        passes: ['hsl-adjust'],
        uniforms: {
          u_hue: params.hue,
          u_saturation: params.saturation / 100,
          u_lightness: params.lightness / 100
        }
      };
    case 'vignette':
      if (params.amount <= 0) return null;
      return {
        passes: ['vignette'],
        uniforms: {
          u_amount: params.amount / 100,
          u_size: params.size / 100
        }
      };
    case 'drop-shadow':
      return {
        passes: ['drop-shadow'],
        uniforms: {
          u_offsetX: params.offsetX,
          u_offsetY: params.offsetY,
          u_blur: Math.max(0, params.blur),
          u_color: safeVec3(hexToVec3(params.color || '#000000'))
        }
      };
    case 'lumetri-color': {
      const passes = [];
      const uniforms = {};

      // Pass 1: Main (Basic + Creative + Wheels + Vignette)
      const basicOn = params.basic_enabled !== false;
      const creativeOn = !!params.creative_enabled;
      const wheelsOn = !!params.wheels_enabled;
      const vignetteOn = !!params.vignette_enabled;

      if (basicOn || creativeOn || wheelsOn || vignetteOn) {
        passes.push('lumetri-color-main');

        // Basic Correction uniforms
        uniforms.u_basic_enabled = basicOn ? 1 : 0;
        uniforms.u_temperature = params.temperature || 0;
        uniforms.u_tint = params.tint || 0;
        uniforms.u_exposure = params.exposure || 0;
        uniforms.u_contrast = params.contrast || 0;
        uniforms.u_highlights = params.highlights || 0;
        uniforms.u_shadows = params.shadows || 0;
        uniforms.u_whites = params.whites || 0;
        uniforms.u_blacks = params.blacks || 0;
        uniforms.u_saturation = Math.max(0, params.saturation != null ? params.saturation : 100);
        uniforms.u_vibrance = Math.max(-100, Math.min(100, params.vibrance || 0));

        // Creative
        uniforms.u_creative_enabled = creativeOn ? 1 : 0;
        uniforms.u_faded_film = params.faded_film || 0;
        uniforms.u_creative_vibrance = Math.max(-100, Math.min(100, params.creative_vibrance || 0));
        uniforms.u_creative_saturation = Math.max(0, params.creative_saturation != null ? params.creative_saturation : 100);
        uniforms.u_shadow_tint = safeVec3(hexToVec3(params.shadow_tint || '#808080'));
        uniforms.u_highlight_tint = safeVec3(hexToVec3(params.highlight_tint || '#808080'));
        uniforms.u_tint_balance = params.tint_balance || 0;

        // Color Wheels
        uniforms.u_wheels_enabled = wheelsOn ? 1 : 0;
        const sw = wheelToRGB(params.shadow_hue || 0, params.shadow_sat || 0);
        uniforms.u_shadow_wheel_r = sw[0];
        uniforms.u_shadow_wheel_g = sw[1];
        uniforms.u_shadow_wheel_b = sw[2];
        uniforms.u_shadow_luma = params.shadow_luma || 0;
        const mw = wheelToRGB(params.midtone_hue || 0, params.midtone_sat || 0);
        uniforms.u_midtone_wheel_r = mw[0];
        uniforms.u_midtone_wheel_g = mw[1];
        uniforms.u_midtone_wheel_b = mw[2];
        uniforms.u_midtone_luma = params.midtone_luma || 0;
        const hw = wheelToRGB(params.highlight_hue || 0, params.highlight_sat || 0);
        uniforms.u_highlight_wheel_r = hw[0];
        uniforms.u_highlight_wheel_g = hw[1];
        uniforms.u_highlight_wheel_b = hw[2];
        uniforms.u_highlight_luma = params.highlight_luma || 0;

        // Vignette
        uniforms.u_vignette_enabled = vignetteOn ? 1 : 0;
        uniforms.u_vignette_amount = params.vignette_amount || 0;
        uniforms.u_vignette_midpoint = params.vignette_midpoint != null ? params.vignette_midpoint : 50;
        uniforms.u_vignette_roundness = params.vignette_roundness != null ? params.vignette_roundness : 50;
        uniforms.u_vignette_feather = params.vignette_feather != null ? params.vignette_feather : 50;
      }

      // Creative Sharpen — reuse existing sharpen shader as extra pass
      if (creativeOn && params.creative_sharpen > 0) {
        passes.push('sharpen');
        uniforms.u_amount = params.creative_sharpen / 100;
      }

      // Pass 2: Curves
      if (params.curves_enabled && params._curveLUT) {
        passes.push('lumetri-color-curves');
        uniforms.u_curveLUT = params._curveLUT;
        uniforms.u_hsl_curves_active = params._hslCurveLUT ? 1 : 0;
        if (params._hslCurveLUT) {
          uniforms.u_hslCurveLUT = params._hslCurveLUT;
        }
      }

      // Pass 3: HSL Secondary
      if (params.hsl_enabled) {
        passes.push('lumetri-color-secondary');
        uniforms.u_hsl_hue_center = params.hsl_hue_center || 0;
        uniforms.u_hsl_hue_range = params.hsl_hue_range != null ? params.hsl_hue_range : 30;
        uniforms.u_hsl_sat_center = params.hsl_sat_center != null ? params.hsl_sat_center : 50;
        uniforms.u_hsl_sat_range = params.hsl_sat_range != null ? params.hsl_sat_range : 50;
        uniforms.u_hsl_luma_center = params.hsl_luma_center != null ? params.hsl_luma_center : 50;
        uniforms.u_hsl_luma_range = params.hsl_luma_range != null ? params.hsl_luma_range : 50;
        uniforms.u_hsl_denoise = params.hsl_denoise != null ? params.hsl_denoise : 10;
        uniforms.u_hsl_temperature = params.hsl_temperature || 0;
        uniforms.u_hsl_tint = params.hsl_tint || 0;
        uniforms.u_hsl_contrast = params.hsl_contrast || 0;
        uniforms.u_hsl_saturation = params.hsl_saturation != null ? params.hsl_saturation : 100;
        uniforms.u_hsl_show_mask = params.hsl_show_mask ? 1 : 0;
        uniforms.u_hsl_sharpen = params.hsl_sharpen || 0;
      }

      if (passes.length === 0) return null;
      return { passes, uniforms };
    }
    default:
      return null;
  }
}

// Helper for drop-shadow color
function hexToVec3(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

// Validate a vec3 array: must be 3-element, all finite numbers
function safeVec3(v) {
  if (!Array.isArray(v) || v.length !== 3) return [0, 0, 0];
  return [
    isFinite(v[0]) ? v[0] : 0,
    isFinite(v[1]) ? v[1] : 0,
    isFinite(v[2]) ? v[2] : 0
  ];
}

// Convert color wheel hue (degrees) + saturation (0-100) to RGB offset vector
function wheelToRGB(hue, sat) {
  const s = sat / 100;
  const h = hue / 360;
  // HSL to RGB with L=0.5 for pure color, then scale by saturation
  const q = 0.5 + 0.5;  // L=0.5 -> q = 1
  const p = 0;
  const hue2rgb = (p2, q2, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p2 + (q2 - p2) * 6 * t;
    if (t < 1/2) return q2;
    if (t < 2/3) return p2 + (q2 - p2) * (2/3 - t) * 6;
    return p2;
  };
  const r = hue2rgb(p, q, h + 1/3) * s;
  const g = hue2rgb(p, q, h) * s;
  const b = hue2rgb(p, q, h - 1/3) * s;
  return [r - 0.5 * s, g - 0.5 * s, b - 0.5 * s]; // centered offset
}

// Set of effect IDs that have GL shader implementations
// Includes both direct shader IDs and compound effect IDs (whose passes map to multiple shaders)
export const GL_SUPPORTED_EFFECTS = new Set([
  ...Object.keys(FRAGMENT_SHADERS),
  'lumetri-color'  // compound effect: passes resolved by getEffectConfig
]);

// Effects that should NOT use GL (handled as canvas compositing)
export const COMPOSITING_EFFECTS = new Set(['transform', 'opacity', 'crop']);

// Composite vertex shader — transforms clip position via u_mvp mat3
export const COMPOSITE_VERT = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
uniform mat3 u_mvp;
void main() {
  vec3 pos = u_mvp * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

// Composite fragment shader — crop + opacity on the composited output
export const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
uniform float u_opacity;
uniform vec4 u_crop; // left, top, right, bottom (0..1 ratios)
void main() {
  // Discard pixels in crop regions
  if (v_texCoord.x < u_crop.x || v_texCoord.x > (1.0 - u_crop.z) ||
      v_texCoord.y < u_crop.y || v_texCoord.y > (1.0 - u_crop.w)) {
    fragColor = vec4(0.0);
    return;
  }
  vec4 color = texture(u_source, v_texCoord);
  fragColor = vec4(color.rgb, color.a * u_opacity);
}`;

