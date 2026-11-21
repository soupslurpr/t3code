#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodePath from "node:path";
import { LocalArchPackageError, assertInvariant } from "./arch/common.ts";
import {
  prepareLocalArchPackage,
  publishLocalArchPackage,
  cleanLocalArchPackageStage,
} from "./arch/stage.ts";

interface CliOptions {
  readonly appImagePath?: string | undefined;
  readonly stageDir?: string | undefined;
  readonly packageRelease?: number | undefined;
  readonly keepStage: boolean;
  readonly help: boolean;
}

function parseCliOptions(args: ReadonlyArray<string>): CliOptions {
  let appImagePath: string | undefined;
  let stageDir: string | undefined;
  let packageRelease: number | undefined;
  let keepStage = false;
  let help = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    if (argument === "--appimage" || argument === "--stage-dir" || argument === "--pkgrel") {
      const value = args[argumentIndex + 1];
      assertInvariant(value !== undefined, `${argument} requires a value`);
      argumentIndex += 1;
      if (argument === "--appimage") {
        appImagePath = value;
      } else if (argument === "--stage-dir") {
        stageDir = value;
      } else {
        packageRelease = Number(value);
        assertInvariant(
          Number.isSafeInteger(packageRelease) && packageRelease > 0,
          `invalid --pkgrel value '${value}'`,
        );
      }
    } else if (argument === "--keep-stage") {
      keepStage = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new LocalArchPackageError({ message: `unknown argument '${argument}'` });
    }
  }

  return { appImagePath, stageDir, packageRelease, keepStage, help };
}

function printUsage(): void {
  console.log(`usage:
  node scripts/local-arch-package.ts prepare [--appimage PATH] [--pkgrel N] [--stage-dir PATH]
  node scripts/local-arch-package.ts publish [--stage-dir PATH] [--keep-stage]
  node scripts/local-arch-package.ts clean [--stage-dir PATH]`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  const options = parseCliOptions(args);
  if (options.help) {
    printUsage();
    return;
  }

  const rootDir = NodePath.resolve(import.meta.dirname, "..");
  if (command === "prepare") {
    assertInvariant(!options.keepStage, "--keep-stage is only valid with publish");
    await prepareLocalArchPackage({
      rootDir,
      appImagePath: options.appImagePath,
      stageDir: options.stageDir,
      packageRelease: options.packageRelease,
    });
  } else if (command === "publish") {
    assertInvariant(
      options.appImagePath === undefined && options.packageRelease === undefined,
      "--appimage and --pkgrel are only valid with prepare",
    );
    await publishLocalArchPackage({
      rootDir,
      stageDir: options.stageDir,
      keepStage: options.keepStage,
    });
  } else if (command === "clean") {
    assertInvariant(
      options.appImagePath === undefined &&
        options.packageRelease === undefined &&
        !options.keepStage,
      "clean only accepts --stage-dir",
    );
    cleanLocalArchPackageStage(rootDir, options.stageDir);
  } else {
    throw new LocalArchPackageError({ message: `unknown command '${command}'` });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
