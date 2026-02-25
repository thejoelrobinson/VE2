// Canvas-based bezier curve editor widget for Lumetri Color panel
// Reusable class — instantiate per curve section
import { clamp } from '../../core/MathUtils.js';

const POINT_RADIUS = 5;
const POINT_HIT_RADIUS = 10;
const GRID_DIVISIONS = 4;

const CHANNEL_COLORS = {
  master: '#d4d4d4',
  red: '#ff4444',
  green: '#44cc44',
  blue: '#4488ff'
};

export class CurveEditor {
  /**
   * @param {HTMLElement} container - parent element to mount into
   * @param {object} opts
   * @param {string[]} opts.channels - e.g. ['master','red','green','blue'] or ['hueVsSat','hueVsHue',...]
   * @param {Function} opts.onChange - (channel, points) => void
   * @param {number} [opts.width=256]
   * @param {number} [opts.height=256]
   */
  constructor(container, opts) {
    this._container = container;
    this._channels = opts.channels || ['master', 'red', 'green', 'blue'];
    this._onChange = opts.onChange || (() => {});
    this._width = opts.width || 256;
    this._height = opts.height || 256;

    // Points per channel: { channelName: [[x,y], ...] }
    this._points = {};
    for (const ch of this._channels) {
      this._points[ch] = [[0, 0], [1, 1]];
    }

    this._activeChannel = this._channels[0];
    this._dragging = null; // index of point being dragged
    this._hovered = -1;

    this._el = document.createElement('div');
    this._el.className = 'nle-lumetri-curve-editor';

    // Channel tabs
    this._tabBar = document.createElement('div');
    this._tabBar.className = 'nle-lumetri-curve-tabs';
    for (const ch of this._channels) {
      const tab = document.createElement('button');
      tab.className = 'nle-lumetri-curve-tab';
      tab.dataset.channel = ch;
      tab.textContent = ch === 'master' ? 'RGB' : ch.charAt(0).toUpperCase();
      if (CHANNEL_COLORS[ch]) {
        tab.style.borderBottomColor = CHANNEL_COLORS[ch];
      }
      if (ch === this._activeChannel) tab.classList.add('active');
      tab.addEventListener('click', () => this._setChannel(ch));
      this._tabBar.appendChild(tab);
    }
    this._el.appendChild(this._tabBar);

    // Canvas
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'nle-lumetri-curve-canvas';
    this._canvas.width = this._width;
    this._canvas.height = this._height;
    this._ctx = this._canvas.getContext('2d');
    this._el.appendChild(this._canvas);

    // Mouse handlers — store bound refs for cleanup
    this._boundMouseDown = (e) => this._onMouseDown(e);
    this._boundMouseMove = (e) => this._onMouseMove(e);
    this._boundMouseUp = () => this._onMouseUp();
    this._boundDblClick = (e) => this._onDblClick(e);

    this._canvas.addEventListener('mousedown', this._boundMouseDown);
    this._canvas.addEventListener('dblclick', this._boundDblClick);
    // mousemove/mouseup on window for drag-outside-canvas support
    window.addEventListener('mousemove', this._boundMouseMove);
    window.addEventListener('mouseup', this._boundMouseUp);

    container.appendChild(this._el);
    this._draw();
  }

  setPoints(channel, points) {
    this._points[channel] = points && points.length >= 2
      ? [...points.map(p => [...p])]
      : [[0, 0], [1, 1]];
    if (channel === this._activeChannel) this._draw();
  }

  getPoints(channel) {
    return this._points[channel] ? this._points[channel].map(p => [...p]) : [[0, 0], [1, 1]];
  }

  destroy() {
    this._canvas.removeEventListener('mousedown', this._boundMouseDown);
    this._canvas.removeEventListener('dblclick', this._boundDblClick);
    window.removeEventListener('mousemove', this._boundMouseMove);
    window.removeEventListener('mouseup', this._boundMouseUp);
    this._el.remove();
  }

  _setChannel(ch) {
    this._activeChannel = ch;
    for (const tab of this._tabBar.children) {
      tab.classList.toggle('active', tab.dataset.channel === ch);
    }
    this._draw();
  }

  _getMousePos(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height; // flip Y
    return [clamp(x, 0, 1), clamp(y, 0, 1)];
  }

  _findPoint(mx, my) {
    const pts = this._points[this._activeChannel];
    const hitR = POINT_HIT_RADIUS / this._width;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - mx;
      const dy = pts[i][1] - my;
      if (Math.sqrt(dx * dx + dy * dy) < hitR) return i;
    }
    return -1;
  }

  _onMouseDown(e) {
    const [mx, my] = this._getMousePos(e);
    const idx = this._findPoint(mx, my);
    if (idx >= 0) {
      this._dragging = idx;
      this._canvas.style.cursor = 'grabbing';
    } else {
      // Add new point
      const pts = this._points[this._activeChannel];
      pts.push([mx, my]);
      pts.sort((a, b) => a[0] - b[0]);
      this._dragging = pts.findIndex(p => p[0] === mx && p[1] === my);
      this._draw();
      this._onChange(this._activeChannel, this.getPoints(this._activeChannel));
    }
  }

  _onMouseMove(e) {
    const [mx, my] = this._getMousePos(e);
    if (this._dragging !== null && this._dragging >= 0) {
      const pts = this._points[this._activeChannel];
      const pt = pts[this._dragging];

      // First and last points are locked to x=0 and x=1
      if (this._dragging === 0) {
        pt[0] = 0;
      } else if (this._dragging === pts.length - 1) {
        pt[0] = 1;
      } else {
        // Constrain between neighbors
        const prev = pts[this._dragging - 1][0] + 0.005;
        const next = pts[this._dragging + 1][0] - 0.005;
        pt[0] = clamp(mx, prev, next);
      }
      pt[1] = my;
      this._draw();
    } else {
      const idx = this._findPoint(mx, my);
      this._canvas.style.cursor = idx >= 0 ? 'grab' : 'crosshair';
    }
  }

  _onMouseUp() {
    if (this._dragging !== null) {
      this._dragging = null;
      this._canvas.style.cursor = 'crosshair';
      this._onChange(this._activeChannel, this.getPoints(this._activeChannel));
    }
  }

  _onDblClick(e) {
    const [mx, my] = this._getMousePos(e);
    const idx = this._findPoint(mx, my);
    if (idx > 0 && idx < this._points[this._activeChannel].length - 1) {
      // Delete point (not first or last)
      this._points[this._activeChannel].splice(idx, 1);
      this._draw();
      this._onChange(this._activeChannel, this.getPoints(this._activeChannel));
    }
  }

  _draw() {
    const ctx = this._ctx;
    const w = this._width;
    const h = this._height;
    const ch = this._activeChannel;
    const pts = this._points[ch];

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < GRID_DIVISIONS; i++) {
      const pos = (i / GRID_DIVISIONS) * w;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(w, pos);
      ctx.stroke();
    }

    // Identity diagonal
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw curve using monotone cubic interpolation
    const color = CHANNEL_COLORS[ch] || '#d4d4d4';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    if (pts.length >= 2) {
      const sorted = [...pts].sort((a, b) => a[0] - b[0]);
      // Sample curve at each pixel
      for (let px = 0; px < w; px++) {
        const x = px / (w - 1);
        const y = this._interpolate(sorted, x);
        const sy = (1 - y) * h;
        if (px === 0) ctx.moveTo(px, sy);
        else ctx.lineTo(px, sy);
      }
    }
    ctx.stroke();

    // Draw control points
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0] * w;
      const py = (1 - pts[i][1]) * h;

      ctx.fillStyle = this._dragging === i ? '#ffffff' : color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Monotone cubic Hermite interpolation at x given sorted points
  _interpolate(sorted, x) {
    const n = sorted.length;
    if (x <= sorted[0][0]) return sorted[0][1];
    if (x >= sorted[n - 1][0]) return sorted[n - 1][1];

    // Find segment
    let seg = 0;
    for (let j = 0; j < n - 1; j++) {
      if (x >= sorted[j][0] && x < sorted[j + 1][0]) { seg = j; break; }
    }

    const xs = sorted.map(p => p[0]);
    const ys = sorted.map(p => p[1]);

    // Compute tangents
    const deltas = [];
    for (let i = 0; i < n - 1; i++) {
      deltas[i] = (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6);
    }
    const m = new Array(n);
    m[0] = deltas[0];
    m[n - 1] = deltas[n - 2];
    for (let i = 1; i < n - 1; i++) {
      m[i] = (deltas[i - 1] + deltas[i]) / 2;
      if (deltas[i - 1] * deltas[i] <= 0) m[i] = 0;
    }

    const hh = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / hh;
    const t2 = t * t;
    const t3 = t2 * t;

    return clamp(
      (2 * t3 - 3 * t2 + 1) * ys[seg] +
      (t3 - 2 * t2 + t) * hh * m[seg] +
      (-2 * t3 + 3 * t2) * ys[seg + 1] +
      (t3 - t2) * hh * m[seg + 1],
      0, 1
    );
  }
}

export default CurveEditor;
