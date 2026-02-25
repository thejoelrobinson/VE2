const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLogLevel = LOG_LEVELS.INFO;

const log = (level, levelName, consoleFn, message, args) => {
  if (level < currentLogLevel) return;
  const prefix = `[NLE] [${levelName}]`;
  if (args !== undefined) {
    consoleFn(`${prefix} ${message}`, args);
  } else {
    consoleFn(`${prefix} ${message}`);
  }
};

export const logger = {
  setLevel(level) { if (level in LOG_LEVELS) currentLogLevel = LOG_LEVELS[level]; },
  debug(message, args) { log(LOG_LEVELS.DEBUG, 'DEBUG', console.debug, message, args); },
  info(message, args) { log(LOG_LEVELS.INFO, 'INFO', console.info, message, args); },
  warn(message, args) { log(LOG_LEVELS.WARN, 'WARN', console.warn, message, args); },
  error(message, args) { log(LOG_LEVELS.ERROR, 'ERROR', console.error, message, args); }
};

export default logger;
