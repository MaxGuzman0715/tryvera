import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import AuthShell from "../components/AuthShell";

type LocationState = { from?: { pathname?: string } };

export default function Login() {
  const { user, needsSetup, login, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const redirectTo = (location.state as LocationState | null)?.from?.pathname ?? "/apply";

  useEffect(() => {
    if (loading) return;
    if (needsSetup) navigate("/setup", { replace: true });
    else if (user) navigate(redirectTo, { replace: true });
  }, [loading, needsSetup, user, navigate, redirectTo]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to your Tryvera workspace."
      footer={
        <>
          New here? <Link to="/">See what Tryvera does</Link>
        </>
      }
    >
      <form className="tb-auth-form" onSubmit={onSubmit}>
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          required
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          required
        />
        {error && (
          <p className="tb-auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="tb-auth-submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
