import pino from 'pino';

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: { svc: 'orchestrator' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
