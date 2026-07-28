// BrushOverlay
//
// Two responsibilities:
//   1. Render existing mask annotations (decoded from RLE).
//   2. When brush tool is active, render the in-progress paint layer.
//
// Brush painting strategy:
//   • An offscreen <canvas> at image resolution holds the current paint.
//   • Mouse moves draw circles of brushSize on it.
//   • On mouseup we encode as RLE and POST to backend.
//   • We tint the painted pixels by active label color when rendering.

import { useEffect, useRef, useState } from "react";
import { Layer, Image as KImage, Circle } from "react-konva";
import { useEditor } from "../../../store/editor";
import {
  useHistory,
  makeCreateCmd,
  makeUpdateGeometryCmd,
  makeDeleteCmd,
} from "../../../store/history";
import { rleDecode, rleEncodeFromCanvas } from "../../../utils/rle";
import { MASK_PURPLE } from "../../../utils/colors";
import { isInsideImage, clampToImage } from "../../../utils/geometry";

export default function BrushOverlay({
  imageId,
  annotations,
  labels,
  imageWidth,
  imageHeight,
  scale,
}) {
  const { activeTool, activeLabelId, selectedIds, selectId } = useEditor();
  const { push } = useHistory();

  // Layer canvas: the composite of all existing mask annotations
  const compositeRef = useRef(null);
  // The Konva node for the composite — needed to force a redraw, since mutating
  // the underlying canvas in place does NOT make Konva repaint on its own.
  const compositeNodeRef = useRef(null);
  // Per-pixel "which mask owns this pixel" map, for click-to-select hit-testing.
  // owner[i] is a 1-based slot into `ids`; 0 means no mask there.
  const ownerRef = useRef({ owner: null, ids: [] });
  // Working canvas: the in-progress brush paint
  const workingRef = useRef(null);
  const [, rerender] = useState(0);

  const [brushSize, setBrushSize] = useState(20);
  const [erase, setErase] = useState(false);
  const [cursor, setCursor] = useState(null);
  const isDrawing = useRef(false);

  // Build/rebuild the composite mask layer whenever the masks OR the selection
  // change. Selected masks are drawn more opaque so you can see what's picked.
  // We also build a pixel→mask ownership map here (reusing the same decode) so a
  // click on the canvas can tell which mask it landed on.
  useEffect(() => {
    if (imageWidth === 0 || imageHeight === 0) return;
    if (!compositeRef.current) {
      compositeRef.current = document.createElement("canvas");
    }
    const c = compositeRef.current;
    c.width = imageWidth;
    c.height = imageHeight;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    const masks = annotations.filter((a) => a.type === "mask" && a.geometry?.rle);
    const owner = new Uint16Array(imageWidth * imageHeight);
    const ids = [];
    // One read + one write for the whole composite (cheaper than per-mask).
    const img = ctx.getImageData(0, 0, imageWidth, imageHeight);
    const d = img.data;

    for (const a of masks) {
      const slot = ids.push(a.id); // 1-based; later masks overwrite = topmost wins
      const mk = rleDecode(a.geometry.rle, a.geometry.size);
      const lbl = labels.find((l) => l.id === a.label_id);
      const hex = lbl?.color && /^#[0-9a-fA-F]{6}$/.test(lbl.color) ? lbl.color : MASK_PURPLE;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const a255 = Math.round(255 * (selectedIds.has(a.id) ? 0.82 : 0.42));
      for (let i = 0; i < mk.length; i++) {
        if (mk[i]) {
          owner[i] = slot;
          const j = i * 4;
          d[j] = r;
          d[j + 1] = g;
          d[j + 2] = b;
          d[j + 3] = Math.max(d[j + 3], a255);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    ownerRef.current = { owner, ids };

    // Force Konva to repaint the layer with the mutated canvas. Without this a
    // deleted/undone mask would linger on screen even though it's gone.
    compositeNodeRef.current?.getLayer()?.batchDraw();
    rerender((n) => n + 1);
  }, [annotations, labels, imageWidth, imageHeight, selectedIds]);

  // Click a mask on the canvas (select tool only) → select it; empty → deselect.
  const onCompositeClick = (e) => {
    if (activeTool !== "select") return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getAbsoluteTransform().copy().invert().point(
      stage.getPointerPosition(),
    );
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const { owner, ids } = ownerRef.current;
    e.cancelBubble = true;
    if (!owner || x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) {
      selectId(null);
      return;
    }
    const slot = owner[y * imageWidth + x];
    if (slot > 0) selectId(ids[slot - 1], e.evt.shiftKey);
    else selectId(null);
  };

  // Set up the working canvas when brush tool becomes active
  useEffect(() => {
    if (activeTool !== "brush") {
      // Discard any unfinished paint
      if (workingRef.current) {
        const ctx = workingRef.current.getContext("2d");
        ctx.clearRect(
          0,
          0,
          workingRef.current.width,
          workingRef.current.height,
        );
      }
      isDrawing.current = false;
      setCursor(null);
      return;
    }
    if (!workingRef.current) {
      workingRef.current = document.createElement("canvas");
    }
    workingRef.current.width = imageWidth;
    workingRef.current.height = imageHeight;
    const ctx = workingRef.current.getContext("2d");
    ctx.clearRect(0, 0, imageWidth, imageHeight);
  }, [activeTool, imageWidth, imageHeight]);

  // Wire mouse events on the document — we read coords from Konva stage transform
  useEffect(() => {
    if (activeTool !== "brush") return;
    const onMove = (e) => {
      // Find the stage container in the DOM
      const stageEl = document.querySelector(".konvajs-content");
      if (!stageEl) return;
      const rect = stageEl.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { scale: s, offsetX, offsetY } = useEditor.getState();
      const rawX = (sx - offsetX) / s;
      const rawY = (sy - offsetY) / s;
      const { imageWidth: iw, imageHeight: ih } = useEditor.getState();
      if (!isInsideImage(rawX, rawY, iw, ih)) {
        setCursor(null);
        return;
      }
      const { x: ix, y: iy } = clampToImage(rawX, rawY, iw, ih);
      setCursor({ x: ix, y: iy });

      if (isDrawing.current && workingRef.current) {
        // Always record the dragged region solidly. Whether it ADDS to or
        // ERASES from a mask is decided at commit (onUp) from the `erase` flag,
        // so the same stroke can grow or shrink the selected mask.
        const ctx = workingRef.current.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = MASK_PURPLE;
        ctx.beginPath();
        ctx.arc(ix, iy, brushSize, 0, Math.PI * 2);
        ctx.fill();
        rerender((n) => n + 1);
      }
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      const stageEl = document.querySelector(".konvajs-content");
      if (!stageEl) return;
      const r = stageEl.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        return;
      const {
        scale: s,
        offsetX,
        offsetY,
        imageWidth: iw,
        imageHeight: ih,
      } = useEditor.getState();
      const rawX = (e.clientX - r.left - offsetX) / s;
      const rawY = (e.clientY - r.top - offsetY) / s;
      if (!isInsideImage(rawX, rawY, iw, ih)) return;
      isDrawing.current = true;
      onMove(e);
    };

    const onUp = async () => {
      if (!isDrawing.current || !workingRef.current) {
        isDrawing.current = false;
        return;
      }
      isDrawing.current = false;
      const iw = imageWidth;
      const ih = imageHeight;
      const working = workingRef.current;
      const clearWorking = () => {
        working.getContext("2d").clearRect(0, 0, iw, ih);
        rerender((n) => n + 1);
      };

      // The stroke region (solid) as RLE. Nothing painted → nothing to do.
      const strokeRle = rleEncodeFromCanvas(working);
      if (!strokeRle) {
        clearWorking();
        return;
      }

      // Read fresh state from the store (this handler's closure would otherwise
      // hold a stale annotations/selection snapshot).
      const {
        annotations: anns,
        selectedIds: selNow,
        activeLabelId: lblId,
      } = useEditor.getState();

      // Editing an existing mask? (exactly one mask selected)
      const selArr = [...selNow];
      const sel =
        selArr.length === 1
          ? anns.find((a) => a.id === selArr[0] && a.type === "mask")
          : null;

      if (sel) {
        // Merge the stroke into the selected mask: ADD (brush) or SUBTRACT
        // (erase). This is how you grow or shrink an existing mask.
        const merged = document.createElement("canvas");
        merged.width = iw;
        merged.height = ih;
        const mctx = merged.getContext("2d");
        const mk = rleDecode(sel.geometry.rle, sel.geometry.size);
        const base = mctx.createImageData(iw, ih);
        for (let i = 0; i < mk.length; i++) {
          if (mk[i]) base.data[i * 4 + 3] = 255;
        }
        mctx.putImageData(base, 0, 0);
        mctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
        mctx.drawImage(working, 0, 0);

        const rle = rleEncodeFromCanvas(merged);
        if (!rle) {
          // Erased the whole thing → remove the mask entirely.
          await push(makeDeleteCmd(sel));
        } else {
          await push(makeUpdateGeometryCmd(sel, { rle, size: [ih, iw] }));
        }
        clearWorking();
        return;
      }

      // No mask selected → create a new one. (Erasing on empty space is a no-op.)
      if (erase) {
        clearWorking();
        return;
      }
      if (lblId == null) {
        clearWorking();
        alert("Pick a label class first (right panel → type name → +).");
        return;
      }
      await push(
        makeCreateCmd({
          image_id: imageId,
          label_id: lblId,
          type: "mask",
          geometry: { rle: strokeRle, size: [ih, iw] },
          source: "manual",
        }),
      );
      clearWorking();
    };

    const onKey = (e) => {
      if (e.key === "[") setBrushSize((s) => Math.max(2, s - 2));
      if (e.key === "]") setBrushSize((s) => Math.min(200, s + 2));
      if (e.key.toLowerCase() === "x") setErase((v) => !v);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [activeTool, brushSize, erase, imageWidth, imageHeight]);

  return (
    <>
      {/* Composite of existing masks. It listens only in the select tool, so it
          can be clicked to select a mask without blocking the drawing tools. */}
      <Layer>
        {compositeRef.current && (
          <KImage
            ref={compositeNodeRef}
            image={compositeRef.current}
            listening={activeTool === "select"}
            onClick={onCompositeClick}
            onTap={onCompositeClick}
          />
        )}
        {workingRef.current && activeTool === "brush" && (
          <KImage image={workingRef.current} opacity={0.5} listening={false} />
        )}
        {activeTool === "brush" && cursor && (
          <Circle
            x={cursor.x}
            y={cursor.y}
            radius={brushSize}
            stroke={erase ? "#ef4444" : "#fff"}
            strokeWidth={1.5 / scale}
            dash={[4 / scale, 3 / scale]}
            listening={false}
          />
        )}
      </Layer>
    </>
  );
}
