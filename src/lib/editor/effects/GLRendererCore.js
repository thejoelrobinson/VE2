// Shared WebGL 2.0 GPU-accelerated effect renderer core.
// Factory function returning a plain renderer object usable in both
// main-thread (GLEffectRenderer) and worker (CompositorWorker) contexts.
import { VERTEX_SHADER, FRAGMENT_SHADERS, getEffectConfig, GL_SUPPORTED_EFFECTS, GLSL_SRGB_UTILS } from './effectShaders.js';

/**
 * Create a GL renderer instance.
 * @param {{ log?: (...args: any[]) => void, createCanvas?: () => HTMLCanvasElement|OffscreenCanvas }} [opts]
 */
export function createGLRenderer(opts = {}) {
  const log = opts.log || console;

  return {
    _gl: null,
    _canvas: null,
    _programs: new Map(),
    _quadVAO: null,
    _sourceTexture: null,
    _fbos: [null, null],
    _fboTextures: [null, null],
    _currentFBO: 0,
    _width: 0,
    _height: 0,
    _initialized: false,
    _lutTextures: new Map(),
    _nextTexUnit: 1,
    _hasFloat: false,   // EXT_color_buffer_float available (RGBA16F render targets)
    _contextLost: false,
    _failedShaders: new Set(),

    init(canvas) {
      if (this._initialized) return true;

      if (canvas) {
        this._canvas = canvas;
      } else if (typeof OffscreenCanvas !== 'undefined') {
        this._canvas = new OffscreenCanvas(1, 1);
      } else if (opts.createCanvas) {
        this._canvas = opts.createCanvas();
      } else if (typeof document !== 'undefined') {
        this._canvas = document.createElement('canvas');
      } else {
        return false;
      }

      // WebGL context loss/restore handling
      this._canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        log.warn('[GLRenderer] WebGL context lost');
        this._contextLost = true;
      });
      this._canvas.addEventListener('webglcontextrestored', () => {
        log.info('[GLRenderer] WebGL context restored, reinitializing');
        this._contextLost = false;
        this._reinitialize();
      });

      this._gl = this._canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        alpha: true,
        preserveDrawingBuffer: true,
        antialias: false,
        powerPreference: 'high-performance'
      });

      if (!this._gl) {
        log.warn('WebGL 2.0 not available');
        return false;
      }

      // Enable RGBA16F render targets for higher precision (prevents banding in multi-pass effects)
      const floatExt = this._gl.getExtension('EXT_color_buffer_float');
      this._hasFloat = !!floatExt;
      if (this._hasFloat) {
        log.info('[GLRenderer] RGBA16F render targets enabled');
      }

      this._setupQuad();
      this._initialized = true;
      return true;
    },

    _reinitialize() {
      const gl = this._gl;
      if (!gl) return;
      // Clear old state
      this._programs.clear();
      this._failedShaders.clear();
      this._fbos = [null, null];
      this._fboTextures = [null, null];
      this._sourceTexture = null;
      this._lutTextures.clear();
      this._nextTexUnit = 1;
      this._quadVAO = null;
      this._width = 0;
      this._height = 0;
      // Re-check float support
      const floatExt = gl.getExtension('EXT_color_buffer_float');
      this._hasFloat = !!floatExt;
      // Rebuild quad
      this._setupQuad();
    },

    _setupQuad() {
      const gl = this._gl;
      const vertices = new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
         1,  1, 1, 1,
      ]);
      this._quadVAO = gl.createVertexArray();
      gl.bindVertexArray(this._quadVAO);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindVertexArray(null);
    },

    _extractUniforms(program) {
      const gl = this._gl;
      const uniforms = {};
      const uniformTypes = {};
      const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < numUniforms; i++) {
        const info = gl.getActiveUniform(program, i);
        uniforms[info.name] = gl.getUniformLocation(program, info.name);
        uniformTypes[info.name] = info.type;
      }
      return { uniforms, uniformTypes };
    },

    _getProgram(shaderId) {
      if (this._programs.has(shaderId)) return this._programs.get(shaderId);
      if (this._failedShaders.has(shaderId)) return null;
      const fragSrc = FRAGMENT_SHADERS[shaderId];
      if (!fragSrc) return null;
      const program = this._compileProgram(VERTEX_SHADER, fragSrc);
      if (!program) {
        this._failedShaders.add(shaderId);
        return null;
      }
      const { uniforms, uniformTypes } = this._extractUniforms(program);
      const entry = { program, uniforms, uniformTypes };
      this._programs.set(shaderId, entry);
      return entry;
    },

    _compileProgram(vertSrc, fragSrc) {
      const gl = this._gl;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vertSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        const msg = gl.getShaderInfoLog(vs);
        log.error('Vertex shader compile error:', msg);
        gl.deleteShader(vs);
        return null;
      }
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        const msg = gl.getShaderInfoLog(fs);
        log.error('Fragment shader compile error:', msg);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.bindAttribLocation(program, 0, 'a_position');
      gl.bindAttribLocation(program, 1, 'a_texCoord');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const msg = gl.getProgramInfoLog(program);
        log.error('Program link error:', msg);
        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return program;
    },

    _resize(width, height) {
      if (this._width === width && this._height === height) return;
      const gl = this._gl;
      this._width = width;
      this._height = height;
      this._canvas.width = width;
      this._canvas.height = height;
      gl.viewport(0, 0, width, height);
      for (let i = 0; i < 2; i++) {
        if (this._fbos[i]) gl.deleteFramebuffer(this._fbos[i]);
        if (this._fboTextures[i]) gl.deleteTexture(this._fboTextures[i]);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // RGBA16F: 16-bit float precision prevents banding in multi-pass effect chains
        if (this._hasFloat) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          log.error(`[GLRenderer] FBO incomplete: ${status}`);
          gl.deleteFramebuffer(fbo);
          gl.deleteTexture(tex);
          this._fbos[i] = null;
          this._fboTextures[i] = null;
          continue;
        }
        this._fboTextures[i] = tex;
        this._fbos[i] = fbo;
      }
      if (!this._sourceTexture) {
        this._sourceTexture = gl.createTexture();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    _getPassthroughProgram() {
      if (this._programs.has('_passthrough')) return this._programs.get('_passthrough');
      const fragSrc = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
void main() {
  fragColor = texture(u_source, v_texCoord);
}`;
      const program = this._compileProgram(VERTEX_SHADER, fragSrc);
      if (!program) {
        log.error('[GLRenderer] Failed to compile passthrough program');
        return null;
      }
      const { uniforms } = this._extractUniforms(program);
      const entry = { program, uniforms };
      this._programs.set('_passthrough', entry);
      return entry;
    },

    _getLinearizeProgram() {
      if (this._programs.has('_linearize')) return this._programs.get('_linearize');
      const fragSrc = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
${GLSL_SRGB_UTILS}
void main() {
  vec4 color = texture(u_source, v_texCoord);
  fragColor = vec4(srgbToLinear(color.rgb), color.a);
}`;
      const program = this._compileProgram(VERTEX_SHADER, fragSrc);
      if (!program) return null;
      const { uniforms } = this._extractUniforms(program);
      const entry = { program, uniforms };
      this._programs.set('_linearize', entry);
      return entry;
    },

    _getDelinearizeProgram() {
      if (this._programs.has('_delinearize')) return this._programs.get('_delinearize');
      const fragSrc = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_source;
${GLSL_SRGB_UTILS}
void main() {
  vec4 color = texture(u_source, v_texCoord);
  fragColor = vec4(linearToSrgb(color.rgb), color.a);
}`;
      const program = this._compileProgram(VERTEX_SHADER, fragSrc);
      if (!program) return null;
      const { uniforms } = this._extractUniforms(program);
      const entry = { program, uniforms };
      this._programs.set('_delinearize', entry);
      return entry;
    },

    uploadSource(source, width, height, linearize = false) {
      if (this._contextLost) return false;
      const gl = this._gl;
      // Validate texture size
      const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (width > maxSize || height > maxSize) {
        log.error(`[GLRenderer] Source ${width}x${height} exceeds MAX_TEXTURE_SIZE ${maxSize}`);
        return false;
      }
      this._resize(width, height);
      gl.bindTexture(gl.TEXTURE_2D, this._sourceTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._currentFBO = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[0]);
      gl.viewport(0, 0, width, height);
      const prog = linearize ? this._getLinearizeProgram() : this._getPassthroughProgram();
      if (!prog) {
        log.error('[GLRenderer] Passthrough/linearize program unavailable');
        return false;
      }
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._sourceTexture);
      gl.uniform1i(prog.uniforms['u_source'], 0);
      gl.bindVertexArray(this._quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    },

    applyEffect(effectId, params) {
      if (!this._initialized || !this._gl || this._contextLost) return false;
      const config = getEffectConfig(effectId, params);
      if (!config) return false;
      const gl = this._gl;
      for (const passId of config.passes) {
        const prog = this._getProgram(passId);
        if (!prog) {
          log.warn(`No GL shader for pass: ${passId}`);
          return false;
        }
        const readFBO = this._currentFBO;
        const writeFBO = 1 - readFBO;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[writeFBO]);
        gl.viewport(0, 0, this._width, this._height);
        gl.useProgram(prog.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._fboTextures[readFBO]);
        if (prog.uniforms['u_source'] !== undefined) {
          gl.uniform1i(prog.uniforms['u_source'], 0);
        }
        if (prog.uniforms['u_texelSize'] !== undefined) {
          gl.uniform2f(prog.uniforms['u_texelSize'], 1.0 / this._width, 1.0 / this._height);
        }
        for (const [name, value] of Object.entries(config.uniforms)) {
          const loc = prog.uniforms[name];
          if (loc === undefined) continue;
          if (value && typeof value === 'object' && value._isTexture) {
            gl.activeTexture(gl.TEXTURE0 + value._textureUnit);
            gl.bindTexture(gl.TEXTURE_2D, value._texture);
            gl.uniform1i(loc, value._textureUnit);
          } else if (Array.isArray(value)) {
            if (value.length === 2) gl.uniform2fv(loc, value);
            else if (value.length === 3) gl.uniform3fv(loc, value);
            else if (value.length === 4) gl.uniform4fv(loc, value);
          } else if (typeof value === 'boolean') {
            gl.uniform1i(loc, value ? 1 : 0);
          } else {
            const uType = prog.uniformTypes[name];
            if (uType === gl.INT || uType === gl.BOOL || uType === gl.SAMPLER_2D) {
              gl.uniform1i(loc, value);
            } else {
              gl.uniform1f(loc, value);
            }
          }
        }
        gl.bindVertexArray(this._quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this._currentFBO = writeFBO;
      }
      return true;
    },

    readResult(targetCtx, delinearize = false) {
      if (!this._initialized || !this._gl || this._contextLost) return;
      const gl = this._gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this._width, this._height);
      const prog = delinearize ? this._getDelinearizeProgram() : this._getPassthroughProgram();
      if (!prog) {
        log.error('[GLRenderer] Delinearize/passthrough program unavailable');
        return;
      }
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTextures[this._currentFBO]);
      gl.uniform1i(prog.uniforms['u_source'], 0);
      gl.bindVertexArray(this._quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      targetCtx.drawImage(this._canvas, 0, 0);
    },

    hasShader(effectId) {
      return GL_SUPPORTED_EFFECTS.has(effectId);
    },

    uploadLUT(key, data, width, height = 1) {
      if (!this._initialized || !this._gl || this._contextLost) return null;
      const gl = this._gl;
      let entry = this._lutTextures.get(key);
      if (!entry) {
        const maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
        if (this._nextTexUnit >= maxUnits) {
          log.warn('[GLRenderer] Texture unit limit reached, evicting oldest LUT');
          const oldestKey = this._lutTextures.keys().next().value;
          const old = this._lutTextures.get(oldestKey);
          gl.deleteTexture(old.texture);
          this._lutTextures.delete(oldestKey);
          entry = { texture: gl.createTexture(), unit: old.unit };
        } else {
          const texture = gl.createTexture();
          const unit = this._nextTexUnit++;
          entry = { texture, unit };
        }
        this._lutTextures.set(key, entry);
      }
      gl.activeTexture(gl.TEXTURE0 + entry.unit);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (data.length === width * height * 4) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { _isTexture: true, _texture: entry.texture, _textureUnit: entry.unit };
    },

    cleanup() {
      if (!this._gl) return;
      const gl = this._gl;
      for (const [, entry] of this._programs) {
        gl.deleteProgram(entry.program);
      }
      this._programs.clear();
      this._failedShaders.clear();
      for (let i = 0; i < 2; i++) {
        if (this._fbos[i]) gl.deleteFramebuffer(this._fbos[i]);
        if (this._fboTextures[i]) gl.deleteTexture(this._fboTextures[i]);
      }
      this._fbos = [null, null];
      this._fboTextures = [null, null];
      if (this._sourceTexture) gl.deleteTexture(this._sourceTexture);
      this._sourceTexture = null;
      for (const [, entry] of this._lutTextures) {
        gl.deleteTexture(entry.texture);
      }
      this._lutTextures.clear();
      this._nextTexUnit = 1;
      if (this._quadVAO) gl.deleteVertexArray(this._quadVAO);
      this._quadVAO = null;
      this._gl = null;
      this._canvas = null;
      this._initialized = false;
      this._width = 0;
      this._height = 0;
    }
  };
}
