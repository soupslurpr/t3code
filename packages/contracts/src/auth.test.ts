import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  AuthAdministrativeClientScopes,
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  AuthFilesystemReadScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthRelayConfigureScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  AuthUserDesktopHostScopes,
  authScopeResponse,
  AuthSessionState,
  sessionGrantsScope,
  userDesktopHostPairingScopes,
} from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    const decodeAuthEnvironmentScopes = Schema.decodeSync(AuthEnvironmentScopes);

    expect(decodeAuthEnvironmentScopes(["review:write"])).toEqual(["review:write"]);
    const decodeAuthGrantScopes = Schema.decodeUnknownSync(AuthGrantScopes);

    expect(() => decodeAuthGrantScopes(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Keep the pre-granular vocabulary frozen to expose compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  it.each(AuthEnvironmentScope.literals)(
    "keeps %s permission errors decodable by old clients",
    (scope) => {
      const response = authScopeRequiredResponse(scope);
      expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
      expect(response.requiredPermission).toBe(scope);
    },
  );

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const decodeAuthSessionState = Schema.decodeUnknownSync(AuthSessionState);

    const session = decodeAuthSessionState({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });

  it("computes desktop enrollment preset scopes from exact issuer grants", () => {
    const adminIssuer = {
      authenticated: true,
      permissions: AuthAdministrativeClientScopes,
    };
    expect(userDesktopHostPairingScopes("standard", adminIssuer)).toEqual({
      scopes: AuthStandardClientScopes,
      omitted: [],
    });
    expect(userDesktopHostPairingScopes("standard", adminIssuer)?.scopes).not.toContain(
      AuthRelayConfigureScope,
    );
    expect(userDesktopHostPairingScopes("host-commands", adminIssuer)).toEqual({
      scopes: [...AuthUserDesktopHostScopes, AuthTerminalOperateScope],
      omitted: [],
    });
    expect(userDesktopHostPairingScopes("host-only", adminIssuer)).toEqual({
      scopes: AuthUserDesktopHostScopes,
      omitted: [],
    });

    const partialIssuer = {
      authenticated: true,
      permissions: AuthStandardClientScopes.filter(
        (scope) => scope !== AuthTerminalOperateScope && scope !== AuthRelayWriteScope,
      ),
    };
    const partialStandard = userDesktopHostPairingScopes("standard", partialIssuer);
    expect(partialStandard?.scopes).toContain(AuthFilesystemReadScope);
    expect(partialStandard?.omitted).toEqual([AuthTerminalOperateScope, AuthRelayWriteScope]);
    expect(userDesktopHostPairingScopes("host-commands", partialIssuer)).toBeNull();
    expect(userDesktopHostPairingScopes("host-only", partialIssuer)).toEqual({
      scopes: AuthUserDesktopHostScopes,
      omitted: [],
    });

    const minimumIssuer = {
      authenticated: true,
      permissions: [AuthAccessWriteScope, ...AuthUserDesktopHostScopes],
    };
    const minimumStandard = userDesktopHostPairingScopes("standard", minimumIssuer);
    expect(minimumStandard?.scopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "preview:operate",
      "access:write",
    ]);
    expect(minimumStandard?.omitted).toContain(AuthFilesystemReadScope);

    // Legacy scopes never infer terminal:read from terminal:operate during desktop enrollment.
    const legacyCommandIssuer = {
      authenticated: true,
      scopes: [AuthAccessWriteScope, ...AuthUserDesktopHostScopes, AuthTerminalOperateScope],
    };
    expect(userDesktopHostPairingScopes("host-commands", legacyCommandIssuer)).toEqual({
      scopes: [...AuthUserDesktopHostScopes, AuthTerminalOperateScope],
      omitted: [],
    });
    expect(userDesktopHostPairingScopes("standard", legacyCommandIssuer)?.scopes).not.toContain(
      AuthTerminalReadScope,
    );
    expect(userDesktopHostPairingScopes("standard", legacyCommandIssuer)?.omitted).toContain(
      AuthTerminalReadScope,
    );

    expect(
      userDesktopHostPairingScopes("standard", {
        authenticated: false,
        permissions: AuthAdministrativeClientScopes,
      }),
    ).toBeNull();
    expect(
      userDesktopHostPairingScopes("host-only", {
        authenticated: true,
        permissions: AuthUserDesktopHostScopes,
      }),
    ).toBeNull();
    expect(
      userDesktopHostPairingScopes("standard", {
        authenticated: true,
        permissions: [AuthAccessWriteScope, "orchestration:read", "orchestration:operate"],
      }),
    ).toBeNull();
  });
});
