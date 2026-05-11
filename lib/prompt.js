import { createInterface } from "readline";
import { readdirSync, statSync, readFileSync } from "fs";
import { resolve } from "path";

function createRl() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });
}

function ask(rl, question) {
  return new Promise((res) => {
    if (rl.closed) { res(""); return; }
    rl.question(question, (answer) => res(answer.trim()));
    rl.once("close", () => res(""));
  });
}

/**
 * Prompt for yes/no, returns boolean. Default is applied when user presses Enter.
 */
export async function askYesNo(rl, question, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(rl, `${question} ${hint}: `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/**
 * Prompt for a text value. Returns defaultVal if user presses Enter.
 */
export async function askText(rl, question, defaultVal = "") {
  const hint = defaultVal ? ` [${defaultVal}]` : "";
  const answer = await ask(rl, `${question}${hint}: `);
  return answer || defaultVal;
}

/**
 * Check config for credentials. If missing, prompt user to enter them.
 * Returns { username, password } — either from config or user input.
 */
export async function ensureCredentials(rl, config) {
  let username = config.auth?.username;
  let password = config.auth?.password;

  if (!username || username === "your-username") {
    username = await askText(rl, "Enter Oracle Cloud username");
  }
  if (!password || password === "your-password") {
    password = await askText(rl, "Enter Oracle Cloud password");
  }

  if (!username || !password) {
    console.error("Credentials are required. Exiting.");
    process.exit(1);
  }

  return { username, password };
}

/**
 * Find the newest file in a directory. Returns full path, or null if empty.
 */
export function newestFile(dir, { exclude = [] } = {}) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const excludeSet = new Set(exclude.map((f) => f.toLowerCase()));

  let newest = null;
  let newestTime = 0;

  for (const f of files) {
    if (excludeSet.has(f.toLowerCase())) continue;
    const fullPath = resolve(dir, f);
    const stat = statSync(fullPath);
    if (stat.isFile() && stat.mtimeMs > newestTime) {
      newest = fullPath;
      newestTime = stat.mtimeMs;
    }
  }

  return newest;
}

/**
 * Ask user to select an input file. Defaults to newest file in inputDir.
 */
export async function askInputFile(rl, inputDir, { exclude = [] } = {}) {
  const defaultFile = newestFile(inputDir, { exclude });
  const defaultName = defaultFile ? defaultFile.split("/").pop() : "";

  if (defaultName) {
    const answer = await askText(rl, `Input file`, defaultName);
    // If user typed just a filename (no path), resolve relative to inputDir
    if (!answer.includes("/") && !answer.includes("\\")) {
      return resolve(inputDir, answer);
    }
    return resolve(answer);
  } else {
    const answer = await askText(rl, `Input file (no files found in ${inputDir})`);
    if (!answer) {
      console.error("No input file specified. Exiting.");
      process.exit(1);
    }
    if (!answer.includes("/") && !answer.includes("\\")) {
      return resolve(inputDir, answer);
    }
    return resolve(answer);
  }
}

export { createRl };
