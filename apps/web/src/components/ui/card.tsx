import type { ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

/** Renders a bordered content card. */
export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="card"
      {...props}
    />
  );
}

/** Renders a card header with optional title, description, and action regions. */
export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 p-6 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-4 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      data-slot="card-header"
      {...props}
    />
  );
}

/** Renders a card title. */
export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("text-lg leading-none font-semibold", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

/** Renders supporting text beneath a card title. */
export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("text-sm text-muted-foreground", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

/** Renders an action aligned with a card header. */
export function CardAction({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "col-start-2 row-span-2 row-start-1 inline-flex self-start justify-self-end",
        className,
      )}
      data-slot="card-action"
      {...props}
    />
  );
}

/** Renders a card's main content region. */
export function CardPanel({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex-1 p-6 in-[[data-slot=card]:has(>[data-slot=card-header]:not(.border-b))]:pt-0",
        className,
      )}
      data-slot="card-panel"
      {...props}
    />
  );
}
