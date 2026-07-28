// ProjectMembersPanel.jsx — admin panel to assign a project's single user.
//
// Under the single-user-per-project model each project is worked by exactly one
// non-admin user (admins always have access). This modal shows the current
// assignee and lets an admin pick a different one, or clear it.
//
// Reassigning calls PUT /api/projects/{id}/assignee, which on the server moves
// the project's files to the new owner's folder (authorship of existing
// annotations is preserved). Changing the assignee also changes who can see the
// project.

import { useEffect, useState } from "react";
import { getAssignee, setAssignee, listUsers } from "../../lib/api/client";

export default function ProjectMembersPanel({ project, onClose }) {
  const [assignedId, setAssignedId] = useState(null);
  const [assignedName, setAssignedName] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    Promise.all([getAssignee(project.id), listUsers()])
      .then(([a, u]) => {
        setAssignedId(a.assigned_user_id);
        setAssignedName(a.assigned_username);
        setChoice(a.assigned_user_id ? String(a.assigned_user_id) : "");
        setAllUsers(u);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [project.id]);

  // Only active, plain (non-admin) users can be assigned — admins already see
  // every project.
  const candidates = allUsers.filter((u) => u.is_active && u.role !== "admin");

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const userId = choice ? Number(choice) : null;
      await setAssignee(project.id, userId);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = String(assignedId ?? "") !== String(choice ?? "");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="modal-title">Assigned user — {project.name}</h2>
        <p className="modal-note">
          One user works this project (admins always have access). Choose who it
          is below. Reassigning moves the project's files to the new user; work
          already done keeps its original author.
        </p>

        <p className="muted">
          Currently assigned to:{" "}
          <strong>{assignedName || "— nobody —"}</strong>
        </p>

        <label className="field-label" htmlFor="assignee-select">
          Assign to
        </label>
        <select
          id="assignee-select"
          className="role-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">— nobody (unassigned) —</option>
          {candidates.map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.full_name ? `${u.full_name} (${u.username})` : u.username}
            </option>
          ))}
        </select>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions" style={{ justifyContent: "space-between" }}>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}
