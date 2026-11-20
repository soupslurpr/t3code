// @effect-diagnostics nodeBuiltinImport:off - Host resource bytes are copied into a private guest directory through QGA.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type { GuestIo, GuestCommand, MachinePaths } from "./MachinePorts.ts";

export async function checked(
  guest: GuestIo,
  vm: MachinePaths,
  command: GuestCommand,
  signal?: AbortSignal,
) {
  const result = await guest.exec(vm, command, signal);
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim().slice(-512) || `Guest process exited with status ${result.exitCode}.`,
    );
  return result.stdout;
}

export function makeGuestTools(guest: GuestIo, resource: (name: string) => Promise<string>) {
  const assets = new Map<string, Promise<{ name: string; data: Buffer }[]>>();
  const bundled = (names: readonly string[]) => {
    const key = names.join("\0");
    let result = assets.get(key);
    if (!result) {
      result = Promise.all(
        names.map(async (name) => ({
          name,
          data: await NodeFSP.readFile(await resource("guest/" + name)),
        })),
      );
      assets.set(key, result);
      void result.catch(() => assets.delete(key));
    }
    return result;
  };
  const install = async (vm: MachinePaths, names: readonly string[]) => {
    const files = await bundled(names);
    const hash = NodeCrypto.createHash("sha256");
    for (const { name, data } of files) hash.update(name + "\0").update(data);
    const directory = "/run/t3-agent-tools/" + hash.digest("hex");
    if (
      (await guest.exec(vm, { executable: "/usr/bin/test", args: ["-d", directory] })).exitCode ===
      0
    )
      return directory;
    const temporary = directory + "-" + NodeCrypto.randomUUID();
    await checked(guest, vm, {
      executable: "/usr/bin/install",
      args: ["-d", "-m", "0755", temporary],
    });
    try {
      for (const { name, data } of files) {
        const file = temporary + "/" + name;
        await guest.write(vm, file, 0, data);
        await checked(guest, vm, { executable: "/usr/bin/chmod", args: ["0444", file] });
      }
      const renamed = await guest.exec(vm, {
        executable: "/usr/bin/mv",
        args: ["-T", temporary, directory],
      });
      if (
        renamed.exitCode !== 0 &&
        (await guest.exec(vm, { executable: "/usr/bin/test", args: ["-d", directory] }))
          .exitCode !== 0
      )
        throw new Error("Could not publish guest integration files.");
    } finally {
      await checked(guest, vm, { executable: "/usr/bin/rm", args: ["-rf", "--", temporary] });
    }
    return directory;
  };
  const identity = async (vm: MachinePaths) => {
    const marker = await guest.exec(vm, {
      executable: "/usr/bin/cat",
      args: ["/etc/t3-agent-desktop-user"],
      maxOutputBytes: 256,
    });
    const account = marker.exitCode === 0 ? marker.stdout.trim() : "1000";
    if (!/^(?:[a-z_][a-z0-9_-]{0,31}|[1-9][0-9]{0,4})$/u.test(account))
      throw new Error("Invalid guest desktop user.");
    const record = (
      await checked(guest, vm, {
        executable: "/usr/bin/getent",
        args: ["passwd", account],
        maxOutputBytes: 4096,
      })
    )
      .trim()
      .split(":");
    const [username, , uid, gid, , home] = record;
    if (
      !username ||
      !/^[a-z_][a-z0-9_-]{0,31}$/u.test(username) ||
      !home?.startsWith("/") ||
      !uid ||
      !gid ||
      ![uid, gid].every((id) => /^\d+$/u.test(id) && Number(id) >= 1000 && Number(id) <= 60000)
    )
      throw new Error("The guest has no unprivileged graphical user.");
    return { username, home, uid, gid };
  };
  const session = async (vm: MachinePaths, command: GuestCommand, signal?: AbortSignal) => {
    const user = await identity(vm);
    return checked(
      guest,
      vm,
      {
        ...command,
        executable: "/usr/bin/runuser",
        args: [
          "-u",
          user.username,
          "--",
          "/usr/bin/env",
          "HOME=" + user.home,
          "USER=" + user.username,
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          "XDG_RUNTIME_DIR=/run/user/" + user.uid,
          "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + user.uid + "/bus",
          "WAYLAND_DISPLAY=wayland-0",
          "DISPLAY=:0",
          "XDG_SESSION_TYPE=wayland",
          command.executable,
          ...(command.args ?? []),
        ],
      },
      signal,
    );
  };
  return { install, identity, session };
}
export type GuestTools = ReturnType<typeof makeGuestTools>;
