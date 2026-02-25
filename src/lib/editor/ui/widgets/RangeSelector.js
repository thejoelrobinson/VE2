// Dual-handle range selector for HSL Secondary keying
// Gradient track background with center + range boundary handles
import { clamp } from '../../core/MathUtils.js';

export class RangeSelector {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.label - e.g. 'Hue', 'Saturation', 'Luminance'
   * @param {string} opts.gradient - CSS gradient for track bg, e.g. 'linear-gradient(to right, red, ...)'
   * @param {number} opts.min - min value (default 0)
   * @param {number} opts.max - max value (default 360 for hue, 100 otherwise)
   * @param {number} opts.center - initial center value
   * @param {number} opts.range - initial range value
   * @param {Function} opts.onChange - (center, range) => void
   */
  constructor(container, opts) {
    this._container = container;
    this._label = opts.label || 'Range';
    this._min = opts.min != null ? opts.min : 0;
    this._max = opts.max != null ? opts.max : 100;
    this._center = opts.center != null ? opts.center : (this._max - this._min) / 2;
    this._range = opts.range != null ? opts.range : (this._max - this._min) / 4;
    this._onChange = opts.onChange || (() => {});
    this._gradient = opts.gradient || 'linear-gradient(to right, #333, #999)';

    this._dragging = null; // 'center' | 'low' | 'high' | null

    this._el = document.createElement('div');
    this._el.className = 'nle-lumetri-range-selector';

    // Label
    const labelEl = document.createElement('div');
    labelEl.className = 'nle-lumetri-range-label';
    labelEl.textContent = this._label;
    this._el.appendChild(labelEl);

    // Track
    this._track = document.createElement('div');
    this._track.className = 'nle-lumetri-range-track';
    this._track.style.background = this._gradient;

    // Selected region overlay
    this._region = document.createElement('div');
    this._region.className = 'nle-lumetri-range-region';
    this._track.appendChild(this._region);

    // Handles
    this._lowHandle = document.createElement('div');
    this._lowHandle.className = 'nle-lumetri-range-handle lumetri-range-handle-low';
    this._track.appendChild(this._lowHandle);

    this._centerHandle = document.createElement('div');
    this._centerHandle.className = 'nle-lumetri-range-handle lumetri-range-handle-center';
    this._track.appendChild(this._centerHandle);

    this._highHandle = document.createElement('div');
    this._highHandle.className = 'nle-lumetri-range-handle lumetri-range-handle-high';
    this._track.appendChild(this._highHandle);

    this._el.appendChild(this._track);

    // Value display
    this._valueEl = document.createElement('div');
    this._valueEl.className = 'nle-lumetri-range-value';
    this._el.appendChild(this._valueEl);

    // Mouse events
    this._lowHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); this._dragging = 'low'; });
    this._highHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); this._dragging = 'high'; });
    this._centerHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); this._dragging = 'center'; });
    this._track.addEventListener('mousedown', (e) => {
      // Click on track moves center
      this._dragging = 'center';
      this._updateFromMouse(e);
    });

    window.addEventListener('mousemove', this._boundMouseMove = (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', this._boundMouseUp = () => this._onMouseUp());

    container.appendChild(this._el);
    this._updateLayout();
  }

  setValues(center, range) {
    this._center = center;
    this._range = range;
    this._updateLayout();
  }

  destroy() {
    window.removeEventListener('mousemove', this._boundMouseMove);
    window.removeEventListener('mouseup', this._boundMouseUp);
    this._el.remove();
  }

  _valToPercent(val) {
    return ((val - this._min) / (this._max - this._min)) * 100;
  }

  _percentToVal(pct) {
    return this._min + (pct / 100) * (this._max - this._min);
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    this._updateFromMouse(e);
  }

  _updateFromMouse(e) {
    const rect = this._track.getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const val = this._percentToVal(pct);
    const totalRange = this._max - this._min;

    if (this._dragging === 'center') {
      this._center = clamp(val, this._min, this._max);
    } else if (this._dragging === 'low') {
      const low = clamp(val, this._min, this._center);
      this._range = this._center - low;
    } else if (this._dragging === 'high') {
      const high = clamp(val, this._center, this._max);
      this._range = high - this._center;
    }

    this._range = clamp(this._range, 1, totalRange / 2);
    this._updateLayout();
    this._onChange(this._center, this._range);
  }

  _onMouseUp() {
    if (this._dragging) {
      this._dragging = null;
      this._onChange(this._center, this._range);
    }
  }

  _updateLayout() {
    const centerPct = this._valToPercent(this._center);
    const rangePct = (this._range / (this._max - this._min)) * 100;
    const lowPct = Math.max(0, centerPct - rangePct);
    const highPct = Math.min(100, centerPct + rangePct);

    this._region.style.left = lowPct + '%';
    this._region.style.width = (highPct - lowPct) + '%';

    this._lowHandle.style.left = lowPct + '%';
    this._centerHandle.style.left = centerPct + '%';
    this._highHandle.style.left = highPct + '%';

    this._valueEl.textContent = `${Math.round(this._center)} \u00B1 ${Math.round(this._range)}`;
  }
}

export default RangeSelector;
