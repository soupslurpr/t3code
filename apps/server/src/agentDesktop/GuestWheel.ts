import { checked, type GuestTools } from "./GuestTools.ts";
import type { GuestIo, MachinePaths } from "./MachinePorts.ts";

// QEMU's USB tablet accepts only the vertical wheel. Linux uinput supplies both axes in one event frame.
export async function guestWheel(
  guest: GuestIo,
  vm: MachinePaths,
  tools: GuestTools,
  horizontal: number,
  vertical: number,
  signal: AbortSignal,
) {
  const directory = await tools.install(vm, ["wheel.py"]);
  const generation = directory.split("/").at(-1)!.slice(0, 16);
  const unit = "t3-agent-wheel-" + generation;
  const socket = "/run/" + unit + "/input.sock";
  const helper = directory + "/wheel.py";
  if (
    (await guest.exec(vm, { executable: "/usr/bin/test", args: ["-S", socket] }, signal))
      .exitCode !== 0
  ) {
    await checked(guest, vm, { executable: "/usr/bin/modprobe", args: ["uinput"] }, signal);
    const start = await guest.exec(
      vm,
      {
        executable: "/usr/bin/systemd-run",
        args: [
          "--quiet",
          "--collect",
          "--unit=" + unit,
          "--property=Type=exec",
          "--property=RuntimeDirectory=" + unit,
          "--property=RuntimeDirectoryMode=0700",
          "/usr/bin/python",
          "-B",
          helper,
          "serve",
        ],
      },
      signal,
    );
    if (start.exitCode !== 0)
      await checked(
        guest,
        vm,
        { executable: "/usr/bin/systemctl", args: ["is-active", "--quiet", unit] },
        signal,
      );
  }
  await checked(
    guest,
    vm,
    {
      executable: "/usr/bin/python",
      args: ["-B", helper, "wheel", String(horizontal), String(vertical)],
      timeoutMs: 10_000,
    },
    signal,
  );
}
