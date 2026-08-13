import { assert, describe, it } from "vite-plus/test";

import {
  AgentDesktopImageArgumentError,
  AgentDesktopImageDownloadError,
  PINNED_ARCH_IMAGE,
  agentDesktopCloudConfig,
  parseAgentDesktopImageArguments,
  pinnedImageDownloadPlan,
} from "./agent-desktop-image.mjs";

describe("Agent desktop image builder", () => {
  it("resolves explicit build inputs", () => {
    const options = parseAgentDesktopImageArguments(
      [
        "--source",
        "/tmp/source.qcow2",
        "--output",
        "/tmp/output.qcow2",
        "--sha256",
        "A".repeat(64),
        "--disk-size",
        "96G",
        "--force",
      ],
      {},
    );

    assert.deepEqual(options, {
      source: "/tmp/source.qcow2",
      output: "/tmp/output.qcow2",
      expectedSha256: "a".repeat(64),
      diskSize: "96G",
      downloadPinned: false,
      force: true,
      skipChecksum: false,
      cleanOnFailure: false,
    });
  });

  it("resolves the immutable official image", () => {
    const options = parseAgentDesktopImageArguments(
      ["--download-pinned", "--output", "/tmp/output.qcow2", "--clean-on-failure"],
      {},
    );

    assert.equal(options.source, undefined);
    assert.equal(options.downloadPinned, true);
    assert.equal(options.cleanOnFailure, true);
    assert.match(PINNED_ARCH_IMAGE.url, /\/images\/v20260801\.566320\//u);
    assert.equal(PINNED_ARCH_IMAGE.sha256.length, 64);
    assert.equal(PINNED_ARCH_IMAGE.sizeBytes, 556_424_192);
  });

  it("requires a source and a bounded QEMU disk size", () => {
    assert.throws(() => parseAgentDesktopImageArguments([], {}), AgentDesktopImageArgumentError);
    assert.throws(
      () =>
        parseAgentDesktopImageArguments(
          ["--source", "/tmp/source.qcow2", "--disk-size", "unbounded"],
          {},
        ),
      /QEMU size/u,
    );
  });

  it("provisions a private graphical guest without SSH", () => {
    const config = agentDesktopCloudConfig();
    assert.match(config, /package_upgrade: true/u);
    assert.match(config, /qemu-guest-agent/u);
    assert.match(config, /mesa-utils/u);
    assert.match(config, /packages:[\s\S]*\n  - gdm\n/u);
    assert.match(config, /path: \/etc\/gdm\/custom\.conf[\s\S]*defer: true/u);
    assert.match(config, /AutomaticLogin=t3agent/u);
    assert.match(config, /toolkit-accessibility=true/u);
    assert.match(config, /mask, sshd\.service, sshd\.socket/u);
    assert.notMatch(config, /ssh_authorized_keys/u);
    assert.match(config, /T3 Agent desktop image provisioned/u);
  });

  it("validates complete and resumable official image responses", () => {
    assert.deepEqual(pinnedImageDownloadPlan(200, { "content-length": "100" }, 0, 100), {
      append: false,
      initialBytes: 0,
    });
    assert.deepEqual(
      pinnedImageDownloadPlan(
        206,
        { "content-length": "60", "content-range": "bytes 40-99/100" },
        40,
        100,
      ),
      { append: true, initialBytes: 40 },
    );
    assert.throws(
      () => pinnedImageDownloadPlan(206, { "content-length": "60" }, 40, 100),
      AgentDesktopImageDownloadError,
    );
    assert.throws(
      () => pinnedImageDownloadPlan(200, { "content-length": "99" }, 0, 100),
      /size mismatch/u,
    );
    let retryableFailure;
    try {
      pinnedImageDownloadPlan(429, {}, 0, 100);
    } catch (error) {
      retryableFailure = error;
    }
    assert(retryableFailure instanceof AgentDesktopImageDownloadError);
    assert.equal(retryableFailure.retryable, true);
  });
});
