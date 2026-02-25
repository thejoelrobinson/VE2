// Lightweight context menu for timeline clips, tracks, and media bin
let activeMenu = null;

function dismiss() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKey);
}

function onDocClick(e) {
  if (activeMenu && !activeMenu.contains(e.target)) {
    dismiss();
  }
}

function onDocKey(e) {
  if (e.key === 'Escape') dismiss();
}

export const contextMenu = {
  // Show a context menu at the given position
  // items: [{ label, action, disabled?, separator? }]
  show(x, y, items) {
    dismiss();

    const menu = document.createElement('div');
    menu.className = 'nle-context-menu';

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'nle-context-separator';
        menu.appendChild(sep);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'nle-context-item';
      if (item.disabled) row.classList.add('disabled');
      row.textContent = item.label;

      if (!item.disabled) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          dismiss();
          item.action();
        });
      }

      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    activeMenu = menu;

    // Position — keep within viewport
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, maxX)}px`;
    menu.style.top = `${Math.min(y, maxY)}px`;

    // Dismiss listeners
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onDocKey);
    });
  }
};

export default contextMenu;
