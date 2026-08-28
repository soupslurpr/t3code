import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";

import { connectionAtomRuntime } from "../connection/runtime";

/** Exposes preview and desktop-supervision RPC commands to the mobile client. */
export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
