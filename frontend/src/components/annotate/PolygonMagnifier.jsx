// PolygonMagnifier.jsx — a loupe / zoom overlay for precise polygon clicking.
// Input:   the source image and the cursor position over it.
// Process: samples a small SIZE x SIZE region around the cursor and scales up.
// Output:  a floating magnified view with a crosshair + zoom controls, so
//          vertices can be placed accurately on high-resolution images.

import { useEffect, useRef } from "react";
import useImage from "use-image";
import { Minus, Plus } from "lucide-react";

const SIZE = 112;

export const MAGNIFIER_ZOOM_MIN = 2;
export const MAGNIFIER_ZOOM_MAX = 14;
export const MAGNIFIER_ZOOM_DEFAULT = 5;
const ZOOM_PRESETS = [3, 5, 8, 12];

/** Map image pixel → loupe canvas pixel (viewport centered on point). */
function makeToLoupe(sx, sy, srcW, srcH) {
  return (ix, iy) => ({
    x: ((ix - sx) / srcW) * SIZE,
    y: ((iy - sy) / srcH) * SIZE,
  });
}

export default function PolygonMagnifier({
  imageUrl,
  point,
  imageWidth,
  imageHeight,
  draftPolygon,
  strokeColor = "#6B4EFF",
  zoom,
  onZoomChange,
}) {
  const [img] = useImage(imageUrl);
  const canvasRef = useRef(null);

  const setZoom = (z) => {
    onZoomChange(Math.min(MAGNIFIER_ZOOM_MAX, Math.max(MAGNIFIER_ZOOM_MIN, z)));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || !point || imageWidth < 1 || imageHeight < 1) return;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(SIZE * dpr);
    canvas.width = px;
    canvas.height = px;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const srcW = SIZE / zoom;
    const srcH = SIZE / zoom;
    const sx = point.x - srcW / 2;
    const sy = point.y - srcH / 2;

    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, SIZE, SIZE);

    const ix0 = Math.max(0, sx);
    const iy0 = Math.max(0, sy);
    const ix1 = Math.min(imageWidth, sx + srcW);
    const iy1 = Math.min(imageHeight, sy + srcH);

    if (ix1 > ix0 && iy1 > iy0) {
      const cropW = ix1 - ix0;
      const cropH = iy1 - iy0;
      const dx = ((ix0 - sx) / srcW) * SIZE;
      const dy = ((iy0 - sy) / srcH) * SIZE;
      const dw = (cropW / srcW) * SIZE;
      const dh = (cropH / srcH) * SIZE;
      ctx.drawImage(img, ix0, iy0, cropW, cropH, dx, dy, dw, dh);
    }

    const toLoupe = makeToLoupe(sx, sy, srcW, srcH);
    const cx = SIZE / 2;
    const cy = SIZE / 2;

    if (draftPolygon.length > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const first = toLoupe(draftPolygon[0][0], draftPolygon[0][1]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < draftPolygon.length; i++) {
        const pt = toLoupe(draftPolygon[i][0], draftPolygon[i][1]);
        ctx.lineTo(pt.x, pt.y);
      }
      const cur = toLoupe(point.x, point.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();

      ctx.fillStyle = strokeColor;
      for (const [px, py] of draftPolygon) {
        const pt = toLoupe(px, py);
        if (pt.x < -8 || pt.x > SIZE + 8 || pt.y < -8 || pt.y > SIZE + 8)
          continue;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, SIZE);
    ctx.moveTo(0, cy);
    ctx.lineTo(SIZE, cy);
    ctx.stroke();

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }, [img, point, imageWidth, imageHeight, draftPolygon, strokeColor, zoom]);

  const zoomLabel = Number.isInteger(zoom) ? `${zoom}×` : `${zoom.toFixed(1)}×`;
  const sliderPct =
    ((zoom - MAGNIFIER_ZOOM_MIN) / (MAGNIFIER_ZOOM_MAX - MAGNIFIER_ZOOM_MIN)) *
    100;

  const hasImageInLoupe =
    point &&
    imageWidth > 0 &&
    imageHeight > 0 &&
    point.x + SIZE / zoom / 2 > 0 &&
    point.y + SIZE / zoom / 2 > 0 &&
    point.x - SIZE / zoom / 2 < imageWidth &&
    point.y - SIZE / zoom / 2 < imageHeight;

  return (
    <div className="polygon-magnifier-wrap">
      <div
        className={`polygon-magnifier ${hasImageInLoupe ? "" : "polygon-magnifier-idle"}`}
        title="Live magnified view at cursor"
      >
        <canvas ref={canvasRef} className="polygon-magnifier-canvas" />
        {!point && (
          <span className="polygon-magnifier-hint">Move on canvas</span>
        )}
        <span className="polygon-magnifier-label">{zoomLabel}</span>
      </div>

      <div className="polygon-magnifier-controls">
        <div className="polygon-magnifier-zoom-row">
          <button
            type="button"
            className="polygon-magnifier-step"
            onClick={() => setZoom(zoom - 1)}
            disabled={zoom <= MAGNIFIER_ZOOM_MIN}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus size={14} />
          </button>
          <div className="polygon-magnifier-slider-wrap">
            <input
              type="range"
              className="polygon-magnifier-slider"
              min={MAGNIFIER_ZOOM_MIN}
              max={MAGNIFIER_ZOOM_MAX}
              step={1}
              value={Math.round(zoom)}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ "--pct": `${sliderPct}%` }}
              aria-label="Magnification level"
            />
          </div>
          <button
            type="button"
            className="polygon-magnifier-step"
            onClick={() => setZoom(zoom + 1)}
            disabled={zoom >= MAGNIFIER_ZOOM_MAX}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus size={14} />
          </button>
          <span className="polygon-magnifier-zoom-val">{zoomLabel}</span>
        </div>
        <div className="polygon-magnifier-presets">
          {ZOOM_PRESETS.map((z) => (
            <button
              key={z}
              type="button"
              className={`polygon-magnifier-preset ${Math.round(zoom) === z ? "active" : ""}`}
              onClick={() => setZoom(z)}
            >
              {z}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
