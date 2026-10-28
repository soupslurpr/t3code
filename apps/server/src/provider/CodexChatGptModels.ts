import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { mapCodexModelCapabilities } from "./CodexProvider.ts";
import { codexAccessProgramOptionDescriptors } from "../codexModelOptions.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      available_access_programs: Schema.optional(
        Schema.NullOr(Schema.Struct({ cyber: Schema.Array(Schema.String) })),
      ),
      default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              effort: Schema.NonEmptyString,
              description: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
    }),
  ),
});

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model): ServerProviderModel => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
      // A pinned Codex CLI can predate a model the account already has; the catalog still lists its efforts.
      const catalogCapabilities =
        model.default_reasoning_level && model.supported_reasoning_levels
          ? mapCodexModelCapabilities({
              id: model.slug,
              model: model.slug,
              displayName: model.display_name,
              description: "",
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: model.default_reasoning_level,
              supportedReasoningEfforts: model.supported_reasoning_levels.map((level) => ({
                reasoningEffort: level.effort,
                description: level.description ?? "",
              })),
            })
          : null;
      const capabilities = native?.capabilities ?? catalogCapabilities;
      const accessPrograms = codexAccessProgramOptionDescriptors(
        model.available_access_programs?.cyber.map((program) =>
          program === "daybreak_blue"
            ? "daybreakBlue"
            : program === "daybreak_red"
              ? "daybreakRed"
              : program,
        ),
      );
      return {
        ...native,
        capabilities:
          capabilities || accessPrograms.length > 0
            ? {
                ...capabilities,
                // The fresh account catalog owns entitlements, even if native metadata is cached.
                optionDescriptors: [
                  ...(capabilities?.optionDescriptors ?? []).filter(
                    (option) => option.id !== "cyberAccessProgram",
                  ),
                  ...accessPrograms,
                ],
              }
            : null,
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      };
    });
}, Effect.timeout("15 seconds"));
