import { initEditor } from './lib/editor/index.js';
import { timelineEngine } from './lib/editor/timeline/TimelineEngine.js';

document.addEventListener('DOMContentLoaded', () => {
  initEditor();

  // Add track buttons
  document.querySelectorAll('.nle-add-track-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type === 'audio' ? 'audio' : 'video';
      timelineEngine.addTrack(type);
    });
  });
});
