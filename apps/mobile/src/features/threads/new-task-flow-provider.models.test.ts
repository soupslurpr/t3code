import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { resolveMobileLeadAvailability, defaultMobileLeadRole } from "../../lib/lead";
import { resolveNewTaskModelSelection } from "../../lib/modelOptions";
import { leadServerConfig, wonderMax } from "./lead-test-fixtures";

describe("new human task model preference", () => {
  it.each([true, false])(
    "keeps Full preference separate from worker availability (%s)",
    (workers) => {
      const config = leadServerConfig();
      const availability = resolveMobileLeadAvailability(
        workers ? config : { ...config, providers: config.providers.slice(0, 1) },
        null,
      );
      const preferred = availability.wonderSelections[0];
      expect(preferred).toEqual(wonderMax);
      const sources = {
        draftSelection: { instanceId: ProviderInstanceId.make("saved"), model: "draft" },
        projectDefaultSelection: { instanceId: ProviderInstanceId.make("saved"), model: "project" },
        stickySelection: { instanceId: ProviderInstanceId.make("saved"), model: "sticky" },
      };
      for (const source of [
        "draftSelection",
        "projectDefaultSelection",
        "stickySelection",
      ] as const) {
        const resolved = resolveNewTaskModelSelection({
          draftSelection: null,
          projectDefaultSelection: null,
          stickySelection: null,
          leadDefaultSelection: preferred,
          modelOptions: [],
          [source]: sources[source],
        });
        expect(resolved).toBe(sources[source]);
      }
      const resolved = resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        leadDefaultSelection: preferred,
        modelOptions: [],
      });
      expect(resolved).toBe(preferred);
      expect(defaultMobileLeadRole(resolved!, availability).options).toEqual([
        ...wonderMax.options,
        ...(workers ? [{ id: "leadRole", value: "lead" }] : []),
      ]);
    },
  );
  it("does not fabricate Full when that model is unavailable", () => {
    const availability = resolveMobileLeadAvailability(leadServerConfig("muse-wonder-1.0"), null);
    expect(availability.wonderSelections).toEqual([]);
    expect(
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        leadDefaultSelection: availability.wonderSelections[0],
        modelOptions: [],
      }),
    ).toBeNull();
  });
});
