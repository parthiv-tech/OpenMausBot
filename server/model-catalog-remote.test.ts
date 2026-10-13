// The remote catalog is a fallback, so its failure modes matter more than its
// happy path: a bad payload, a refused request, or an unwritable data directory
// must all leave the previous catalog (or nothing) in place.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  MODELS_DEV_URL,
  primeRemoteCatalog,
  providerIdForDriverKind,
  refreshRemoteCatalog,
  remoteCatalogCachedAt,
  remoteCatalogFor,
  remoteCatalogIsStale,
  remoteCatalogPath,
  REMOTE_CATALOG_TTL_MS,
  resetRemoteCatalog,
} from "./model-catalog-remote.ts";

const model = (release_date: string, extra: Record<string, unknown> = {}) => ({
  tool_call: true,
  release_date,
  modalities: { output: ["text"] },
  ...extra,
});

const PAYLOAD = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-old": { id: "claude-old", name: "Claude Old", ...model("2024-01-01") },
      "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", ...model("2025-09-29") },
      // filtered: an embedding endpoint and a model that cannot call tools
      "claude-embed": { id: "claude-embed", name: "Embed", ...model("2026-05-01") },
      "claude-no-tools": { id: "claude-no-tools", name: "No tools", tool_call: false, release_date: "2026-06-01" },
      "claude-audio-preview": { id: "claude-audio-preview", name: "Audio", ...model("2026-06-02") },
    },
  },
  openai: { id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", ...model("2026-07-01") } } },
  // Alibaba's catalog carries other vendors' models the Qwen CLI does not route
  alibaba: {
    id: "alibaba",
    models: {
      "qwen3-coder": { id: "qwen3-coder", name: "Qwen3 Coder", ...model("2025-07-22") },
      "glm-5.2": { id: "glm-5.2", name: "GLM 5.2", ...model("2026-02-01") },
    },
  },
  // present in the catalog but no driver maps to it
  cursor: { id: "cursor", models: { "cursor-x": { id: "cursor-x", name: "Cursor X", ...model("2026-01-01") } } },
};

const okFetch = (payload: unknown): typeof fetch =>
  (async () => Response.json(payload)) as unknown as typeof fetch;

let scratch: string;

beforeEach(() => {
  resetRemoteCatalog();
  scratch = mkdtempSync(join(tmpdir(), "omb-remote-catalog-"));
});

afterEach(async () => {
  resetRemoteCatalog();
  await removeTempDir(scratch);
});

describe("provider mapping", () => {
  it("maps only first-party engines whose provider is one-to-one with the CLI", () => {
    expect(providerIdForDriverKind("claudeAgent")).toBe("anthropic");
    expect(providerIdForDriverKind("codex")).toBe("openai");
    expect(providerIdForDriverKind("geminiAgent")).toBe("google");
    expect(providerIdForDriverKind("grokAgent")).toBe("xai");
    expect(providerIdForDriverKind("kimiAgent")).toBe("moonshotai");
    expect(providerIdForDriverKind("minimax")).toBe("minimax");
    expect(providerIdForDriverKind("qwenAgent")).toBe("alibaba");
  });

  it("leaves engines with no matching provider unmapped rather than guessing", () => {
    // Cursor, Droid/Factory, Hermes, Pi, Box, Antigravity and the
    // user-configured OpenAI-compatible engine have no models.dev provider
    // that names them; a wrong list is worse than an empty one.
    for (const driverKind of ["cursorAgent", "droidAgent", "hermesAgent", "piAgent", "boxAgent", "antigravityAgent", "customAcp", "openai-compat", "vision"]) {
      expect(providerIdForDriverKind(driverKind)).toBeNull();
    }
  });

  it("points at the models.dev JSON export", () => {
    expect(MODELS_DEV_URL).toBe("https://models.dev/api.json");
  });
});

describe("refreshRemoteCatalog", () => {
  it("caches the payload and offers only chat-capable rows, newest first", async () => {
    expect(await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD), now: 1_000 })).toBe(true);

    const catalog = remoteCatalogFor("claudeAgent")!;
    expect(catalog.options.map((option) => option.id)).toEqual(["claude-sonnet-4-5", "claude-old"]);
    expect(catalog.options[0].label).toBe("Claude Sonnet 4.5");
    // the newest row is what a bot with no selection runs
    expect(catalog.default).toBe("claude-sonnet-4-5");
    expect(remoteCatalogCachedAt()).toBe(1_000);
  });

  it("serves the pretty-printed labels for the engines it maps", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD) });
    expect(remoteCatalogFor("codex")).toEqual({ default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }] });
  });

  it("narrows a shared provider to the models that CLI actually serves", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD) });
    // The Qwen CLI runs Qwen models; Alibaba also lists GLM/Kimi/DeepSeek.
    expect(remoteCatalogFor("qwenAgent")?.options.map((option) => option.id)).toEqual(["qwen3-coder"]);
  });

  it("has nothing to offer for a provider no driver maps to", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD) });
    expect(remoteCatalogFor("cursorAgent")).toBeNull();
    expect(remoteCatalogFor("hermesAgent")).toBeNull();
  });

  it("has nothing to offer before the first fetch", () => {
    expect(remoteCatalogFor("claudeAgent")).toBeNull();
    expect(remoteCatalogCachedAt()).toBeNull();
    expect(remoteCatalogIsStale()).toBe(true);
  });

  it("writes a cache that a later boot primes from without a network call", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD), now: 2_000 });
    expect(existsSync(remoteCatalogPath(scratch))).toBe(true);

    resetRemoteCatalog();
    expect(remoteCatalogFor("claudeAgent")).toBeNull();
    expect(primeRemoteCatalog(scratch)).toBe(true);
    expect(remoteCatalogFor("codex")?.default).toBe("gpt-5.6-sol");
    expect(remoteCatalogCachedAt()).toBe(2_000);
    // still fresh at the TTL boundary, stale just past it
    expect(remoteCatalogIsStale(2_000 + REMOTE_CATALOG_TTL_MS)).toBe(false);
    expect(remoteCatalogIsStale(2_000 + REMOTE_CATALOG_TTL_MS + 1)).toBe(true);
  });

  it("never accepts a payload the picker cannot use", async () => {
    expect(await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch({ not_a_provider: { models: {} } }) })).toBe(false);
    expect(await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch("not an object") })).toBe(false);
    expect(remoteCatalogFor("claudeAgent")).toBeNull();
    expect(existsSync(remoteCatalogPath(scratch))).toBe(false);
  });

  it("keeps the last usable catalog when the request fails", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD), now: 3_000 });

    const refused = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const exploding = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: refused })).toBe(false);
    expect(await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: exploding })).toBe(false);

    expect(remoteCatalogFor("claudeAgent")?.default).toBe("claude-sonnet-4-5");
    expect(remoteCatalogCachedAt()).toBe(3_000);
  });

  it("survives an unwritable data directory without dropping the in-memory catalog", async () => {
    // A file where the cache directory should be: mkdir fails, memory must not.
    const blocked = join(scratch, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(await refreshRemoteCatalog({ dataDir: blocked, fetchImpl: okFetch(PAYLOAD) })).toBe(true);
    expect(remoteCatalogFor("claudeAgent")?.default).toBe("claude-sonnet-4-5");
  });

  it("ignores a corrupt cache file", () => {
    const path = remoteCatalogPath(scratch);
    mkdirSync(join(scratch, "model-catalog"), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(primeRemoteCatalog(scratch)).toBe(false);
    expect(remoteCatalogFor("claudeAgent")).toBeNull();
  });

  it("trims the payload it writes to disk to what the picker renders", async () => {
    await refreshRemoteCatalog({ dataDir: scratch, fetchImpl: okFetch(PAYLOAD) });
    const written = JSON.parse(readFileSync(remoteCatalogPath(scratch), "utf8")) as { fetchedAt: number; providers: Record<string, unknown[]> };
    expect(written.providers.anthropic).toHaveLength(2);
    expect(JSON.stringify(written)).not.toContain("claude-no-tools");
  });
});
