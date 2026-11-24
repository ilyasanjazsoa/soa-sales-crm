import { Panel } from "../ui";

/** A screen whose features arrive in a later milestone. Says what is coming instead of showing fake data. */
export function ComingPage({ title, what, milestone }: { title: string; what: string; milestone: number }) {
  return (
    <Panel title={title}>
      <p className="text-sm text-zinc-300">{what}</p>
      <p className="mt-1 text-xs text-zinc-500">Arrives in milestone {milestone}.</p>
    </Panel>
  );
}
