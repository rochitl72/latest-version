// ProjectList.jsx — the home screen: projects, image upload, exports.
// Create/delete projects, upload images, trigger COCO/YOLO/labeled-zip exports,
// auto-split datasets and open a project to annotate.

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  listProjects,
  createProject,
  deleteProject,
  listImages,
  uploadImages,
  exportYoloUrl,
  exportCocoUrl,
  exportLabeledZipUrl,
  imageFileUrl,
  bulkUpdateStatus,
  workflowStats,
  autoSplit,
  setImageSplit,
  exportToDownloads,
  ApiError,
} from "../../lib/api/client";
import VersionsPanel from "./VersionsPanel";
import ProjectMembersPanel from "../admin/ProjectMembersPanel";
import { isAdmin } from "../../lib/auth";
import {
  Plus,
  Trash2,
  FolderOpen,
  Upload,
  Download,
  CheckCircle,
  Users,
} from "lucide-react";

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [activeProject, setActive] = useState(null);
  const [images, setImages] = useState([]);
  const [stats, setStats] = useState({});
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [newName, setNewName] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [membersFor, setMembersFor] = useState(null);
  const admin = isAdmin();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setProjects([]);
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const refreshImages = async (p) => {
    const [imgs, st] = await Promise.all([
      listImages(p.id),
      workflowStats(p.id),
    ]);
    setImages(imgs);
    setStats(st.by_status || {});
  };

  const onCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await createProject({
        name: newName.trim(),
        task_type: "segmentation",
      });
      setNewName("");
      await refresh();
      setActive(created);
      await refreshImages(created);
    } catch (e) {
      alert(
        e instanceof ApiError
          ? e.message
          : `Could not create project: ${e.message}`,
      );
    } finally {
      setCreating(false);
    }
  };

  const onExportDownloads = async () => {
    if (!activeProject) return;
    setExporting(true);
    try {
      const res = await exportToDownloads(activeProject.id, true);
      alert(
        `Exported to Downloads:\n\n` +
          `Folder: ${res.folder}\n` +
          `Zip: ${res.zip}\n\n` +
          `${res.image_count} images · ${res.annotation_count} annotations\n` +
          `Classes: ${res.classes.join(", ")}`,
      );
    } catch (e) {
      alert(e instanceof ApiError ? e.message : `Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const onSelect = async (p) => {
    setActive(p);
    setSelected(new Set());
    refreshImages(p);
  };

  // Deep-link support: "/?open=<id>" (used by the My progress page) opens that
  // project automatically once the list has loaded.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || activeProject || projects.length === 0) return;
    const p = projects.find((x) => String(x.id) === String(openId));
    if (p) onSelect(p);
  }, [projects, searchParams]);

  const onUpload = async (e) => {
    if (!activeProject || !e.target.files) return;
    await uploadImages(activeProject.id, e.target.files);
    refreshImages(activeProject);
  };

  const filtered = images.filter((img) => {
    if (filter === "all") return true;
    return img.status === filter;
  });

  const toggleSelect = (id, shift) => {
    const next = new Set(shift ? selected : []);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const onBulkApprove = async () => {
    if (!activeProject || selected.size === 0) return;
    await bulkUpdateStatus([...selected], "approved");
    refreshImages(activeProject);
    setSelected(new Set());
  };

  const onAutoSplit = async () => {
    if (!activeProject) return;
    setSplitting(true);
    try {
      const res = await autoSplit(activeProject.id, 0.7, 0.2, 0.1, false);
      if (res.total === 0) {
        alert(
          "No images to split. Upload images first, or annotate some if using 'annotated only' mode.",
        );
      } else {
        alert(
          `Dataset split updated (70% / 20% / 10%):\n\n` +
            `Train: ${res.train}\nVal: ${res.val}\nTest: ${res.test}\n\n` +
            `Total: ${res.total} images — check the train/val/test dropdown on each tile.`,
        );
      }
      await refreshImages(activeProject);
    } catch (e) {
      alert(`Auto-split failed: ${e.message}`);
    } finally {
      setSplitting(false);
    }
  };

  return (
    <div className="screen project-list">
      <aside className="sidebar">
        <h3>Projects</h3>
        {admin && (
          <div className="new-project">
            <input
              placeholder="New project..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
            />

            <button onClick={onCreate} disabled={creating}>
              <Plus size={14} />
            </button>
          </div>
        )}
        {loadError && <p className="sidebar-error">{loadError}</p>}
        {loading && !loadError && (
          <p className="sidebar-muted">Loading projects…</p>
        )}
        <ul className="project-items">
          {projects.map((p) => (
            <li
              key={p.id}
              className={activeProject?.id === p.id ? "active" : ""}
              onClick={() => onSelect(p)}
            >
              <FolderOpen size={14} />
              <span>{p.name}</span>
              {admin && (
                <>
                  <button
                    className="del"
                    title="Assign user"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMembersFor(p);
                    }}
                  >
                    <Users size={12} />
                  </button>
                  <button
                    className="del"
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete project "${p.name}"? This cannot be undone.`))
                        deleteProject(p.id).then(refresh);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {activeProject && admin && (
          <VersionsPanel
            projectId={activeProject.id}
            onVersionChange={() => refreshImages(activeProject)}
          />
        )}
      </aside>

      <main className="main-area">
        {!activeProject ? (
          <div className="empty-state">
            <FolderOpen size={48} />
            <h2>Select a project</h2>
          </div>
        ) : (
          <>
            <div className="project-header">
              <div>
                <h2>{activeProject.name}</h2>
                <p className="meta">
                  {images.length} images · approved {stats.approved || 0} ·
                  review {stats.needs_review || 0}
                </p>
              </div>
              <div className="actions">
                {admin && (
                  <>
                    {activeProject.assigned_user_id ? (
                      <label className="btn-primary">
                        <Upload size={14} /> Upload
                        <input
                          type="file"
                          multiple
                          accept="image/*,video/*"
                          onChange={onUpload}
                          style={{ display: "none" }}
                        />
                      </label>
                    ) : (
                      <button
                        className="btn-primary"
                        disabled
                        title="Assign a user to this project first (Users icon in the sidebar) — images are stored under the assigned user's folder."
                      >
                        <Upload size={14} /> Upload
                      </button>
                    )}
                    <button
                      className="btn-secondary"
                      onClick={onAutoSplit}
                      disabled={splitting || images.length === 0}
                      title="Randomly assign all images to train (70%), val (20%), test (10%)"
                    >
                      {splitting ? "Splitting…" : "Auto-split"}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={onBulkApprove}
                      disabled={selected.size === 0}
                    >
                      <CheckCircle size={14} /> Approve ({selected.size})
                    </button>
                  </>
                )}
                {/* Downloads: open to every member of this project, not just
                    admin — anyone who can see the images can take them home. */}
                <a
                  className="btn-secondary"
                  href={exportLabeledZipUrl(activeProject.id)}
                  title="Images + drawn-on overlays + YOLO labels + COCO json, all in one zip"
                >
                  <Download size={14} /> Labeled zip
                </a>
                <a
                  className="btn-secondary"
                  href={exportCocoUrl(activeProject.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download size={14} /> COCO JSON
                </a>
                <a
                  className="btn-secondary"
                  href={exportYoloUrl(activeProject.id)}
                >
                  <Download size={14} /> YOLO zip
                </a>
                {admin && (
                  <button
                    className="btn-secondary"
                    onClick={onExportDownloads}
                    disabled={exporting || images.length === 0}
                    title="Also copy labeled images + labels into the server's own ~/Downloads folder"
                  >
                    <Download size={14} />
                    {exporting ? "Exporting…" : "Save to server Downloads"}
                  </button>
                )}
              </div>
            </div>

            <div className="filter-bar">
              {[
                "all",
                "unannotated",
                "in_progress",
                "needs_review",
                "approved",
              ].map((f) => (
                <button
                  key={f}
                  className={`filter-chip ${filter === f ? "active" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f.replace("_", " ")}{" "}
                  {f !== "all" ? `(${stats[f] || 0})` : ""}
                </button>
              ))}
            </div>

            <div className="image-grid">
              {filtered.map((img) => (
                <div
                  key={img.id}
                  className={`image-tile ${selected.has(img.id) ? "tile-selected" : ""}`}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      toggleSelect(img.id, true);
                    } else {
                      nav(`/projects/${activeProject.id}/annotate/${img.id}`);
                    }
                  }}
                >
                  <img
                    src={imageFileUrl(activeProject.id, img.id)}
                    alt={img.filename}
                  />
                  <div className="tile-overlay">
                    <span className={`status status-${img.status}`}>
                      {img.status}
                    </span>
                    <span className="split-badge">{img.split}</span>
                    {img.sequence_id && (
                      <span className="seq-badge">f{img.frame_index}</span>
                    )}
                    <span className="filename">{img.filename}</span>
                  </div>
                  {admin && (
                    <select
                      className="split-select"
                      value={img.split}
                      onClick={(e) => e.stopPropagation()}
                      onChange={async (e) => {
                        e.stopPropagation();
                        await setImageSplit(img.id, e.target.value);
                        await refreshImages(activeProject);
                      }}
                    >
                      <option value="train">train</option>
                      <option value="val">val</option>
                      <option value="test">test</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {membersFor && (
        <ProjectMembersPanel
          project={membersFor}
          onClose={async () => {
            const forId = membersFor.id;
            setMembersFor(null);
            // Refresh so the upload gate reflects a newly-assigned user: pull
            // the fresh project list and re-sync the open project from it.
            try {
              const fresh = await listProjects();
              setProjects(fresh);
              if (activeProject?.id === forId) {
                const updated = fresh.find((x) => x.id === forId);
                if (updated) setActive(updated);
              }
            } catch {
              /* ignore refresh errors */
            }
          }}
        />
      )}
    </div>
  );
}
