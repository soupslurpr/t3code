/** Manages one session-scoped lease on GNOME toolkit accessibility. */
export class AccessibilityStatusLease {
  #lease = null;
  #operation = Promise.resolve();
  #read;
  #report;
  #write;

  constructor({ read, report, write }) {
    this.#read = read;
    this.#report = report;
    this.#write = write;
  }

  get enabledByLease() {
    return this.#lease?.changed === true;
  }

  /** Enables toolkit accessibility until the lease is restored. */
  acquire() {
    return this.#enqueue(async () => {
      if (this.#lease !== null) return;
      try {
        const initiallyEnabled = await this.#read("IsEnabled");
        this.#lease = { changed: false };
        if (initiallyEnabled) return;
        await this.#write("IsEnabled", true);
        this.#lease = { changed: true };
      } catch (error) {
        this.#lease = { changed: false };
        this.#report("enable", error);
      }
    });
  }

  /** Restores toolkit accessibility when this lease enabled it. */
  restore() {
    return this.#enqueue(async () => {
      const lease = this.#lease;
      this.#lease = null;
      if (lease?.changed !== true) return;
      try {
        const screenReaderEnabled = await this.#read("ScreenReaderEnabled");
        const enabled = await this.#read("IsEnabled");
        if (enabled && !screenReaderEnabled) await this.#write("IsEnabled", false);
      } catch (error) {
        this.#report("restore", error);
      }
    });
  }

  /** Serializes lease transitions across concurrent snapshot and release commands. */
  #enqueue(operation) {
    const result = this.#operation.then(operation);
    this.#operation = result.catch(() => undefined);
    return result;
  }
}
