import { CircleAlert, LogIn, Shield } from "lucide-react";
import { Navigate, useSearchParams } from "react-router";
import { useMe } from "../session";
import { Loading } from "../ui";

const ERRORS: Record<string, string> = {
  not_allowed:
    "That account can't sign in to the CRM. Ask your administrator to add you, and use your company Microsoft account.",
  expired: "The sign-in took too long or was interrupted. Try again.",
};

export function LoginPage() {
  const [params] = useSearchParams();
  const me = useMe();
  if (me.isPending) return <Loading label="Checking your session…" />;
  if (me.data) return <Navigate to="/" replace />;
  const error = params.get("error");

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center gap-2">
          <Shield size={22} className="text-emerald-400" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Security Of America · Sales CRM</h1>
            <p className="text-xs text-zinc-400">Private workspace for the sales team</p>
          </div>
        </div>
        {error !== null && (
          <p
            role="alert"
            className="flex gap-2 rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300"
          >
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {ERRORS[error] ?? "Sign-in failed. Try again."}
          </p>
        )}
        <a
          href="/api/auth/login"
          className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          <LogIn size={16} aria-hidden="true" />
          Sign in with Microsoft
        </a>
        <p className="text-xs text-zinc-400">
          Uses your company account and its two-step verification. The CRM never sees or stores your password.
        </p>
      </div>
    </div>
  );
}
