import { assert, describe, it } from "vite-plus/test";

import {
  createBatchedIdleCollector,
  createStreamCaptureCompletion,
} from "../resources/computer-use/stream-capture-completion.js";

/** Creates one instrumented stream capture completion fixture. */
function makeFixture({ stopError = null, closeError = null } = {}) {
  const calls = [];
  const resolutions = [];
  const rejections = [];
  const finish = createStreamCaptureCompletion({
    clearPoll: () => calls.push("clear-poll"),
    unregister: () => calls.push("unregister"),
    stopPipeline: () => {
      calls.push("stop-pipeline");
      if (stopError !== null) throw stopError;
    },
    closeRemote: () => {
      calls.push("close-remote");
      if (closeError !== null) throw closeError;
    },
    resolve: (data) => resolutions.push(data),
    reject: (error) => rejections.push(error),
  });
  return { calls, finish, rejections, resolutions };
}

describe("createStreamCaptureCompletion", () => {
  it("stops the pipeline before closing the remote exactly once", () => {
    const fixture = makeFixture();
    const frame = new Uint8Array([1, 2, 3]);

    assert.isTrue(fixture.finish(null, frame));
    assert.isFalse(fixture.finish(new Error("late failure")));

    assert.deepEqual(fixture.calls, ["clear-poll", "unregister", "stop-pipeline", "close-remote"]);
    assert.deepEqual(fixture.resolutions, [frame]);
    assert.deepEqual(fixture.rejections, []);
  });

  it("closes the remote for every capture terminal path", () => {
    const terminalErrors = [
      null,
      new Error("stream failure"),
      new Error("stream timeout"),
      new Error("capture cancelled"),
      new Error("pipeline construction failure"),
    ];

    for (const terminalError of terminalErrors) {
      const fixture = makeFixture();
      fixture.finish(terminalError, new Uint8Array([1]));
      assert.equal(fixture.calls.filter((call) => call === "close-remote").length, 1);
    }
  });

  it("keeps repeated capture descriptor ownership flat", () => {
    const openDescriptors = new Set();
    let maxOpenDescriptors = 0;
    const captureCount = 2_048;

    for (let captureIndex = 0; captureIndex < captureCount; captureIndex += 1) {
      openDescriptors.add(captureIndex);
      maxOpenDescriptors = Math.max(maxOpenDescriptors, openDescriptors.size);
      const finish = createStreamCaptureCompletion({
        clearPoll: () => undefined,
        unregister: () => undefined,
        stopPipeline: () => undefined,
        closeRemote: () => openDescriptors.delete(captureIndex),
        resolve: () => undefined,
        reject: () => undefined,
      });

      finish(captureIndex % 2 === 0 ? null : new Error("capture failed"));
      finish(new Error("late failure"));
    }

    assert.equal(maxOpenDescriptors, 1);
    assert.equal(openDescriptors.size, 0);
  });

  it("still closes the remote when stopping the pipeline fails", () => {
    const stopError = new Error("pipeline stop failed");
    const fixture = makeFixture({ stopError });

    fixture.finish(null, new Uint8Array([1]));

    assert.deepEqual(fixture.calls, ["clear-poll", "unregister", "stop-pipeline", "close-remote"]);
    assert.deepEqual(fixture.rejections, [stopError]);
  });
});

describe("createBatchedIdleCollector", () => {
  it("coalesces completed capture generations into bounded idle collections", () => {
    const scheduled = [];
    let collectionCount = 0;
    const complete = createBatchedIdleCollector({
      interval: 32,
      schedule: (collect) => scheduled.push(collect),
      collect: () => {
        collectionCount += 1;
      },
    });

    for (let captureIndex = 0; captureIndex < 64; captureIndex += 1) complete();
    assert.equal(scheduled.length, 1);
    assert.equal(collectionCount, 0);

    scheduled.shift()();
    assert.equal(collectionCount, 1);
    for (let captureIndex = 0; captureIndex < 31; captureIndex += 1) complete();
    assert.equal(scheduled.length, 0);
    complete();
    assert.equal(scheduled.length, 1);
  });
});
