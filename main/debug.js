const fs = require("graceful-fs");
const os = require("os");
const path = require("path");

let packageVersion = "unknown";
try {
  packageVersion = require("../package.json").version || "unknown";
} catch {
  packageVersion = "unknown";
}

const DEBUG_TOKENS = new Set(["deug", "debug"]);
const DEFAULT_MAX_PAYLOAD_LENGTH = 12000;
const HEADER_SEPARATOR = "=".repeat(80);

function isDebugToken(value) {
  return typeof value === "string" && DEBUG_TOKENS.has(value.trim().toLowerCase());
}

function isDebugEnabled(argv = process.argv, env = process.env) {
  if (env && env.DEEPNEST_DEBUG_ACTIVE === "1") {
    return true;
  }

  return Array.isArray(argv) && argv.some((value) => isDebugToken(value));
}

function resolveDebugFilePath(options = {}) {
  const env = options.env || process.env;
  const overridePath =
    typeof env.DEEPNEST_DEBUG_PATH === "string" ? env.DEEPNEST_DEBUG_PATH.trim() : "";

  if (overridePath) {
    return path.resolve(overridePath);
  }

  const isPackaged =
    typeof options.isPackaged === "boolean"
      ? options.isPackaged
      : Boolean(options.app && options.app.isPackaged);

  const baseDir = isPackaged
    ? path.dirname(options.execPath || process.execPath)
    : options.cwd || process.cwd();

  return path.join(baseDir, "debug.txt");
}

function getAppVersion(app) {
  if (app && typeof app.getVersion === "function") {
    try {
      return app.getVersion();
    } catch {
      return packageVersion;
    }
  }

  return packageVersion;
}

function truncateString(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function safeJsonStringify(value, maxLength = DEFAULT_MAX_PAYLOAD_LENGTH) {
  const seen = new WeakSet();

  const json = JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return `${currentValue.toString()}n`;
      }

      if (typeof currentValue === "function") {
        return `[Function ${currentValue.name || "anonymous"}]`;
      }

      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
        };
      }

      if (Buffer.isBuffer(currentValue)) {
        return {
          type: "Buffer",
          length: currentValue.length,
        };
      }

      if (currentValue && typeof currentValue === "object") {
        if (seen.has(currentValue)) {
          return "[Circular]";
        }

        seen.add(currentValue);

        if (typeof currentValue.length === "number" && currentValue.constructor) {
          const ctorName = currentValue.constructor.name;
          if (
            ctorName.endsWith("Array") &&
            ctorName !== "Array" &&
            typeof currentValue.BYTES_PER_ELEMENT === "number"
          ) {
            return {
              type: ctorName,
              length: currentValue.length,
            };
          }
        }

        if (typeof currentValue.nodeType === "number" && typeof currentValue.nodeName === "string") {
          return `[Node ${currentValue.nodeName}]`;
        }
      }

      if (typeof currentValue === "string" && currentValue.length > maxLength) {
        return truncateString(currentValue, maxLength);
      }

      return currentValue;
    },
    2
  );

  return truncateString(json, maxLength);
}

function formatLine({ timestamp, level, scope, event, payload, maxPayloadLength }) {
  const prefix = `${timestamp} [${level.toUpperCase()}]${scope ? ` [${scope}]` : ""} ${event}`;

  if (payload === undefined) {
    return prefix;
  }

  return `${prefix} ${safeJsonStringify(payload, maxPayloadLength)}`;
}

function ensureDirectoryForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const processGlobal = globalThis;
if (!processGlobal.__DEEPNEST_DEBUG_PROCESS_SESSION_ID) {
  processGlobal.__DEEPNEST_DEBUG_PROCESS_SESSION_ID = `${Date.now()}-${process.pid}`;
}
if (!processGlobal.__DEEPNEST_DEBUG_HEADER_KEYS) {
  processGlobal.__DEEPNEST_DEBUG_HEADER_KEYS = new Set();
}

function createDebugLogger(options = {}) {
  const enabled =
    typeof options.enabled === "boolean"
      ? options.enabled
      : isDebugEnabled(options.argv, options.env || process.env);
  const scope = options.scope || "app";
  const maxPayloadLength = options.maxPayloadLength || DEFAULT_MAX_PAYLOAD_LENGTH;
  const filePath = options.filePath || resolveDebugFilePath(options);
  const sessionId = options.sessionId || processGlobal.__DEEPNEST_DEBUG_PROCESS_SESSION_ID;
  const headerRegistry = processGlobal.__DEEPNEST_DEBUG_HEADER_KEYS;

  function appendLine(line) {
    if (!enabled) {
      return;
    }

    ensureDirectoryForFile(filePath);
    fs.appendFileSync(filePath, `${line}${os.EOL}`, "utf8");
  }

  function writeHeader(extra) {
    if (!enabled) {
      return;
    }

    const headerKey = `${filePath}::${sessionId}`;
    if (headerRegistry.has(headerKey)) {
      return;
    }

    headerRegistry.add(headerKey);

    appendLine(HEADER_SEPARATOR);
    appendLine(
      formatLine({
        timestamp: new Date().toISOString(),
        level: "info",
        scope,
        event: "session-start",
        payload: {
          sessionId,
          argv: options.argv || process.argv,
          platform: process.platform,
          pid: process.pid,
          packaged:
            typeof options.isPackaged === "boolean"
              ? options.isPackaged
              : Boolean(options.app && options.app.isPackaged),
          appVersion: options.appVersion || getAppVersion(options.app),
          debugFilePath: filePath,
          ...extra,
        },
        maxPayloadLength,
      })
    );
  }

  function log(level, event, payload) {
    if (!enabled) {
      return;
    }

    writeHeader();
    appendLine(
      formatLine({
        timestamp: new Date().toISOString(),
        level,
        scope,
        event,
        payload,
        maxPayloadLength,
      })
    );
  }

  return {
    enabled,
    filePath,
    sessionId,
    scope,
    startSession(extra) {
      writeHeader(extra);
      return enabled ? filePath : null;
    },
    info(event, payload) {
      log("info", event, payload);
    },
    warn(event, payload) {
      log("warn", event, payload);
    },
    error(event, payload) {
      log("error", event, payload);
    },
  };
}

module.exports = {
  createDebugLogger,
  getAppVersion,
  isDebugEnabled,
  isDebugToken,
  resolveDebugFilePath,
  safeJsonStringify,
};
