import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import TOML from "@iarna/toml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  const configPath = process.env.CONFIG_PATH || resolve(PROJECT_ROOT, "config.toml");

  let raw;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`Config file not found: ${configPath}`);
      console.error("Copy config.example.toml to config.toml and fill in your values.");
      process.exit(1);
    }
    throw err;
  }

  const config = TOML.parse(raw);

  if (!config.api?.base_url) {
    console.error("Missing required config: [api] base_url");
    process.exit(1);
  }

  // Ensure sections exist (credentials may be filled in via prompt)
  config.auth = config.auth || {};
  config.options = config.options || {};

  _config = config;
  return config;
}
