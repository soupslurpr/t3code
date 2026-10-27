import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (
  catalog: Record<string, unknown>,
  usageResult: Record<string, unknown> | Error = {},
  museHome = "/test/muse",
) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [], museHome },
    connection: {
      request: vi.fn(async (method) => {
        if (method === "model/list") return catalog;
        if (usageResult instanceof Error) throw usageResult;
        return usageResult;
      }),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};
const subscriptionUsage = {
  observedAtMs: Date.parse("2026-10-12T12:00:00Z"),
  tier: "pro",
  window: {
    resetsAtMs: Date.parse("2026-10-12T16:00:00Z"),
    usedPercent: 25,
    windowDurationMins: 300,
  },
  weekly: { resetsAtMs: Date.parse("2026-10-19T12:00:00Z"), usedPercent: 40 },
};
const fakeMuseHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const museHome = yield* fs.makeTempDirectoryScoped({ prefix: "muse-home-test-" });
  const hostname = yield* HostProcess.Hostname;
  const resolvedHome = yield* fs.realPath(museHome);
  const info = yield* fs.stat(museHome);
  const crypto = yield* Crypto.Crypto;
  const fingerprint = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(
      `muse\0${hostname}\0${info.dev}:${Option.getOrThrow(info.ino)}\0${resolvedHome}`,
    ),
  );
  return { museHome, homeFingerprint: Hex.encode(fingerprint) };
});

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const { museHome, homeFingerprint } = yield* fakeMuseHome;
        const host = makeHost(metaCatalog, {}, museHome);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-wonder-1.0",
          "muse-custom",
        ]);
        expect(snapshot.models.map((model) => model.name)).toEqual([
          "Muse Wonder 1.0",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.request).toHaveBeenCalledWith("usage/read", {});
        expect(snapshot.usageLimits).toEqual({
          checkedAt: snapshot.checkedAt,
          credentialFingerprint: homeFingerprint,
          windows: [],
          unavailable: {
            reason: "probeFailed",
            message: "Muse has not reported subscription usage yet. Run a Muse turn, then refresh.",
          },
        });
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("probeFailed");
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("reports observed windows and a login-home fingerprint even with no models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(subscriptionUsage.observedAtMs + 60_000);
        const binaryPath = yield* fakeCli();
        const { museHome, homeFingerprint } = yield* fakeMuseHome;
        for (const models of [metaCatalog.models, []]) {
          const host = makeHost(
            { ...metaCatalog, models },
            { usage: subscriptionUsage, extra: true },
            museHome,
          );
          const createHost = vi.fn(async () => host);
          const snapshot = yield* checkMuseProviderStatus(
            settings({ enabled: true, binaryPath }),
            {},
            undefined,
            createHost,
          );
          expect(snapshot.status).toBe(models.length ? "ready" : "warning");
          expect(snapshot.usageLimits).toEqual({
            checkedAt: "2026-10-12T12:00:00.000Z",
            credentialFingerprint: homeFingerprint,
            windows: [
              {
                id: "window",
                kind: "session",
                label: "Session",
                usedPercent: 25,
                windowDurationMins: 300,
                resetsAt: "2026-10-12T16:00:00.000Z",
              },
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 40,
                windowDurationMins: 10080,
                resetsAt: "2026-10-19T12:00:00.000Z",
              },
            ],
          });
          expect(createHost).toHaveBeenCalledOnce();
          expect(host.close).toHaveBeenCalledOnce();
        }
      }),
    ),
  );

  it.effect("scopes the login-home fingerprint to the hostname", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const { museHome } = yield* fakeMuseHome;
        const fingerprints = [];
        for (const hostname of ["host-one", "host-two"]) {
          const snapshot = yield* checkMuseProviderStatus(
            settings({ enabled: true, binaryPath }),
            {},
            undefined,
            async () => makeHost(metaCatalog, { usage: subscriptionUsage }, museHome),
          ).pipe(Effect.provideService(HostProcess.Hostname, hostname));
          const fingerprint = snapshot.usageLimits?.credentialFingerprint;
          expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
          fingerprints.push(fingerprint);
        }
        expect(fingerprints[0]).not.toBe(fingerprints[1]);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "shares the login-home fingerprint between a symlink and its real path",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* fakeCli();
          const { museHome, homeFingerprint } = yield* fakeMuseHome;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const aliasDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-alias-test-" });
          const alias = path.join(aliasDirectory, "muse");
          yield* fs.symlink(museHome, alias);
          for (const home of [yield* fs.realPath(museHome), alias]) {
            const snapshot = yield* checkMuseProviderStatus(
              settings({ enabled: true, binaryPath }),
              {},
              undefined,
              async () => makeHost(metaCatalog, { usage: subscriptionUsage }, home),
            );
            expect(snapshot.usageLimits?.credentialFingerprint).toBe(homeFingerprint);
          }
        }).pipe(Effect.provideService(HostProcess.Hostname, "shared-host")),
      ),
  );

  it.effect("omits the fingerprint when the hostname is empty, even for empty probes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const { museHome } = yield* fakeMuseHome;
        for (const usageResult of [{ usage: subscriptionUsage }, {}]) {
          const snapshot = yield* checkMuseProviderStatus(
            settings({ enabled: true, binaryPath }),
            {},
            undefined,
            async () => makeHost(metaCatalog, usageResult, museHome),
          ).pipe(Effect.provideService(HostProcess.Hostname, ""));
          expect(snapshot.status).toBe("ready");
          expect(snapshot.usageLimits).toBeDefined();
          expect(snapshot.usageLimits).not.toHaveProperty("credentialFingerprint");
          expect(snapshot.usageLimits?.windows).toHaveLength("usage" in usageResult ? 2 : 0);
        }
      }),
    ),
  );

  it.effect(
    "omits the fingerprint when the login home cannot be statted, even for empty probes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* fakeCli();
          const { museHome } = yield* fakeMuseHome;
          for (const usageResult of [{ usage: subscriptionUsage }, {}]) {
            const host = makeHost(metaCatalog, usageResult, `${museHome}/missing`);
            const snapshot = yield* checkMuseProviderStatus(
              settings({ enabled: true, binaryPath }),
              {},
              undefined,
              async () => host,
            );
            expect(snapshot.status).toBe("ready");
            expect(snapshot.usageLimits).toBeDefined();
            expect(snapshot.usageLimits).not.toHaveProperty("credentialFingerprint");
            expect(snapshot.usageLimits?.windows).toHaveLength("usage" in usageResult ? 2 : 0);
          }
        }),
      ),
  );

  it.effect("keeps catalog readiness when usage fails or has malformed data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        for (const result of [
          new Error("private error"),
          { usage: { ...subscriptionUsage, window: {} } },
        ]) {
          const host = makeHost(metaCatalog, result);
          const snapshot = yield* checkMuseProviderStatus(
            settings({ enabled: true, binaryPath }),
            {},
            undefined,
            async () => host,
          );
          expect(snapshot.status).toBe("ready");
          expect(snapshot.models.map((model) => model.slug)).toEqual(["muse-wonder-1.0"]);
          expect(snapshot.usageLimits?.unavailable).toEqual({
            reason: "probeFailed",
            message: "Muse could not report subscription usage.",
          });
          expect(host.close).toHaveBeenCalledOnce();
        }
      }),
    ),
  );

  it.effect(
    "uses probe time for invalid observation times and omits an unknown home fingerprint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(subscriptionUsage.observedAtMs);
          const binaryPath = yield* fakeCli();
          for (const observedAtMs of [0, -1, subscriptionUsage.observedAtMs + 5 * 60_000 + 1]) {
            const host = makeHost(
              metaCatalog,
              { usage: { ...subscriptionUsage, observedAtMs } },
              "",
            );
            const snapshot = yield* checkMuseProviderStatus(
              settings({ enabled: true, binaryPath }),
              {},
              undefined,
              async () => host,
            );
            expect(snapshot.usageLimits?.checkedAt).toBe(snapshot.checkedAt);
            expect(snapshot.usageLimits?.credentialFingerprint).toBeUndefined();
          }
        }),
      ),
  );
});
