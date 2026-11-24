import { CircleAlert, Loader, RefreshCw, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/* Shared pieces in the demo's style: dark zinc, emerald = good, amber = pending, blue = AI, red = error. */

export const inputClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 outline-none focus:border-blue-500";

export function Panel(props: {
  title?: string;
  icon?: LucideIcon;
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  const { title, icon: Icon, right, children, pad = true } = props;
  return (
    <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60">
      {title !== undefined && (
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
          {Icon !== undefined && <Icon size={16} className="text-zinc-400" aria-hidden="true" />}
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

const BUTTON_KINDS = {
  default: "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500",
  primary: "bg-emerald-700 text-white hover:bg-emerald-700",
  danger: "bg-red-600 text-white hover:bg-red-500",
  ghost: "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
  blue: "bg-blue-600 text-white hover:bg-blue-500",
} as const;

export function Btn(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    kind?: keyof typeof BUTTON_KINDS;
    icon?: LucideIcon;
    busy?: boolean;
    small?: boolean;
  },
) {
  const {
    kind = "default",
    icon: Icon,
    busy = false,
    small = false,
    className = "",
    children,
    disabled,
    ...rest
  } = props;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || busy}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
        small ? "px-2.5 py-1 text-xs" : "px-3 py-2 text-sm"
      } ${BUTTON_KINDS[kind]} ${className}`}
    >
      {busy ? (
        <Loader size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        Icon && <Icon size={14} aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

const PILL_TONES = {
  green: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  amber: "border-amber-800 bg-amber-950/40 text-amber-300",
  blue: "border-blue-800 bg-blue-950/40 text-blue-300",
  red: "border-red-800 bg-red-950/40 text-red-300",
  zinc: "border-zinc-700 bg-zinc-900 text-zinc-300",
} as const;

export function Pill({ tone = "zinc", children }: { tone?: keyof typeof PILL_TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-400">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-amber-300" role="status">
      <Loader size={14} className="animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300"
    >
      <CircleAlert size={16} aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry !== undefined && (
        <Btn small kind="ghost" icon={RefreshCw} onClick={onRetry}>
          Retry
        </Btn>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-zinc-400">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-xs text-zinc-400">{hint}</span>}
    </label>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { title, onClose, children, wide = false } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus moves into the dialog and returns to where it was on close; Tab stays inside; Escape closes it.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const first = focusable().find((element) => element.getAttribute("aria-label") !== "Close") ?? focusable()[0];
    if (dialog.current !== null && !dialog.current.contains(document.activeElement)) first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl`}
      >
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-800"
          >
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "text-zinc-100",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
      {sub !== undefined && <p className="mt-1 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}
