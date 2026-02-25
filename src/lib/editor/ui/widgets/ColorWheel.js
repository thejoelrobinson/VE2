// Circular color wheel widget for 3-way color correction
// Class-based, reusable — one per shadow/midtone/highlight

const WHEEL_PADDING = 8;
const CROSSHAIR_SIZE = 6;
const LUMA_SLIDER_HEIGHT = 16;

export class ColorWheel {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.label - 'Shadows', 'Midtones', or 'Highlights'
   * @param {Function} opts.onChange - (hue, sat, luma) => void
   */
  constructor(container, opts) {
    this._container = container;
    this._label = opts.label || 'Wheel';
    this._onChange = opts.onChange || (() => {});

    this._hue = 0;    // degrees 0-360
    this._sat = 0;    // 0-100
    this._luma = 0;   // -100 to 100

    this._dragging = false;

    this._el = document.createElement('div');
    this._el.className = 'nle-lumetri-color-wheel';

    // Label
    const labelEl = document.createElement('div');
    labelEl.className = 'nle-lumetri-wheel-label';
    labelEl.textContent = this._label;
    this._el.appendChild(labelEl);

    // Canvas for wheel
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'nle-lumetri-wheel-canvas';
    this._canvas.width = 120;
    this._canvas.height = 120;
    this._ctx = this._canvas.getContext('2d');
    this._el.appendChild(this._canvas);

    // Luma slider
    this._lumaWrap = document.createElement('div');
    this._lumaWrap.className = 'nle-lumetri-wheel-luma';
    this._lumaSlider = document.createElement('input');
    this._lumaSlider.type = 'range';
    this._lumaSlider.min = '-100';
    this._lumaSlider.max = '100';
    this._lumaSlider.value = '0';
    this._lumaSlider.step = '1';
    this._lumaSlider.className = 'nle-lumetri-wheel-luma-slider';
    this._lumaSlider.addEventListener('input', () => {
      this._luma = parseInt(this._lumaSlider.value, 10);
      this._onChange(this._hue, this._sat, this._luma);
    });
    this._lumaWrap.appendChild(this._lumaSlider);
    this._el.appendChild(this._lumaWrap);

    // Wheel mouse events
    this._canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('mousemove', this._boundMouseMove = (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', this._boundMouseUp = () => this._onMouseUp());

    // Double-click to reset
    this._canvas.addEventListener('dblclick', () => {
      this._hue = 0;
      this._sat = 0;
      this._luma = 0;
      this._lumaSlider.value = '0';
      this._draw();
      this._onChange(this._hue, this._sat, this._luma);
    });

    container.appendChild(this._el);
    this._draw();
  }

  setValues(hue, sat, luma) {
    this._hue = hue;
    this._sat = sat;
    this._luma = luma;
    this._lumaSlider.value = String(luma);
    this._draw();
  }

  destroy() {
    window.removeEventListener('mousemove', this._boundMouseMove);
    window.removeEventListener('mouseup', this._boundMouseUp);
    this._el.remove();
  }

  _getWheelCenter() {
    return { x: this._canvas.width / 2, y: this._canvas.height / 2 };
  }

  _getWheelRadius() {
    return (Math.min(this._canvas.width, this._canvas.height) / 2) - WHEEL_PADDING;
  }

  _onMouseDown(e) {
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const center = this._getWheelCenter();
    const r = this._getWheelRadius();
    const dist = Math.sqrt((mx - center.x) ** 2 + (my - center.y) ** 2);
    if (dist <= r) {
      this._dragging = true;
      this._updateFromMouse(mx, my);
    }
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    this._updateFromMouse(mx, my);
  }

  _onMouseUp() {
    if (this._dragging) {
      this._dragging = false;
      this._onChange(this._hue, this._sat, this._luma);
    }
  }

  _updateFromMouse(mx, my) {
    const center = this._getWheelCenter();
    const r = this._getWheelRadius();
    const dx = mx - center.x;
    const dy = my - center.y;
    const dist = Math.min(r, Math.sqrt(dx * dx + dy * dy));

    this._sat = Math.round((dist / r) * 100);
    // Convert mouse angle to CSS hue: atan2(-dy,dx) gives 0=right,90=up
    // Ring maps 3 o'clock to CSS hue 90, so CSS hue = mouseAngle + 90
    const mouseAngle = ((Math.atan2(-dy, dx) * 180 / Math.PI) + 360) % 360;
    this._hue = Math.round((mouseAngle + 90) % 360);

    this._draw();
    this._onChange(this._hue, this._sat, this._luma);
  }

  _draw() {
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const center = this._getWheelCenter();
    const r = this._getWheelRadius();

    ctx.clearRect(0, 0, w, h);

    // Draw color ring using conic gradient (simulated via arc segments)
    const segments = 360;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const nextAngle = ((i + 1) / segments) * Math.PI * 2;

      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.arc(center.x, center.y, r, angle, nextAngle);
      ctx.closePath();

      const hue = (i + 90) % 360; // offset so red is at top
      ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
      ctx.fill();
    }

    // Inner fill (dark center)
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = '#2a2a2a';
    ctx.fill();

    // Gradient from center to edge for saturation indication
    const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r * 0.7);
    gradient.addColorStop(0, 'rgba(42, 42, 42, 1)');
    gradient.addColorStop(1, 'rgba(42, 42, 42, 0)');
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Ring border
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Crosshair at current position
    // Stored hue is CSS hue (0=red, 120=green, 240=blue)
    // Convert back to canvas angle: mouseAngle = hue - 90
    const mouseAngle = (this._hue - 90) * Math.PI / 180;
    const dist = (this._sat / 100) * r;
    const cx = center.x + Math.cos(mouseAngle) * dist;
    const cy = center.y - Math.sin(mouseAngle) * dist;

    // Crosshair
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - CROSSHAIR_SIZE, cy);
    ctx.lineTo(cx + CROSSHAIR_SIZE, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - CROSSHAIR_SIZE);
    ctx.lineTo(cx, cy + CROSSHAIR_SIZE);
    ctx.stroke();

    // Dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

export default ColorWheel;
