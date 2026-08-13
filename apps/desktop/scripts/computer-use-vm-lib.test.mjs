import { assert, describe, it } from "vite-plus/test";

import {
  decodedBase64Bytes,
  gpt56OriginalImageTokens,
  resolveComputerUseVmConfig,
  selectComputerUseVmTarget,
} from "./computer-use-vm-lib.mjs";

describe("computer-use VM scripts", () => {
  it.each(["t3code://app/", "t3code://app/#/draft/test-thread"])(
    "finds the app renderer at %s among unrelated targets",
    (url) => {
      const renderer = { type: "page", url };
      assert.strictEqual(
        selectComputerUseVmTarget([
          { type: "service_worker", url: "t3code://app/" },
          { type: "page", url: "https://example.com/" },
          renderer,
        ]),
        renderer,
      );
    },
  );

  it("rejects non-app renderer targets", () => {
    assert.isUndefined(
      selectComputerUseVmTarget([
        { type: "page", url: "t3code://app.example/" },
        { type: "page", url: "t3code://app/other" },
        { type: "service_worker", url: "t3code://app/" },
      ]),
    );
  });

  it("resolves overridable loopback defaults", () => {
    const defaults = resolveComputerUseVmConfig({});
    assert.equal(defaults.cdpEndpoint, "http://127.0.0.1:29222");
    assert.equal(defaults.sshHost, "127.0.0.1");
    assert.equal(defaults.sshPort, 22022);
    assert.match(defaults.sshKeyPath, /release\/computer-use-vm\/seed\/id_ed25519$/u);

    const configured = resolveComputerUseVmConfig({
      T3_COMPUTER_USE_VM_CDP_URL: "http://127.0.0.1:39222",
      T3_COMPUTER_USE_VM_SSH_HOST: "vm.test",
      T3_COMPUTER_USE_VM_SSH_PORT: "32022",
      T3_COMPUTER_USE_VM_SSH_USER: "agent",
      T3_COMPUTER_USE_VM_SSH_KEY: "/tmp/key",
      T3_COMPUTER_USE_VM_KNOWN_HOSTS: "/tmp/known-hosts",
    });
    assert.deepEqual(configured, {
      cdpEndpoint: "http://127.0.0.1:39222",
      sshHost: "vm.test",
      sshPort: 32022,
      sshUser: "agent",
      sshKeyPath: "/tmp/key",
      knownHostsPath: "/tmp/known-hosts",
    });
  });

  it("rejects invalid SSH ports", () => {
    assert.throws(
      () => resolveComputerUseVmConfig({ T3_COMPUTER_USE_VM_SSH_PORT: "0" }),
      /must be a positive integer/u,
    );
  });

  it("counts padded base64 payloads exactly", () => {
    assert.equal(decodedBase64Bytes(""), 0);
    assert.equal(decodedBase64Bytes("YQ=="), 1);
    assert.equal(decodedBase64Bytes("YWI="), 2);
    assert.equal(decodedBase64Bytes("YWJj"), 3);
  });

  it("counts GPT-5.6 original-detail image patches", () => {
    assert.equal(gpt56OriginalImageTokens(0, 0), 0);
    assert.equal(gpt56OriginalImageTokens(400, 225), 104);
    assert.equal(gpt56OriginalImageTokens(800, 450), 375);
    assert.equal(gpt56OriginalImageTokens(1600, 900), 1450);
  });
});
