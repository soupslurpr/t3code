/** Tracks input commands invalidated by the latest release boundary. */
export class InputCancellationEpoch {
  #generation = 0;

  /** Captures the cancellation generation assigned to one input command. */
  capture() {
    return this.#generation;
  }

  /** Invalidates every input command captured before this release boundary. */
  cancel() {
    this.#generation += 1;
  }

  /** Tests whether a captured input command has crossed a release boundary. */
  isCancelled(generation) {
    return generation !== this.#generation;
  }
}
