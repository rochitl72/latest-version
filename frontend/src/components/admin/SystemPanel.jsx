// SystemPanel.jsx — admin "System & Storage" page.
//
// Two halves:
//   1. Overview  — totals across the whole install, polled live
//   2. Per user  — pick someone and see BOTH sides of what they own: the real
//                  folder tree on disk, and their rows in Postgres
//
// Everything polls on a timer rather than over a socket. This project has no
// WebSocket by design, and a few seconds' latency on an ops panel costs
// nothing. There is a pause toggle for when you want a stable view.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  systemOverview,
  systemStorage,
  systemUser,
  systemIntegrity,
  csvUrl,
} from "../../lib/api/client";
import {
  Database,
  HardDrive,
  Download,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Pause,
  Play,
  Folder,
  FileText,
  ChevronRight,
  ChevronDown,
  Users as UsersIcon,
} from "lucide-react";

const POLL_MS = 4000;

/** Recursive folder tree. Directories start expanded so the shape is obvious. */
function TreeNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 3);
  if (node.type === "file") {
    return (
      <div className="tree-row" style={{ paddingLeft: depth * 16 + 20 }}>
        <FileText size={12} className="tree-ico" />
        <span className="tree-name">{node.name}</span>
        <span className="tree-size">{node.size_human}</span>
      </div>
    );
  }
  const kids = node.children || [];
  return (
    <>
      <div
        className="tree-row tree-dir"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setOpen((v) => !v)}
      >
        {kids.length > 0 ? (
          open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span style={{ width: 12, display: "inline-block" }} />
        )}
        <Folder size={12} className="tree-ico" />
        <span className="tree-name">{node.name}/</span>
        {node.missing && <span className="sys-warn">missing</span>}
        {kids.length > 0 && <span className="tree-size">{kids.length}</span>}
      </div>
      {open &&
        kids.map((c, i) => (
          <TreeNode key={`${c.name}-${i}`} node={c} depth={depth + 1} />
        ))}
      {open && node.truncated && (
        <div className="tree-row" style={{ paddingLeft: (depth + 1) * 16 + 20 }}>
          <span className="tree-name sys-muted">… truncated</span>
        </div>
      )}
    </>
  );
}

export default function SystemPanel() {
  const [overview, setOverview] = useState(null);
  const [storage, setStorage] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState(true);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(null);
  const timer = useRef(null);
  const selRef = useRef(null);
  selRef.current = selectedId;

  const poll = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([systemOverview(), systemStorage()]);
      setOverview(o);
      setStorage(s);
      // Default to the first non-admin user so the page is useful immediately.
      if (selRef.current == null && s.users?.length) {
        const first = s.users.find((u) => u.role !== "admin") || s.users[0];
        setSelectedId(first.user_id);
      }
      if (selRef.current != null) {
        setDetail(await systemUser(selRef.current));
      }
      setTick(new Date());
      setErr(null);
    } catch (e) {
      setErr(e?.message || "Could not read system status.");
    }
  }, []);

  useEffect(() => {
    poll();
  }, [poll]);

  // Re-fetch immediately when you switch user, without waiting for the timer.
  useEffect(() => {
    if (selectedId == null) return;
    systemUser(selectedId).then(setDetail).catch(() => {});
  }, [selectedId]);

  useEffect(() => {
    if (!live) {
      clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timer.current);
  }, [live, poll]);

  const runIntegrity = async () => {
    setChecking(true);
    try {
      setIntegrity(await systemIntegrity());
    } catch (e) {
      setErr(e?.message || "Integrity check failed.");
    } finally {
      setChecking(false);
    }
  };

  const db = overview?.database;
  const st = overview?.storage;
  const env = overview?.environment;

  return (
    <div className="admin-page">
      <div className="admin-head">
        <div>
          <h1>System &amp; storage</h1>
          <p className="admin-sub">
            Live view of the database and what each user owns on disk.
          </p>
        </div>
        <div className="admin-head-actions">
          <span className="sys-tick">
            {tick ? `updated ${tick.toLocaleTimeString()}` : "loading…"}
          </span>
          <button className="btn-secondary" onClick={() => setLive((v) => !v)}>
            {live ? <Pause size={14} /> : <Play size={14} />}
            {live ? "Live" : "Paused"}
          </button>
          <button className="btn-secondary" onClick={poll}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {err && (
        <p className="inline-note inline-note-error" role="alert">
          {err}
        </p>
      )}

      {/* ── Overview tiles ──────────────────────────────────────── */}
      <div className="sys-tiles">
        <div className="sys-tile">
          <Database size={16} />
          <strong>{db?.size_human ?? "—"}</strong>
          <small>{db?.engine ?? "database"}</small>
        </div>
        <div className="sys-tile">
          <HardDrive size={16} />
          <strong>{st?.size_human ?? "—"}</strong>
          <small>{st?.file_count ?? 0} files on disk</small>
        </div>
        <div className="sys-tile">
          <UsersIcon size={16} />
          <strong>{db?.table_counts?.users ?? "—"}</strong>
          <small>accounts</small>
        </div>
        <div className="sys-tile">
          <Folder size={16} />
          <strong>{db?.table_counts?.images ?? "—"}</strong>
          <small>{db?.table_counts?.annotations ?? 0} annotations</small>
        </div>
      </div>

      <section className="sys-card">
        <h2>
          <Database size={16} /> Database
        </h2>
        <dl className="sys-facts">
          <div>
            <dt>Connection</dt>
            <dd className="sys-mono">{db?.url ?? "—"}</dd>
          </div>
          <div>
            <dt>Storage root</dt>
            <dd className="sys-mono">{st?.root ?? "—"}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>
              {env?.environment}
              {env && !env.auth_enabled && (
                <span className="sys-warn"> · AUTH DISABLED</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="sys-chips">
          {db &&
            Object.entries(db.table_counts).map(([t, n]) => (
              <span key={t} className="sys-chip">
                <span className="sys-mono">{t}</span>
                <b>{n}</b>
              </span>
            ))}
        </div>
      </section>

      {/* ── Per-user ────────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <UsersIcon size={16} /> Per user
        </h2>
        {/* Grouped by role — admin/ and users/ are separate branches on disk,
            so the tab bar mirrors that split rather than one flat list. */}
        {["admin", "user"].map((roleGroup) => {
          const group = storage?.users?.filter((u) => u.role === roleGroup) || [];
          if (group.length === 0) return null;
          return (
            <div key={roleGroup} className="sys-usergroup">
              <span className="sys-usergroup-label">
                {roleGroup === "admin" ? "Admins (admin/)" : "Users (users/)"}
              </span>
              <div className="sys-userbar">
                {group.map((u) => (
                  <button
                    key={u.user_id}
                    className={`sys-usertab ${
                      u.user_id === selectedId ? "active" : ""
                    }`}
                    onClick={() => setSelectedId(u.user_id)}
                  >
                    <span className="sys-mono">{u.folder}</span>
                    <small>
                      {u.size_human} · {u.file_count} files
                    </small>
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {detail && (
          <div className="sys-split">
            {/* Disk side */}
            <div className="sys-half">
              <h3>
                <HardDrive size={14} /> Files on disk
              </h3>
              <p className="sys-mono sys-muted">{detail.storage.path}</p>
              <div className="sys-tree">
                <TreeNode node={detail.storage.tree} />
              </div>
              {detail.activity_log_tail?.length > 0 && (
                <details className="sys-details">
                  <summary>activity.log (last 25 lines)</summary>
                  <pre className="sys-log">
                    {detail.activity_log_tail.join("\n")}
                  </pre>
                </details>
              )}
            </div>

            {/* Database side */}
            <div className="sys-half">
              <h3>
                <Database size={14} /> Rows in Postgres
              </h3>
              <dl className="sys-facts">
                <div>
                  <dt>Role / status</dt>
                  <dd>
                    {detail.user.role} · {detail.user.status}
                  </dd>
                </div>
                <div>
                  <dt>Annotations authored</dt>
                  <dd>{detail.database.annotations_authored}</dd>
                </div>
                <div>
                  <dt>Last login</dt>
                  <dd>
                    {detail.user.last_login_at
                      ? new Date(detail.user.last_login_at).toLocaleString()
                      : "never"}
                  </dd>
                </div>
              </dl>

              {detail.database.projects.length === 0 ? (
                <p className="sys-muted">No projects assigned.</p>
              ) : (
                detail.database.projects.map((p) => (
                  <div key={p.id} className="sys-proj">
                    <h4>
                      {p.name}{" "}
                      <span className="sys-muted sys-mono">
                        #{p.id} · {p.size_human}
                      </span>
                    </h4>
                    <table className="data-table sys-imgtable">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>File</th>
                          <th>Status</th>
                          <th className="num">Ann.</th>
                          <th>storage_path</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.images.map((im) => (
                          <tr key={im.id}>
                            <td>{im.id}</td>
                            <td title={im.filename}>
                              {im.filename.length > 22
                                ? im.filename.slice(0, 21) + "…"
                                : im.filename}
                            </td>
                            <td>{im.status}</td>
                            <td className="num">{im.annotations}</td>
                            <td className="sys-mono sys-path">
                              {im.file_exists ? "✅" : "❌"} {im.storage_path}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}

              {detail.database.recent_activity.length > 0 && (
                <details className="sys-details">
                  <summary>Recent actions (from activity_log)</summary>
                  <ul className="sys-list">
                    {detail.database.recent_activity.map((a) => (
                      <li key={a.id} className="sys-mono">
                        {a.at ? new Date(a.at).toLocaleString() : ""} · {a.action}
                        {a.image_id ? ` · image ${a.image_id}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Downloads ───────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <Download size={16} /> Download data
        </h2>
        <div className="sys-downloads">
          {[
            ["images", "Images + file paths"],
            ["annotations", "Annotations"],
            ["users", "Users"],
            ["activity", "Activity log"],
          ].map(([name, title]) => (
            <a key={name} className="sys-dl" href={csvUrl(name)}>
              <FileText size={15} />
              <span>
                <strong>{title}</strong>
                <small>CSV</small>
              </span>
              <Download size={14} className="sys-dl-icon" />
            </a>
          ))}
        </div>
        <p className="panel-hint">
          Password hashes are never included. For a full restorable backup run{" "}
          <span className="sys-mono">scripts/backup.sh</span> on the server.
        </p>
      </section>

      {/* ── Integrity (collapsed — occasional maintenance) ──────── */}
      <details className="sys-card sys-maint">
        <summary>
          <ShieldCheck size={15} /> Maintenance · database vs disk
        </summary>
        <p className="panel-hint">
          Finds images whose file has vanished, and files nothing references.
          Worth running occasionally — deleting an image leaves its annotation
          JSON behind, and deleting a project leaves its folder, so unreferenced
          files build up over time.
        </p>
        <button className="btn-secondary" onClick={runIntegrity} disabled={checking}>
          <ShieldCheck size={14} />
          {checking ? "Checking…" : "Run check"}
        </button>
        {integrity && (
          <div className="sys-integrity">
            {integrity.ok ? (
              <p className="sys-ok">
                ✅ {integrity.checked_images} images all present, nothing orphaned.
              </p>
            ) : (
              <>
                {integrity.missing_files.length > 0 && (
                  <>
                    <h3 className="sys-bad">
                      <AlertTriangle size={14} /> {integrity.missing_files.length}{" "}
                      image file(s) missing
                    </h3>
                    <ul className="sys-list">
                      {integrity.missing_files.map((m) => (
                        <li key={m.image_id} className="sys-mono">
                          #{m.image_id} {m.filename} → {m.path}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {integrity.orphan_count > 0 && (
                  <>
                    <h3 className="sys-bad">
                      <AlertTriangle size={14} /> {integrity.orphan_count} orphaned
                      file(s) · {integrity.orphan_human}
                    </h3>
                    <ul className="sys-list">
                      {integrity.orphan_files.map((o) => (
                        <li key={o.path} className="sys-mono">
                          {o.path} · {o.size_human}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
