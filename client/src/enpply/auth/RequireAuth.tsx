import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import LoadingScreen from "../../marketing/components/LoadingScreen";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (needsSetup) return <Navigate to="/setup" replace state={{ from: location }} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (needsSetup) return <Navigate to="/setup" replace state={{ from: location }} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (user.role !== "admin") return <Navigate to="/apply" replace />;
  return <>{children}</>;
}
