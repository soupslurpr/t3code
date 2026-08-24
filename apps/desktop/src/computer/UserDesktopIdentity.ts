import * as NodeOS from "node:os";

import {
  type UserDesktopCapability,
  UserDesktopHostRegistration,
  UserDesktopId,
  UserDesktopLabel,
  type UserDesktopPlatform,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const IDENTITY_FILE_NAME = "user-desktop-identity.json";

const UserDesktopIdentityDocument = Schema.Struct({
  version: Schema.Literal(1),
  desktopId: UserDesktopId,
});

const decodeIdentityDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UserDesktopIdentityDocument),
);
const encodeIdentityDocument = Schema.encodeEffect(
  Schema.fromJsonString(UserDesktopIdentityDocument),
);

const IdentityOperation = Schema.Literals([
  "read",
  "decode",
  "encode",
  "create-directory",
  "write-temporary-file",
  "replace-file",
]);

/** Reports that a stable user-desktop identity could not be loaded safely. */
export class UserDesktopIdentityError extends Schema.TaggedErrorClass<UserDesktopIdentityError>()(
  "UserDesktopIdentityError",
  {
    operation: IdentityOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `User desktop identity ${this.operation} failed at ${this.path}.`;
  }
}

/** Exposes the stable identity registered by this graphical desktop. */
export class UserDesktopIdentity extends Context.Service<
  UserDesktopIdentity,
  {
    readonly registration: UserDesktopHostRegistration;
  }
>()("@t3tools/desktop/computer/UserDesktopIdentity") {}

/** Maps Electron's host platform to the bounded user-desktop protocol value. */
function platformName(platform: NodeJS.Platform): UserDesktopPlatform {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "unknown";
}

/** Builds a safe initial label without using it as desktop identity. */
function defaultLabel(hostname: string): UserDesktopLabel {
  const normalized = hostname.trim().slice(0, 256);
  return UserDesktopLabel.make(normalized.length > 0 ? normalized : "This device");
}

/** Advertises only the platforms implemented by the current computer-use host. */
function platformCapabilities(platform: UserDesktopPlatform): ReadonlyArray<UserDesktopCapability> {
  return platform === "linux" ? ["view", "control", "availability"] : [];
}

const writeIdentity = Effect.fn("userDesktopIdentity.write")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly identityPath: string;
  readonly path: DesktopEnvironment.DesktopEnvironment["Service"]["path"];
  readonly desktopId: UserDesktopId;
  readonly temporarySuffix: string;
}) {
  const directory = input.path.dirname(input.identityPath);
  const temporaryPath = `${input.identityPath}.${process.pid}.${input.temporarySuffix}.tmp`;
  const encoded = yield* encodeIdentityDocument({
    version: 1,
    desktopId: input.desktopId,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new UserDesktopIdentityError({ operation: "encode", path: input.identityPath, cause }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new UserDesktopIdentityError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(temporaryPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new UserDesktopIdentityError({
          operation: "write-temporary-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(temporaryPath, input.identityPath).pipe(
    Effect.mapError(
      (cause) =>
        new UserDesktopIdentityError({
          operation: "replace-file",
          path: input.identityPath,
          cause,
        }),
    ),
    Effect.ensuring(input.fileSystem.remove(temporaryPath).pipe(Effect.ignore)),
  );
});

/** Creates or loads one durable identity for the current graphical desktop. */
export const makeWithHostname = Effect.fn("userDesktopIdentity.makeWithHostname")(function* (
  hostname: string,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const identityPath = environment.path.join(environment.stateDir, IDENTITY_FILE_NAME);
  const exists = yield* fileSystem.exists(identityPath);
  const desktopId = exists
    ? yield* fileSystem.readFileString(identityPath).pipe(
        Effect.mapError(
          (cause) => new UserDesktopIdentityError({ operation: "read", path: identityPath, cause }),
        ),
        Effect.flatMap((raw) =>
          decodeIdentityDocument(raw).pipe(
            Effect.mapError(
              (cause) =>
                new UserDesktopIdentityError({
                  operation: "decode",
                  path: identityPath,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((document) => document.desktopId),
      )
    : yield* Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4;
        const created = UserDesktopId.make(`user-${uuid}`);
        yield* writeIdentity({
          fileSystem,
          identityPath,
          path: environment.path,
          desktopId: created,
          temporarySuffix: uuid,
        });
        return created;
      });

  const platform = platformName(environment.platform);
  return UserDesktopIdentity.of({
    registration: {
      protocolVersion: 1,
      desktopId,
      defaultLabel: defaultLabel(hostname),
      platform,
      capabilities: platformCapabilities(platform),
    },
  });
});

export const make = makeWithHostname(NodeOS.hostname());

export const layer = Layer.effect(UserDesktopIdentity, make);
