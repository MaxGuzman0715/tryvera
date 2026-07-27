import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import AuthShell from "../components/AuthShell";

export default function Setup() {
  const { user, needsSetup, loading, setup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!needsSetup && user) navigate("/apply", { replace: true });
    else if (!needsSetup && !user) navigate("/login", { replace: true });
  }, [loading, needsSetup, user, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await setup(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="First-time setup"
      subtitle="No users exist yet. Create the first administrator account — you'll be signed in automatically and can add more users from the Users page afterwards."
    >
      <form className="tb-auth-form" onSubmit={onSubmit}>
        <label htmlFor="setup-email">Admin email</label>
        <input
          id="setup-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          required
        />
        <label htmlFor="setup-password">Password</label>
        <input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          required
        />
        <label htmlFor="setup-confirm">Confirm password</label>
        <input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={submitting}
          required
        />
        {error && (
          <p className="tb-auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="tb-auth-submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create admin account"}
        </button>
      </form>
    </AuthShell>
  );
}
