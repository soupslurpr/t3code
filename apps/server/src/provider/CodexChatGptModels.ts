import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
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
    .map((model) => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
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
          native?.capabilities || accessPrograms.length > 0
            ? {
                ...native?.capabilities,
                // The fresh account catalog owns entitlements, even if native metadata is cached.
                optionDescriptors: [
                  ...(native?.capabilities?.optionDescriptors ?? []).filter(
                    (option) => option.id !== "cyberAccessProgram",
                  ),
                  ...accessPrograms,
                ],
              }
            : null,
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      } satisfies ServerProviderModel;
    });
}, Effect.timeout("15 seconds"));
