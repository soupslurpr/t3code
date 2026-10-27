import { guideFileAvailability } from "./guideFileAvailability";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

interface LoadedDiff {
  readonly key: string;
  readonly cursor: string | null;
  readonly done: boolean;
  readonly files: ReadonlyMap<string, FileDiffMetadata>;
  readonly folded: unknown;
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

export function useGuideDiffFiles({
  environmentId,
  reference,
  headSha,
  wantedPaths,
  enabled,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  headSha: string;
  wantedPaths: ReadonlyArray<string>;
  enabled: boolean;
}) {
  const key = `${environmentId}:${pullRequestReviewKey(reference)}:${headSha}`;
  const [loaded, setLoaded] = useState<LoadedDiff>({
    key,
    cursor: null,
    done: false,
    files: NO_FILES,
    folded: null,
  });
  const current: LoadedDiff =
    loaded.key === key ? loaded : { key, cursor: null, done: false, files: NO_FILES, folded: null };
  const { files: availableFiles, loading } = guideFileAvailability({
    files: current.files,
    wantedPaths,
    done: current.done,
    enabled,
  });
  const query = useEnvironmentQuery(
    loading
      ? pullRequestEnvironment.diff({
          environmentId,
          input: { ...reference, ...(current.cursor === null ? {} : { cursor: current.cursor }) },
        })
      : null,
  );

  const data = query.data;
  if (data !== null && !current.done && current.folded !== data) {
    const parsed = getRenderablePatch(
      data.patch,
      `pull-request-guide:${key}:${current.cursor ?? "first"}`,
    );
    const files = new Map(current.files);
    if (parsed?.kind === "files") {
      for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
    }
    setLoaded({
      key,
      cursor: data.nextCursor,
      done: data.nextCursor === null,
      files,
      folded: data,
    });
  }

  return {
    // The diff endpoint follows the current PR head. Old guide coordinates
    // must never be paired with its code, including pages already cached here.
    files: availableFiles,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}
