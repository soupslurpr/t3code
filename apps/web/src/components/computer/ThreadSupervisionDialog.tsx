import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { lazy, Suspense } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const Panel = lazy(() => import("./ThreadSupervisionPanel"));

export type SupervisionTab = "monitors" | "agent" | "user" | "worktree";
const selected = Atom.make<{ target: ScopedThreadRef; tab: SupervisionTab } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-supervision:dialog"),
);

export function openThreadSupervision(target: ScopedThreadRef, tab: SupervisionTab = "monitors") {
  appAtomRegistry.set(selected, { target, tab });
}

export function ThreadSupervisionDialogHost() {
  const choice = useAtomValue(selected);
  if (!choice) return null;
  const { target, tab } = choice;
  return (
    <Suspense fallback={null}>
      <Panel
        key={JSON.stringify([target.environmentId, target.threadId])}
        target={target}
        tab={tab}
        selectTab={(next) => openThreadSupervision(target, next)}
        close={() => appAtomRegistry.set(selected, null)}
      />
    </Suspense>
  );
}
