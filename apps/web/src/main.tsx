import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ApiError } from "./api";
import { Layout } from "./Layout";
import { AdminPage } from "./pages/Admin";
import { AccountPage } from "./pages/AccountPage";
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
      {
        index: true,
        element: (
          <ComingPage
            title="Today"
            milestone={7}
            what="Your next best actions, today's schedule and this week's numbers."
          />
        ),
      },
      { path: "prospects", element: <ProspectsPage /> },
      { path: "accounts/:id", element: <AccountPage /> },
      { path: "pipeline", element: <PipelinePage /> },
      {
        path: "calendar",
        element: (
          <ComingPage title="Calendar" milestone={5} what="A two-week view of CRM meetings and your busy time." />
        ),
      },
      {
        path: "ask",
        element: (
          <ComingPage
            title="Ask Sales AI"
            milestone={7}
            what="Ask questions about your pipeline, answered from CRM data."
          />
        ),
      },
      { path: "settings", element: <SettingsPage /> },
      {
        path: "admin",
        element: <AdminPage />,
        children: [
          { index: true, element: <AdminIndex /> },
          { path: "users", element: <AdminUsersPage /> },
          {
            path: "pricing",
            element: (
              <ComingPage title="Pricing" milestone={6} what="Rates, add-ons and term discounts, with versions." />
            ),
          },
          {
            path: "references",
            element: (
              <ComingPage
                title="Client references"
                milestone={3}
                what="Proof points for outreach, named only with the client's permission."
              />
            ),
          },
          {
            path: "suppressions",
            element: (
              <ComingPage
                title="Suppression list"
                milestone={4}
                what="Addresses the CRM will never email, company-wide."
              />
            ),
          },

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
