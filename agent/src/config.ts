// Non-secret runtime settings. Values already in the environment win; for the keys
// below that are unset, the repo-root .env.local is read. No other key is ever read
// from that file, so credentials and the contract secret never enter the agent process.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO_ROOT_URL = new URL("../../", import.meta.url);
export const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);

const ALLOWED_KEYS = [
  "GATEWAY_URL",
  "OLLAMA_URL",
  "CLEARSHELF_MODEL",
  "CLEARSHELF_THINK",
  "CLEARSHELF_MIN_AVAILABLE_RAM_MIB",
] as const;
type Key = (typeof ALLOWED_KEYS)[number];

export interface Config {
  gatewayUrl: string;
  ollamaUrl: string;
  model: string;
  repoRoot: string;
}

function parseEnvFile(text: string): Partial<Record<Key, string>> {
  const out: Partial<Record<Key, string>> = {};
  for (const line of text.split(/\r?\n/u)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
    if (!m) continue;
    const key = m[1] as Key;
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let loaded: Config | null = null;

export function loadConfig(): Config {
  if (loaded) return loaded;
  const envPath = fileURLToPath(new URL(".env.local", REPO_ROOT_URL));
  const fromFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
  for (const key of ALLOWED_KEYS) {
    const v = fromFile[key];
    if (process.env[key] === undefined && v !== undefined && v !== "") process.env[key] = v;
  }
  loaded = {
    gatewayUrl: process.env.GATEWAY_URL ?? "http://127.0.0.1:8791",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    model: process.env.CLEARSHELF_MODEL ?? "nemotron-3-nano:4b",
    repoRoot: REPO_ROOT,
  };
  return loaded;
}
