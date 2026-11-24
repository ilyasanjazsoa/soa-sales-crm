import { NavLink, Outlet } from "react-router";
import { useMe } from "../session";

const SECTIONS = [
  { to: "users", label: "Users", admin: true },
  { to: "pricing", label: "Pricing" },
  { to: "references", label: "Client references" },
  { to: "suppressions", label: "Suppression list" },
  { to: "audit", label: "Audit log", admin: true },
  { to: "export", label: "Export" },
];

export function AdminPage() {
  const me = useMe();
  const isAdmin = me.data?.user.role === "admin";
  return (
    <div className="space-y-4">
      <nav aria-label="Admin" className="flex gap-1 overflow-x-auto border-b border-zinc-800">
        {SECTIONS.filter((section) => section.admin !== true || isAdmin).map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            className={({ isActive }) =>
              `whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                isActive ? "border-emerald-500 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
