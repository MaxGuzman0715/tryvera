import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuthUser, UserRole } from "../types";
import { useAuth } from "../auth/AuthContext";
import { IconUsers } from "../../ui/icons";

type ProfileRow = { id: string };

type EditDraft = {
  email: string;
  role: UserRole;
  password: string;
  profile_ids: string[];
};

function emptyDraft(): EditDraft {
  return { email: "", role: "user", password: "", profile_ids: [] };
}

function draftFromUser(u: AuthUser): EditDraft {
  return { email: u.email, role: u.role, password: "", profile_ids: u.profile_ids ?? [] };
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<EditDraft>(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>(emptyDraft());
  const [busy, setBusy] = useState(false);

  async function reload() {
    setError(null);
    try {
      const [u, p] = await Promise.all([api.listUsers(), api.listProfiles()]);
      setUsers(u.users);
      setProfiles(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function toggleDraftProfile(draft: EditDraft, id: string): EditDraft {
    const has = draft.profile_ids.includes(id);
    return {
      ...draft,
      profile_ids: has ? draft.profile_ids.filter((x) => x !== id) : [...draft.profile_ids, id],
    };
  }

  async function handleCreate() {
    if (!creating.email.trim() || !creating.password || creating.password.length < 6) {
      setError("Email and a password of at least 6 characters are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createUser({
        email: creating.email.trim(),
        password: creating.password,
        role: creating.role,
        profile_ids: creating.profile_ids,
      });
      setCreating(emptyDraft());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(editingId, {
        email: editDraft.email.trim() || undefined,
        role: editDraft.role,
        profile_ids: editDraft.profile_ids,
        ...(editDraft.password ? { password: editDraft.password } : {}),
      });
      setEditingId(null);
      setEditDraft(emptyDraft());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(u: AuthUser) {
    if (u.id === currentUser?.id) return;
    if (!window.confirm(`Delete user ${u.email}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteUser(u.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1><IconUsers />Users</h1>
      <p className="sub">Admins manage all users and assign profiles they can access.</p>
      {error && <p className="error">{error}</p>}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>Create user</h3>
        <div style={{ display: "grid", gap: "0.5rem", maxWidth: "30rem" }}>
          <label>Email</label>
          <input
            type="email"
            value={creating.email}
            onChange={(e) => setCreating({ ...creating, email: e.target.value })}
          />
          <label>Password (min 6 chars)</label>
          <input
            type="password"
            value={creating.password}
            onChange={(e) => setCreating({ ...creating, password: e.target.value })}
          />
          <label>Role</label>
          <select
            value={creating.role}
            onChange={(e) => setCreating({ ...creating, role: e.target.value as UserRole })}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <label>Assigned profiles</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {profiles.map((p) => (
              <label key={p.id} className="mono" style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={creating.profile_ids.includes(p.id)}
                  onChange={() => setCreating(toggleDraftProfile(creating, p.id))}
                />
                {p.id}
              </label>
            ))}
            {profiles.length === 0 && <span className="sub">No profiles yet.</span>}
          </div>
        </div>
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button type="button" className="btn primary" disabled={busy} onClick={handleCreate}>
            Create
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Existing users</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Email</th>
              <th align="left">Role</th>
              <th align="left">Profiles</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isEditing = editingId === u.id;
              return (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border, #444)" }}>
                  <td>
                    {isEditing ? (
                      <input
                        type="email"
                        value={editDraft.email}
                        onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                      />
                    ) : (
                      <span className="mono">{u.email}</span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <select
                        value={editDraft.role}
                        onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as UserRole })}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    ) : (
                      <span className={`badge ${u.role}`}>{u.role}</span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                        {profiles.map((p) => (
                          <label
                            key={p.id}
                            className="mono"
                            style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}
                          >
                            <input
                              type="checkbox"
                              checked={editDraft.profile_ids.includes(p.id)}
                              onChange={() => setEditDraft(toggleDraftProfile(editDraft, p.id))}
                            />
                            {p.id}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <span className="mono" style={{ fontSize: "0.78rem" }}>
                        {(u.profile_ids ?? []).join(", ") || "—"}
                      </span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <>
                        <input
                          type="password"
                          placeholder="New password (optional)"
                          value={editDraft.password}
                          onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })}
                          style={{ marginBottom: "0.25rem" }}
                        />
                        <div className="actions">
                          <button type="button" className="btn small primary" disabled={busy} onClick={handleSaveEdit}>
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => {
                              setEditingId(null);
                              setEditDraft(emptyDraft());
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="actions">
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => {
                            setEditingId(u.id);
                            setEditDraft(draftFromUser(u));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn small danger"
                          disabled={busy || u.id === currentUser?.id}
                          onClick={() => void handleDelete(u)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
