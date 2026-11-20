// @effect-diagnostics nodeBuiltinImport:off - QGA carries bounded binary process output to the host ledger.
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import type * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";
import {
  type DesktopJobExecutor,
  type DesktopJobAuthority,
  type DesktopJobProcess,
} from "@t3tools/shared/desktopJobs";
import type { DesktopLease, GuestIo, MachinePaths } from "./MachinePorts.ts";
import { checked, type GuestTools } from "./GuestTools.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reply = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(Schema.String),
      pid: Schema.optional(Schema.Int),
      exit: Schema.optional(Schema.Int),
      stdout: Schema.optional(Schema.String),
      stderr: Schema.optional(Schema.String),
    }),
  ),
);
const write = (sink: NodeStream.Writable, bytes: Buffer) =>
  new Promise<void>((resolve, reject) => sink.write(bytes, (e) => (e ? reject(e) : resolve())));

export function guestJobExecutor(
  guest: GuestIo,
  vm: MachinePaths,
  tools: GuestTools,
  user: string,
  hold: (authority: DesktopJobAuthority) => Promise<DesktopLease>,
): DesktopJobExecutor {
  return {
    checkDirectory: async (cwd) => {
      await tools.session(vm, { executable: "/usr/bin/test", args: ["-d", cwd] });
    },
    connect(_cwd, stdout, stderr, authority) {
      const id = NodeCrypto.randomUUID(),
        dir = "/run/t3-agent-job-" + id,
        unit = "t3-agent-job-" + id + ".service";
      const finished = Promise.withResolvers<Awaited<DesktopJobProcess["done"]>>();
      let helper = "";
      let lease: DesktopLease | undefined, stopping: string | undefined;
      let configuring = false,
        launched = false,
        started = false,
        settled = false;
      const finish = async (result: Awaited<DesktopJobProcess["done"]>) => {
        if (settled) return;
        settled = true;
        try {
          await lease?.release();
        } finally {
          stdout.end();
          stderr.end();
          finished.resolve(result);
        }
      };
      const call = async (payload: Readonly<Record<string, unknown>>) => {
        const raw = await checked(guest, vm, {
          executable: "/usr/bin/python",
          args: ["-B", helper, "request", dir],
          stdin: Buffer.from(encode(payload)),
          maxOutputBytes: 256 * 1024,
          timeoutMs: 15_000,
        });
        const response = reply(raw);
        if (response.error) throw new Error(response.error);
        return response;
      };
      const stopUnit = () =>
        checked(guest, vm, {
          executable: "/usr/bin/systemctl",
          args: ["stop", unit],
          timeoutMs: 20_000,
        });
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = () =>
        (shutdownPromise ??= (async () => {
          if (!launched) return;
          if (stopping === "SIGKILL") {
            await guest
              .exec(vm, {
                executable: "/usr/bin/systemctl",
                args: ["kill", "--kill-whom=all", "--signal=SIGKILL", unit],
              })
              .catch(() => {});
          }
          try {
            await stopUnit();
          } catch (cause) {
            const state = await checked(guest, vm, {
              executable: "/usr/bin/systemctl",
              args: ["show", "--property=ActiveState", "--value", unit],
            });
            if (!["inactive", "failed"].includes(state.trim())) throw cause;
          }
        })());
      let offsets = { stdout: 0, stderr: 0 };
      const poll = () => call({ op: "poll", ...offsets });
      const drain = async (page: Awaited<ReturnType<typeof poll>>) => {
        try {
          for (;;) {
            if (settled) return;
            let bytes = 0;
            for (const [name, sink] of [
              ["stdout", stdout],
              ["stderr", stderr],
            ] as const) {
              const data = Buffer.from(page[name] ?? "", "base64");
              if (data.length) {
                await write(sink, data);
                offsets[name] += data.length;
                bytes += data.length;
              }
            }
            if (page.exit !== undefined) {
              await call({ op: "close" }).catch(() => {});
              await finish({
                code: page.exit >= 0 ? page.exit : null,
                signal: page.exit < 0 ? (stopping ?? signalName(-page.exit)) : null,
              });
              return;
            }
            if (bytes === 0) await NodeTimersPromises.setTimeout(150);
            page = await poll();
          }
        } catch (error) {
          const stopped = await shutdown().then(
            () => true,
            () => false,
          );
          await finish({
            code: null,
            signal: stopped ? (stopping ?? null) : null,
            ...(stopped && stopping
              ? {}
              : {
                  error:
                    error instanceof Error
                      ? error.message
                      : "Guest process lost its control channel.",
                }),
            unconfirmed: !stopped,
          });
        }
      };
      return {
        connected: Promise.resolve(),
        done: finished.promise,
        async configure(config) {
          if (stopping) throw new Error("Guest command cancelled.");
          configuring = true;
          try {
            lease = await hold(authority);
            if (stopping) throw new Error("Guest command cancelled.");
            helper = (await tools.install(vm, ["job.py"])) + "/job.py";
            await checked(guest, vm, {
              executable: "/usr/bin/mkdir",
              args: ["-m", "0700", "--", dir],
            });
            await guest.write(vm, dir + "/launch", 0, Buffer.from(encode({ ...config, user })));
            if (stopping) throw new Error("Guest command cancelled.");
            launched = true;
            const launch = await guest
              .exec(vm, {
                executable: "/usr/bin/systemd-run",
                args: [
                  "--quiet",
                  "--collect",
                  "--unit=" + unit,
                  "--property=Type=exec",
                  "--property=KillMode=control-group",
                  "--property=TimeoutStopSec=2s",
                  "/usr/bin/python",
                  "-B",
                  helper,
                  "serve",
                  dir,
                ],
              })
              .catch(() => null);
            // A missing start reply may mean systemd already admitted the unit. Only query its existing socket.
            let page: Awaited<ReturnType<typeof poll>> | undefined;
            for (let i = 0; i < 48 && !page; i++) {
              if (stopping) throw new Error("Guest command cancelled.");
              try {
                page = await poll();
              } catch (error) {
                if (launch && launch.exitCode !== 0)
                  throw new Error(launch.stderr.slice(-512), { cause: error });
                if (i === 47) throw error;
                await NodeTimersPromises.setTimeout(50);
              }
            }
            if (!page?.pid) throw new Error("The guest command did not publish its process id.");
            started = true;
            void drain(page);
            return page.pid;
          } catch (error) {
            const stopped = await shutdown().then(
              () => true,
              () => false,
            );
            if (stopped && lease)
              await guest
                .exec(vm, { executable: "/usr/bin/rm", args: ["-rf", "--", dir] })
                .catch(() => {});
            await finish({
              code: null,
              signal: stopping ?? null,
              error: error instanceof Error ? error.message : "Guest command start failed.",
              unconfirmed: !stopped,
            });
            throw error;
          }
        },
        async write(data, close) {
          if (!data.length && !close) return;
          await call({
            op: "write",
            key: NodeCrypto.randomUUID(),
            bytes: data.toString("base64"),
            close,
          });
        },
        async resize(columns, rows) {
          await call({ op: "resize", key: NodeCrypto.randomUUID(), columns, rows });
        },
        async signal(name) {
          if (settled) return;
          if (!started) {
            stopping = name;
            if (!configuring) await finish({ code: null, signal: name });
            return;
          }
          if (name === "SIGKILL") {
            stopping = name;
            await shutdown();
            await finish({ code: null, signal: name });
          } else await call({ op: "signal", key: NodeCrypto.randomUUID(), signal: name });
        },
      };
    },
  };
}

function signalName(number: number) {
  return Object.entries(NodeOS.constants.signals).find(([, n]) => n === number)?.[0] ?? null;
}
