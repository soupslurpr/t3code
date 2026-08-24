/** Runs remembered authorization while guaranteeing live-session cleanup. */
export async function rememberAndRelease(start, release) {
  try {
    await start();
  } finally {
    await release();
  }
}
