import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  ThreadId,
  type ComputerHostRegistration,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";
import { DesktopThreadLifecycleService } from "./DesktopThreadLifecycle.ts";
import * as Hosts from "./UserDesktopHosts.ts";

it.effect("binds enrollment and replies to the desktop, socket and registration generation", () =>
  Effect.gen(function* () {
    const hosts = yield* Hosts.make;
    const env = EnvironmentId.make("environment");
    const session = {
      sessionId: AuthSessionId.make("session"),
      subject: "desktop-host:host-a",
      method: "bearer-access-token" as const,
      scopes: AuthStandardClientScopes,
    };
    const registration: ComputerHostRegistration = {
      clientId: "renderer",
      environmentId: env,
      supportedOperations: ["computerStatus"],
      userDesktop: {
        desktopId: "host-a",
        protocolVersion: 1,
        platform: "linux",
        defaultLabel: "Desktop",
        capabilities: ["view"],
      },
    };
    const one = hosts.forSocket(session, env);
    const other = hosts.forSocket(session, env);
    const unauthorized = hosts.forSocket({ ...session, subject: "client" }, env);
    expect(
      (yield* Effect.result(unauthorized.connect(registration).pipe(Stream.runDrain)))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.result(
        one
          .connect({
            ...registration,
            userDesktop: { ...registration.userDesktop, desktopId: "host-b" },
          })
          .pipe(Stream.runDrain),
      ))._tag,
    ).toBe("Failure");
    const ready = yield* Deferred.make<string>();
    const pending = yield* Deferred.make<string>();
    const connection = yield* one.connect(registration).pipe(
      Stream.runForEach((e) =>
        e.type === "connected"
          ? Deferred.succeed(ready, e.connectionId)
          : e.type === "request"
            ? Deferred.succeed(pending, e.request.requestId)
            : Effect.void,
      ),
      Effect.forkScoped,
    );
    const generation = yield* Deferred.await(ready);
    const status = yield* hosts
      .invoke(
        {
          controllerId: "controller",
          controllerKind: "agent",
          environmentId: env,
          threadId: ThreadId.make("thread"),
        },
        "host-a",
        "computerStatus",
        {},
        250,
      )
      .pipe(Effect.forkScoped);
    const reply = {
      clientId: "renderer",
      connectionId: generation,
      requestId: yield* Deferred.await(pending),
      ok: true,
      result: "verified",
    };
    expect((yield* Effect.result(other.respond(reply)))._tag).toBe("Failure");
    expect((yield* Effect.result(one.respond({ ...reply, connectionId: "retired" })))._tag).toBe(
      "Failure",
    );
    yield* one.respond(reply);
    expect(yield* Fiber.join(status)).toBe("verified");
    yield* Fiber.interrupt(connection);
    expect((yield* hosts.list()).desktops[0]?.connectionState).toBe("offline");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        UserDesktops.layerMemory,
        Layer.succeed(DesktopThreadLifecycleService, {
          changes: Stream.empty,
          read: () => Effect.die("No active thread"),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-enrolled-hosts-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeCrypto.layer,
      ),
    ),
  ),
);
