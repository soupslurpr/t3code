#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { zstdDecompressSync } from "node:zlib";

const UPSTREAM_REF = "3ba0f711642a888aec92a611a3f3b2211157ff89";
const USER_AGENT = "effect-codex-app-server-generator";
const PRECOMPUTED_EXPORTS_URL = `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/precomputed/app-server-exports-experimental.json.zst`;

const PrecomputedExports = Schema.Struct({
  typescript: Schema.Record(Schema.String, Schema.String),
  json_schema: Schema.Record(Schema.String, Schema.String),
  internal_json_schema: Schema.Record(Schema.String, Schema.String),
});

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodePrecomputedExports = Schema.decodeEffect(Schema.fromJsonString(PrecomputedExports));
const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
  readonly paramsNullable?: boolean;
  readonly paramsOptional?: boolean;
}

interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly contents: string;
  readonly qualifiedName: string;
}

class GeneratorError extends Schema.TaggedErrorClass<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GitDiffToRemoteParams: {
    type: "object",
    title: "GitDiffToRemoteParams",
    properties: {
      cwd: { type: "string" },
    },
    required: ["cwd"],
  },
  GitDiffToRemoteResponse: {
    type: "object",
    title: "GitDiffToRemoteResponse",
    properties: {
      sha: { type: "string" },
      diff: { type: "string" },
    },
    required: ["sha", "diff"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
  // Upstream exposes these only as definitions in the aggregate request schema.
  V2GetAccountTokenUsageParams: {
    type: "object",
    title: "GetAccountTokenUsageParams",
    properties: {
      threadId: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
    },
  },
  V2RemoteControlDisableParams: {
    type: "object",
    title: "RemoteControlDisableParams",
    properties: {
      ephemeral: { type: "boolean" },
    },
  },
  V2RemoteControlEnableParams: {
    type: "object",
    title: "RemoteControlEnableParams",
    properties: {
      ephemeral: { type: "boolean" },
    },
  },
};

// Codex 0.150 exposes these values at runtime, but the pinned experimental
// export does not include them yet. Keep every generated response namespace
// compatible with the live protocol.
const Codex0150DefinitionSchemas: Record<string, Schema.Json> = {
  CollabAgentTool: {
    type: "string",
    enum: [
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
      "sendMessage",
      "followupTask",
      "interruptAgent",
      "listAgents",
    ],
  },
  CollabAgentToolCallStatus: {
    type: "string",
    enum: ["inProgress", "completed", "failed", "interrupted"],
  },
  PlanType: {
    type: "string",
    enum: [
      "free",
      "go",
      "plus",
      "pro",
      "prolite",
      "team",
      "self_serve_business_prolite",
      "self_serve_business_usage_based",
      "business",
      "ent26",
      "enterprise_cbp_automation",
      "enterprise_cbp_usage_based",
      "enterprise",
      "edu",
      "edu_plus",
      "edu_pro",
      "unknown",
    ],
  },
  SubAgentActivityKind: {
    type: "string",
    enum: ["started", "interacted", "interrupted", "completed"],
  },
};

function applyCodex0151DefinitionCompatibility(
  exportName: string,
  definitionName: string,
  definitionSchema: Schema.Json,
): Schema.Json {
  const isThreadResponse =
    exportName === "V2ThreadReadResponse" ||
    exportName === "V2ThreadResumeResponse" ||
    exportName === "V2ThreadRollbackResponse";
  if (
    !isThreadResponse ||
    definitionName !== "CodexErrorInfo" ||
    typeof definitionSchema !== "object"
  ) {
    return definitionSchema;
  }

  const schema = definitionSchema as {
    readonly oneOf?: ReadonlyArray<{ readonly enum?: ReadonlyArray<string> }>;
  };
  const [firstVariant, ...remainingVariants] = schema.oneOf ?? [];
  if (!firstVariant?.enum || firstVariant.enum.includes("rateLimitExceeded")) {
    return definitionSchema;
  }

  return {
    ...definitionSchema,
    oneOf: [
      { ...firstVariant, enum: [...firstVariant.enum, "rateLimitExceeded"] },
      ...remainingVariants,
    ],
  };
}

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

/** Downloads and decodes Codex's versioned experimental protocol export. */
const fetchPrecomputedExports = Effect.fn("fetchPrecomputedExports")(function* () {
  const response = yield* HttpClientRequest.get(PRECOMPUTED_EXPORTS_URL).pipe(
    HttpClientRequest.setHeader("user-agent", USER_AGENT),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to fetch ${PRECOMPUTED_EXPORTS_URL}`,
          cause,
        }),
    ),
  );
  const compressed = yield* response.arrayBuffer.pipe(
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: "Failed to read the precomputed Codex protocol export",
          cause,
        }),
    ),
  );
  const json = yield* Effect.try({
    try: () => new TextDecoder().decode(zstdDecompressSync(new Uint8Array(compressed))),
    catch: (cause) =>
      new GeneratorError({
        detail: "Failed to decompress the precomputed Codex protocol export",
        cause,
      }),
  });
  return yield* decodePrecomputedExports(json).pipe(
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: "Failed to decode the precomputed Codex protocol export",
          cause,
        }),
    ),
  );
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

// Codex 0.153 adds async questions to agent messages. Keep older protocol
// fields until the next full refresh, including every thread history namespace.
function addAsyncQuestionFields(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(addAsyncQuestionFields);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const properties = "properties" in value ? value.properties : undefined;
  const itemType =
    properties && typeof properties === "object" && "type" in properties
      ? properties.type
      : undefined;
  const isAgentMessage =
    itemType !== null &&
    typeof itemType === "object" &&
    (("const" in itemType && itemType.const === "agentMessage") ||
      ("enum" in itemType &&
        Array.isArray(itemType.enum) &&
        itemType.enum.includes("agentMessage")));
  if (properties && typeof properties === "object" && isAgentMessage) {
    return {
      ...value,
      properties: {
        ...properties,
        delivery: { anyOf: [{ type: "string", enum: ["async"] }, { type: "null" }] },
        questions: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  options: {
                    anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
                  },
                },
                required: ["title"],
              },
            },
            { type: "null" },
          ],
        },
      },
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, addAsyncQuestionFields(child)]),
  );
}

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function parseMethodParams(expression: string, optional: boolean): Omit<MethodEntry, "method"> {
  const members = expression.split("|").map((member) => member.trim());
  const concreteMembers = members.filter((member) => member !== "null" && member !== "undefined");
  if (concreteMembers.length > 1) {
    throw new Error(`Unsupported request parameter union: ${expression}`);
  }
  return {
    paramsType: concreteMembers[0] ?? "undefined",
    ...(members.includes("null") ? { paramsNullable: true } : {}),
    ...(optional || members.includes("undefined") ? { paramsOptional: true } : {}),
  };
}

function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params(\?)?:\s*([^,}]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...parseMethodParams(match[3]!.trim(), match[2] === "?"),
    });
  }
  return entries;
}

function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "account/logout": "LogoutAccountResponse",
    "account/rateLimits/read": "GetAccountRateLimitsResponse",
    "account/usage/read": "GetAccountTokenUsageResponse",
    "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
    "config/batchWrite": "ConfigWriteResponse",
    "config/mcpServer/reload": "McpServerRefreshResponse",
    "config/value/write": "ConfigWriteResponse",
    "configRequirements/read": "ConfigRequirementsReadResponse",
    "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}

function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  schemaExpression: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => `  ${JSON.stringify(entry.method)}: ${schemaExpression(entry)},`),
    "} as const;",
    "",
  ].join("\n");
}

function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`;
}

function renderMethodParamTypeReference(
  entry: MethodEntry,
  generatedSchemaNames: ReadonlySet<string>,
) {
  const schemaName = resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames);
  const members = [renderSchemaTypeReference(schemaName)];
  if (entry.paramsNullable) members.push("null");
  if (entry.paramsOptional) members.push("undefined");
  return [...new Set(members)].join(" | ");
}

function renderMethodParamSchemaReference(
  entry: MethodEntry,
  generatedSchemaNames: ReadonlySet<string>,
) {
  const schemaName = resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames);
  if (schemaName === "undefined") return "undefined";
  const members = [renderSchemaTypeReference(schemaName)];
  if (entry.paramsNullable) members.push("Schema.Null");
  if (entry.paramsOptional) members.push("Schema.Undefined");
  const uniqueMembers = [...new Set(members)];
  return uniqueMembers.length === 1
    ? uniqueMembers[0]!
    : `Schema.Union([${uniqueMembers.join(", ")}])`;
}

function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/^schema\/json\//, "").replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}

function buildJsonSchemaFiles(
  entries: Readonly<Record<string, string>>,
): ReadonlyArray<JsonSchemaFile> {
  return Object.entries(entries)
    .filter(
      ([fileName]) =>
        fileName.endsWith(".json") &&
        !fileName.startsWith("codex_app_server_protocol.") &&
        ![
          "ClientNotification.json",
          "ClientRequest.json",
          "ServerNotification.json",
          "ServerRequest.json",
        ].includes(fileName),
    )
    .map(([relative, contents]) => {
      const parts = relative.split("/");
      if (parts.length > 1) {
        return {
          namespace: parts[0]!,
          exportName: exportNameForPath(relative),
          fileName: parts.at(-1)!,
          contents,
          qualifiedName: relative.replace(/\.json$/, ""),
        } satisfies JsonSchemaFile;
      }
      return {
        exportName: exportNameForPath(relative),
        fileName: relative,
        contents,
        qualifiedName: relative.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile;
    });
}

/** Returns a required file from the precomputed export. */
function requirePrecomputedFile(entries: Readonly<Record<string, string>>, fileName: string) {
  const contents = entries[fileName];
  return contents === undefined
    ? Effect.fail(
        new GeneratorError({
          detail: `Missing ${fileName} in the precomputed Codex protocol export`,
        }),
      )
    : Effect.succeed(contents);
}

function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);
        if (localRewrite) {
          return [key, `#/definitions/${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `#/definitions/${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  ) as Schema.Json;
}

const generateFiles = Effect.fn("generateFiles")(function* () {
  yield* ensureGeneratedDir();

  const precomputedExports = yield* fetchPrecomputedExports();
  const jsonSchemaFiles = buildJsonSchemaFiles(precomputedExports.json_schema).toSorted(
    (left, right) => left.exportName.localeCompare(right.exportName),
  );

  const exportNameByQualifiedName = new Map(
    jsonSchemaFiles.map((file) => [file.qualifiedName, file.exportName]),
  );
  const aggregateSchemas: Record<string, Schema.Json> = {};

  for (const file of jsonSchemaFiles) {
    const parsed = yield* decodeJsonSchemaDocument(file.contents);
    const localDefinitionNames = new Map(
      Object.keys(parsed.definitions ?? {}).map((definitionName) => [
        definitionName,
        `${file.exportName}__${definitionName.replace(/[^A-Za-z0-9]/g, "")}`,
      ]),
    );

    for (const [definitionName, definitionSchema] of Object.entries(parsed.definitions ?? {})) {
      const compatibleDefinitionSchema =
        Codex0150DefinitionSchemas[definitionName] ??
        applyCodex0151DefinitionCompatibility(file.exportName, definitionName, definitionSchema);
      aggregateSchemas[localDefinitionNames.get(definitionName)!] = stripNullDefaults(
        normalizeNullableTypes(
          rewriteExternalRefs(
            compatibleDefinitionSchema,
            localDefinitionNames,
            file.namespace,
            exportNameByQualifiedName,
          ),
        ),
      );
    }

    const topLevelSchema: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "definitions") {
        topLevelSchema[key] = value;
      }
    }

    aggregateSchemas[file.exportName] = stripNullDefaults(
      normalizeNullableTypes(
        rewriteExternalRefs(
          topLevelSchema,
          localDefinitionNames,
          file.namespace,
          exportNameByQualifiedName,
        ),
      ),
    );
  }

  for (const [name, schema] of Object.entries(ManualSchemas)) {
    if (!(name in aggregateSchemas)) {
      aggregateSchemas[name] = stripNullDefaults(normalizeNullableTypes(schema));
    }
  }

  const compatibleSchemas = Object.fromEntries(
    Object.entries(aggregateSchemas).map(([name, schema]) => [
      name,
      addAsyncQuestionFields(schema),
    ]),
  ) as Record<string, Schema.Json>;
  const generator = makeJsonSchemaGenerator();
  for (const [name, schema] of Object.entries(compatibleSchemas).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    generator.addSchema(name, schema as never);
  }

  const generatedEntries = new Map<string, string>();
  const output = generator.generate("openapi-3.1", compatibleSchemas as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  const generatedSchemaNames = new Set(generatedEntries.keys());
  const protocolTypescript = yield* Effect.all({
    clientRequest: requirePrecomputedFile(precomputedExports.typescript, "ClientRequest.ts"),
    clientNotification: requirePrecomputedFile(
      precomputedExports.typescript,
      "ClientNotification.ts",
    ),
    serverRequest: requirePrecomputedFile(precomputedExports.typescript, "ServerRequest.ts"),
    serverNotification: requirePrecomputedFile(
      precomputedExports.typescript,
      "ServerNotification.ts",
    ),
  });

  const clientRequestEntries = parseRequestEntries(protocolTypescript.clientRequest);
  const clientNotificationEntries = parseNotificationEntries(protocolTypescript.clientNotification);
  const serverRequestEntries = parseRequestEntries(protocolTypescript.serverRequest);
  const serverNotificationEntries = parseNotificationEntries(protocolTypescript.serverNotification);

  const prelude = [
    "// This file is generated by the effect-codex-app-server package. Do not edit manually.",
    `// Upstream protocol ref: ${UPSTREAM_REF}`,
    "",
  ];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    renderMethodConstants("CLIENT_REQUEST_METHODS", clientRequestEntries),
    renderMethodConstants("CLIENT_NOTIFICATION_METHODS", clientNotificationEntries),
    renderMethodConstants("SERVER_REQUEST_METHODS", serverRequestEntries),
    renderMethodConstants("SERVER_NOTIFICATION_METHODS", serverNotificationEntries),
    "export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;",
    "export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;",
    "export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;",
    "export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;",
    "",
    renderTypeInterface("ClientRequestParamsByMethod", clientRequestEntries, (entry) =>
      renderMethodParamTypeReference(entry, generatedSchemaNames),
    ),
    renderTypeInterface("ClientRequestResponsesByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientNotificationParamsByMethod", clientNotificationEntries, (entry) =>
      renderMethodParamTypeReference(entry, generatedSchemaNames),
    ),
    renderTypeInterface("ServerRequestParamsByMethod", serverRequestEntries, (entry) =>
      renderMethodParamTypeReference(entry, generatedSchemaNames),
    ),
    renderTypeInterface("ServerRequestResponsesByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerNotificationParamsByMethod", serverNotificationEntries, (entry) =>
      renderMethodParamTypeReference(entry, generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_PARAMS", clientRequestEntries, (entry) =>
      renderMethodParamSchemaReference(entry, generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_RESPONSES", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderSchemaMap("CLIENT_NOTIFICATION_PARAMS", clientNotificationEntries, (entry) =>
      renderMethodParamSchemaReference(entry, generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_PARAMS", serverRequestEntries, (entry) =>
      renderMethodParamSchemaReference(entry, generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_RESPONSES", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderSchemaMap("SERVER_NOTIFICATION_PARAMS", serverNotificationEntries, (entry) =>
      renderMethodParamSchemaReference(entry, generatedSchemaNames),
    ),
  ].join("\n");

  const namespaceGroups = new Map<string, Array<JsonSchemaFile>>();
  for (const file of jsonSchemaFiles) {
    if (!file.namespace) {
      continue;
    }
    const current = namespaceGroups.get(file.namespace) ?? [];
    current.push(file);
    namespaceGroups.set(file.namespace, current);
  }

  const namespacesOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    ...[...namespaceGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([namespace, files]) => {
        const constantName = namespace.replace(/[^A-Za-z0-9]/g, "");
        return [
          `export const ${constantName} = {`,
          ...files
            .toSorted((left, right) => left.fileName.localeCompare(right.fileName))
            .map(
              (file) =>
                `  ${JSON.stringify(file.fileName.replace(/\.json$/, ""))}: CodexSchema.${file.exportName},`,
            ),
          "} as const;",
          "",
        ].join("\n");
      }),
  ].join("\n");

  const fs = yield* FileSystem.FileSystem;
  const { generatedDir, metaOutputPath, namespacesOutputPath, schemaOutputPath } =
    yield* getGeneratedPaths();
  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
  yield* fs.writeFileString(namespacesOutputPath, namespacesOutput);

  yield* Effect.log(`Generated Codex App Server schemas from ${UPSTREAM_REF}`);

  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(ChildProcess.make("vp", ["fmt", generatedDir, "--write"])),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new GeneratorError({
              detail: `vp fmt failed with exit code ${code}`,
            }),
          ),
    ),
  );
});

generateFiles().pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Logger.layer([Logger.consolePretty()]),
      NodeServices.layer,
      FetchHttpClient.layer,
    ),
  ),
  NodeRuntime.runMain,
);
