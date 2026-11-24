import { ReadyResponse } from "@soa/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader, RefreshCw, Shield, ShieldCheck } from "lucide-react";

async function fetchReady(): Promise<ReadyResponse> {
  const response = await fetch("/readyz");
  return ReadyResponse.parse(await response.json());
}

function ApiStatus() {
  const ready = useQuery({ queryKey: ["readyz"], queryFn: fetchReady });

  if (ready.isPending) {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-800 bg-amber-950/40 px-2.5 py-0.5 text-xs text-amber-300">
        <Loader size={12} className="animate-spin" />
        Checking the server…
      </span>
    );
  }
  if (ready.isError || ready.data.status !== "ok") {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-red-800 bg-red-950/40 px-2.5 py-0.5 text-xs text-red-300">
        <CircleAlert size={12} />
        Server not ready
        <button
          type="button"
          onClick={() => void ready.refetch()}
          className="ml-1 flex items-center gap-1 rounded px-1 text-red-200 hover:bg-red-900/60"
        >
          <RefreshCw size={11} />
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-emerald-800 bg-emerald-950/40 px-2.5 py-0.5 text-xs text-emerald-300">
      <ShieldCheck size={12} />
      Server ready
    </span>
  );
}

export function Shell() {
  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3">
          <Shield size={20} className="text-emerald-400" aria-hidden="true" />
          <h1 className="font-semibold">
            Security Of America <span className="hidden font-normal text-zinc-500 sm:inline">· Sales CRM</span>
          </h1>
          <span className="ml-auto">
            <ApiStatus />
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] p-4">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
          <p className="text-sm font-medium text-zinc-200">Nothing here yet</p>
          <p className="mt-1 text-sm text-zinc-500">Sign-in and the sales screens arrive in the next milestones.</p>
        </section>
      </main>
    </div>
  );
}
