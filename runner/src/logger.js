// Structured logging with levels and agent context

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

function fmt(level, agent, msg, data) {
  const ts = new Date().toISOString();
  const prefix = agent ? `[${agent}]` : '[runner]';
  const base = `${ts} ${level.toUpperCase().padEnd(5)} ${prefix} ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export function log(level, agent, msg, data) {
  if ((LEVELS[level] ?? 2) > currentLevel) return;
  const line = fmt(level, agent, msg, data);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const info = (agent, msg, data) => log('info', agent, msg, data);
export const warn = (agent, msg, data) => log('warn', agent, msg, data);
export const error = (agent, msg, data) => log('error', agent, msg, data);
export const debug = (agent, msg, data) => log('debug', agent, msg, data);
