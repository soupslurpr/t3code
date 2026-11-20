import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  catalog: null as unknown as Atom.Writable<{
    readonly isReady: boolean;
    readonly entries: ReadonlyMap<string, unknown>;
  }>,
  settings: new Map<EnvironmentId, Atom.Writable<ServerSettings | null>>(),
  support: new Map<EnvironmentId, Atom.Writable<boolean>>(),
  configs: new Map<EnvironmentId, Atom.Atom<unknown>>(),
  connections: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<SupervisorConnectionState>>
  >(),
  persist: vi.fn(),
  persistLocal: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: state.persistLocal,
    },
  }),
}));

vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  state.catalog = Atom.keepAlive(
    Atom.make<{ readonly isReady: boolean; readonly entries: ReadonlyMap<string, unknown> }>({
      isReady: true,
      entries: new Map<string, unknown>(),
    }),
  );
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: state.catalog as never,
      stateAtom: ((id: EnvironmentId) => state.connections.get(id)) as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) => state.settings.get(id)) as never,
      configValueAtom: ((id: EnvironmentId) => state.configs.get(id)) as never,
      updateSettings: {
        ...actual.serverEnvironment.updateSettings,
        run: (_registry: unknown, input: unknown) => state.persist(input),
      } as never,
    },
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  startModelPreferencesMigration,
  getClientSettings,
  persistLocalModelPreferences,
  mergeEnvironmentSettings,
} from "./useSettings";

function setup() {
  state.settings.clear();
  state.support.clear();
  state.configs.clear();
  state.connections.clear();
  state.persist.mockReset().mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
  state.persistLocal.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  appAtomRegistry.set(state.catalog, { isReady: true, entries: new Map() });
}

it("skips unsupported migration across settings echoes and reconnects, then migrates after capability adoption", () => {
  setup();
  const id = EnvironmentId.make("old-model-preferences");
  const provider = ProviderInstanceId.make("codex_saved");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider, model: "saved" }],
  });
  const settings = Atom.keepAlive(Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS));
  const support = Atom.keepAlive(Atom.make(false));
  const connection = Atom.keepAlive(
    Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
      AsyncResult.success({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected" as const,
        generation: 1,
      }),
    ),
  );
  state.settings.set(id, settings);
  state.support.set(id, support);
  state.connections.set(id, connection);
  state.configs.set(
    id,
    Atom.make((get) => ({
      settings: get(settings),
      environment: { capabilities: { modelPreferences: get(support) } },
    })),
  );
  appAtomRegistry.set(state.catalog, { isReady: true, entries: new Map([[id, {}]]) });
  using _migration = { [Symbol.dispose]: startModelPreferencesMigration() };
  appAtomRegistry.set(settings, { ...DEFAULT_SERVER_SETTINGS });
  appAtomRegistry.set(
    connection,
    AsyncResult.success({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected" as const,
      generation: 2,
    }),
  );
  expect(state.persist).not.toHaveBeenCalled();
  appAtomRegistry.set(support, true);
  expect(state.persist).toHaveBeenCalledExactlyOnceWith({
    environmentId: id,
    input: { patch: { migrateModelPreferences: { favorites: [{ provider, model: "saved" }] } } },
  });
  appAtomRegistry.set(settings, { ...DEFAULT_SERVER_SETTINGS });
  expect(state.persist).toHaveBeenCalledOnce();
});

describe("model preference migration after an upgraded reconnect", () => {
  it.each(["add-favorite", "remove-favorite", "show-model", "reorder-models"] as const)(
    "preserves a queued %s edit during an upgraded reconnect",
    async (operation) => {
      setup();
      state.persistLocal.mockReset();
      const id = EnvironmentId.make(`pending-reconnect-${operation}`);
      const provider = ProviderInstanceId.make("reconnect-provider");
      const saved = { provider, model: "saved" };
      const added = { provider, model: "last-edit" };
      const legacy = {
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [saved],
        providerModelPreferences: {
          [provider]: { hiddenModels: ["saved"], modelOrder: ["saved", "other"] },
        },
      };
      __setClientSettingsForTests(legacy);
      const settings = Atom.keepAlive(Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS));
      const support = Atom.keepAlive(Atom.make(false));
      const connection = Atom.keepAlive(
        Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
          AsyncResult.success({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            phase: "connected" as const,
            generation: 1,
          }),
        ),
      );
      state.settings.set(id, settings);
      state.configs.set(
        id,
        Atom.make((get) => ({
          settings: get(settings),
          environment: { capabilities: { modelPreferences: get(support) } },
        })),
      );
      state.connections.set(id, connection);
      appAtomRegistry.set(state.catalog, { isReady: true, entries: new Map([[id, {}]]) });
      using _migration = { [Symbol.dispose]: startModelPreferencesMigration() };
      let beginWrite!: () => void;
      let finishWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        beginWrite = resolve;
      });
      const completion = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      state.persistLocal.mockImplementationOnce(async () => {
        beginWrite();
        await completion;
      });
      const patch =
        operation === "add-favorite"
          ? { setModelFavorites: [{ ...added, favorite: true }] }
          : operation === "remove-favorite"
            ? { setModelFavorites: [{ ...saved, favorite: false }] }
            : operation === "show-model"
              ? { setModelsHidden: [{ ...saved, hidden: false }] }
              : { setProviderModelOrder: { provider, modelOrder: ["other", "saved"] } };
      const pending = persistLocalModelPreferences(patch);
      await started;
      expect(state.persist).not.toHaveBeenCalled();
      appAtomRegistry.set(
        connection,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected" as const,
          generation: 2,
        }),
      );
      appAtomRegistry.set(support, true);
      finishWrite();
      await pending;
      const local = getClientSettings();
      const expected = applyServerSettingsPatch(
        {
          ...DEFAULT_SERVER_SETTINGS,
          favorites: legacy.favorites,
          providerModelPreferences: legacy.providerModelPreferences,
        },
        patch,
      );
      expect(local.favorites).toEqual(expected.favorites);
      expect(local.providerModelPreferences).toEqual(expected.providerModelPreferences);
      expect(state.persist).toHaveBeenCalledOnce();
      const migration = state.persist.mock.calls[0]![0].input.patch;
      appAtomRegistry.set(settings, applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, migration));
      expect(state.persist).toHaveBeenCalledOnce();
      const server = appAtomRegistry.get(settings)!;
      const merged = mergeEnvironmentSettings(server, local);
      expect({
        favorites: merged.favorites,
        providerModelPreferences: merged.providerModelPreferences,
      }).toEqual({
        favorites: local.favorites,
        providerModelPreferences: local.providerModelPreferences,
      });
    },
  );
});

it.each([true, false])(
  "waits for every queued local edit before migrating (last write succeeds: %s)",
  async (succeeds) => {
    setup();
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const id = EnvironmentId.make(`queued-reconnect-${succeeds}`);
    const provider = ProviderInstanceId.make("queued-reconnect");
    const settings = Atom.keepAlive(Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS));
    const support = Atom.keepAlive(Atom.make(false));
    state.settings.set(id, settings);
    state.configs.set(
      id,
      Atom.make((get) => ({
        settings: get(settings),
        environment: { capabilities: { modelPreferences: get(support) } },
      })),
    );
    state.connections.set(
      id,
      Atom.keepAlive(
        Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
          AsyncResult.success({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            phase: "connected" as const,
            generation: 1,
          }),
        ),
      ),
    );
    appAtomRegistry.set(state.catalog, { isReady: true, entries: new Map([[id, {}]]) });
    using _migration = { [Symbol.dispose]: startModelPreferencesMigration() };
    const firstStarted = signal();
    const firstFinish = signal();
    const secondStarted = signal();
    const secondFinish = signal();
    const failure = new Error("storage unavailable");
    state.persistLocal
      .mockImplementationOnce(async () => {
        firstStarted.resolve();
        await firstFinish.promise;
      })
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        await secondFinish.promise;
        if (!succeeds) throw failure;
      });
    const first = persistLocalModelPreferences({
      setModelFavorites: [{ provider, model: "first", favorite: true }],
    });
    const second = persistLocalModelPreferences({
      setModelsHidden: [{ provider, model: "second", hidden: true }],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await firstStarted.promise;
      appAtomRegistry.set(support, true);
      expect(state.persist).not.toHaveBeenCalled();
      firstFinish.resolve();
      await secondStarted.promise;
      await first;
      expect(state.persist).not.toHaveBeenCalled();
    } finally {
      firstFinish.resolve();
      secondFinish.resolve();
      await first;
      expect(await second).toBe(succeeds ? null : failure);
    }
    expect(state.persist).toHaveBeenCalledOnce();
    const patch = state.persist.mock.calls[0]![0].input.patch;
    const accepted = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(accepted.favorites).toEqual([{ provider, model: "first" }]);
    expect(accepted.providerModelPreferences).toEqual(
      succeeds ? { [provider]: { hiddenModels: ["second"], modelOrder: [] } } : null,
    );
    appAtomRegistry.set(settings, accepted);
    expect(state.persist).toHaveBeenCalledOnce();
  },
);

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
