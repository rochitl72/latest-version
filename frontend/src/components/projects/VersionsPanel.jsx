// VersionsPanel.jsx — Roboflow-style dataset version snapshots for a project.
// List versions, create a new snapshot, and activate one as the working set.

import { useEffect, useState } from "react";
import { listVersions, createVersion, activateVersion } from "../../lib/api/client";
import { GitBranch, Plus } from "lucide-react";

export default function VersionsPanel({ projectId, onVersionChange }) {
  const [versions, setVersions] = useState([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState(null);

  const refresh = async () => setVersions(await listVersions(projectId));

  useEffect(() => {
    refresh();
  }, [projectId]);

  const onCreate = async () => {
    const vname = name.trim() || `v${versions.length + 1}`;
    setErr(null);
    try {
      await createVersion(projectId, vname);
      setName("");
      await refresh();
      onVersionChange();
    } catch (e) {
      setErr(
        e?.status === 403
          ? "Only an admin can create dataset versions."
          : e?.message || "Could not create the version.",
      );
    }
  };

  const onActivate = async (vid) => {
    setErr(null);
    try {
      await activateVersion(projectId, vid);
      onVersionChange();
    } catch (e) {
      setErr(
        e?.status === 403
          ? "Only an admin can switch the active version."
          : e?.message || "Could not activate that version.",
      );
    }
  };

  return (
    <section className="versions-panel">
      <h4>
        <GitBranch size={14} /> Dataset versions
      </h4>
      {err && (
        <p className="panel-error" role="alert">
          {err}
          <button type="button" className="link-btn" onClick={() => setErr(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="version-create">
        <input
          placeholder="New version name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCreate()}
        />

        <button onClick={onCreate} title="Create version snapshot">
          <Plus size={14} />
        </button>
      </div>
      <ul className="version-list">
        {versions.map((v) => (
          <li key={v.id}>
            <span className="v-name">
              {v.name}
              {v.is_frozen && <span className="frozen-tag">frozen</span>}
            </span>
            <button className="btn-text" onClick={() => onActivate(v.id)}>
              Switch
            </button>
          </li>
        ))}
        {versions.length === 0 && <li className="empty">No versions yet</li>}
      </ul>
    </section>
  );
}
