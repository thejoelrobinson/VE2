// Premiere Pro-style scrubby slider / hot text control.
// Attach to a value display element to enable:
//   - Drag left/right to scrub value (with pointer lock for infinite drag)
//   - Click (no drag) to enter inline text edit
//   - Shift = 10x coarse, Ctrl/Cmd = 10x fine
//   - Arrow keys to increment/decrement when editing

const DRAG_THRESHOLD = 3;

/**
 * Attach scrubby slider behavior to a DOM element.
 * Works with both <span> value displays and <input type="number"> elements.
 *
 * @param {HTMLElement} el
 * @param {Object} opts
 * @param {number} opts.value - initial value
 * @param {number} [opts.min=-Infinity]
 * @param {number} [opts.max=Infinity]
 * @param {number} [opts.step=1]
 * @param {string} [opts.unit='']
 * @param {number} [opts.precision] - decimal places (auto from step)
 * @param {number} [opts.sensitivity] - value per pixel (auto from range)
 * @param {(val: number) => string} [opts.formatValue]
 * @param {(val: number) => void} opts.onChange - called during drag / arrow keys
 * @param {(val: number) => void} [opts.onCommit] - called on drag end / edit confirm (defaults to onChange)
 * @returns {{ setValue(v: number): void, getValue(): number, destroy(): void }}
 */
export function attachScrubby(el, opts) {
  const isInput = el.tagName === 'INPUT';
  let value = opts.value ?? 0;
  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  const step = opts.step ?? 1;
  const unit = opts.unit ?? '';
  const precision = opts.precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const onChange = opts.onChange || (() => {});
  const onCommit = opts.onCommit || onChange;

  // Sensitivity: auto-calculate from range, cap to avoid insane speed
  const rawRange = (isFinite(min) && isFinite(max) && max > min) ? (max - min) : 1000;
  const effectiveRange = Math.min(rawRange, 1000);
  const baseSens = opts.sensitivity ?? Math.max(effectiveRange / 300, 0.005);

  const formatDisplay = opts.formatValue || ((v) => {
    const s = precision === 0 ? String(Math.round(v)) : String(parseFloat(v.toFixed(precision)));
    return unit ? s + unit : s;
  });

  let dragging = false;
  let editing = false;
  let startX = 0;
  let startY = 0;
  let startValue = 0;
  let accumulated = 0;
  let lastX = 0;
  let overlayInput = null;
  let blurHandler = null;

  el.classList.add('nle-scrubby');

  function clampVal(v) {
    return Math.min(Math.max(v, min), max);
  }

  function snapVal(v, mod) {
    const s = mod === 'fine' ? step / 10 : step;
    return s > 0 ? Math.round(v / s) * s : v;
  }

  function updateDisplay() {
    if (isInput) {
      el.value = precision === 0 ? Math.round(value) : parseFloat(value.toFixed(precision));
    } else {
      el.textContent = formatDisplay(value);
    }
  }

  // ── Mouse handlers ──

  function onMouseDown(e) {
    if (e.button !== 0 || editing) return;
    if (isInput && document.activeElement === el) return;

    e.preventDefault();

    // For inputs, sync from DOM in case it was changed by typing
    if (isInput) {
      const parsed = parseFloat(el.value);
      if (!isNaN(parsed)) value = parsed;
    }

    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    startValue = value;
    accumulated = 0;
    dragging = false;

    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD ||
          Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
        dragging = true;
        el.classList.add('nle-scrubby-dragging');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        try { el.requestPointerLock(); } catch (_) { /* fallback to delta tracking */ }
      }
      return;
    }

    let dx;
    if (document.pointerLockElement === el) {
      dx = e.movementX;
    } else {
      dx = e.clientX - lastX;
      lastX = e.clientX;
    }

    let mult = 1;
    let mod = 'normal';
    if (e.shiftKey) { mult = 10; mod = 'coarse'; }
    else if (e.ctrlKey || e.metaKey) { mult = 0.1; mod = 'fine'; }

    accumulated += dx * baseSens * mult;
    const raw = startValue + accumulated;
    const snapped = snapVal(raw, mod);
    const clamped = clampVal(snapped);

    if (clamped !== value) {
      value = clamped;
      updateDisplay();
      onChange(value);
    }
  }

  function onDragEnd() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);

    if (document.pointerLockElement === el) {
      try { document.exitPointerLock(); } catch (_) {}
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    el.classList.remove('nle-scrubby-dragging');

    if (!dragging) {
      startEdit();
    } else {
      dragging = false;
      onCommit(value);
    }
  }

  // ── Inline edit ──

  function startEdit() {
    if (isInput) {
      el.focus();
      el.select();
      return;
    }

    editing = true;
    const editVal = precision === 0 ? Math.round(value) : parseFloat(value.toFixed(precision));

    overlayInput = document.createElement('input');
    overlayInput.type = 'text';
    overlayInput.className = 'nle-scrubby-input';
    overlayInput.value = editVal;

    const rect = el.getBoundingClientRect();
    overlayInput.style.width = Math.max(rect.width + 8, 44) + 'px';

    el.style.display = 'none';
    el.parentNode.insertBefore(overlayInput, el.nextSibling);
    overlayInput.focus();
    overlayInput.select();

    overlayInput.addEventListener('keydown', onEditKey);
    blurHandler = () => commitEdit();
    overlayInput.addEventListener('blur', blurHandler);
  }

  function onEditKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endEdit(); // cancel — don't commit
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      let inc = step;
      if (e.shiftKey) inc *= 10;
      if (e.ctrlKey || e.metaKey) inc /= 10;
      if (e.key === 'ArrowDown') inc = -inc;
      const parsed = parseFloat(overlayInput.value) || 0;
      const newVal = clampVal(parsed + inc);
      overlayInput.value = precision === 0 ? Math.round(newVal) : parseFloat(newVal.toFixed(precision));
      value = newVal;
      onChange(value);
    }
  }

  function commitEdit() {
    if (!editing || !overlayInput) return;
    const parsed = parseFloat(overlayInput.value);
    if (!isNaN(parsed)) {
      value = clampVal(parsed);
      onCommit(value);
    }
    endEdit();
  }

  function endEdit() {
    if (!editing) return;
    editing = false;
    if (overlayInput) {
      overlayInput.removeEventListener('keydown', onEditKey);
      if (blurHandler) overlayInput.removeEventListener('blur', blurHandler);
      overlayInput.remove();
      overlayInput = null;
      blurHandler = null;
    }
    el.style.display = '';
    updateDisplay();
  }

  // ── Arrow keys for input elements ──

  let inputKeyHandler = null;
  if (isInput) {
    inputKeyHandler = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      let inc = step;
      if (e.shiftKey) inc *= 10;
      if (e.ctrlKey || e.metaKey) inc /= 10;
      if (e.key === 'ArrowDown') inc = -inc;
      const parsed = parseFloat(el.value) || 0;
      const newVal = clampVal(parsed + inc);
      value = newVal;
      el.value = precision === 0 ? Math.round(newVal) : parseFloat(newVal.toFixed(precision));
      onChange(value);
    };
    el.addEventListener('keydown', inputKeyHandler);
  }

  el.addEventListener('mousedown', onMouseDown);

  return {
    setValue(v) {
      value = clampVal(v);
      if (!editing && !dragging) updateDisplay();
    },
    getValue() { return value; },
    destroy() {
      el.removeEventListener('mousedown', onMouseDown);
      if (inputKeyHandler) el.removeEventListener('keydown', inputKeyHandler);
      el.classList.remove('nle-scrubby', 'nle-scrubby-dragging');
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
      if (document.pointerLockElement === el) {
        try { document.exitPointerLock(); } catch (_) {}
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (editing) endEdit();
    }
  };
}
