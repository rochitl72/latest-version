// AnnotationCanvas v2 — Phase 2.
//
// What's new vs Phase 1:
//   • Existing annotations rendered via EditableBbox / EditablePolygon
//     so they can be moved, resized, and reshaped in place.
//   • All edits go through the history command stack (Cmd+Z / Cmd+Shift+Z).
//   • Brush tool: paints on an offscreen canvas, ships an RLE mask to backend.
//   • Ellipse tool implemented.

import { useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Image as KImage,
  Rect,
  Line,
  Circle,
  Ellipse,
  Group,
  Text,
} from "react-konva";
import useImage from "use-image";

import { useEditor } from "../../../store/editor";
import {
  useHistory,
  makeCreateCmd,
  makeUpdateGeometryCmd,
} from "../../../store/history";
import {
  flatten,
  polyToNorm,
  isInsideImage,
  clampToImage,
} from "../../../utils/geometry";
import { maskFill, maskStroke } from "../../../utils/colors";
import EditableBbox from "./EditableBbox";
import EditablePolygon from "./EditablePolygon";
import EditableEllipse from "./EditableEllipse";
import EditableKeypoint from "./EditableKeypoint";
import BrushOverlay from "./BrushOverlay";

export default function AnnotationCanvas({
  imageUrl,
  imageId,
  onPointerImageMove,
}) {
  const stageRef = useRef(null);
  const containerRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 });
  const [image] = useImage(imageUrl);

  const {
    scale,
    offsetX,
    offsetY,
    setViewport,
    imageWidth,
    imageHeight,
    setImageSize,
    activeTool,
    annotations,
    addAnnotation,
    updateAnnotationLocal,
    labels,
    activeLabelId,
    selectedIds,
    selectId,
    draftBox,
    setDraftBox,
    draftPolygon,
    appendPolyPoint,
    resetPolyDraft,
    readOnly,
    setClipboard,
    clipboard,
    selectAll,
  } = useEditor();

  const { push } = useHistory();
  const panDragRef = useRef(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // ─── Image setup + fit ──────────────────────────────────────────
  useEffect(() => {
    if (image) setImageSize(image.naturalWidth, image.naturalHeight);
  }, [image]);

  useEffect(() => {
    if (!image || !containerRef.current) return;
    const c = containerRef.current.getBoundingClientRect();
    const fitScale =
      Math.min(c.width / image.naturalWidth, c.height / image.naturalHeight) *
      0.95;
    setViewport({
      scale: fitScale,
      offsetX: (c.width - image.naturalWidth * fitScale) / 2,
      offsetY: (c.height - image.naturalHeight * fitScale) / 2,
    });
    setStageSize({ w: c.width, h: c.height });
  }, [image]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const c = containerRef.current.getBoundingClientRect();
        setStageSize({ w: c.width, h: c.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Space + drag / arrow keys to pan while any tool is active
  useEffect(() => {
    const isTyping = (el) => {
      const t = el;
      return (
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.isContentEditable
      );
    };

    const onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 100 : 36;
        const { offsetX: ox, offsetY: oy } = useEditor.getState();
        const dx =
          e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        const dy =
          e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        setViewport({ offsetX: ox + dx, offsetY: oy + dy });
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        setSpaceHeld(false);
        panDragRef.current = null;
        setIsPanning(false);
      }
    };
    const endPan = () => {
      panDragRef.current = null;
      setIsPanning(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mouseup", endPan);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mouseup", endPan);
    };
  }, [setViewport]);

  // ─── Zoom / pan wheel ───────────────────────────────────────────
  const handleWheel = (e) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    const zoomModifier = e.evt.metaKey || e.evt.ctrlKey;

    if (zoomModifier) {
      const oldScale = scale;
      const scaleBy = 1.08;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
      const clamped = Math.max(0.05, Math.min(20, newScale));
      const mouseX = (pointer.x - offsetX) / oldScale;
      const mouseY = (pointer.y - offsetY) / oldScale;
      setViewport({
        scale: clamped,
        offsetX: pointer.x - mouseX * clamped,
        offsetY: pointer.y - mouseY * clamped,
      });
      return;
    }

    setViewport({
      offsetX: offsetX - e.evt.deltaX,
      offsetY: offsetY - e.evt.deltaY,
    });
  };

  const getImagePoint = (opts) => {
    const stage = stageRef.current;
    if (!stage || imageWidth < 1 || imageHeight < 1) return null;
    const p = stage.getPointerPosition();
    if (!p) return null;
    const raw = { x: (p.x - offsetX) / scale, y: (p.y - offsetY) / scale };
    if (opts?.clamp) return clampToImage(raw.x, raw.y, imageWidth, imageHeight);
    return raw;
  };

  const pointerOnImage = () => {
    const p = getImagePoint();
    return p && isInsideImage(p.x, p.y, imageWidth, imageHeight) ? p : null;
  };

  // ─── BBox tool draft ────────────────────────────────────────────
  const [bboxStart, setBboxStart] = useState(null);

  // ─── Ellipse tool draft ─────────────────────────────────────────
  const [ellipseDraft, setEllipseDraft] = useState(null);
  const [ellipseStart, setEllipseStart] = useState(null);
  const [polyCursor, setPolyCursor] = useState(null);

  const activeLabel = labels.find((l) => l.id === activeLabelId);
  const labelColor = maskStroke(activeLabel?.color);
  const labelFill = maskFill(activeLabel?.color);

  const closeThreshold = () => Math.max(10 / scale, 8);

  // Drawing needs a label class. Bbox and ellipse used to just throw the draft
  // away when there wasn't one — you dragged a box, released, and absolutely
  // nothing happened, with no message. Only polygon bothered to say why.
  const requireLabel = () => {
    if (activeLabelId != null) return true;
    alert(
      labels.length === 0
        ? "This project has no label classes yet.\n\nAdd one in the right-hand panel (type a name, pick a colour, press +) before drawing."
        : "Pick a label class first — click one in the right-hand panel.",
    );
    return false;
  };

  const finishPolygon = async () => {
    if (!requireLabel()) return;
    if (draftPolygon.length < 3) {
      alert("Add at least 3 points by clicking on the image.");
      return;
    }
    const cmd = makeCreateCmd({
      image_id: imageId,
      label_id: activeLabelId,
      type: "polygon",
      geometry: { points: polyToNorm(draftPolygon, imageWidth, imageHeight) },
    });
    await push(cmd);
    resetPolyDraft();
    setPolyCursor(null);
  };

  const handleMouseDown = (e) => {
    const middlePan = e.evt.button === 1;
    const spacePan = spaceHeld && e.evt.button === 0;
    if (middlePan || spacePan) {
      e.evt.preventDefault();
      panDragRef.current = {
        startX: e.evt.clientX,
        startY: e.evt.clientY,
        startOffX: offsetX,
        startOffY: offsetY,
      };
      setIsPanning(true);
      return;
    }

    if (readOnly) return;
    if (e.evt.button !== 0) return;

    if (activeTool === "pan") return;

    if (activeTool === "select") {
      if (e.target === stageRef.current) selectId(null);
      return;
    }

    const p = pointerOnImage();
    const needsImage =
      activeTool === "polygon" ||
      activeTool === "bbox" ||
      activeTool === "ellipse";
    if (needsImage && !p) return;
    if (!p) return;

    if (activeTool === "bbox") {
      setBboxStart(p);
      setDraftBox({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

    if (activeTool === "ellipse") {
      setEllipseStart(p);
      setEllipseDraft({ cx: p.x, cy: p.y, rx: 0, ry: 0 });
      return;
    }

    if (activeTool === "polygon") {
      if (!requireLabel()) return;
      if (draftPolygon.length >= 3) {
        const [fx, fy] = draftPolygon[0];
        const dist = Math.hypot(p.x - fx, p.y - fy);
        if (dist < closeThreshold()) {
          finishPolygon();
          return;
        }
      }
      appendPolyPoint([p.x, p.y]);
      return;
    }
  };

  const handleMouseMove = (e) => {
    if (panDragRef.current) {
      const dx = e.evt.clientX - panDragRef.current.startX;
      const dy = e.evt.clientY - panDragRef.current.startY;
      setViewport({
        offsetX: panDragRef.current.startOffX + dx,
        offsetY: panDragRef.current.startOffY + dy,
      });
      return;
    }

    const raw = getImagePoint();
    if (!raw) return;
    const p = clampToImage(raw.x, raw.y, imageWidth, imageHeight);

    if (activeTool === "bbox" && bboxStart) {
      const x = Math.min(bboxStart.x, p.x);
      const y = Math.min(bboxStart.y, p.y);
      const w = Math.abs(p.x - bboxStart.x);
      const h = Math.abs(p.y - bboxStart.y);
      setDraftBox({ x, y, w, h });
    }

    if (activeTool === "ellipse" && ellipseStart) {
      setEllipseDraft({
        cx: (ellipseStart.x + p.x) / 2,
        cy: (ellipseStart.y + p.y) / 2,
        rx: Math.abs(p.x - ellipseStart.x) / 2,
        ry: Math.abs(p.y - ellipseStart.y) / 2,
      });
    }

    if (activeTool === "polygon") {
      onPointerImageMove?.(raw);
      if (draftPolygon.length > 0) {
        setPolyCursor(clampToImage(raw.x, raw.y, imageWidth, imageHeight));
      }
    }
  };

  const handleMouseLeave = () => {
    if (activeTool === "polygon") {
      setPolyCursor(null);
      onPointerImageMove?.(null);
    }
  };

  const handleMouseUp = async () => {
    if (activeTool === "bbox" && draftBox && bboxStart) {
      setBboxStart(null);
      // Too small to be intentional — a stray click, not a drag. Discard
      // quietly; nagging on every click would be worse than silence here.
      if (draftBox.w < 4 || draftBox.h < 4) {
        setDraftBox(null);
        return;
      }
      if (!requireLabel()) {
        setDraftBox(null);
        return;
      }
      const cmd = makeCreateCmd({
        image_id: imageId,
        label_id: activeLabelId,
        type: "bbox",
        geometry: {
          x: draftBox.x / imageWidth,
          y: draftBox.y / imageHeight,
          w: draftBox.w / imageWidth,
          h: draftBox.h / imageHeight,
        },
      });
      await push(cmd);
      setDraftBox(null);
    }

    if (activeTool === "ellipse" && ellipseDraft && ellipseStart) {
      setEllipseStart(null);
      if (ellipseDraft.rx < 3 || ellipseDraft.ry < 3) {
        setEllipseDraft(null);
        return;
      }
      if (!requireLabel()) {
        setEllipseDraft(null);
        return;
      }
      const cmd = makeCreateCmd({
        image_id: imageId,
        label_id: activeLabelId,
        type: "ellipse",
        geometry: {
          cx: ellipseDraft.cx / imageWidth,
          cy: ellipseDraft.cy / imageHeight,
          rx: ellipseDraft.rx / imageWidth,
          ry: ellipseDraft.ry / imageHeight,
        },
      });
      await push(cmd);
      setEllipseDraft(null);
    }
  };

  const handleDblClick = async () => {
    if (activeTool === "polygon") await finishPolygon();
  };

  // ─── Keyboard (canvas-specific; save/delete/undo handled in AnnotateView) ──
  useEffect(() => {
    const onKey = async (e) => {
      const target = e.target;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (meta && e.key.toLowerCase() === "c" && selectedIds.size > 0) {
        e.preventDefault();
        const items = annotations
          .filter((a) => selectedIds.has(a.id))
          .map((a) => ({
            type: a.type,
            label_id: a.label_id,
            geometry: JSON.parse(JSON.stringify(a.geometry)),
            source: a.source,
          }));
        setClipboard(items);
        return;
      }
      if (
        meta &&
        e.key.toLowerCase() === "v" &&
        clipboard.length > 0 &&
        !readOnly
      ) {
        e.preventDefault();
        for (const item of clipboard) {
          const geo = JSON.parse(JSON.stringify(item.geometry));
          if (geo.x != null) {
            geo.x = Math.min(0.98, geo.x + 0.02);
            geo.y = Math.min(0.98, geo.y + 0.02);
          }
          if (geo.points) {
            geo.points = geo.points.map((p) => [
              Math.min(0.98, p[0] + 0.02),
              Math.min(0.98, p[1] + 0.02),
            ]);
          }
          await push(
            makeCreateCmd({
              image_id: imageId,
              label_id: item.label_id,
              type: item.type,
              geometry: geo,
              source: "paste",
            }),
          );
        }
        return;
      }

      if (e.key === "Escape") {
        resetPolyDraft();
        setPolyCursor(null);
        setDraftBox(null);
        setEllipseDraft(null);
        setEllipseStart(null);
        setBboxStart(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, annotations, clipboard, readOnly]);

  // Snapshot geometry at drag-start so undo restores correctly.
  // Keyed by annotation id; cleared on changeEnd.
  const dragSnapshots = useRef({});

  // ─── Render existing annotations ─────────────────────────────────
  const renderAnnotation = (ann) => {
    const label = labels.find((l) => l.id === ann.label_id);
    const isSelected = selectedIds.has(ann.id);

    const onSelect = (e) => {
      if (activeTool !== "select") return;
      e.cancelBubble = true;
      selectId(ann.id, e.evt.shiftKey);
    };

    const onChange = (newGeo) => {
      // First call of a drag → snapshot the ORIGINAL geometry for undo.
      if (!dragSnapshots.current[ann.id]) {
        dragSnapshots.current[ann.id] = JSON.parse(
          JSON.stringify(ann.geometry),
        );
      }
      // Live local update (no history) — fast feedback during drag
      updateAnnotationLocal(ann.id, { geometry: newGeo });
    };

    const onChangeEnd = async (newGeo) => {
      const original = dragSnapshots.current[ann.id] ?? ann.geometry;
      delete dragSnapshots.current[ann.id];
      try {
        // Push the command with the correct "before" snapshot
        await push(makeUpdateGeometryCmd({ ...ann, geometry: original }, newGeo));
      } catch {
        // The server refused the edit (e.g. 403 on an approved image). The
        // drag already moved the shape locally for responsiveness, so put it
        // back — otherwise the canvas keeps showing a position that was never
        // saved, and the user has no idea their work was rejected.
        updateAnnotationLocal(ann.id, { geometry: original });
      }
    };

    if (ann.type === "bbox") {
      return (
        <EditableBbox
          key={ann.id}
          ann={ann}
          label={label}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          scale={scale}
          selected={isSelected && activeTool === "select"}
          readOnly={readOnly}
          onSelect={onSelect}
          onChange={onChange}
          onChangeEnd={onChangeEnd}
        />
      );
    }

    if (ann.type === "polygon") {
      return (
        <EditablePolygon
          key={ann.id}
          ann={ann}
          label={label}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          scale={scale}
          selected={isSelected && activeTool === "select"}
          readOnly={readOnly}
          onSelect={onSelect}
          onChange={onChange}
          onChangeEnd={onChangeEnd}
        />
      );
    }

    if (ann.type === "ellipse") {
      // Was previously drawn inline as a static shape with no drag and no
      // handles, so an ellipse was the one annotation you could create but
      // never adjust. Now uses the same editable component pattern as bbox
      // and polygon.
      return (
        <EditableEllipse
          key={ann.id}
          ann={ann}
          label={label}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          scale={scale}
          selected={isSelected && activeTool === "select"}
          readOnly={readOnly}
          onSelect={onSelect}
          onChange={onChange}
          onChangeEnd={onChangeEnd}
        />
      );
    }

    if (ann.type === "mask") {
      return null;
    }

    if (ann.type === "keypoint") {
      return (
        <EditableKeypoint
          key={ann.id}
          ann={ann}
          label={label}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          scale={scale}
          selected={isSelected && activeTool === "select"}
          readOnly={readOnly}
          onSelect={onSelect}
          onChange={(geo) => {
            if (!dragSnapshots.current[ann.id]) {
              dragSnapshots.current[ann.id] = JSON.parse(
                JSON.stringify(ann.geometry),
              );
            }
            updateAnnotationLocal(ann.id, { geometry: geo });
          }}
          onChangeEnd={(geo) => {
            const original = dragSnapshots.current[ann.id] ?? ann.geometry;
            delete dragSnapshots.current[ann.id];
            push(makeUpdateGeometryCmd({ ...ann, geometry: original }, geo));
          }}
        />
      );
    }

    return null;
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        // Canvas backdrop (lavender light) — matches the app's tinted Vivid
        // surfaces so the workspace feels part of the same theme.
        background: "#eeecfb",
        cursor: isPanning
          ? "grabbing"
          : spaceHeld
            ? "grab"
            : activeTool === "pan"
              ? "grab"
              : activeTool === "bbox" ||
                  activeTool === "polygon" ||
                  activeTool === "ellipse"
                ? "crosshair"
                : "default",
      }}
    >
      <Stage
        ref={stageRef}
        width={stageSize.w}
        height={stageSize.h}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseUp={handleMouseUp}
        onDblClick={handleDblClick}
        draggable={activeTool === "pan"}
        x={offsetX}
        y={offsetY}
        scaleX={scale}
        scaleY={scale}
        onDragEnd={(e) => {
          if (activeTool === "pan") {
            setViewport({ offsetX: e.target.x(), offsetY: e.target.y() });
          }
        }}
      >
        <Layer listening={false}>{image && <KImage image={image} />}</Layer>

        {/* Mask annotations rendered as a single composited layer for performance */}
        <BrushOverlay
          imageId={imageId}
          annotations={annotations}
          labels={labels}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          scale={scale}
        />

        <Layer
          clipX={0}
          clipY={0}
          clipWidth={imageWidth}
          clipHeight={imageHeight}
        >
          {annotations.map(renderAnnotation)}

          {draftBox && (
            <Rect
              x={draftBox.x}
              y={draftBox.y}
              width={draftBox.w}
              height={draftBox.h}
              stroke={labelColor}
              strokeWidth={2 / scale}
              dash={[6 / scale, 4 / scale]}
              fill={labelFill}
            />
          )}

          {ellipseDraft && (
            <Ellipse
              x={ellipseDraft.cx}
              y={ellipseDraft.cy}
              radiusX={ellipseDraft.rx}
              radiusY={ellipseDraft.ry}
              stroke={labelColor}
              strokeWidth={2 / scale}
              dash={[6 / scale, 4 / scale]}
              fill={labelFill}
            />
          )}

          {draftPolygon.length > 0 && (
            <>
              <Line
                points={flatten(draftPolygon)}
                stroke={labelColor}
                strokeWidth={2 / scale}
                fill={labelFill}
                closed={draftPolygon.length >= 3}
              />

              {polyCursor && (
                <Line
                  points={flatten([
                    ...draftPolygon,
                    [polyCursor.x, polyCursor.y],
                  ])}
                  stroke={labelColor}
                  strokeWidth={1.5 / scale}
                  dash={[4 / scale, 4 / scale]}
                  opacity={0.7}
                />
              )}
              {draftPolygon.map(([x, y], i) => (
                <Circle
                  key={i}
                  x={x}
                  y={y}
                  radius={i === 0 ? 7 / scale : 5 / scale}
                  fill={i === 0 ? "#fff" : labelColor}
                  stroke={labelColor}
                  strokeWidth={1.5 / scale}
                />
              ))}
            </>
          )}
        </Layer>
      </Stage>
    </div>
  );
}
