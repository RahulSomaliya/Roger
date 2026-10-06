/** Minimal structured logger. Pretty lines in development, JSON lines when packaged. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  format: 'pretty' | 'json';
  /** Where lines go. Defaults to stderr. Injected in tests. */
  sink?: (line: string) => void;
  clock?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const clock = options.clock ?? (() => new Date());
  const threshold = LEVEL_RANK[options.level];

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const entry = { ...bindings, ...fields, level, message, time: clock().toISOString() };
    sink(options.format === 'json' ? JSON.stringify(entry, replaceErrors) : prettyLine(entry));
  };

  return {
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, fields) => {
      emit('error', message, fields);
    },
    child: (childBindings) => createLogger(options, { ...bindings, ...childBindings }),
  };
}

function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function prettyLine(entry: LogFields & { level: LogLevel; message: string; time: string }): string {
  const { level, message, time, ...rest } = entry;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${message}${fields ? ` ${fields}` : ''}`;
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  return JSON.stringify(value, replaceErrors);
}

/** Turn anything thrown into a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}
