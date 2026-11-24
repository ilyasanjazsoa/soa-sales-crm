import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ApiError } from "./api";
import { Layout } from "./Layout";
import { AdminPage } from "./pages/Admin";
import { AccountPage } from "./pages/AccountPage";
import { AskPage } from "./pages/Ask";
import { TodayPage } from "./pages/Today";
import { CalendarPage } from "./pages/CalendarPage";
import { AdminPricingPage } from "./pages/AdminPricing";
import { AdminReferencesPage } from "./pages/AdminReferences";
import { AdminSuppressionsPage } from "./pages/AdminSuppressions";
import { AdminUsersPage } from "./pages/AdminUsers";
import { ComingPage } from "./pages/Coming";
import { LoginPage } from "./pages/Login";
import { PipelinePage } from "./pages/Pipeline";
import { ProspectsPage } from "./pages/Prospects";
import { SettingsPage } from "./pages/Settings";
import { useMe } from "./session";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500 && error.status > 0) && failures < 2,
    },
  },
});

function AdminIndex() {
  const me = useMe();
  return <Navigate to={me.data?.user.role === "admin" ? "users" : "pricing"} replace />;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: "prospects", element: <ProspectsPage /> },
      { path: "accounts/:id", element: <AccountPage /> },
      { path: "pipeline", element: <PipelinePage /> },
      { path: "calendar", element: <CalendarPage /> },
      { path: "ask", element: <AskPage /> },
      { path: "settings", element: <SettingsPage /> },
      {
        path: "admin",
        element: <AdminPage />,
        children: [
          { index: true, element: <AdminIndex /> },
          { path: "users", element: <AdminUsersPage /> },
          { path: "pricing", element: <AdminPricingPage /> },
          { path: "references", element: <AdminReferencesPage /> },
          { path: "suppressions", element: <AdminSuppressionsPage /> },

          {
            path: "audit",
            element: (
              <ComingPage title="Audit log" milestone={8} what="Every sign-in, send, stage change and admin change." />
            ),
          },
          {
            path: "export",
            element: <ComingPage title="Export" milestone={8} what="Download accounts and deals as CSV." />,
          },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
