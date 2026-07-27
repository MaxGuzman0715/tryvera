import type { ReactNode } from "react";
import { useEffect } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./enpply/api";
import { applyAppUiTheme } from "./enpply/uiTheme";
import Profiles from "./enpply/pages/Profiles";
import Apply from "./enpply/pages/Apply";
import Result from "./enpply/pages/Result";
import Logs from "./enpply/pages/Logs";
import Config from "./enpply/pages/Config";
import Playground from "./enpply/pages/Playground";
import GlobalSpinner from "./enpply/components/GlobalSpinner";
import Analytics from "./enpply/pages/Analytics";
import GenerationToasts from "./enpply/components/GenerationToasts";
import Login from "./enpply/pages/Login";
import Setup from "./enpply/pages/Setup";
import Users from "./enpply/pages/Users";
import UserSettings from "./enpply/pages/UserSettings";
import EnpplifySettings from "./enpply/pages/EnpplifySettings";
import Landing from "./marketing/pages/Landing";
import NotFound from "./marketing/pages/NotFound";
import LoadingScreen from "./marketing/components/LoadingScreen";
import { AuthProvider, useAuth } from "./enpply/auth/AuthContext";
import { RequireAdmin, RequireAuth } from "./enpply/auth/RequireAuth";

/**
 * Routes the React Router knows about. Anything not matching one of these
 * patterns falls through to the TealBridge-themed NotFound page (rendered
 * outside the Enpply Layout). Update this list whenever a new top-level
 * route is added — the duplication is intentional and small.
 */
const KNOWN_ROUTE_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/login$/,
  /^\/setup$/,
  /^\/apply$/,
  /^\/result\/[^/]+$/,
  /^\/logs$/,
  /^\/config$/,
  /^\/playground$/,
  /^\/users$/,
  /^\/settings$/,
  /^\/enpplify$/,
  /^\/analytics$/,
];

function isKnownRoute(pathname: string): boolean {
  return KNOWN_ROUTE_PATTERNS.some((re) => re.test(pathname));
}

// Analytics is now always available to admins. The legacy
// VITE_ENABLE_ANALYTICS_TAB env var is no longer consulted.

function Layout({ children }: { children: ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="layout">
      <GlobalSpinner />
      <GenerationToasts />
      <header className="nav">
        <div className="nav-inner">
          <span className="brand">TealBridge</span>
          {user ? (
            <>
              <nav className="nav-links">
                {isAdmin && (
                  <NavLink end to="/" className={({ isActive }) => (isActive ? "active" : "")}>
                    Profiles
                  </NavLink>
                )}
                <NavLink to="/apply" className={({ isActive }) => (isActive ? "active" : "")}>
                  Job Apply
                </NavLink>
                <NavLink to="/logs" className={({ isActive }) => (isActive ? "active" : "")}>
                  Application Logs
                </NavLink>
                <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
                  Settings
                </NavLink>
                <NavLink to="/enpplify" className={({ isActive }) => (isActive ? "active" : "")}>
                  Enpplify
                </NavLink>
                {isAdmin && (
                  <NavLink to="/config" className={({ isActive }) => (isActive ? "active" : "")}>
                    Config
                  </NavLink>
                )}
                {isAdmin && (
                  <NavLink to="/playground" className={({ isActive }) => (isActive ? "active" : "")}>
                    Playground
                  </NavLink>
                )}
                {isAdmin && (
                  <NavLink to="/users" className={({ isActive }) => (isActive ? "active" : "")}>
                    Users
                  </NavLink>
                )}
                {isAdmin && (
                  <NavLink to="/analytics" className={({ isActive }) => (isActive ? "active" : "")}>
                    Analytics
                  </NavLink>
                )}
              </nav>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginLeft: "auto" }}>
                <span className="mono" style={{ fontSize: "0.78rem", opacity: 0.8 }}>
                  {user.email} ({user.role})
                </span>
                <button type="button" className="btn small" onClick={() => void handleLogout()}>
                  Sign out
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function AppShell() {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    // Per-user preference wins; fall back to the global AppSettings default.
    const personal = user.preferences?.ui_theme;
    if (personal === "light" || personal === "dark") {
      applyAppUiTheme(personal);
      return;
    }
    void api.getSettings().then((s) => {
      applyAppUiTheme(s.ui_theme === "light" ? "light" : "dark");
    });
  }, [user]);

  if (loading) {
    return <LoadingScreen />;
  }

  // TealBridge-themed public surfaces — landing + auth pages — render
  // OUTSIDE the Enpply Layout so the dark teal chrome owns the whole
  // viewport (no signed-in nav above the auth card). Auth pages stay
  // accessible after the first user exists; the Login/Setup components
  // themselves handle the redirect-when-signed-in case.
  if (!user && !needsSetup && location.pathname === "/") {
    return <Landing />;
  }
  if (location.pathname === "/login" || location.pathname === "/setup") {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    );
  }

  // Unknown route: render the TealBridge-themed NotFound page outside the
  // Enpply Layout so the marketing chrome owns the viewport. Applies to
  // both signed-in and anonymous visitors — NotFound itself picks
  // contextual CTAs based on auth state.
  if (!isKnownRoute(location.pathname)) {
    return <NotFound />;
  }

  return (
    <Layout>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAdmin>
              <Profiles />
            </RequireAdmin>
          }
        />
        <Route
          path="/apply"
          element={
            <RequireAuth>
              <Apply />
            </RequireAuth>
          }
        />
        <Route
          path="/result/:id"
          element={
            <RequireAuth>
              <Result />
            </RequireAuth>
          }
        />
        <Route
          path="/logs"
          element={
            <RequireAuth>
              <Logs />
            </RequireAuth>
          }
        />
        <Route
          path="/config"
          element={
            <RequireAdmin>
              <Config />
            </RequireAdmin>
          }
        />
        <Route
          path="/playground"
          element={
            <RequireAdmin>
              <Playground />
            </RequireAdmin>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAdmin>
              <Users />
            </RequireAdmin>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <UserSettings />
            </RequireAuth>
          }
        />
        <Route
          path="/enpplify"
          element={
            <RequireAuth>
              <EnpplifySettings />
            </RequireAuth>
          }
        />
        <Route
          path="/analytics"
          element={
            <RequireAdmin>
              <Analytics />
            </RequireAdmin>
          }
        />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
