// ActivityFeed.jsx — admin view of the audit trail.
// Streams rows from /api/activity and renders each action as a human sentence
// ("drew a polygon", "approved image") with a relative timestamp.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LayoutDashboard, Users } from "lucide-react";
import { listActivity, listProjects } from "../../lib/api/client";

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

function describe(row) {
  const d = row.details || {};
  switch (row.action) {
    case "login": return "signed in";
    case "logout": return "signed out";
    case "annotation.create": return `drew a ${d.type || "shape"}`;
    case "annotation.update": return "edited an annotation";
    case "annotation.delete": return "deleted an annotation";
    case "image.upload": return `uploaded ${d.count ?? ""} image(s)`;
    case "image.status_change": return `set image → ${d.to || "?"}`;
    case "review.approve": return "approved an image";
    case "review.reject": return "rejected an image";
    case "project.create": return `created project "${d.name || ""}"`;
    case "project.member_add": return `added ${d.username || "a user"} to a project`;
    case "project.member_remove": return `removed ${d.username || "a user"} from a project`;
    case "user.create": return `created user ${d.created_user || d.username || ""}`;
    case "version.create": return "created a dataset version";
    default: return row.action;
  }
}

export default function ActivityFeed() {
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    const params = { limit: 200 };
    if (projectId) params.project_id = projectId;
    if (action) params.action = action;
    listActivity(params).then(setRows).catch((e) => setError(e.message));
  }, [projectId, action]);

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>Activity log</h1>
          <p className="muted">Every change, who made it, and when.</p>
        </div>
        <div className="admin-nav">
          <Link to="/admin" className="btn-text"><LayoutDashboard className="nav-ico" size={15} /> Dashboard</Link>
          <Link to="/admin/users" className="btn-text"><Users className="nav-ico" size={15} /> Users</Link>
        </div>
      </div>

      <div className="filter-row">
        <label className="field inline">
          <span>Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            <option value="annotation">Annotations</option>
            <option value="review">Reviews</option>
            <option value="image">Images</option>
            <option value="user">Users</option>
            <option value="project">Projects</option>
            <option value="login">Logins</option>
          </select>
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      <ul className="activity-list">
        {rows.map((r) => (
          <li key={r.id} className="activity-item">
            <span className="activity-user">{r.username || "—"}</span>
            <span className="activity-desc">{describe(r)}</span>
            <span className="activity-time">{timeAgo(r.created_at)}</span>
          </li>
        ))}
        {rows.length === 0 && <li className="muted">No activity yet.</li>}
      </ul>
    </div>
  );
}
