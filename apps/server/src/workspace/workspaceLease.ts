import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Kept apart from withWorkspaceLease because that lease is non-reentrant and
// restores call Git work that leases the project root.
interface Reservation {
  readonly targets: ReadonlyArray<string>;
  readonly traversedPaths: ReadonlyArray<string>;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) => {
  if (a.kind !== "restore" && b.kind !== "restore") return false;
  if (
    a.targets.some((left) =>
      b.targets.some((right) => contains(path, left, right) || contains(path, right, left)),
    )
  )
    return true;
  if (
    a.kind === "restore" &&
    a.targets.some((root) => b.traversedPaths.some((entry) => contains(path, root, entry)))
  )
    return true;
  if (
    b.kind === "restore" &&
    b.targets.some((root) => a.traversedPaths.some((entry) => contains(path, root, entry)))
  )
    return true;
  return false;
};

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
export const resolveWorkspacePath = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string, PlatformError> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : resolveWorkspacePath(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
  );

const MAX_SYMLINK_HOPS = 40;

const splitPathSegments = (path: Path.Path, remainder: string): string[] =>
  (path.sep === "\\" ? remainder.split(/[\\/]+/) : remainder.split(path.sep)).filter(
    (segment) => segment.length > 0 && segment !== ".",
  );

// Walk component-by-component like POSIX path lookup (without collapsing `..` before dereferencing
// symlinks) so we capture both the final canonical target (matching OS chdir, unlike Node's
// fs.realpath which lexically collapses `..` first) and every symlink/directory traversed along
// the way within Linux's 40-hop SYMLOOP_MAX budget.
export const traceWorkspacePath = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  rawPath: string,
) {
  const absoluteRaw = path.isAbsolute(rawPath)
    ? rawPath
    : `${path.resolve(".")}${path.sep}${rawPath}`;
  const root = path.parse(absoluteRaw).root;
  const queue = splitPathSegments(path, absoluteRaw.slice(root.length));
  let resolved = root;
  let hops = 0;
  const traversedPaths = new Set<string>();

  while (queue.length > 0) {
    const segment = queue.shift()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Stepping out of a directory still requires that directory to exist during lookup.
      traversedPaths.add(resolved);
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    const linkTarget =
      typeof fileSystem.readLink === "function"
        ? yield* fileSystem.readLink(candidate).pipe(Effect.orElseSucceed(() => null))
        : null;
    if (linkTarget !== null && hops < MAX_SYMLINK_HOPS) {
      hops++;
      traversedPaths.add(candidate);
      if (path.isAbsolute(linkTarget)) {
        const linkRoot = path.parse(linkTarget).root;
        resolved = linkRoot;
        queue.unshift(...splitPathSegments(path, linkTarget.slice(linkRoot.length)));
      } else {
        queue.unshift(...splitPathSegments(path, linkTarget));
      }
      continue;
    }
    resolved = candidate;
  }

  // Also run resolveWorkspacePath (which uses realPath) so mocks that only stub realPath
  // continue to report canonical targets.
  const realTarget = yield* resolveWorkspacePath(fileSystem, path, resolved).pipe(
    Effect.orElseSucceed(() => resolved),
  );
  const targets = realTarget === resolved ? [resolved] : [resolved, realTarget];
  return { resolved: realTarget, targets, traversedPaths: [...traversedPaths] };
});

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    traceWorkspacePath(fileSystem, path, cwd).pipe(
      Effect.flatMap(({ targets, traversedPaths }) => {
        const reservation: Reservation = { targets, traversedPaths, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = withReservation("restore");

/** Waits out overlapping restores; turn startups never wait on each other. */
export const withTurnStartReservation = withReservation("turn-start");

export const canonicalWorkspaceLease =
  (fs: FileSystem.FileSystem, path: Path.Path) =>
  <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    withCanonicalWorkspaceLeases(fs, path, [cwd], effect);

/** Acquire deduplicated lexical+canonical workspace leases in deterministic sorted order. */
export const withCanonicalWorkspaceLeases = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwds: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.forEach(cwds, (cwd) =>
    resolveWorkspacePath(fs, path, cwd).pipe(
      Effect.orElseSucceed(() => cwd),
      Effect.map((canonical) => (canonical === cwd ? [canonical] : [canonical, cwd])),
    ),
  ).pipe(
    Effect.flatMap((lists) => {
      const keys = [...new Set(lists.flat())].toSorted((left, right) => left.localeCompare(right));
      return keys.reduceRight<Effect.Effect<A, E, R>>(
        (inner, key) => withWorkspaceLease(key, inner),
        effect,
      );
    }),
  );

export const withWorkspaceBindingLease = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) => withTurnStartReservation(fs, path, cwd, canonicalWorkspaceLease(fs, path)(cwd, effect));

/** Exclusive over every overlapping workspace while removing a worktree or scratch directory. */
export const withWorkspaceRemovalLease = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  effect: Effect.Effect<A, E, R>,
  extraLeasePaths: ReadonlyArray<string> = [],
) =>
  withCheckpointRestoreReservation(
    fs,
    path,
    cwd,
    withCanonicalWorkspaceLeases(fs, path, [cwd, ...extraLeasePaths], effect),
  );
