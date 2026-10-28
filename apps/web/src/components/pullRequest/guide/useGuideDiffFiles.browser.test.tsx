import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type PullRequestDiffResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  pages: new Map<string | null, Atom.Writable<AsyncResult.AsyncResult<PullRequestDiffResult>>>(),
  requests: vi.fn(),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: ({ input }: { input: { cursor?: string } }) => {
      state.requests(input);
      return state.pages.get(input.cursor ?? null)!;
    },
  },
}));

import { useGuideDiffFiles } from "./useGuideDiffFiles";

function Probe({ wantedPaths, enabled = true }: { wantedPaths: string[]; enabled?: boolean }) {
  const diff = useGuideDiffFiles({
    environmentId: EnvironmentId.make("test"),
    reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
    headSha: "new-head",
    wantedPaths,
    enabled,
  });
  return (
    <output>
      {JSON.stringify({
        loading: diff.loading,
        files: [...diff.files].map(([path, file]) => [path, file.additionLines.join("")]),
      })}
    </output>
  );
}

function page(path: string, value: string, nextCursor: string | null): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`,
    truncated: false,
    nextCursor,
  };
}

it.each([
  { name: "contains the requested file", path: "wanted.ts", cursor: null },
  { name: "ends before a newly added file", path: "other.ts", cursor: null },
  { name: "has an obsolete next cursor", path: "other.ts", cursor: "old-next" },
])("waits for a cached page that $name to settle", async ({ path, cursor }) => {
  state.pages.clear();
  state.requests.mockClear();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page(path, "STALE", cursor), { waiting: true }),
  );
  state.pages.set(null, first);
  state.pages.set(
    "old-next",
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(AsyncResult.initial(true)),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} />
    </RegistryContext.Provider>,
  );
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ loading: true, files: [] });

  await act(() => registry.set(first, AsyncResult.success(page("wanted.ts", "FRESH", null))));
  expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH\n"]] });
});

it("hides stale cached guide code without requesting pages and restores the current-head cache", async () => {
  state.pages.clear();
  state.requests.mockClear();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  state.pages.set(
    null,
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
      AsyncResult.success(page("wanted.ts", "FRESH", null)),
    ),
  );
  const tree = (enabled: boolean) => (
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} enabled={enabled} />
    </RegistryContext.Provider>
  );
  await using screen = await render(tree(true));
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH\n"]] });
  const requestsBeforeDisable = state.requests.mock.calls.length;
  await screen.rerender(tree(false));
  expect(result()).toEqual({ loading: false, files: [] });
  expect(state.requests).toHaveBeenCalledTimes(requestsBeforeDisable);
  await screen.rerender(tree(true));
  expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH\n"]] });
  expect(state.requests).toHaveBeenCalledTimes(requestsBeforeDisable);
});

it("starts no guide query while disabled and loads it after enabling", async () => {
  state.pages.clear();
  state.requests.mockClear();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.initial(true),
  );
  state.pages.set(null, first);
  const tree = (enabled: boolean) => (
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} enabled={enabled} />
    </RegistryContext.Provider>
  );
  await using screen = await render(tree(false));
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ loading: false, files: [] });
  expect(state.requests).not.toHaveBeenCalled();
  await screen.rerender(tree(true));
  expect(result()).toEqual({ loading: true, files: [] });
  expect(state.requests).toHaveBeenCalled();
  await act(() => registry.set(first, AsyncResult.success(page("wanted.ts", "FRESH", null))));
  expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH\n"]] });
});
