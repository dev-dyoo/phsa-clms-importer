import { mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";

function ts() {
  return new Date().toISOString();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Create a timestamped subdirectory name for this run.
 */
function runDirName() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/**
 * Create a logger that writes to the given base log directory.
 *
 * Without prefix: creates log/<timestamp>/summary.log, errors.log, debug.log
 * With prefix:    creates log/<prefix>-<timestamp>-summary.log, -errors.log, -debug.log (flat)
 *
 * @param {string} baseLogDir - e.g. "FilterAllContracts/log"
 * @param {object} opts
 * @param {boolean} opts.debug - enable debug logging
 * @param {string}  opts.prefix - optional prefix for flat log files (e.g. "contracts")
 */
export function createLogger(baseLogDir, { debug: debugEnabled = false, prefix } = {}) {
  const stamp = runDirName();
  const logDir = prefix ? baseLogDir : resolve(baseLogDir, stamp);
  mkdirSync(logDir, { recursive: true });

  // With prefix: "contracts-20260303-143025-summary.log"
  // Without:     "summary.log" (inside timestamped subdirectory)
  const filePrefix = prefix ? `${prefix}-${stamp}-` : "";

  let processed = 0;
  let failed = 0;

  function writeLine(file, line) {
    appendFileSync(resolve(logDir, `${filePrefix}${file}`), line + "\n");
  }

  function info(msg) {
    const line = `[${ts()}] ${msg}`;
    console.log(line);
    writeLine("summary.log", line);
    processed++;
  }

  function error(msg, details) {
    const line = `[${ts()}] ERROR: ${msg}`;
    console.error(line);
    writeLine("summary.log", line);
    const detailStr = details ? JSON.stringify(details, null, 2) : "";
    writeLine("errors.log", line + (detailStr ? "\n" + detailStr : ""));
    failed++;
  }

  function debug(msg, data) {
    if (!debugEnabled) return;
    const line = `[${ts()}] DEBUG: ${msg}`;
    const dataStr = data !== undefined ? "\n" + JSON.stringify(data, null, 2) : "";
    writeLine("debug.log", line + dataStr);
  }

  function summary() {
    const total = processed + failed;
    const lines = [
      "",
      "=".repeat(50),
      `Run complete: ${total} total, ${total - failed} succeeded, ${failed} failed`,
      `Logs: ${resolve(logDir, `${filePrefix}summary.log`)}`,
      "=".repeat(50),
    ];
    for (const line of lines) {
      console.log(line);
      writeLine("summary.log", line);
    }
  }

  return { info, error, debug, summary, logDir };
}
