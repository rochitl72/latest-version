// AdminDashboard.jsx — admin landing page.
//
// Progress is measured in IMAGES, never in annotation count. The number of
// shapes on an image varies entirely with its content — one photo may need two
// boxes, the next forty — so a running annotation tally says nothing about how
// far through a dataset you are. Images marked done out of images total is a
// figure you can plan against, so that is what this page reports.
//
// Everything comes from one call (/dashboard/progress), filterable by project
// and by time window. Charts are hand-rolled SVG: no chart dependency, and the
// data volumes here are small enough that it costs nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  FolderOpen,
  Images,
  CheckCircle2,
  ThumbsUp,
  CalendarClock,
  TrendingUp,
  RefreshCw,
} from "lucide-react";
import {
  listProjects,
  dashProgress,
  dashReviewQueue,
} from "../../lib/api/client";

const STATUS_META = {
  unannotated: { label: "Unannotated", color: "#cbd5e1" },
  in_progress: { label: "In progress", color: "#f59e0b" },
  annotated: { label: "Annotated", color: "#15803d" },
  needs_review: { label: "Needs review", color: "#0ea5e9" },
  approved: { label: "Approved", color: "#10b981" },
  rejected: { label: "Rejected", color: "#ef4444" },
};

const RANGES = [
  { key: 1, label: "Today" },
  { key: 7, label: "7 days" },
  { key: 30, label: "30 days" },
  { key: 60, label: "2 months" },
];

function initials(c) {
  const src = (c.full_name || c.username || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function Stat({ icon: Icon, label, value, hint, accent }) {
  return (
    <div className="stat-card" style={accent ? { "--accent-bar": accent } : undefined}>
      {Icon && <Icon className="stat-icon" size={20} strokeWidth={2} />}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint != null && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/** Donut showing done / total. The single most important number on the page. */
function ProgressRing({ pct, done, total, size = 132 }) {
  const stroke = 13;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="ring-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={`${done} of ${total} images done, ${pct}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke="#e2e9e2" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="#15803d" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * filled} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="47%" textAnchor="middle" className="ring-pct">
          {pct}%
        </text>
        <text x="50%" y="64%" textAnchor="middle" className="ring-sub">
          {done}/{total}
        </text>
      </svg>
      <span className="ring-caption">Images done</span>
    </div>
  );
}

/** Stacked horizontal bar of the status split — the whole dataset at a glance. */
function StatusBar({ byStatus, total }) {
  if (!total) return <p className="muted">No images yet.</p>;
  const parts = Object.entries(STATUS_META)
    .map(([k, meta]) => ({ k, ...meta, n: byStatus?.[k] || 0 }))
    .filter((p) => p.n > 0);
  return (
    <div className="statusbar-block">
      <div className="statusbar" role="img" aria-label="Status breakdown">
        {parts.map((p) => (
          <div
            key={p.k}
            className="statusbar-seg"
            style={{ width: `${(p.n / total) * 100}%`, background: p.color }}
            title={`${p.label}: ${p.n} (${Math.round((p.n / total) * 100)}%)`}
          />
        ))}
      </div>
      <ul className="statusbar-legend">
        {Object.entries(STATUS_META).map(([k, meta]) => (
          <li key={k}>
            <span className="dot" style={{ background: meta.color }} />
            {meta.label}
            <b>{byStatus?.[k] || 0}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Grouped bars per day: images marked done, and images approved. */
function TrendChart({ series }) {
  const w = 760;
  const h = 200;
  const pad = { t: 12, r: 8, b: 26, l: 30 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const max = Math.max(1, ...series.map((d) => Math.max(d.marked_done, d.approved)));
  // Round the axis up to something readable rather than a raw max.
  const top = max <= 4 ? max : Math.ceil(max / 5) * 5;
  const n = series.length || 1;
  const slot = iw / n;
  const barW = Math.max(2, Math.min(14, slot * 0.34));

  const y = (v) => pad.t + ih - (v / top) * ih;
  const ticks = [0, top / 2, top].map((v) => Math.round(v));
  // With many days, only label a few so the axis stays legible.
  const labelEvery = Math.ceil(n / 8);

  const anyData = series.some((d) => d.marked_done || d.approved);

  return (
    <div className="chart-block">
      <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" role="img"
           aria-label="Images marked done and approved per day">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)}
                  stroke="#e2e9e2" strokeWidth="1" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">
              {t}
            </text>
          </g>
        ))}

        {series.map((d, i) => {
          const cx = pad.l + i * slot + slot / 2;
          const hDone = (d.marked_done / top) * ih;
          const hAppr = (d.approved / top) * ih;
          return (
            <g key={d.date}>
              <rect x={cx - barW - 1} y={y(d.marked_done)} width={barW}
                    height={Math.max(0, hDone)} rx="2" fill="#15803d">
                <title>{`${d.date} · ${d.marked_done} marked done`}</title>
              </rect>
              <rect x={cx + 1} y={y(d.approved)} width={barW}
                    height={Math.max(0, hAppr)} rx="2" fill="#10b981">
                <title>{`${d.date} · ${d.approved} approved`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={cx} y={h - 8} textAnchor="middle" className="chart-tick">
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={w - pad.r} y1={pad.t + ih} y2={pad.t + ih}
              stroke="#cbd5e1" strokeWidth="1" />
      </svg>

      <div className="chart-legend">
        <span><i style={{ background: "#15803d" }} /> Marked done</span>
        <span><i style={{ background: "#10b981" }} /> Approved</span>
      </div>
      {!anyData && (
        <p className="muted chart-empty">
          Nothing was marked done in this window. Mark an image done in the
          annotator, or widen the range.
        </p>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(""); // "" = all projects
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const pid = projectId || undefined;
      const [p, q] = await Promise.all([
        dashProgress(pid, days),
        dashReviewQueue(pid),
      ]);
      setData(p);
      setQueue(q.queue || []);
    } catch (e) {
      setError(e.message || "Could not load the dashboard.");
    } finally {
      setLoading(false);
    }
  }, [projectId, days]);

  useEffect(() => {
    load();
  }, [load]);

  const rangeLabel = useMemo(
    () => RANGES.find((r) => r.key === days)?.label ?? `${days} days`,
    [days],
  );

  if (loading && !data) {
    return (
      <div className="admin-page">
        <p className="muted">Loading dashboard…</p>
      </div>
    );
  }

  const d = data || {};
  const total = d.total_images || 0;

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>Admin dashboard</h1>
          <p className="admin-sub">
            Progress measured in images completed, not annotation count.
          </p>
        </div>
        <div className="admin-nav">
          <Link to="/" className="btn-text">
            <FolderOpen className="nav-ico" size={15} /> Projects
          </Link>
          <Link to="/admin/users" className="btn-text">
            <Users className="nav-ico" size={15} /> Users
          </Link>
          <Link to="/admin/activity" className="btn-text">
            <ScrollText className="nav-ico" size={15} /> Activity log
          </Link>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────── */}
      <div className="dash-filters">
        <label className="dash-filter">
          <span>Project</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <div className="dash-filter">
          <span>Timeline</span>
          <div className="seg-group" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={`seg${days === r.key ? " active" : ""}`}
                onClick={() => setDays(r.key)}
                aria-pressed={days === r.key}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <button className="btn-secondary dash-refresh" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {/* ── Headline ────────────────────────────────────────────── */}
      <section className="dash-hero">
        <ProgressRing
          pct={d.completion_pct ?? 0}
          done={d.done ?? 0}
          total={total}
        />
        <div className="dash-hero-stats">
          <Stat
            icon={Images}
            label="Total images"
            value={total}
            hint={`${d.remaining ?? 0} remaining`}
          />
          <Stat
            icon={CheckCircle2}
            label="Marked done"
            value={`${d.done ?? 0}/${total}`}
            hint={`${d.completion_pct ?? 0}% of the dataset`}
          />
          <Stat
            icon={ThumbsUp}
            label="Approved"
            value={d.approved ?? 0}
            hint={`${d.approved_pct ?? 0}% reviewed & approved`}
          />
          <Stat
            icon={TrendingUp}
            label={`Done · ${rangeLabel}`}
            value={d.done_in_range ?? 0}
            hint={`${d.throughput_per_day ?? 0}/day average`}
          />
          <Stat
            icon={CalendarClock}
            label="Projected finish"
            value={
              d.projected_days_remaining != null
                ? `${d.projected_days_remaining}d`
                : "—"
            }
            hint={
              d.projected_days_remaining != null
                ? "at the current rate"
                : "needs some completed work first"
            }
          />
        </div>
      </section>

      {/* ── Status split ────────────────────────────────────────── */}
      <section className="panel-card">
        <div className="panel-card-head">
          <LayoutDashboard size={16} />
          <span>Where every image stands</span>
        </div>
        <StatusBar byStatus={d.by_status} total={total} />
      </section>

      {/* ── Trend ───────────────────────────────────────────────── */}
      <section className="panel-card">
        <div className="panel-card-head">
          <TrendingUp size={16} />
          <span>Daily throughput · {rangeLabel}</span>
        </div>
        <TrendChart series={d.series || []} />
      </section>

      {/* ── Per project ─────────────────────────────────────────── */}
      <section className="panel-card">
        <div className="panel-card-head">
          <FolderOpen size={16} />
          <span>Progress by project</span>
        </div>
        {(d.projects || []).length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <table className="data-table dash-projtable">
            <thead>
              <tr>
                <th>Project</th>
                <th>Assigned to</th>
                <th className="num">Done</th>
                <th className="num">Total</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {d.projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    {p.assignee || <span className="muted">unassigned</span>}
                  </td>
                  <td className="num">{p.done}</td>
                  <td className="num">{p.total}</td>
                  <td>
                    <div className="minibar-row">
                      <div className="minibar">
                        <div
                          className="minibar-fill"
                          style={{ width: `${p.completion_pct}%` }}
                        />
                      </div>
                      <span className="minibar-pct">{p.completion_pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── People ──────────────────────────────────────────────── */}
      <section className="panel-card">
        <div className="panel-card-head">
          <Users size={16} />
          <span>Progress by person</span>
        </div>
        {(d.contributors || []).length === 0 ? (
          <p className="muted">Nobody has work assigned yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th className="num">Assigned</th>
                <th className="num">Done</th>
                <th className="num">Approved</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {d.contributors.map((c) => (
                <tr key={c.user_id}>
                  <td>
                    <div className="user-cell">
                      <span className={`user-avatar role-${c.role}`}>
                        {initials(c)}
                      </span>
                      <div className="user-cell-text">
                        <span className="user-cell-name">
                          {c.full_name || c.username}
                        </span>
                        <span className="user-cell-handle">@{c.username}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`role-badge role-${c.role}`}>{c.role}</span>
                  </td>
                  <td className="num">{c.images_assigned}</td>
                  <td className="num">{c.images_done}</td>
                  <td className="num">{c.images_approved}</td>
                  <td>
                    <div className="minibar-row">
                      <div className="minibar">
                        <div
                          className="minibar-fill"
                          style={{ width: `${c.completion_pct}%` }}
                        />
                      </div>
                      <span className="minibar-pct">{c.completion_pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Review queue ────────────────────────────────────────── */}
      <section className="panel-card">
        <div className="panel-card-head">
          <CheckCircle2 size={16} />
          <span>Waiting on review ({queue.length})</span>
        </div>
        {queue.length === 0 ? (
          <p className="muted">Nothing waiting on a reviewer.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Image</th>
                <th>Status</th>
                <th>Owner</th>
                <th className="num">Shapes</th>
              </tr>
            </thead>
            <tbody>
              {queue.slice(0, 15).map((q) => (
                <tr key={q.image_id}>
                  <td>
                    <Link to={`/projects/${q.project_id}/annotate/${q.image_id}`}>
                      {q.filename}
                    </Link>
                  </td>
                  <td>{STATUS_META[q.status]?.label || q.status}</td>
                  <td>
                    {q.assigned_to || <span className="muted">unassigned</span>}
                  </td>
                  <td className="num">{q.annotation_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
