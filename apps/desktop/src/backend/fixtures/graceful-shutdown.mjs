/** Records whether a backend can finish child work before its process group stops. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

process.stdin.resume();
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    "-e",
    `
  process.on("SIGTERM", () => process.exit(23));
  process.stdin.on("data", () => process.exit(0));
  process.stdout.write("ready");
`,
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);

child.stdin.on("error", () => {});
child.once("exit", (code) => {
  NodeFS.writeFileSync(process.argv[2], String(code));
  process.exit(0);
});
process.on("SIGTERM", () => child.stdin.end("finish"));
child.stdout.once("data", () => process.stdout.write("ready"));
