import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Columns,
  LogOut,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { z } from "zod";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { api } from "./api";
import { ME_KEY, useMe } from "./session";
import { Btn, ErrorState, Loading } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  managers?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Today", icon: Sun },
  { to: "/prospects", label: "Prospects", icon: Search },
  { to: "/pipeline", label: "Pipeline", icon: Columns },
  { to: "/calendar", label: "Calendar", icon: Calendar },
  { to: "/ask", label: "Ask Sales AI", icon: Sparkles },
  { to: "/admin", label: "Admin", icon: ShieldCheck, managers: true },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const me = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => api("/api/auth/logout", z.undefined(), { method: "POST" }),
    onSettled: async () => {
      queryClient.setQueryData(ME_KEY, null);
      await queryClient.invalidateQueries();
    },
  });

  if (me.isPending) return <Loading label="Loading your workspace…" />;
  if (me.isError) {
    return (
      <div className="p-4">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (me.data === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  const { user } = me.data;
  const items = NAV.filter((item) => item.managers !== true || user.role !== "ae");

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3">
          <Shield size={20} className="text-emerald-400" aria-hidden="true" />
          <span className="font-semibold">
            Security Of America <span className="hidden font-normal text-zinc-500 sm:inline">· Sales CRM</span>
          </span>
          <span className="ml-auto hidden text-sm text-zinc-400 sm:block">
            {user.name}, {user.title}
          </span>
          <Btn
            small
            kind="ghost"
            icon={LogOut}
            busy={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
            className="ml-auto sm:ml-0"
          >
            Sign out
          </Btn>
        </div>
        <nav aria-label="Main" className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-3 pb-2">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${
                  isActive ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`
              }
            >
              <Icon size={14} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      {me.data.mail.needsReconnect && (
        <div role="alert" className="border-b border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
          Your mailbox connection needs to be renewed.{" "}
          <a className="underline" href="/api/auth/login">
            Reconnect
          </a>
        </div>
      )}
      <main className="mx-auto max-w-[1400px] p-4">
        <Outlet />
      </main>
    </div>
  );
}
