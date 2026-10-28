// @effect-diagnostics nodeBuiltinImport:off - ABI receipt tests isolate synthetic native functions in a child.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { expect, it } from "@effect/vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const windowsReceiptWorker = String.raw`
import fs from "node:fs/promises";
import path from "node:path";
const [moduleUrl, directory, scenario] = process.argv.slice(1);
Object.defineProperty(process, "platform", { value: "win32" });
const { renameNoReplace } = await import(moduleUrl);
const parentIdentity = await fs.stat(directory, { bigint: true });
const fake = { load: () => ({ func: (declaration) => {
  if (declaration.includes("GetLastError")) return () => 183;
  const fn = () => { throw new Error("filesystem operation must be async"); };
  fn.async = (...args) => {
    const callback = args.pop();
    if (declaration.includes("CreateFileW")) { callback(null, 1n); return; }
    if (declaration.includes("GetFileInformationByHandle")) {
      const identity = args[1];
      identity.writeUInt32LE(Number(parentIdentity.dev), 28);
      identity.writeUInt32LE(Number(parentIdentity.ino >> 32n), 44);
      identity.writeUInt32LE(Number(parentIdentity.ino & 0xffffffffn), 48);
    }
    if (declaration.includes("SetFileInformationByHandle")) {
      callback(null, scenario === "collision" ? 0 : scenario === "malformed" ? "2" : 2);
    } else callback(null, 2);
  };
  return fn;
}})};
try {
  await renameNoReplace({ source: path.join(directory,"source"), destination: path.join(directory,"destination"), parentIdentity, loadKoffi: async () => fake });
  process.stdout.write(JSON.stringify({ status: "fulfilled" }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "rejected", code: error.code, message: error.message }));
}
`;

it.each(["success", "collision", "malformed"] as const)(
  "interprets Windows BOOL receipts with stale last-error: %s",
  async (scenario) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rename-bool-"));
    try {
      const result = await execFile(process.execPath, [
        "--input-type=module",
        "-e",
        windowsReceiptWorker,
        new URL("./renameNoReplace.ts", import.meta.url).href,
        directory,
        scenario,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject(
        scenario === "success"
          ? { status: "fulfilled" }
          : { status: "rejected", code: scenario === "collision" ? "EEXIST" : "UNCONFIRMED" },
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
