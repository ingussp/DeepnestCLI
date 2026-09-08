export interface DebugLoggerLike {
  enabled: boolean;
  filePath?: string | null;
  startSession: (extra?: Record<string, unknown>) => string | null | undefined;
  info: (event: string, payload?: unknown) => void;
  warn: (event: string, payload?: unknown) => void;
  error: (event: string, payload?: unknown) => void;
}

const noopLogger: DebugLoggerLike = {
  enabled: false,
  filePath: null,
  startSession: () => null,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

declare global {
  interface Window {
    __deepnestDebugLogger?: DebugLoggerLike;
  }
}

export function setUiDebugLogger(logger: DebugLoggerLike): void {
  window.__deepnestDebugLogger = logger;
}

export function getUiDebugLogger(): DebugLoggerLike {
  return window.__deepnestDebugLogger ?? noopLogger;
}

export function debugInfo(event: string, payload?: unknown): void {
  getUiDebugLogger().info(event, payload);
}

export function debugWarn(event: string, payload?: unknown): void {
  getUiDebugLogger().warn(event, payload);
}

export function debugError(event: string, payload?: unknown): void {
  getUiDebugLogger().error(event, payload);
}
