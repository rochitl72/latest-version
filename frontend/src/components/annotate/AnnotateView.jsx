// AnnotateView.jsx — the main annotation workspace for one image.
// Owns the label list, loads/saves annotations, wires the canvas to the editor
// store, and hosts the review + gallery chrome around the drawing surface.

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import AnnotationCanvas from "./canvas/AnnotationCanvas";
import { useEditor } from "../../store/editor";
import {
  listLabels,
  createLabel,
  deleteLabel,
  listAnnotations,
  imageFileUrl,
  listImages,
  updateImageStatus,
} from "../../lib/api/client";
import ReviewBar from "./ReviewBar";
import { getCurrentUser } from "../../lib/auth";
import OnboardingGuide, { shouldShowOnboarding } from "./OnboardingGuide";
import ToolTipButton from "../common/ToolTipButton";
import ImageGallerySidebar from "./ImageGallerySidebar";
import AnnotateControlsDock from "./AnnotateControlsDock";
import PolygonMagnifier, {
  MAGNIFIER_ZOOM_DEFAULT,
  MAGNIFIER_ZOOM_MAX,
  MAGNIFIER_ZOOM_MIN,
} from "./PolygonMagnifier";
import { maskStroke } from "../../utils/colors";
import { useHistory, makeCreateCmd, makeDeleteCmd } from "../../store/history";
import { polyToNorm } from "../../utils/geometry";
import { LABEL_PURPLE_PALETTE } from "../../utils/colors";
import {
  MousePointer2,
  Square,
  Hexagon,
  Brush,
  Circle,
  Move,
  ArrowLeft,
  Plus,
  Trash2,
  Crosshair,
} from "lucide-react";

const TOOLS = [
  {
    id: "select",
    icon: MousePointer2,
    label: "Select",
    shortcut: "V",
    hint: "Click shapes to select. Drag to move or resize.",
  },
  {
    id: "pan",
    icon: Move,
    label: "Pan",
    shortcut: "H",
    hint: "Drag to move. Or scroll / Space+drag on any tool.",
  },
  {
    id: "bbox",
    icon: Square,
    label: "Bounding Box",
    shortcut: "B",
    hint: "Click and drag to draw a rectangle.",
  },
  {
    id: "polygon",
    icon: Hexagon,
    label: "Polygon",
    shortcut: "P",
    hint: "Click corners. Finish when done.",
  },
  {
    id: "brush",
    icon: Brush,
    label: "Brush Mask",
    shortcut: "K",
    hint: "Paint a pixel mask. Release to save.",
  },
  {
    id: "ellipse",
    icon: Circle,
    label: "Ellipse",
    shortcut: "E",
    hint: "Click and drag to draw an oval.",
  },
  {
    id: "keypoint",
    icon: Crosshair,
    label: "Keypoints",
    shortcut: "J",
    hint: "Click to place each joint.",
  },
];

export default function AnnotateView() {
  const { projectId, imageId } = useParams();
  const pid = Number(projectId);
  const iid = Number(imageId);
  const nav = useNavigate();

  const {
    activeTool,
    setTool,
    labels,
    setLabels,
    activeLabelId,
    setActiveLabel,
    annotations,
    setAnnotations,
    removeAnnotation,
    selectedIds,
    selectId,
    imageWidth,
    imageHeight,
    imageStatus,
    setImageStatus,
    readOnly,
    draftPolygon,
    resetPolyDraft,
    draftKeypoints,
    resetKeypointDraft,
  } = useEditor();

  const {
    undo,
    redo,
    canUndo,
    canRedo,
    clear: clearHistory,
    push,
  } = useHistory();
  const [labelName, setLabelName] = useState("");
  const [keypointTemplate, setKeypointTemplate] = useState("");
  // Surfaces any failed API call in this view. Without it, a rejected promise
  // disappears and the UI silently does nothing.
  const [err, setErr] = useState(null);
  const [showKeypointField, setShowKeypointField] = useState(false);
  const [currentImage, setCurrentImage] = useState(null);
  const [projectImages, setProjectImages] = useState([]);
  const [showGuide, setShowGuide] = useState(shouldShowOnboarding);
  const [magnifierPoint, setMagnifierPoint] = useState(null);
  const [magnifierZoom, setMagnifierZoom] = useState(() => {
    const saved = localStorage.getItem("polygonMagnifierZoom");
    const n = saved ? Number(saved) : MAGNIFIER_ZOOM_DEFAULT;
    return Number.isFinite(n)
      ? Math.min(MAGNIFIER_ZOOM_MAX, Math.max(MAGNIFIER_ZOOM_MIN, n))
      : MAGNIFIER_ZOOM_DEFAULT;
  });

  useEffect(() => {
    localStorage.setItem("polygonMagnifierZoom", String(magnifierZoom));
  }, [magnifierZoom]);

  const refreshProjectImages = async () => {
    try {
      const imgs = await listImages(pid);
      setProjectImages(imgs);
      return imgs;
    } catch (e) {
      setErr(e?.message || "Could not load this project's images.");
      return [];
    }
  };

  useEffect(() => {
    clearHistory();
    (async () => {
      const imgs = await refreshProjectImages();
      const img = imgs.find((x) => x.id === iid);
      setCurrentImage(img || null);
      if (img) setImageStatus(img.status);

      const [lbls, anns] = await Promise.all([
        listLabels(pid),
        listAnnotations(iid),
      ]);
      setLabels(lbls);
      setAnnotations(anns);
    })();
  }, [pid, iid]);

  useEffect(() => {
    if (activeTool !== "polygon") setMagnifierPoint(null);
  }, [activeTool, iid]);

  const hasUnsavedPolygon = draftPolygon.length >= 3;
  const hasUnsavedKeypoints = draftKeypoints.length > 0;

  const handleSetTool = (t) => {
    setTool(t);
  };

  const saveCurrentDraft = async () => {
    if (activeLabelId == null) {
      alert("Pick a label class first (right panel → road → click the row).");
      return;
    }
    if (hasUnsavedPolygon) {
      await finishPolygon();
      return;
    }
    if (hasUnsavedKeypoints) {
      await push(
        makeCreateCmd({
          image_id: iid,
          label_id: activeLabelId,
          type: "keypoint",
          geometry: {
            points: draftKeypoints.map((p) => ({
              name: p.name,
              x: p.x / imageWidth,
              y: p.y / imageHeight,
              v: p.v,
            })),
          },
        }),
      );
      resetKeypointDraft();
      return;
    }
    alert("Nothing to save — draw a shape first.");
  };

  const deleteSelected = async () => {
    if (selectedIds.size > 0) {
      for (const id of [...selectedIds]) {
        const ann = annotations.find((a) => a.id === id);
        if (ann) await push(makeDeleteCmd(ann));
      }
      selectId(null);
      return;
    }
    alert("Select a shape in the list, or on the canvas, to delete it.");
  };

  const onDeleteAnnotation = async (ann) => {
    if (!confirm(`Delete this ${ann.type} annotation?`)) return;
    try {
      await push(makeDeleteCmd(ann));
      if (selectedIds.has(ann.id)) selectId(null);
    } catch {
      /* push shows alert */
    }
  };

  useEffect(() => {
    const onKey = async (e) => {
      const t = e.target;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          if (canRedo()) await redo();
        } else if (canUndo()) {
          await undo();
        }
        return;
      }

      if (meta) return;

      const m = {
        v: "select",
        h: "pan",
        b: "bbox",
        p: "polygon",
        e: "ellipse",
        k: "brush",
        j: "keypoint",
      };
      const tool = m[e.key.toLowerCase()];
      if (tool) {
        handleSetTool(tool);
        e.preventDefault();
        return;
      }

      if (e.key === "Enter" && !readOnly) {
        if (hasUnsavedPolygon || hasUnsavedKeypoints) {
          e.preventDefault();
          await saveCurrentDraft();
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
        if (selectedIds.size > 0) {
          e.preventDefault();
          await deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    annotations,
    selectedIds,
    hasUnsavedPolygon,
    hasUnsavedKeypoints,
    activeLabelId,
    readOnly,
  ]);

  const onAddLabel = async () => {
    if (!labelName.trim()) return;
    const color =
      LABEL_PURPLE_PALETTE[labels.length % LABEL_PURPLE_PALETTE.length];
    const kpNames = keypointTemplate
      ? keypointTemplate
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    setErr(null);
    try {
      const created = await createLabel(pid, {
        name: labelName.trim(),
        color,
        keypoint_names: kpNames,
        skeleton_edges:
          kpNames && kpNames.length > 1
            ? kpNames.slice(0, -1).map((_, i) => [i, i + 1])
            : null,
      });
      setLabels([...labels, created]);
      setActiveLabel(created.id);
      setLabelName("");
      setKeypointTemplate("");
    } catch (e) {
      // Creating a label is admin-only. Without this the request just failed
      // in silence and the button looked broken.
      setErr(
        e?.status === 403
          ? "Only an admin can add label classes. Ask an admin to set up the classes for this project."
          : e?.message || "Could not add the label.",
      );
    }
  };

  const onDeleteLabel = async (id) => {
    if (
      !confirm(
        "Delete this label class?\n\nEvery annotation using it will be deleted too.",
      )
    )
      return;
    setErr(null);
    try {
      await deleteLabel(pid, id);
      setLabels(labels.filter((l) => l.id !== id));
      setAnnotations(annotations.filter((a) => a.label_id !== id));
      if (activeLabelId === id) setActiveLabel(labels[0]?.id ?? null);
    } catch (e) {
      setErr(
        e?.status === 403
          ? "Only an admin can delete label classes."
          : e?.message || "Could not delete the label.",
      );
    }
  };

  const finishPolygon = async () => {
    if (activeLabelId == null) {
      alert("Create a label class first.");
      return;
    }
    if (draftPolygon.length < 3) {
      alert("Click at least 3 corners on the image.");
      return;
    }
    await push(
      makeCreateCmd({
        image_id: iid,
        label_id: activeLabelId,
        type: "polygon",
        geometry: { points: polyToNorm(draftPolygon, imageWidth, imageHeight) },
      }),
    );
    resetPolyDraft();
  };

  const markImageDone = async () => {
    setErr(null);
    try {
      await updateImageStatus(iid, "annotated");
      setImageStatus("annotated");
      const imgs = await refreshProjectImages();
      setCurrentImage(imgs.find((x) => x.id === iid) || null);
    } catch (e) {
      setErr(e?.message || "Could not update the image status.");
    }
  };

  const navigateToImage = async (img) => {
    if (img.id === iid) return;
    nav(`/projects/${pid}/annotate/${img.id}`);
  };

  const draftActionLabel = (() => {
    if (hasUnsavedPolygon) return "Save polygon";
    if (hasUnsavedKeypoints) return "Save keypoints";
    return null;
  })();

  return (
    <div className="annotate-view">
      <div className="annotate-topbar">
        <button className="back-btn" onClick={() => nav(-1)}>
          <ArrowLeft size={18} /> Back
        </button>
        <button className="btn-text" onClick={() => setShowGuide(true)}>
          Quick guide
        </button>
      </div>

      <div className="annotate-main">
        <ImageGallerySidebar
          projectId={pid}
          currentImageId={iid}
          images={projectImages}
          onSelectImage={navigateToImage}
        />

        <div className="canvas-area">
          <AnnotationCanvas
            imageUrl={imageFileUrl(pid, iid)}
            imageId={iid}
            onPointerImageMove={
              activeTool === "polygon" && !readOnly
                ? setMagnifierPoint
                : undefined
            }
          />

          <div className="canvas-overlay">
            <div className="canvas-overlay-pills">
              <div className="status-pill">
                {imageWidth}×{imageHeight}
              </div>
              {currentImage?.sequence_id && (
                <div className="status-pill">
                  Frame {currentImage.frame_index ?? 0}
                </div>
              )}
              {readOnly && (
                <div className="status-pill approved-pill">
                  Approved (read-only)
                </div>
              )}
            </div>
            {activeTool === "polygon" && !readOnly && imageWidth > 0 && (
              <PolygonMagnifier
                imageUrl={imageFileUrl(pid, iid)}
                point={magnifierPoint}
                imageWidth={imageWidth}
                imageHeight={imageHeight}
                draftPolygon={draftPolygon}
                strokeColor={maskStroke(
                  labels.find((l) => l.id === activeLabelId)?.color,
                )}
                zoom={magnifierZoom}
                onZoomChange={setMagnifierZoom}
              />
            )}
          </div>

          <aside className="tool-rail-float">
            {TOOLS.map((t) => (
              <ToolTipButton
                key={t.id}
                label={t.label}
                shortcut={t.shortcut}
                hint={t.hint}
                active={activeTool === t.id}
                className={`tool-btn-float ${activeTool === t.id ? "active" : ""}`}
                onClick={() => handleSetTool(t.id)}
                disabled={readOnly && t.id !== "select" && t.id !== "pan"}
              >
                <t.icon size={18} />
              </ToolTipButton>
            ))}
          </aside>

          <AnnotateControlsDock
            tool={activeTool}
            hasLabel={labels.length > 0 && activeLabelId != null}
            canUndo={canUndo()}
            canRedo={canRedo()}
            hasSelection={selectedIds.size > 0}
            readOnly={readOnly}
            draftLabel={draftActionLabel}
            onSaveDraft={saveCurrentDraft}
            onUndo={undo}
            onRedo={redo}
            onDelete={deleteSelected}
            onMarkImageDone={markImageDone}
            imageDone={
              imageStatus === "annotated" || imageStatus === "approved"
            }
          />
        </div>

        <aside className="side-panel">
          <ReviewBar
            imageId={iid}
            status={imageStatus}
            readOnly={readOnly}
            onStatusChange={(s) => {
              setImageStatus(s);
              void refreshProjectImages();
            }}
          />

          <section>
            <h4>Labels</h4>
            <p className="panel-hint">
              A label is the kind of thing you are marking — <em>car</em>,{" "}
              <em>person</em>, <em>pothole</em>. Add one, then draw.
            </p>
            <div className="new-label">
              <input
                placeholder="e.g. car"
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onAddLabel()}
              />

              <button onClick={onAddLabel} title="Add this label">
                <Plus size={14} />
              </button>
            </div>

            {/* Keypoints only matter for pose/skeleton work. Showing the field
                to everyone made it look required — it is not, and most projects
                (boxes, polygons, masks) never touch it. Hidden behind a toggle. */}
            {showKeypointField ? (
              <>
                <input
                  className="kp-template"
                  placeholder="nose, left_eye, right_eye"
                  value={keypointTemplate}
                  onChange={(e) => setKeypointTemplate(e.target.value)}
                />
                <p className="panel-hint">
                  Optional. Only for skeleton/pose labelling — names the points
                  you will click on each object, in order.{" "}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setShowKeypointField(false);
                      setKeypointTemplate("");
                    }}
                  >
                    Hide
                  </button>
                </p>
              </>
            ) : (
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowKeypointField(true)}
              >
                + Add keypoints (optional — for pose/skeleton only)
              </button>
            )}

            {err && (
              <p className="panel-error" role="alert">
                {err}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setErr(null)}
                >
                  Dismiss
                </button>
              </p>
            )}

            <ul className="label-list">
              {labels.map((l) => (
                <li
                  key={l.id}
                  className={activeLabelId === l.id ? "active" : ""}
                  onClick={() => setActiveLabel(l.id)}
                >
                  <span className="color-dot" style={{ background: l.color }} />
                  <span className="name">{l.name}</span>
                  <span className="count">
                    {annotations.filter((a) => a.label_id === l.id).length}
                  </span>
                  <button
                    className="del"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteLabel(l.id);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h4>On this image ({annotations.length})</h4>
            <p className="side-hint">
              Click a row to select · Del to delete · masks appear after you
              save.
            </p>
            <ul className="ann-list">
              {annotations.map((a) => {
                const lbl = labels.find((l) => l.id === a.label_id);
                return (
                  <li
                    key={a.id}
                    className={selectedIds.has(a.id) ? "selected" : ""}
                    onClick={() => {
                      handleSetTool("select");
                      selectId(a.id);
                    }}
                  >
                    <span
                      className="color-dot color-dot-purple"
                      style={{ background: lbl?.color || "#6B4EFF" }}
                    />
                    <span className="ann-meta">
                      <span className="ann-type">{a.type}</span>
                      <span className="ann-label">{lbl?.name || "—"}</span>
                    </span>
                    <button
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteAnnotation(a);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="shortcuts">
            <h4>Shortcuts</h4>
            <div className="kbd-row">
              <kbd>V</kbd> Select & edit shapes
            </div>
            <div className="kbd-row">
              <kbd>Enter</kbd> Save current shape
            </div>
            <div className="kbd-row">
              <kbd>⌘Z</kbd> Undo · <kbd>Del</kbd> Delete
            </div>
            <div className="kbd-row">
              <kbd>[</kbd> <kbd>]</kbd> Prev / next image
            </div>
            <div className="kbd-row">
              <kbd>Scroll</kbd> Pan · <kbd>⌘</kbd>+<kbd>scroll</kbd> Zoom
            </div>
            <div className="kbd-row">
              <kbd>Space</kbd>+drag or <kbd>H</kbd> Pan tool
            </div>
            <div className="kbd-row">
              <kbd>↑↓←→</kbd> Nudge view · <kbd>Shift</kbd> faster
            </div>
          </section>
        </aside>
      </div>

      {showGuide && <OnboardingGuide onDismiss={() => setShowGuide(false)} />}
    </div>
  );
}
