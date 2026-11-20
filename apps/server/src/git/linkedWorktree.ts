import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Git from "../vcs/GitVcsDriver.ts";

/** A project can be its own checkout. Only a distinct linked checkout is removable. */
export const makeWorktreeMembershipProbe = (
  git: Git.GitVcsDriver["Service"],
  fs: FileSystem.FileSystem,
) =>
  Effect.fn("GitWorkflowService.worktreeMembership")(function* (project: string, cwd: string) {
    const probe = (root: string, args: string[]) =>
      git.execute({
        cwd: root,
        operation: "GitWorkflowService.worktreeMembership",
        args,
        allowNonZeroExit: true,
      });
    const local = yield* probe(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--absolute-git-dir",
    ]);
    if (local.exitCode !== 0) return null;
    const [top, common, privateDir] = local.stdout.trimEnd().split("\n");
    if (!top || !common || !privateDir) return null;
    const repo = yield* probe(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const real = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => null));
    const root = yield* real(cwd);
    const repository = repo.exitCode === 0 ? yield* real(repo.stdout.trimEnd()) : null;
    if (
      repository === null ||
      root === null ||
      (yield* real(top)) !== root ||
      (yield* real(common)) !== repository
    )
      return null;
    const projectCheckout = root === (yield* real(project));
    const privateGitDir = yield* real(privateDir);
    if (privateGitDir === null || (!projectCheckout && privateGitDir === repository)) return null;
    const records = yield* probe(project, ["worktree", "list", "--porcelain", "-z"]);
    if (records.exitCode !== 0 || records.stdoutTruncated) return null;
    for (const item of records.stdout.split("\0")) {
      if (item.startsWith("worktree ") && (yield* real(item.slice(9))) === root)
        return projectCheckout ? ("project" as const) : ("linked" as const);
    }
    return null;
  });

export const makePrunableWorktreeProbe = (
  git: Git.GitVcsDriver["Service"],
  fs: FileSystem.FileSystem,
) =>
  Effect.fn("GitWorkflowService.isPrunableWorktree")(function* (project: string, cwd: string) {
    const listing = yield* git.execute({
      cwd: project,
      operation: "GitWorkflowService.isPrunableWorktree",
      args: ["worktree", "list", "--porcelain", "-z"],
    });
    if (listing.stdoutTruncated) return false;
    const real = yield* fs
      .realPath(cwd)
      .pipe(Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? cwd : null)));
    if (real !== cwd) return false;
    return listing.stdout.split("\0\0").some((record) => {
      const fields = record.split("\0");
      return (
        fields.includes("worktree " + real) &&
        fields.some((field) => field === "prunable" || field.startsWith("prunable "))
      );
    });
  });
