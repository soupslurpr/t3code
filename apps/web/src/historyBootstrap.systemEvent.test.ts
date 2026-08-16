import { MessageId, ThreadMonitorId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { buildBootstrapInput } from "./historyBootstrap";

it("preserves typed monitor events as system context", () => {
  const result = buildBootstrapInput(
    [
      {
        id: MessageId.make("monitor-1"),
        role: "system",
        text: "Monitor triggered: Wait for the build",
        systemEvent: {
          type: "monitor.continuation",
          deliveryGroupId: "delivery-group-1",
          monitors: [
            {
              monitorId: ThreadMonitorId.make("monitor-1"),
              triggeredAt: "2026-02-09T00:00:00.000Z",
              triggerReason: "signal",
              observation: {
                label: "Wait for the build",
                summary: "Build passed.",
                evidence: "exitCode=0",
              },
              continuation: { prompt: "Report the result." },
            },
          ],
          observationTrust: "untrusted",
          grantsAuthorization: false,
        },
        createdAt: "2026-02-09T00:00:00.000Z",
        turnId: null,
        updatedAt: "2026-02-09T00:00:00.000Z",
        streaming: false,
      },
    ],
    "What happened?",
    2_000,
  );

  expect(result.text).toContain("SYSTEM:\nMonitor triggered: Wait for the build");
  expect(result.text).toContain('"observationTrust":"untrusted"');
  expect(result.text).toContain('"grantsAuthorization":false');
  expect(result.text).not.toContain("USER:\nMonitor triggered");
});
