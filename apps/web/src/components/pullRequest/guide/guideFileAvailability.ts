const NO_FILES: ReadonlyMap<string, never> = new Map<string, never>();

export function guideFileAvailability<T>({
  files,
  wantedPaths,
  done,
  enabled,
}: {
  files: ReadonlyMap<string, T>;
  wantedPaths: ReadonlyArray<string>;
  done: boolean;
  enabled: boolean;
}) {
  return {
    files: enabled ? files : NO_FILES,
    loading: enabled && !done && wantedPaths.some((path) => !files.has(path)),
  };
}
