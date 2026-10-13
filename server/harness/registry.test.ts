// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { resetPathCacheForTests } from "../env-path.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("resolves maintenance commands to the configured CLI or driver default", async () => {
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      defaulted: { driver: "fake" },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
    });

    expect(registry.cliTarget("defaulted")).toEqual({ driverKind: "fake", cli: "fakebin" });
    expect(registry.cliTarget("overridden")).toEqual({ driverKind: "fake", cli: "/opt/fake/custom-bin" });
    expect(registry.cliTarget("missing")).toBeNull();
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
    expect(registry.cliTarget("mystery")).toEqual({ driverKind: "from-the-future", cli: null });
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  it("refreshes a live model catalog only on an explicit provider action", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const refreshes = { a: 0, b: 0 };
    for (const instanceId of ["a", "b"] as const) {
      const instance = registry.get(instanceId)!;
      const models: ModelCatalog = { default: "", options: [] };
      Object.assign(instance, {
        models,
        refreshModels: async () => {
          refreshes[instanceId] += 1;
          const id = `${instanceId}-${refreshes[instanceId]}`;
          models.default = id;
          models.options = [{ id, label: `Dynamic ${id}` }];
        },
      });
    }

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const first = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(first.a.default).toBe("a-1");
    expect(first.b.default).toBe("b-1");

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const second = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(second.a.default).toBe("a-2");
    expect(second.b.default).toBe("b-2");
    expect(refreshes).toEqual({ a: 2, b: 2 });
  });

  it("refreshes every live catalog in one pass", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const seen: string[] = [];
    for (const instanceId of ["a", "b"] as const) {
      Object.assign(registry.get(instanceId)!, { refreshModels: async () => { seen.push(instanceId); } });
    }

    expect(await registry.refreshAllModels()).toBe(2);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("probes the fleet once for an app-open refresh, not once per engine", async () => {
    // Opening the app used to POST refresh-models per instance, and every one of
    // those answered with a full describe() — so an N-engine fleet paid N x N
    // engine probes. Both paths are measured here so the difference is a
    // number, not a claim.
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    const ids = ["a", "b", "c"] as const;
    await registry.load(Object.fromEntries(ids.map((id) => [id, { driver: "fake" }])));
    let probes = 0;
    for (const id of ids) {
      const instance = registry.get(id)!;
      const snapshot = instance.snapshot.bind(instance);
      Object.assign(instance, { refreshModels: async () => {}, snapshot: async () => { probes += 1; return snapshot(); } });
    }

    await registry.refreshAllModels();
    await registry.describe();
    const batched = probes;

    probes = 0;
    for (const id of ids) {
      await registry.refreshModels(id);
      await registry.describe();
    }

    expect(batched).toBe(3);
    expect(probes).toBe(9);
  });

  const REMOTE: ModelCatalog = { default: "claude-opus-5", options: [{ id: "claude-opus-5", label: "Claude Opus 5" }] };

  it("adds the catalog's newer models to an engine that could not answer its probe", async () => {
    // A timed-out spawn, a CLI with no catalog subcommand, a machine briefly
    // offline: the picker is left with the list bundled at build time, which is
    // the one list on this machine that cannot be newer than the app.
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const registry = new ProviderRegistry([fake.driver], { remoteCatalog: () => REMOTE });
    await registry.load({ a: { driver: "claudeAgent" } });

    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("available");
    // bundled rows first, and the bundled default is untouched
    expect(described.models).toEqual({
      default: "claudeAgent-1",
      options: [
        { id: "claudeAgent-1", label: "claudeAgent one" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
  });

  it("fills the default when the bundled catalog has nothing at all", async () => {
    const fake = makeFakeDriver({ kind: "qwenAgent" });
    Object.assign(fake.driver, { models: { default: "", options: [] } });
    const registry = new ProviderRegistry([fake.driver], { remoteCatalog: () => REMOTE });
    await registry.load({ a: { driver: "qwenAgent" } });

    const [described] = await registry.describe();
    expect(described.models).toEqual(REMOTE);
  });

  it("never second-guesses a probe that answered", async () => {
    // A driver publishes its probe result by replacing `models`, so a list that
    // is no longer the driver's declared catalog IS the engine's own answer.
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const registry = new ProviderRegistry([fake.driver], { remoteCatalog: () => REMOTE });
    await registry.load({ a: { driver: "claudeAgent" } });
    Object.assign(registry.get("a")!, {
      models: { default: "claude-opus-5", options: [{ id: "claude-opus-5", label: "Claude Opus 5" }] },
    });

    const [described] = await registry.describe();
    expect(described.models.options.map((option) => option.id)).toEqual(["claude-opus-5"]);
  });

  it("adds nothing for an unavailable or signed-out engine", async () => {
    // Offering a pick an engine cannot run is worse than offering none, so the
    // catalog stops at exactly the case where the engine itself is healthy.
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const registry = new ProviderRegistry([fake.driver], { remoteCatalog: () => REMOTE });
    await registry.load({ broken: { driver: "claudeAgent" }, signedout: { driver: "claudeAgent" } });
    Object.assign(registry.get("broken")!, {
      snapshot: async () => ({ state: "unavailable" as const, reason: "probe exploded" }),
    });
    Object.assign(registry.get("signedout")!, {
      snapshot: async () => ({ state: "available" as const, authenticated: false }),
    });

    const described = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(described.broken.options.map((option) => option.id)).toEqual(["claudeAgent-1"]);
    expect(described.signedout.options.map((option) => option.id)).toEqual(["claudeAgent-1"]);
  });

  it("leaves an unmapped engine's catalog alone", async () => {
    const fake = makeFakeDriver({ kind: "cursorAgent" });
    let asked = 0;
    const registry = new ProviderRegistry([fake.driver], { remoteCatalog: () => { asked += 1; return null; } });
    await registry.load({ a: { driver: "cursorAgent" } });

    const [described] = await registry.describe();
    expect(described.models.options.map((option) => option.id)).toEqual(["cursorAgent-1"]);
    expect(asked).toBe(1);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("installing an npm engine from Settings", () => {
  // A stand-in npm on PATH: records its arguments and drops the expected
  // executable into the prefix it was given. No registry, no network.
  const FAKE_NPM = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const prefix = args[args.indexOf('--prefix') + 1];
mkdirSync(join(prefix, 'bin'), { recursive: true });
writeFileSync(join(prefix, 'bin', 'fakebin'), '#!/bin/sh\\necho fixture\\n', { mode: 0o755 });
process.exit(0);
`;
  let scratch: string;
  let originalPath: string | undefined;
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    resetPathCacheForTests();
    await removeTempDir(scratch);
  });
  function addFakeNpm(binDir: string) {
    const npm = join(binDir, "npm");
    writeFileSync(npm, FAKE_NPM, { mode: 0o755 });
    chmodSync(npm, 0o755);
    resetPathCacheForTests();
  }
  function withFakeNpm(present: boolean): string {
    scratch = mkdtempSync(join(tmpdir(), "omb-registry-install-"));
    originalPath = process.env.PATH;
    const binDir = join(scratch, "fake-path");
    mkdirSync(binDir);
    if (present) addFakeNpm(binDir);
    process.env.PATH = binDir;
    process.env.FAKE_NPM_LOG = join(scratch, "npm-calls.jsonl");
    resetPathCacheForTests();
    return binDir;
  }

  it("advertises and runs the install only when the driver names an npm package and npm is on PATH", async () => {
    withFakeNpm(true);
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine", darwin: "npm install -g fake-engine" }, needsNode: true } });
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data") });
    await registry.load({ a: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.install?.server).toEqual({ package: "fake-engine" });
    expect(await registry.installRuntime("a")).toBe(true);
    const calls = readFileSync(process.env.FAKE_NPM_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["install", "-g", "--prefix", join(scratch, "data", "tools", "npm"), "--loglevel=error", "--allow-scripts=fake-engine", "fake-engine@latest"]);
    expect(existsSync(join(scratch, "data", "tools", "npm", "bin", "fakebin"))).toBe(true);
    expect(await registry.installRuntime("missing")).toBe(false);
  });

  it("offers nothing without npm, for a curl installer, or for a managed engine", async () => {
    withFakeNpm(true);
    const fake = makeFakeDriver();
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine" } } });
    // The PATH scan also looks in standard install locations, so "no npm" is
    // injected rather than simulated through PATH.
    const without = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data"), npmAvailable: () => false });
    await without.load({ a: { driver: "fake" } });
    expect((await without.describe())[0].install?.server).toBeUndefined();
    expect(await without.installRuntime("a")).toBe(false);
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data") });
    await registry.load({ a: { driver: "fake" } });
    Object.assign(fake.driver, { install: { command: { linux: "curl -fsSL https://example.test/install.sh | bash" } } });
    expect((await registry.describe())[0].install?.server).toBeUndefined();
    expect(await registry.installRuntime("a")).toBe(false);
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine" }, managed: { label: "Install", downloadBytes: 1 } } });
    expect((await registry.describe())[0].install?.server).toBeUndefined();
    expect(existsSync(join(scratch, "data"))).toBe(false);
  });
});
