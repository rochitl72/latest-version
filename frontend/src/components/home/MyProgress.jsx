// MyProgress.jsx — a plain user's personal home / progress page.
// Input:   the signed-in user's stats (myStats) + the projects they belong to.
// Process: fetches per-project workflow stats to compute a % completion bar.
// Output:  stat cards (drawn / assigned / approved / sent-back) and a grid of
//          project cards that deep-link into the annotator ("/?open=<id>").

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Shapes,
  ClipboardList,
  ThumbsUp,
  XCircle,
  FolderOpen,
  ArrowRight,
} from "lucide-react";
import { myStats, listProjects, workflowStats } from "../../lib/api/client";
import { getCurrentUser } from "../../lib/auth";

// A personal home / progress page for a plain user: their own contribution
// numbers plus the projects they've been assigned to, each with a completion
// bar. Admins get the full team dashboard elsewhere; this is the individual
// view so a user can track their own work.

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="stat-card">
      {Icon && <Icon className="stat-icon" size={20} strokeWidth={2} />}
      <div className="stat-value">{value ?? 0}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function MyProgress() {
  const [stats, setStats] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const me = getCurrentUser();

  useEffect(() => {
    myStats().then(setStats).catch((e) => setError(e.message));
    listProjects()
      .then(async (ps) => {
        // Pull each project's status breakdown so we can show a completion bar.
        const withStats = await Promise.all(
          ps.map(async (p) => {
            try {
              const w = await workflowStats(p.id);
              return { ...p, w };
            } catch {
              return { ...p, w: null };
            }
          }),
        );
        setProjects(withStats);
      })
      .catch((e) => setError(e.message));
  }, []);

  const completion = (w) => {
    if (!w || !w.total) return 0;
    return Math.round(((w.by_status.approved || 0) / w.total) * 100);
  };

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>Welcome, {me?.full_name || me?.username}</h1>
          <p className="muted">Your annotation progress at a glance.</p>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="stat-grid">
        <Stat icon={Shapes} label="Annotations drawn" value={stats?.annotations_created} />
        <Stat icon={ClipboardList} label="Images assigned" value={stats?.images_assigned} />
        <Stat icon={ThumbsUp} label="Approved" value={stats?.images_approved} />
        <Stat icon={XCircle} label="Sent back" value={stats?.images_rejected} />
      </div>

      <section className="admin-section">
        <h2>Your projects</h2>
        {projects.length === 0 ? (
          <p className="muted">
            You haven't been added to any projects yet. An admin needs to assign
            you to one before you can start annotating.
          </p>
        ) : (
          <div className="proj-cards">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={`/?open=${p.id}`}
                className="proj-card"
              >
                <div className="proj-card-head">
                  <FolderOpen size={16} />
                  <span className="proj-card-name">{p.name}</span>
                  <ArrowRight size={15} className="proj-card-go" />
                </div>
                {p.w && (
                  <>
                    <div className="proj-bar">
                      <div
                        className="proj-bar-fill"
                        style={{ width: `${completion(p.w)}%` }}
                      />
                    </div>
                    <div className="proj-card-meta">
                      {completion(p.w)}% approved · {p.w.total} images
                    </div>
                  </>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
