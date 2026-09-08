import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\ud800");
    const lowSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\udc00");
    const replacement = PreviewIpc.resolvePartitionScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["environment","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["environment","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });

  effectIt.effect("targets imports at the same partition tuple as the renderer", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const request = (environmentId: string, targetProfileId: string) =>
      PreviewIpc.importBrowserCookies.handler({
        environmentId,
        sourceId: "helium",
        sourceProfileDirectory: "Default",
        targetProfileId,
      });

    return Effect.gen(function* () {
      yield* request("a", "b");
      yield* request("a::b", DEFAULT_BROWSER_PROFILE_ID);

      expect(received[0]).toMatchObject(PreviewIpc.resolvePartitionScope("a", "b"));
      expect(received[1]).toMatchObject(
        PreviewIpc.resolvePartitionScope("a::b", DEFAULT_BROWSER_PROFILE_ID),
      );
      expect(received[0]?.namespace).toBe("profile");
      expect(received[1]?.namespace).toBeUndefined();
    }).pipe(Effect.provideService(BrowserImport.BrowserImport, browserImport));
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("returns automation status for long runtime tab ids", () =>
    Effect.gen(function* () {
      const tabId =
        `["environment-1","thread:delegated-task:${"a".repeat(120)}",` +
        `"server-epoch-1","preview-1"]`;
      const status = {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };
      const manager = PreviewManager.PreviewManager.of({
        automationStatus: () => Effect.succeed(status),
      } as unknown as PreviewManager.PreviewManager["Service"]);

      expect(tabId.length).toBeGreaterThan(128);
      expect(
        yield* PreviewIpc.automationStatus
          .handler({ tabId })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
      ).toEqual(status);
    }),
  );

  effectIt.effect("returns target failures as cloneable IPC data without native context", () =>
    Effect.gen(function* () {
      const failures = [
        new PreviewManager.PreviewAutomationInvalidSelectorError({
          operation: "click",
          tabId: "private-native-tab",
          selectorKind: "locator",
          selectorLength: 11,
          reasonLength: 20,
          cause: { message: "private page content" },
        }),
        new PreviewManager.PreviewAutomationTargetNotEditableError({
          tabId: "private-native-tab",
          selectorKind: "locator",
          selectorLength: 11,
        }),
        new PreviewManager.PreviewAutomationTargetNotActionableError({
          tabId: "private-native-tab",
          selectorKind: "locator",
          selectorLength: 11,
        }),
        new PreviewManager.PreviewAutomationTimeoutError({
          tabId: "private-native-tab",
          timeoutMs: 1000,
        }),
        new PreviewManager.PreviewAutomationControlInterruptedError({
          operation: "press",
          tabId: "private-native-tab",
          webContentsId: 42,
        }),
        new PreviewManager.PreviewAutomationTargetNotFoundError({
          operation: "click",
          tabId: "private-native-tab",
          selectorKind: "selector",
          selectorLength: 10,
        }),
        new PreviewManager.PreviewAutomationCoordinatesOutsideViewportError({
          tabId: "private-native-tab",
          x: 1200,
          y: 100,
          viewportWidth: 1100,
          viewportHeight: 760,
        }),
      ];
      const commands = [
        { method: PreviewIpc.automationClick, input: { selector: "#private" } },
        { method: PreviewIpc.automationType, input: { selector: "#private", text: "private" } },
        { method: PreviewIpc.automationScroll, input: { selector: "#private", deltaY: 100 } },
        { method: PreviewIpc.automationWaitFor, input: { selector: "#private" } },
        { method: PreviewIpc.automationPress, input: { key: "Escape" } },
      ];

      for (const failure of failures) {
        const manager = PreviewManager.PreviewManager.of({
          automationClick: () => Effect.fail(failure),
          automationType: () => Effect.fail(failure),
          automationScroll: () => Effect.fail(failure),
          automationWaitFor: () => Effect.fail(failure),
          automationPress: () => Effect.fail(failure),
        } as unknown as PreviewManager.PreviewManager["Service"]);

        for (const command of commands) {
          const result = yield* command.method
            .handler({ tabId: "private-native-tab", input: command.input })
            .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
          expect(structuredClone(result)).toEqual({ ok: false, error: { _tag: failure._tag } });
        }
      }

      const manager = PreviewManager.PreviewManager.of({
        automationClick: () => Effect.void,
        automationType: () => Effect.void,
        automationScroll: () => Effect.void,
        automationWaitFor: () => Effect.void,
        automationPress: () => Effect.void,
      } as unknown as PreviewManager.PreviewManager["Service"]);
      for (const command of commands) {
        const result = yield* command.method
          .handler({ tabId: "tab-1", input: command.input })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        expect(result).toBeUndefined();
      }
    }),
  );

  effectIt.effect("preserves arbitrary evaluation values and bounded exception summaries", () =>
    Effect.gen(function* () {
      for (const value of [
        null,
        false,
        0,
        "",
        { ok: false, error: { _tag: "page-data" } },
        { type: "object", objectId: "remote-1" },
      ]) {
        const manager = PreviewManager.PreviewManager.of({
          automationEvaluate: () => Effect.succeed(value),
        } as unknown as PreviewManager.PreviewManager["Service"]);
        const result = yield* PreviewIpc.automationEvaluate
          .handler({ tabId: "tab-1", input: { expression: "value" } })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        expect(structuredClone(result)).toEqual({ ok: true, value });
      }
      for (const description of [
        "Error: deliberate failure\n    at private-stack",
        "x".repeat(3000),
      ]) {
        const manager = PreviewManager.PreviewManager.of({
          automationEvaluate: () =>
            Effect.fail(
              new PreviewManager.PreviewAutomationEvaluationError({
                tabId: "private-tab",
                detailKind: "exception-description",
                detailLength: description.length,
                cause: { exception: { description }, privateField: "private payload" },
              }),
            ),
        } as unknown as PreviewManager.PreviewManager["Service"]);
        const result = yield* PreviewIpc.automationEvaluate
          .handler({ tabId: "tab-1", input: { expression: "throw value" } })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        expect(structuredClone(result)).toEqual({
          ok: false,
          error: {
            _tag: "PreviewAutomationEvaluationError",
            evaluationMessage: description.startsWith("Error")
              ? "Error: deliberate failure"
              : "x".repeat(2000),
          },
        });
      }
    }),
  );

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
