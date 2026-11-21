import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { useState, type ReactNode } from "react";
import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { desktopError, type ActionClient } from "./desktopClient";

export function DesktopError({ message }: { message: string | null | undefined }) {
  return message ? (
    <p
      role="alert"
      className="text-sm wrap-anywhere whitespace-pre-line text-destructive select-text"
    >
      {message}
    </p>
  ) : null;
}

export function DesktopSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly (readonly [NoInfer<V>, string])[];
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <Select<V>
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{options.find(([id]) => id === value)?.[1]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function GuardedAction<R, Output>({
  client,
  request,
  children,
  onSuccess,
  disabled,
  confirm,
  destructive,
}: {
  client: ActionClient<R, Output>;
  request: NoInfer<R>;
  children: ReactNode;
  onSuccess?: (result: Output) => void;
  disabled?: boolean;
  confirm?: string;
  destructive?: boolean;
}) {
  const allowed = useAtomValue(client.permission(request));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();
  const requestKey = JSON.stringify(request);
  const currentKey = useStableCallback(() => requestKey);
  const run = async (button: HTMLButtonElement) => {
    const stillSelected = () => button.isConnected && currentKey() === requestKey;
    setBusy(true);
    setError(null);
    const execute = async () => {
      if (
        confirm &&
        !(await readLocalApi()?.dialogs.confirm(confirm, {
          variant: destructive ? "destructive" : "default",
        }))
      )
        return;
      if (!stillSelected()) return;
      const result = await client.invoke(request);
      if (stillSelected()) onSuccess?.(result);
    };
    await execute().catch((cause) => {
      if (stillSelected()) setError(desktopError(cause));
    });
    setBusy(false);
  };
  return (
    <>
      <Button
        type="button"
        variant={destructive ? "destructive-outline" : "outline"}
        size="xs"
        disabled={!allowed || disabled || busy}
        aria-busy={busy}
        title={allowed ? undefined : gt("Permission required")}
        onClick={(event) => void run(event.currentTarget)}
      >
        {children}
      </Button>
      <DesktopError message={error} />
    </>
  );
}

export function DesktopSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}
