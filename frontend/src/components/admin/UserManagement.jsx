// UserManagement.jsx — admin CRUD for accounts.
// Create users, switch roles (user/admin), and activate/deactivate. Mirrors the
// admin-only endpoints in app/api/auth/users.py.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  FolderOpen,
  UserPlus,
  UserX,
  UserCheck,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import {
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
  deleteUserPermanently,
} from "../../lib/api/client";
import { getCurrentUser } from "../../lib/auth";

const ROLES = ["user", "admin"];

// Two-letter initials from the best available name, for the avatar circle.
function initials(u) {
  const src = (u.full_name || u.username || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function CreateUserForm({ onCreated }) {
  const [form, setForm] = useState({
    username: "",
    full_name: "",
    email: "",
    password: "",
    role: "user",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await createUser(form);
      setForm({ username: "", full_name: "", email: "", password: "", role: "user" });
      onCreated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-card">
      <div className="panel-card-head">
        <UserPlus size={16} />
        <span>Add a user</span>
      </div>
      <form onSubmit={submit} className="create-user-row">
        <input placeholder="Username" value={form.username} onChange={set("username")} required />
        <input placeholder="Full name" value={form.full_name} onChange={set("full_name")} />
        <input placeholder="Email" type="email" value={form.email} onChange={set("email")} />
        <input placeholder="Password" type="password" value={form.password} onChange={set("password")} />
        <select value={form.role} onChange={set("role")}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add user"}
        </button>
        {error && <div className="form-error full-row">{error}</div>}
      </form>
    </div>
  );
}

/** Confirmation for permanent deletion.
 *
 * Deliberately requires typing the username rather than just clicking "OK":
 * this row cannot be restored, and the difference between this and the
 * Deactivate button next to it is not visually obvious. Making the admin
 * reproduce the name forces them to look at WHICH account they picked.
 */
function DeleteUserDialog({ user, onCancel, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = typed === user.username;

  const go = async () => {
    if (!matches) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title danger">
          <AlertTriangle size={18} /> Delete @{user.username} permanently?
        </h2>
        <p className="modal-text">
          This removes the account for good — it cannot be undone. Deactivating
          instead keeps the account and lets you switch it back on later.
        </p>
        <ul className="modal-list">
          <li>Their projects are <strong>kept</strong>, but become unassigned.</li>
          <li>
            Their files move to{" "}
            <span className="sys-mono">storage/orphan_projects/</span> — nothing
            is erased.
          </li>
          <li>
            Annotations they drew in other people&apos;s projects stay, shown as
            an unknown author.
          </li>
        </ul>
        <label className="modal-label">
          Type <strong>{user.username}</strong> to confirm:
        </label>
        <input
          className="modal-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={user.username}
          autoFocus
        />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={go}
            disabled={!matches || busy}
            title={matches ? "" : "Type the username exactly to enable this"}
          >
            <Trash2 size={14} /> {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const me = getCurrentUser();

  const load = () =>
    listUsers().then(setUsers).catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const changeRole = async (u, role) => {
    setError("");
    try {
      await updateUser(u.id, { role });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleActive = async (u) => {
    setError("");
    try {
      if (u.is_active) await deactivateUser(u.id);
      else await updateUser(u.id, { is_active: true });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const doDelete = async (u) => {
    setError("");
    const res = await deleteUserPermanently(u.id);
    setConfirmDelete(null);
    setNotice(
      `Deleted @${u.username}.` +
        (res.orphaned_projects
          ? ` ${res.orphaned_projects} project(s) kept and unassigned; their files moved to orphan_projects/.`
          : " They had no projects."),
    );
    load();
  };

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>Users</h1>
          <p className="muted">Create accounts and manage roles.</p>
        </div>
        <div className="admin-nav">
          <Link to="/admin" className="btn-text"><LayoutDashboard className="nav-ico" size={15} /> Dashboard</Link>
          <Link to="/" className="btn-text"><FolderOpen className="nav-ico" size={15} /> Projects</Link>
        </div>
      </div>

      <CreateUserForm onCreated={load} />
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      <div className="table-card">
        <table className="data-table user-table">
          <thead>
            <tr>
              <th>User</th><th>Email</th><th>Role</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.is_active ? "" : "row-inactive"}>
                <td>
                  <div className="user-cell">
                    <span className={`user-avatar role-${u.role}`}>{initials(u)}</span>
                    <div className="user-cell-text">
                      <span className="user-cell-name">
                        {u.full_name || u.username}
                        {u.id === me?.id && <span className="muted"> (you)</span>}
                      </span>
                      <span className="user-cell-handle">@{u.username}</span>
                    </div>
                  </div>
                </td>
                <td>{u.email || <span className="muted">—</span>}</td>
                <td>
                  <select
                    className="role-select"
                    value={u.role}
                    onChange={(e) => changeRole(u, e.target.value)}
                    disabled={u.id === me?.id}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td>
                  <span className={`status-badge ${u.is_active ? "is-active" : "is-inactive"}`}>
                    {u.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="user-actions">
                  {u.id !== me?.id && (
                    <>
                      <button
                        className="icon-btn"
                        title={u.is_active ? "Deactivate" : "Reactivate"}
                        onClick={() => toggleActive(u)}
                      >
                        {u.is_active ? <UserX size={16} /> : <UserCheck size={16} />}
                      </button>
                      <button
                        className="icon-btn icon-btn-danger"
                        title="Delete permanently"
                        onClick={() => setConfirmDelete(u)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDelete && (
        <DeleteUserDialog
          user={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => doDelete(confirmDelete)}
        />
      )}
    </div>
  );
}
