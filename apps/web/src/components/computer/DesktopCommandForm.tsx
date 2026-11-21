import { Checkbox } from "../ui/checkbox";
import {
  DesktopExecutionAccess,
  UserDesktopExecutionResult,
  type UserDesktopHumanRequest,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { DesktopError, GuardedAction } from "./DesktopControls";
import { executionAccess } from "./DesktopPermissions";
import { type DesktopClient, useDesktopRead } from "./desktopClient";

const decodeExecutionResult = Schema.decodeUnknownSync(UserDesktopExecutionResult);

export function DesktopCommandForm({
  client,
  desktop,
  onStarted,
}: {
  client: DesktopClient<UserDesktopHumanRequest>;
  desktop: UserDesktopTarget;
  onStarted: (processId: string) => void;
}) {
  const gt = useGT();
  const access = useDesktopRead(
    client,
    executionAccess(desktop, { action: "status" }),
    DesktopExecutionAccess,
    6000,
  );
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [commandId, setCommandId] = useState(randomUUID);
  const granted = access.data?.desktop.desktopId === desktop.desktopId && access.data.granted;
  return (
    <div className="grid gap-2">
      <DesktopError message={access.error} />
      {access.data && (
        <p>
          {access.data.user} · {access.data.homeDirectory}
        </p>
      )}
      <label>
        {gt("Executable")}
        <Input
          value={program}
          onChange={(e) => {
            setProgram(e.target.value);
            setCommandId(randomUUID());
          }}
        />
      </label>
      <label>
        {gt("Arguments (one per line)")}
        <Textarea
          value={args}
          onChange={(e) => {
            setArgs(e.target.value);
            setCommandId(randomUUID());
          }}
        />
      </label>
      <label>
        {gt("Working directory")}
        <Input
          value={cwd}
          placeholder={access.data?.homeDirectory}
          onChange={(e) => {
            setCwd(e.target.value);
            setCommandId(randomUUID());
          }}
        />
      </label>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={terminal}
          onCheckedChange={(checked) => {
            setTerminal(checked);
            setCommandId(randomUUID());
          }}
        />{" "}
        {gt("Interactive terminal")}
      </label>
      <div>
        <GuardedAction
          client={client}
          disabled={!granted || !program.trim()}
          request={{
            operation: "execution",
            input: {
              operation: "command",
              desktop,
              commandId,
              executable: program.trim(),
              arguments: args === "" ? [] : args.split("\n"),
              ...(cwd.trim() ? { workingDirectory: cwd.trim() } : {}),
              terminal,
              keepStdinOpen: terminal,
              waitMs: 0,
            },
          }}
          onSuccess={(raw) => {
            const result = decodeExecutionResult(raw);
            if (result.desktop.desktopId !== desktop.desktopId) return;
            if (result.kind === "process" || result.kind === "permission-required") {
              setCommandId(randomUUID());
              onStarted(result.kind === "process" ? result.process.processId : result.processId);
            }
          }}
        >
          {gt("Run command")}
        </GuardedAction>
      </div>
    </div>
  );
}
