// GitHub-backed model catalog — the fallback for an engine whose own probe
// came back empty.
//
// Every engine in this app is its own authority on the models it can run:
// `codex app-server`, the Claude CLI's account catalog, `opencode models`,
// ~/.kimi-code/config.toml, … This module never overrides that answer, and it
// is never the reason a model list changes. What it adds is the models that
// shipped AFTER this app release: when a working, signed-in engine could not
// answer its own probe — a timed-out spawn, a machine briefly offline, a CLI
// with no catalog subcommand — the picker is left showing the list bundled at
// build time, which is the only list on this machine that cannot be newer than
// the app. The registry merges these rows in, newest first, after the bundled
// ones; a probe that DID answer is never second-guessed.
//
// Source: https://models.dev/api.json, the JSON export of the models.dev
// catalog (github.com/sst/models.dev — the data OpenCode itself renders).
// Fetched in the background at boot, cached under the data directory, and read
// from memory on the request path, so opening the app never waits on GitHub.
// Nothing here is fatal: an unreachable host leaves the previous behavior
// exactly as it was, with each engine showing what its own probe reported.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** A day. The catalog is a fallback, not a live feed — re-fetching it more
 *  often than this buys nothing and costs a request per app open. */
export const REMOTE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 8_000;

/** driverKind → the models.dev provider whose models that CLI serves.
 *
 *  Only first-party engines where the provider is one-to-one with the CLI and
 *  the model families match, so an added row is a model that CLI really serves.
 *  `idPrefix` narrows a provider that also carries other vendors' models: the
 *  Qwen CLI runs Qwen models, while Alibaba's catalog also lists GLM, Kimi and
 *  DeepSeek endpoints it does not route.
 *
 *  Deliberately absent: Cursor, Droid/Factory, Hermes, Pi, Box, Antigravity and
 *  the user-configured OpenAI-compatible engine — no provider on models.dev
 *  names them (or, for Antigravity, the CLI serves two vendor families at
 *  once), and a wrong list is worse than an empty one. */
const PROVIDER_BY_DRIVER: Record<string, { provider: string; idPrefix?: string }> = {
  claudeAgent: { provider: "anthropic" },
  codex: { provider: "openai" },
  geminiAgent: { provider: "google" },
  grokAgent: { provider: "xai" },
  kimiAgent: { provider: "moonshotai" },
  minimax: { provider: "minimax" },
  qwenAgent: { provider: "alibaba", idPrefix: "qwen" },
};

/** Rows a coding-agent picker must not offer: they cannot run a tool loop. */
const NON_CHAT_ID = /(?:^|[-/. _])(?:embed|embedding|tts|whisper|audio|realtime|image|video|music|sora|dall-e|moderation|transcribe|computer-use|deep-research)(?:[-/. _]|$)/i;

interface RemoteModel {
  id: string;
  name?: string;
  /** ISO date; newest first in the picker, and the newest becomes the default. */
  release_date?: string;
}

/** Trimmed provider → models map. The full payload is ~5 MB; only what the
 *  picker renders is kept. */
export type RemoteCatalogPayload = Record<string, RemoteModel[]>;

let cache: RemoteCatalogPayload | null = null;
let cachedAt: number | null = null;

export function remoteCatalogPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, "model-catalog", "models.dev.json");
}

export function providerIdForDriverKind(driverKind: string): string | null {
  return PROVIDER_BY_DRIVER[driverKind]?.provider ?? null;
}

/** When the in-memory catalog was written, or null when nothing is loaded. */
export function remoteCatalogCachedAt(): number | null {
  return cachedAt;
}

function parseModels(raw: unknown): RemoteModel[] {
  const models: RemoteModel[] = [];
  if (!raw || typeof raw !== "object") return models;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as { id?: unknown; name?: unknown; tool_call?: unknown; release_date?: unknown; modalities?: { output?: unknown } };
    if (row.tool_call !== true) continue;
    const output = row.modalities?.output;
    // A coding engine needs a tool loop and text back. Rows that declare
    // otherwise are image/audio endpoints wearing a chat model's name.
    if (Array.isArray(output) && !output.includes("text")) continue;
    const modelId = typeof row.id === "string" && row.id ? row.id : id;
    if (!modelId || NON_CHAT_ID.test(modelId)) continue;
    models.push({
      id: modelId,
      ...(typeof row.name === "string" && row.name ? { name: row.name } : {}),
      ...(typeof row.release_date === "string" ? { release_date: row.release_date } : {}),
    });
  }
  // Newest first, id as the tie-break so the order is stable across fetches.
  return models.sort((a, b) =>
    String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")) || a.id.localeCompare(b.id));
}

/** Accept only the shape the picker can use; a mangled payload must leave the
 *  previous catalog (or nothing) in place rather than empty every engine. */
function parsePayload(raw: unknown): RemoteCatalogPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const source = (raw as { providers?: unknown }).providers ?? raw;
  if (!source || typeof source !== "object") return null;
  const payload: RemoteCatalogPayload = {};
  for (const [providerId, value] of Object.entries(source as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const models = parseModels((value as { models?: unknown }).models);
    if (models.length) payload[providerId] = models;
  }
  return Object.keys(payload).length ? payload : null;
}

/** The trimmed shape this module writes: provider id → the rows it kept. */
function parseStoredProviders(raw: unknown): RemoteCatalogPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload: RemoteCatalogPayload = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const models = value.flatMap((row): RemoteModel[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as { id?: unknown; name?: unknown; release_date?: unknown };
      if (typeof record.id !== "string" || !record.id) return [];
      return [{
        id: record.id,
        ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
        ...(typeof record.release_date === "string" ? { release_date: record.release_date } : {}),
      }];
    });
    if (models.length) payload[providerId] = models;
  }
  return Object.keys(payload).length ? payload : null;
}

/** Load the on-disk cache into memory (synchronous, no network). Called at
 *  boot so the first describe() already has the fallback available. */
export function primeRemoteCatalog(dataDir: string = DATA_DIR): boolean {
  try {
    const parsed = JSON.parse(readFileSync(remoteCatalogPath(dataDir), "utf8")) as { fetchedAt?: unknown; providers?: unknown };
    const payload = parseStoredProviders(parsed?.providers);
    if (!payload) return false;
    cache = payload;
    cachedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null;
    return true;
  } catch {
    return false;
  }
}

/** True when there is no usable cache, or the one on disk is older than the TTL. */
export function remoteCatalogIsStale(now: number = Date.now()): boolean {
  return cachedAt === null || now - cachedAt > REMOTE_CATALOG_TTL_MS;
}

/** Fetch and cache the catalog. Resolves false on any failure — no network,
 *  a non-OK response, a payload the picker cannot use — and the caller is
 *  expected to carry on with whatever is already loaded. */
export async function refreshRemoteCatalog(options: {
  dataDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: number;
} = {}): Promise<boolean> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = parsePayload(await response.json());
    if (!payload) return false;
    cache = payload;
    cachedAt = now;
    try {
      const path = remoteCatalogPath(dataDir);
      mkdirSync(dirname(path), { recursive: true });
      // Write through a temp file: a half-written catalog must never be what
      // the next boot primes itself with.
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ fetchedAt: now, providers: payload }));
      renameSync(temporary, path);
    } catch {
      // An unwritable data directory costs the fallback across restarts, not
      // this session.
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The picker rows for a driver, from memory only — describe() runs on the
 *  request path and must never touch the network. null when there is nothing
 *  to offer, which leaves the engine's own catalog alone. */
export function remoteCatalogFor(driverKind: string): ModelCatalog | null {
  if (!cache) return null;
  const mapping = PROVIDER_BY_DRIVER[driverKind];
  if (!mapping) return null;
  const models = (cache[mapping.provider] ?? []).filter(
    (model) => !mapping.idPrefix || model.id.startsWith(mapping.idPrefix),
  );
  if (!models.length) return null;
  return {
    default: models[0].id,
    options: models.map((model) => ({ id: model.id, label: model.name ?? model.id })),
  };
}

/** Drop the in-memory catalog. Used by tests and when the data directory moves. */
export function resetRemoteCatalog(): void {
  cache = null;
  cachedAt = null;
}
