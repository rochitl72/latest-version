// SystemPanel.jsx — admin "System & Storage" page.
//
// Answers, without shelling into a container: where the database is, how big
// it is, what each user owns on disk, and whether the two still agree.
//
// Live: the overview and per-user storage poll every few seconds, so creating
// a user or saving an annotation shows up here on its own. Polling rather than
// a socket is deliberate — this project has no WebSocket, and a few-second
// delay on an ops panel is fine. The integrity scan is NOT polled: it stats
// every file on disk, so it runs only when you ask for it.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  systemOverview,
  systemStorage,
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
  FolderOpen,
  FileText,
} from "lucide-react";

const POLL_MS = 5000;

export default function SystemPanel() {
  const [overview, setOverview] = useState(null);
  const [storage, setStorage] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState(true);
  const [err, setErr] = useState(null);
  const [lastTick, setLastTick] = useState(null);
  const timer = useRef(null);

  const poll = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([systemOverview(), systemStorage()]);
      setOverview(o);
      setStorage(s);
      setLastTick(new Date());
      setErr(null);
    } catch (e) {
      setErr(e?.message || "Could not read system status.");
    }
  }, []);

  useEffect(() => {
    poll();
  }, [poll]);

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
    setErr(null);
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
            Where the data lives, and whether the database still agrees with the
            disk.
          </p>
        </div>
        <div className="admin-head-actions">
          <span className="sys-tick">
            {lastTick
              ? `updated ${lastTick.toLocaleTimeString()}`
              : "loading…"}
          </span>
          <button
            className="btn-secondary"
            onClick={() => setLive((v) => !v)}
            title={live ? "Pause auto-refresh" : "Resume auto-refresh"}
          >
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

      {/* ── Database ────────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <Database size={16} /> Database
        </h2>
        {!db ? (
          <p className="sidebar-muted">Loading…</p>
        ) : (
          <>
            <dl className="sys-facts">
              <div>
                <dt>Engine</dt>
                <dd>{db.engine}</dd>
              </div>
              <div>
                <dt>Size on disk</dt>
                <dd>{db.size_human}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd className="sys-mono">{db.url}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>
                  {env?.environment}
                  {env && !env.auth_enabled && (
                    <span className="sys-warn"> · AUTH DISABLED</span>
                  )}
                  {env?.seed_test_user && (
                    <span className="sys-warn"> · test user seeded</span>
                  )}
                </dd>
              </div>
            </dl>

            <table className="data-table sys-counts">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="num">Rows</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(db.table_counts).map(([t, n]) => (
                  <tr key={t}>
                    <td className="sys-mono">{t}</td>
                    <td className="num">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="panel-hint">
              The password is never shown. The database itself is not a file you
              can open — it is a running server, read through SQL or the CSV
              downloads below.
            </p>
          </>
        )}
      </section>

      {/* ── Storage ─────────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <HardDrive size={16} /> File storage
        </h2>
        {!st ? (
          <p className="sidebar-muted">Loading…</p>
        ) : (
          <>
            <dl className="sys-facts">
              <div>
                <dt>Root</dt>
                <dd className="sys-mono">{st.root}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>
                  {st.size_human} · {st.file_count} files
                </dd>
              </div>
              <div>
                <dt>Exports</dt>
                <dd className="sys-mono">{st.export_root}</dd>
              </div>
            </dl>

            <table className="data-table">
              <thead>
                <tr>
                  <th>User folder</th>
                  <th>Role</th>
                  <th className="num">Projects</th>
                  <th className="num">Files</th>
                  <th className="num">Size</th>
                  <th>Log</th>
                </tr>
              </thead>
              <tbody>
                {storage?.users?.map((u) => (
                  <tr key={u.user_id}>
                    <td>
                      <span className="sys-mono">{u.folder}</span>
                      {!u.exists && (
                        <span className="sys-warn"> · folder missing</span>
                      )}
                    </td>
                    <td>
                      <span className={`role-chip role-${u.role}`}>{u.role}</span>
                    </td>
                    <td className="num">{u.projects.length}</td>
                    <td className="num">{u.file_count}</td>
                    <td className="num">{u.size_human}</td>
                    <td>{u.has_activity_log ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {storage?.users?.some((u) => u.projects.length > 0) && (
              <details className="sys-details">
                <summary>
                  <FolderOpen size={13} /> Project folders
                </summary>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Project folder</th>
                      <th className="num">Images</th>
                      <th className="num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.users.flatMap((u) =>
                      u.projects.map((p) => (
                        <tr key={`${u.user_id}-${p.id}`}>
                          <td className="sys-mono">{u.username}</td>
                          <td className="sys-mono">
                            {p.folder}
                            {!p.exists && (
                              <span className="sys-warn"> · missing</span>
                            )}
                          </td>
                          <td className="num">{p.images}</td>
                          <td className="num">{p.size_human}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </details>
            )}
          </>
        )}
      </section>

      {/* ── Integrity ───────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <ShieldCheck size={16} /> Database vs disk
        </h2>
        <p className="panel-hint">
          Checks that every stored path still points at a real file, and finds
          files nothing references. Not run automatically — it stats every file,
          so it is a manual check.
        </p>
        <button
          className="btn-primary"
          onClick={runIntegrity}
          disabled={checking}
        >
          <ShieldCheck size={14} />
          {checking ? "Checking…" : "Run check"}
        </button>

        {integrity && (
          <div className="sys-integrity">
            {integrity.ok ? (
              <p className="sys-ok">
                ✅ All {integrity.checked_images} images match a real file, and
                nothing is orphaned.
              </p>
            ) : (
              <>
                {integrity.missing_files.length > 0 && (
                  <>
                    <h3 className="sys-bad">
                      <AlertTriangle size={14} />{" "}
                      {integrity.missing_files.length} image
                      {integrity.missing_files.length === 1 ? "" : "s"} with no
                      file on disk
                    </h3>
                    <p className="panel-hint">
                      These will fail to load in the annotator.
                    </p>
                    <ul className="sys-list">
                      {integrity.missing_files.map((m) => (
                        <li key={m.image_id} className="sys-mono">
                          #{m.image_id} {m.filename} → {m.path}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {integrity.missing_annotation_files.length > 0 && (
                  <>
                    <h3 className="sys-bad">
                      <AlertTriangle size={14} />{" "}
                      {integrity.missing_annotation_files.length} missing
                      annotation backup{" "}
                      {integrity.missing_annotation_files.length === 1
                        ? "file"
                        : "files"}
                    </h3>
                    <ul className="sys-list">
                      {integrity.missing_annotation_files.map((m) => (
                        <li key={m.image_id} className="sys-mono">
                          image #{m.image_id} → {m.path}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {integrity.orphan_count > 0 && (
                  <>
                    <h3 className="sys-bad">
                      <AlertTriangle size={14} /> {integrity.orphan_count}{" "}
                      orphaned file
                      {integrity.orphan_count === 1 ? "" : "s"} ·{" "}
                      {integrity.orphan_human}
                    </h3>
                    <p className="panel-hint">
                      On disk but referenced by no database row. Deleting an
                      image leaves its annotation JSON behind, and deleting a
                      project leaves its whole folder — so these accumulate.
                      {integrity.orphans_truncated && " (first 200 shown)"}
                    </p>
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
      </section>

      {/* ── Downloads ───────────────────────────────────────────── */}
      <section className="sys-card">
        <h2>
          <Download size={16} /> Download data
        </h2>
        <p className="panel-hint">
          Spreadsheet-friendly CSV straight from the database. Opens in Excel or
          Numbers.
        </p>
        <div className="sys-downloads">
          {[
            ["images", "Images + file paths", "every image, its project, owner and on-disk paths"],
            ["annotations", "Annotations", "every shape with its label, type and geometry"],
            ["users", "Users", "accounts, roles and last login"],
            ["activity", "Activity log", "the full audit trail"],
          ].map(([name, title, sub]) => (
            <a key={name} className="sys-dl" href={csvUrl(name)}>
              <FileText size={15} />
              <span>
                <strong>{title}</strong>
                <small>{sub}</small>
              </span>
              <Download size={14} className="sys-dl-icon" />
            </a>
          ))}
        </div>
        <p className="panel-hint">
          Password hashes are never included in any export. For a full,
          restorable backup of the database and image files, run{" "}
          <span className="sys-mono">scripts/backup.sh</span> on the server —
          that is an operator task, not a browser download.
        </p>
      </section>
    </div>
  );
}
