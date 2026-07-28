// ImageGallerySidebar.jsx — collapsible strip of image thumbnails.
// Lets the annotator filter by workflow status and jump between images in the
// current project; pulls live counts from the workflow-stats endpoint.

import { useCallback, useEffect, useMemo, useState } from "react";
import { workflowStats, imageFileUrl } from "../../lib/api/client";
import { ChevronLeft, ChevronRight, Images } from "lucide-react";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "unannotated", label: "Unannotated" },
  { id: "in_progress", label: "In progress" },
  { id: "annotated", label: "Done" },
  { id: "needs_review", label: "Needs review" },
  { id: "approved", label: "Approved" },
];

export default function ImageGallerySidebar({
  projectId,
  currentImageId,
  images,
  onSelectImage,
}) {
  const [filter, setFilter] = useState("all");
  const [stats, setStats] = useState({});

  useEffect(() => {
    workflowStats(projectId).then((s) => setStats(s.by_status || {}));
  }, [projectId, images.length, currentImageId]);

  const filtered = useMemo(() => {
    if (filter === "all") return images;
    return images.filter((img) => img.status === filter);
  }, [images, filter]);

  const currentIndex = filtered.findIndex((img) => img.id === currentImageId);

  const goRelative = useCallback(
    (delta) => {
      if (filtered.length === 0) return;
      const idx = currentIndex < 0 ? 0 : currentIndex;
      const next = (idx + delta + filtered.length) % filtered.length;
      onSelectImage(filtered[next]);
    },
    [filtered, currentIndex, onSelectImage],
  );

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") {
        e.preventDefault();
        goRelative(-1);
      } else if (e.key === "]") {
        e.preventDefault();
        goRelative(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goRelative]);

  return (
    <aside className="gallery-sidebar">
      <div className="gallery-header">
        <Images size={14} />
        <span>Gallery</span>
        <span className="gallery-count">{filtered.length}</span>
      </div>

      <div className="gallery-nav">
        <button
          type="button"
          className="gallery-nav-btn"
          onClick={() => goRelative(-1)}
          disabled={filtered.length < 2}
          title="Previous image ([)"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="gallery-pos">
          {filtered.length === 0
            ? "—"
            : `${currentIndex >= 0 ? currentIndex + 1 : "?"} / ${filtered.length}`}
        </span>
        <button
          type="button"
          className="gallery-nav-btn"
          onClick={() => goRelative(1)}
          disabled={filtered.length < 2}
          title="Next image (])"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="gallery-filters">
        {FILTERS.map((f) => {
          const count =
            f.id === "all"
              ? images.length
              : (stats[f.id] ?? images.filter((i) => i.status === f.id).length);
          return (
            <button
              key={f.id}
              type="button"
              className={`gallery-filter ${filter === f.id ? "active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="gallery-filter-n">{count}</span>
            </button>
          );
        })}
      </div>

      <ul className="gallery-list">
        {filtered.map((img) => (
          <li
            key={img.id}
            className={`gallery-item ${img.id === currentImageId ? "active" : ""}`}
            onClick={() => onSelectImage(img)}
          >
            <img
              src={imageFileUrl(projectId, img.id)}
              alt={img.filename}
              loading="lazy"
            />

            <div className="gallery-item-meta">
              <span className={`gallery-status status-${img.status}`}>
                {img.status.replace("_", " ")}
              </span>
              <span className="gallery-split">{img.split}</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
