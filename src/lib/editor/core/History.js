// Command-pattern undo/redo with grouping support
import { eventBus } from './EventBus.js';
import { EDITOR_EVENTS } from './Constants.js';
import { editorState } from './EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';

class History {
  constructor() {
    this._undoStack = [];
    this._redoStack = [];
    this._grouping = false;
    this._groupCommands = [];
    this._maxSize = 200;
  }

  push(command) {
    // command: { execute(), undo(), description }
    if (this._grouping) {
      this._groupCommands.push(command);
      return;
    }
    command.execute();
    this._undoStack.push(command);
    this._redoStack = [];
    if (this._undoStack.length > this._maxSize) {
      this._undoStack.shift();
    }
    editorState.markDirty();
    eventBus.emit(EDITOR_EVENTS.HISTORY_PUSH, { description: command.description });
  }

  // Push a command without executing it (for snapshot-based undo where mutations are already applied)
  pushWithoutExecute(command) {
    if (this._grouping) {
      this._groupCommands.push(command);
      return;
    }
    this._undoStack.push(command);
    this._redoStack = [];
    if (this._undoStack.length > this._maxSize) {
      this._undoStack.shift();
    }
    editorState.markDirty();
    eventBus.emit(EDITOR_EVENTS.HISTORY_PUSH, { description: command.description });
  }

  beginGroup(description) {
    this._grouping = true;
    this._groupCommands = [];
    this._groupDescription = description;
    timelineEngine.beginBatch();
  }

  endGroup() {
    if (!this._grouping) return;
    this._grouping = false;
    const commands = [...this._groupCommands];
    this._groupCommands = [];
    if (commands.length === 0) {
      timelineEngine.commitBatch();
      return;
    }

    // Execute all commands (within the already-open batch)
    try {
      for (const cmd of commands) {
        cmd.execute();
      }
    } finally {
      timelineEngine.commitBatch();
    }

    // Push grouped command (redo/undo wrap in batch)
    const grouped = {
      description: this._groupDescription || 'Grouped operation',
      execute() {
        timelineEngine.beginBatch();
        try {
          for (const cmd of commands) cmd.execute();
        } finally {
          timelineEngine.commitBatch();
        }
      },
      undo() {
        timelineEngine.beginBatch();
        try {
          for (let i = commands.length - 1; i >= 0; i--) {
            commands[i].undo();
          }
        } finally {
          timelineEngine.commitBatch();
        }
      }
    };
    this._undoStack.push(grouped);
    this._redoStack = [];
    editorState.markDirty();
    eventBus.emit(EDITOR_EVENTS.HISTORY_PUSH, { description: grouped.description });
  }

  undo() {
    if (this._undoStack.length === 0) return false;
    const command = this._undoStack.pop();
    timelineEngine.beginBatch();
    try {
      command.undo();
    } finally {
      timelineEngine.commitBatch();
    }
    this._redoStack.push(command);
    editorState.markDirty();
    eventBus.emit(EDITOR_EVENTS.HISTORY_UNDO, { description: command.description });
    return true;
  }

  redo() {
    if (this._redoStack.length === 0) return false;
    const command = this._redoStack.pop();
    timelineEngine.beginBatch();
    try {
      command.execute();
    } finally {
      timelineEngine.commitBatch();
    }
    this._undoStack.push(command);
    editorState.markDirty();
    eventBus.emit(EDITOR_EVENTS.HISTORY_REDO, { description: command.description });
    return true;
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  clear() {
    this._undoStack = [];
    this._redoStack = [];
  }
}

export const history = new History();
export default history;
