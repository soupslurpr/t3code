/** Selects transient access unless restoring or explicitly remembering approval. */
export function portalPersistMode(restoreToken, remember) {
  return restoreToken !== null || remember ? 2 : 0;
}
