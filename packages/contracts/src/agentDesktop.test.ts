import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentDesktop,
  AgentDesktopAcquireInput,
  AgentDesktopCommandInput,
  AgentDesktopCopyInput,
  AgentDesktopHostTransferInput,
  AgentDesktopManageInput,
  AgentDesktopNetworkTelemetry,
  AgentDesktopReadFileInput,
  AgentDesktopList,
  AgentDesktopRequirementRemedy,
  AgentDesktopWriteFileInput,
} from "./agentDesktop.ts";

const decodeAcquire = Schema.decodeUnknownSync(AgentDesktopAcquireInput);
const decodeDesktop = Schema.decodeUnknownSync(AgentDesktop);
const decodeManage = Schema.decodeUnknownSync(AgentDesktopManageInput);
const decodeNetwork = Schema.decodeUnknownSync(AgentDesktopNetworkTelemetry);
const decodeCommand = Schema.decodeUnknownSync(AgentDesktopCommandInput);
const decodeCopy = Schema.decodeUnknownSync(AgentDesktopCopyInput);
const decodeHostTransfer = Schema.decodeUnknownSync(AgentDesktopHostTransferInput);
const decodeReadFile = Schema.decodeUnknownSync(AgentDesktopReadFileInput);
const decodeWriteFile = Schema.decodeUnknownSync(AgentDesktopWriteFileInput);
const decodeList = Schema.decodeUnknownSync(AgentDesktopList);
const decodeRemedy = Schema.decodeUnknownSync(AgentDesktopRequirementRemedy);

describe("agent desktop contracts", () => {
  it("accepts automatic, fresh, and explicit acquisition", () => {
    expect(decodeAcquire({})).toEqual({});
    expect(
      decodeAcquire({
        fresh: true,
        requirements: { graphics: "preferred", retention: "preserve" },
      }),
    ).toEqual({
      fresh: true,
      requirements: { graphics: "preferred", retention: "preserve" },
    });
    expect(decodeAcquire({ desktopId: "desktop-1" })).toEqual({ desktopId: "desktop-1" });
    expect(() => decodeAcquire({ desktopId: "desktop-1", fresh: true })).toThrow();
  });

  it("accepts every reversible lifecycle transition", () => {
    for (const operation of ["resume", "park", "stop", "reset", "delete", "restore"] as const) {
      expect(decodeManage({ operation, desktopId: "desktop-1" })).toEqual({
        operation,
        desktopId: "desktop-1",
      });
    }
    expect(
      decodeManage({ operation: "clone", desktopId: "desktop-1", label: "Browser test" }),
    ).toEqual({ operation: "clone", desktopId: "desktop-1", label: "Browser test" });
    expect(decodeManage({ operation: "delete-permanently", desktopId: "desktop-1" })).toEqual({
      operation: "delete-permanently",
      desktopId: "desktop-1",
    });
    expect(
      decodeManage({
        operation: "handoff",
        desktopId: "desktop-1",
        owner: {
          environmentId: "local",
          threadId: "thread-2",
          controllerId: "controller-2",
        },
      }).operation,
    ).toBe("handoff");
  });

  it("bounds exact guest command and file operations", () => {
    expect(
      decodeCommand({
        executable: "/usr/bin/env",
        arguments: ["true"],
        environment: [{ name: "LANG", value: "C.UTF-8" }],
      }),
    ).toEqual({
      executable: "/usr/bin/env",
      arguments: ["true"],
      environment: [{ name: "LANG", value: "C.UTF-8" }],
    });
    expect(decodeReadFile({ path: "/tmp/result", encoding: "base64" }).encoding).toBe("base64");
    expect(decodeWriteFile({ path: "/tmp/result", data: "hello", mode: "overwrite" }).mode).toBe(
      "overwrite",
    );
  });

  it("requires copies to cross the workspace boundary", () => {
    expect(
      decodeCopy({
        source: { kind: "workspace", path: "artifacts/report" },
        destination: { kind: "agent", desktopId: "desktop-1", path: "/tmp/report" },
        collision: "replace",
        compression: "auto",
      }),
    ).toEqual({
      source: { kind: "workspace", path: "artifacts/report" },
      destination: { kind: "agent", desktopId: "desktop-1", path: "/tmp/report" },
      collision: "replace",
      compression: "auto",
    });
    expect(() =>
      decodeCopy({
        source: { kind: "workspace", path: "first" },
        destination: { kind: "workspace", path: "second" },
      }),
    ).toThrow();
  });

  it("keeps transfer capability URLs inside host-only inputs", () => {
    expect(
      decodeHostTransfer({
        operation: "import",
        transferId: "transfer-1",
        url: "http://127.0.0.1:3773/api/agent-desktop-transfers/private",
        guestPath: "/tmp/report",
        collision: "create",
        compression: "gzip",
        sizeBytes: 42,
        sha256: "a".repeat(64),
      }).operation,
    ).toBe("import");
  });

  it("bounds resource and network telemetry", () => {
    const network = decodeNetwork({
      available: true,
      connected: true,
      privateAddresses: ["10.0.2.15"],
      receivedBytes: 1_000,
      transmittedBytes: 2_000,
      receivedPackets: 10,
      transmittedPackets: 20,
      receivedDrops: 0,
      transmittedDrops: 0,
      receiveBytesPerSecond: 100,
      transmitBytesPerSecond: 200,
      activeFlowCount: 1,
      connections: [
        {
          protocol: "tcp",
          localAddress: "10.0.2.15",
          localPort: 40_000,
          remoteAddress: "203.0.113.1",
          remotePort: 443,
          state: "established",
          processId: 42,
          processName: "chromium",
        },
      ],
      connectionsTruncated: false,
      routes: [],
      sampledAt: "2026-08-12T20:00:00.000Z",
    });
    expect(network.activeFlowCount).toBe(1);

    expect(
      decodeDesktop({
        id: "desktop-1",
        label: "Agent desktop",
        owner: {
          environmentId: "local",
          threadId: "thread-1",
          controllerId: "controller-1",
        },
        state: "active",
        capabilities: ["computer", "network-telemetry"],
        graphics: {
          backend: "virgl",
          hardwareAccelerated: true,
          renderer: "virgl",
          checkpointMode: "disk-consistent",
        },
        controllerId: "controller-1",
        viewerCount: 1,
        createdAt: "2026-08-12T19:00:00.000Z",
        lastActiveAt: "2026-08-12T20:00:00.000Z",
        recoverableUntil: null,
        retention: "preserve",
        resources: {
          cpuUsagePercent: 12.5,
          memoryUsedBytes: 1_000,
          memoryLimitBytes: 2_000,
          diskAllocatedBytes: 3_000,
          diskVirtualBytes: 4_000,
          network,
        },
      }).id,
    ).toBe("desktop-1");
  });

  it("reports structured host prerequisites and bounded remedies", () => {
    const list = decodeList({
      available: false,
      desktops: [],
      requirements: [
        {
          id: "display",
          label: "Virtual display",
          status: "degraded",
          required: true,
          remedy: {
            kind: "install-packages",
            automatic: true,
            packages: ["qemu-hw-display-virtio-vga"],
            detail: "Install the official display module.",
          },
        },
      ],
    });
    expect(list.requirements[0]?.remedy?.packages).toEqual(["qemu-hw-display-virtio-vga"]);
    expect(() =>
      decodeRemedy({
        kind: "install-packages",
        automatic: true,
        detail: "Missing package list.",
      }),
    ).toThrow();
    expect(() =>
      decodeRemedy({
        kind: "manual",
        automatic: false,
        packages: ["unexpected"],
        detail: "Manual repair.",
      }),
    ).toThrow();
  });
});
