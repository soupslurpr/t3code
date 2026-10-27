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
import { expect, it, vi } from "vite-plus/test";

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
} from "./useSettings";

function setup() {
  state.settings.clear();
  state.support.clear();
  state.configs.clear();
  state.connections.clear();
  state.persist.mockReset().mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
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
