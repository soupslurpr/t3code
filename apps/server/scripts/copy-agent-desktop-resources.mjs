/** Copies server-owned Agent desktop helpers beside the production bundle. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const serverDirectory = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../..");
const sourceDirectory = NodePath.join(serverDirectory, "resources", "agent-desktop");
const targetDirectory = NodePath.join(serverDirectory, "dist", "resources", "agent-desktop");

await NodeFSP.rm(targetDirectory, { recursive: true, force: true });
await NodeFSP.mkdir(NodePath.dirname(targetDirectory), { recursive: true });
await NodeFSP.cp(sourceDirectory, targetDirectory, { recursive: true });
