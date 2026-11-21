import { triageCommandForEnvironment } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickTriageEnvironment } from "./triageTarget";

describe("pickTriageEnvironment", () => {
  it("skips a primary machine whose server lacks triage", () => {
    expect(
      pickTriageEnvironment({
        onScreen: null,
        primary: "old-primary",
        connected: ["old-primary", "new-remote"],
        supportsTriage: (environmentId) => environmentId === "new-remote",
      }),
    ).toBe("new-remote");
  });

  it("prefers a capable primary over other capable machines", () => {
    expect(
      pickTriageEnvironment({
        onScreen: null,
        primary: "primary",
        connected: ["remote", "primary"],
        supportsTriage: () => true,
      }),
    ).toBe("primary");
  });
});

it("uses the selected machine's installation for terminal triage", () => {
  const upstream: ExecutionEnvironmentDescriptor = {
    environmentId: EnvironmentId.make("remote"),
    label: "Workstation",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: true },
  };
  const fork = { ...upstream, forkBuild: { channel: "test", revision: null } };
  const command = "'/opt/test fork/t3' triage --base-dir '/srv/test home'";
  expect(triageCommandForEnvironment({ environment: fork, installedTriageCommand: command })).toBe(
    command,
  );
  expect(triageCommandForEnvironment({ environment: fork })).toBeNull();
  expect(triageCommandForEnvironment(undefined)).toBeNull();
  expect(triageCommandForEnvironment({ environment: upstream })).toBe("npx t3 triage");
});
