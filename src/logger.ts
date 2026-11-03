/**
 * Pi Matrix Integration — error log file 
 *
 * Recurring extension errors (poll/reconnect failures while the homeserver
 * is unreachable, failed sends) used to spam the Pi TUI console. They now
 * append to a file the extension owns (`config.logPath`, default
 * `.pi/matrix/logs/pi-matrix.log` — a relative path, so it lands under the
 * working directory unless the configured value is absolute or starts with
 * `~/`). One-level rotation keeps the file bounded:
 * past 1 MB the current file is moved to `<path>.old` and a fresh one is
 * started (one generation kept, no log-daemon complexity).
 *
 * Writes are synchronous and fire-and-forget: the error paths that call
 * these are already best-effort, and a log failure must never take the
 * extension down. When the file cannot be written, the console is used as
 * the fallback so nothing is silently lost.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MatrixLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** One-level rotation threshold (bytes). */
const MAX_BYTES = 1_000_000;

const LEVEL_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4, log: 2 };

function append(logPath: string, level: string, message: string, fallback: (line: string) => void, minLevel?: string): void {
  // Severity gate: drop anything LESS severe than the configured minimum
  // (error 0 … trace 4). An unrecognized minLevel falls back to info.
  if (minLevel && (LEVEL_ORDER[level] ?? 2) > (LEVEL_ORDER[minLevel] ?? 2)) return;
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.old`);
    }
    appendFileSync(logPath, line, 'utf-8');
  } catch {
    fallback(line.trim());
  }
}

/** Create a file-backed logger. `logPath` must already be home-expanded. */
export function createMatrixLogger(logPath: string, logLevel?: string): MatrixLogger {
  const target = logPath || '.pi/matrix/logs/pi-matrix.log';
  const level = logLevel?.toLowerCase();
  return {
    debug: (m) => append(target, 'debug', m, console.debug, level),
    warn: (m) => append(target, 'warn', m, console.warn, level),
    error: (m) => append(target, 'error', m, console.error, level),
  };
}

/** Console-backed logger (fallback when no logger is wired, e.g. tests). */
export function createConsoleLogger(): MatrixLogger {
  return {
    debug: (m) => console.debug(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

/**
 * js-sdk `Logger` (the drop-in interface `matrix-js-sdk` uses for its
 * default loglevel-based logger, which is bound to `console` → the Pi
 * session's stdout). The sdk transport passes one of these to
 * `new MatrixClient({ logger })`: the client, its sync loop
 * (`getChild("sync")`), and the Rust-crypto WASM (the same logger, via
 * `initRustCrypto` → `OlmMachine.initFromStore`) all write here instead.
 */
export interface JsSdkLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  getChild(namespace: string): JsSdkLogger;
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Stdout-capture layer 1: rebind the matrix-js-sdk's module-level
 * `logger` (lib/logger.js) to the file-backed `target`, in place.
 *
 * ~56 SDK files import that object directly — including
 * `models/room.js`, the "setting pendingEvent status" site that the
 * per-client `logger` option (lib/client.js) does not route. The
 * loglevel `methodFactory` the SDK installs re-reads `console` at
 * call time, so capturing the console at import time cannot catch it;
 * the import is a live ESM binding to the single shared object, so
 * overwriting its methods routes every importer to the logfile.
 * The legacy loglevel `log` method (room.js calls `logger.log`) maps
 * to `info`; `getChild` is re-served from `target`, cached per
 * namespace.
 */
export function rebindJsSdkModuleLogger(
  sdkModuleLogger: unknown,
  target: JsSdkLogger,
): void {
  const obj = sdkModuleLogger as Record<string, unknown>;
  for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
    const write = target[level];
    obj[level] = (...args: unknown[]): void => write(...args);
  }
  obj.log = (...args: unknown[]): void => target.info(...args);
  const childCache = new Map<string, JsSdkLogger>();
  obj.getChild = (ns: string) => {
    let child = childCache.get(ns);
    if (!child) {
      child = target.getChild(ns);
      childCache.set(ns, child);
    }
    return child;
  };
}

// Interceptor ownership (F4): the NEWEST install routes the console and
// may re-target the log path; only the NEWEST teardown restores it. A
// superseded stack's uninstaller is a no-op. The previous process-wide
// flag made the first install win while ANY uninstall restored — so a
// /matrix-switch teardown of the old stack could silently kill console
// capture the new stack still expected.
type ConsoleLevel = "log" | "info" | "debug" | "warn" | "error";
const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "info", "debug", "warn", "error"];
/** The pre-patch console methods, captured by the first install and
 *  restored by the newest teardown (null while nothing is installed). */
let interceptorOrig: Record<ConsoleLevel, (...args: unknown[]) => void> | null = null;
let interceptorRejection: ((reason: unknown) => void) | null = null;
/** The live route target; re-set on every install, read at write time. */
let interceptorTarget: string | null = null;
let interceptorOwner: symbol | null = null;

/**
 * Stdout-capture layer 2: route the process-global `console` methods
 * (plus unhandled promise rejections) to `logPath`, with the same
 * rotation as the rest of this module. Catches what layer 1 cannot:
 * the Rust crypto WASM's stack traces, third-party console leaks, and
 * anything else that writes to the terminal's stdout.
 *
 * The write fallback is the pre-patch console, so a broken log file can
 * never recurse. Re-install re-targets the same patch (no double-patch);
 * see the ownership note above. Note: registering the
 * `unhandledRejection` listener makes the process log-and-continue
 * instead of Node's default fatal exit.
 */
export function installConsoleInterceptor(logPath: string): () => void {
  const owner = Symbol("console-interceptor");
  if (interceptorOrig === null) {
    const orig: Record<ConsoleLevel, (...args: unknown[]) => void> = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    };
    interceptorOrig = orig;
    const route = (level: ConsoleLevel, args: unknown[]): void =>
      append(interceptorTarget ?? logPath, level, args.map(formatLogArg).join(" "), (line) =>
        orig[level](line),
      );
    const patched = console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>;
    for (const level of CONSOLE_LEVELS) {
      patched[level] = (...args) => route(level, args);
    }
    interceptorRejection = (reason: unknown): void =>
      route("error", ["unhandled promise rejection:", reason]);
    process.on("unhandledRejection", interceptorRejection);
  }
  interceptorTarget = logPath;
  interceptorOwner = owner;
  return () => {
    if (interceptorOwner !== owner) return; // superseded: the newest stack owns the console
    interceptorOwner = null;
    if (interceptorOrig === null) return;
    const patched = console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>;
    for (const level of CONSOLE_LEVELS) patched[level] = interceptorOrig[level];
    if (interceptorRejection) process.off("unhandledRejection", interceptorRejection);
    interceptorOrig = null;
    interceptorRejection = null;
  };
}

/** File-backed js-sdk logger: same rotation + console fallback as `createMatrixLogger`. */
export function createJsSdkFileLogger(logPath: string): JsSdkLogger {
  const make = (namespace: string): JsSdkLogger => {
    const write = (level: string, args: unknown[]): void => {
      const msg = args.map(formatLogArg).join(" ");
      append(logPath, level, namespace ? `[${namespace}] ${msg}` : msg, console.debug);
    };
    return {
      trace: (...args) => write("trace", args),
      debug: (...args) => write("debug", args),
      info: (...args) => write("info", args),
      warn: (...args) => write("warn", args),
      error: (...args) => write("error", args),
      getChild: (ns) => make(namespace ? `${namespace}:${ns}` : ns),
    };
  };
  return make("");
}
