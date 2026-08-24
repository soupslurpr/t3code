import { assert, describe, it } from "vite-plus/test";

import { InputCancellationEpoch } from "../resources/computer-use/input-cancellation.js";

describe("InputCancellationEpoch", () => {
  it("invalidates active and queued input captured before release", () => {
    const cancellation = new InputCancellationEpoch();
    const active = cancellation.capture();
    const queued = cancellation.capture();

    cancellation.cancel();

    assert.isTrue(cancellation.isCancelled(active));
    assert.isTrue(cancellation.isCancelled(queued));
    assert.isFalse(cancellation.isCancelled(cancellation.capture()));
  });

  it("keeps later input isolated from a subsequent release", () => {
    const cancellation = new InputCancellationEpoch();
    cancellation.cancel();
    const later = cancellation.capture();

    assert.isFalse(cancellation.isCancelled(later));
    cancellation.cancel();
    assert.isTrue(cancellation.isCancelled(later));
  });
});
