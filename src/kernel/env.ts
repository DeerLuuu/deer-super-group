import { execFileSync } from "node:child_process";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_API_KEY_ENVS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"];
const DEFAULT_BASE_URL_ENVS = ["DEEPSEEK_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"];

function readWindowsRegistry(name: string, key: string): string | undefined {
  try {
    const output = execFileSync("reg", ["query", key, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      // Missing registry values return a non-zero exit code and write to stderr;
      // keep that out of the app/test logs.
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(name)) continue;
      const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
      if (match) {
        const value = match[1].trim();
        if (value) return value;
      }
    }
  } catch {
    // Not found, or reg is unavailable.
  }
  return undefined;
}

/**
 * Read an environment variable at call time.
 *
 * On Windows we read the user/system registry first, because Electron inherits
 * a snapshot of the environment at launch and `process.env` will not see later
 * changes made in System Properties. `process.env` remains the fallback for
 * variables set only in the launching terminal (or loaded from `.env`).
 */
export function readEnv(name: string): string | undefined {
  const key = name.trim();
  if (!key || !ENV_NAME.test(key)) return undefined;

  if (process.platform === "win32") {
    const fromUser = readWindowsRegistry(key, "HKCU\\Environment");
    if (fromUser) return fromUser;
    const fromMachine = readWindowsRegistry(
      key,
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    );
    if (fromMachine) return fromMachine;
  }

  const value = process.env[key];
  return value?.trim() || undefined;
}

/**
 * Resolve the first available env var.
 * When `configuredName` is set, only that name is tried; otherwise a small
 * provider-aware fallback list is used.
 */
export function resolveEnv(
  configuredName: string,
  fallbackNames: string[],
): { name: string; value: string } | null {
  const name = configuredName.trim();
  const candidates = name ? [name] : fallbackNames;
  for (const candidate of candidates) {
    const value = readEnv(candidate);
    if (value) return { name: candidate, value };
  }
  return null;
}

export function resolveApiKeyEnv(settings: {
  apiKeyEnv: string;
}): { name: string; value: string } | null {
  return resolveEnv(settings.apiKeyEnv, DEFAULT_API_KEY_ENVS);
}

export function resolveBaseUrlEnv(settings: {
  baseUrlEnv: string;
}): { name: string; value: string } | null {
  return resolveEnv(settings.baseUrlEnv, DEFAULT_BASE_URL_ENVS);
}

export function defaultApiKeyEnvCandidates(): string[] {
  return [...DEFAULT_API_KEY_ENVS];
}

export function defaultBaseUrlEnvCandidates(): string[] {
  return [...DEFAULT_BASE_URL_ENVS];
}
