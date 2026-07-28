// AdminDashboard.jsx — admin landing page.
// Aggregates project counts, per-status image totals, top contributors and the
// review queue into a single overview built from the dashboard endpoints.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  FolderOpen,
  Images,
  CheckCircle2,
  Shapes,
  ThumbsUp,
  CalendarClock,
} from "lucide-react";
import {
  listProjects,
  dashOverview,
  dashContributors,
  dashReviewQueue,
} from "../../lib/api/client";

const STATUS_LABELS = {
  unannotated: "Unannotated",
  in_progress: "In progress",
  annotated: "Annotated",
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
};

function initials(c) {
  const src = (c.full_name || c.username || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function Stat({ icon: Icon, label, value, hint }) {
  return (
    <div className="stat-card">
      {Icon && <Icon className="stat-icon" size={20} strokeWidth={2} />}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint != null && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export default function AdminDashboard() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(""); // "" = all projects
  const [overview, setOverview] = useState(null);
  const [contributors, setContributors] = useState([]);
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const pid = projectId || undefined;
    Promise.all([
      dashOverview(pid),
      dashContributors(pid),
      dashReviewQueue(pid),
    ])
      .then(([ov, co, rq]) => {
        if (cancelled) return;
        setOverview(ov);
        setContributors(co.contributors || []);
        setQueue(rq.queue || []);
        setError("");
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>Admin dashboard</h1>
          <p className="muted">Progress and activity across your projects.</p>
        </div>
        <div className="admin-nav">
          <Link to="/" className="btn-text"><FolderOpen className="nav-ico" size={15} /> Projects</Link>
          <Link to="/admin/users" className="btn-text"><Users className="nav-ico" size={15} /> Users</Link>
          <Link to="/admin/activity" className="btn-text"><ScrollText className="nav-ico" size={15} /> Activity log</Link>
        </div>
      </div>

      <label className="field inline">
        <span>Project</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {overview && (
        <>
          <div className="stat-grid">
            <Stat icon={Images} label="Total images" value={overview.total_images} />
            <Stat
              icon={CheckCircle2}
              label="Completion"
              value={`${overview.completion_pct}%`}
              hint={`${overview.remaining} remaining`}
            />
            <Stat icon={Shapes} label="Annotations" value={overview.total_annotations} />
            <Stat icon={Users} label="Active users" value={overview.active_users} />
            <Stat
              icon={ThumbsUp}
              label="Approved / 7d"
              value={overview.approved_last_7_days}
              hint={`${overview.throughput_per_day}/day`}
            />
            <Stat
              icon={CalendarClock}
              label="Projected finish"
              value={
                overview.projected_days_remaining != null
                  ? `${overview.projected_days_remaining}d`
                  : "—"
              }
            />
          </div>

          <div className="progress-breakdown">
            {Object.entries(overview.by_status).map(([status, n]) => (
              <div key={status} className="progress-row">
                <span className="progress-name">
                  {STATUS_LABELS[status] || status}
                </span>
                <div className="progress-bar">
                  <div
                    className={`progress-fill status-${status}`}
                    style={{
                      width: overview.total_images
                        ? `${(n / overview.total_images) * 100}%`
                        : "0%",
                    }}
                  />
                </div>
                <span className="progress-count">{n}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <section className="admin-section">
        <h2>Contributors</h2>
        {contributors.length === 0 ? (
          <p className="muted">No contributor activity yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th><th>Role</th><th>Total</th>
                <th>Today</th><th>This week</th><th>Assigned</th><th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {contributors.map((c) => (
                <tr key={c.user_id}>
                  <td>
                    <div className="contrib-user">
                      <span className={`user-avatar role-${c.role}`}>{initials(c)}</span>
                      <span className="user-cell-name">{c.full_name || c.username}</span>
                    </div>
                  </td>
                  <td><span className={`role-chip role-${c.role}`}>{c.role}</span></td>
                  <td>{c.annotations_total}</td>
                  <td>{c.annotations_today}</td>
                  <td>{c.annotations_this_week}</td>
                  <td>{c.images_assigned}</td>
                  <td>{c.images_approved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="admin-section">
        <h2>Review queue <span className="muted">({queue.length})</span></h2>
        {queue.length === 0 ? (
          <p className="muted">Nothing waiting for review.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Image</th><th>Status</th><th>Assigned</th>
                <th>Annotations</th><th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => (
                <tr key={q.image_id}>
                  <td>{q.filename}</td>
                  <td><span className={`status-chip status-${q.status}`}>{q.status}</span></td>
                  <td>{q.assigned_to || "—"}</td>
                  <td>{q.annotation_count}</td>
                  <td>
                    <Link
                      to={`/projects/${q.project_id}/annotate/${q.image_id}`}
                      className="btn-text"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
