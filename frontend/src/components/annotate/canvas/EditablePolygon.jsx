// Editable polygon — drag any vertex to reshape.
//
// Interactions when selected:
//   • Drag a vertex        → move it
//   • Alt-click a vertex   → delete it (min 3 vertices stays)
//   • Click an edge        → insert a new vertex at the click point
//   • Double-click anywhere on the shape → insert a new vertex on the nearest
//                            edge at that point, immediately draggable
//   • Drag the body        → translate whole polygon

import { Group, Line, Text, Rect } from "react-konva";
import { polyToPixel, polyToNorm, flatten } from "../../../utils/geometry";
import { maskFill, maskStroke } from "../../../utils/colors";

// Distance from point p to segment a→b, plus which segment index it belongs to.
// Used to work out where a double-click should insert a new vertex.
function distToSegment(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export default function EditablePolygon({
  ann,
  label,
  imageWidth,
  imageHeight,
  scale,
  selected,
  readOnly,
  onSelect,
  onChange,
  onChangeEnd,
}) {
  const color = maskStroke(label?.color, selected);
  const fill = maskFill(label?.color, selected);
  const ptsNorm = ann.geometry.points || [];
  const ptsPx = polyToPixel(ptsNorm, imageWidth, imageHeight);

  if (ptsPx.length === 0) return null;

  const handleSize = 6 / scale;
  const strokeW = 2 / scale;

  // Convert a pointer event to image-pixel coordinates, accounting for the
  // stage's current zoom/pan. Used by the double-click insert.
  const pointerToImage = (e) => {
    const stage = e.target.getStage();
    if (!stage) return null;
    const transform = stage.getAbsoluteTransform().copy().invert();
    return transform.point(stage.getPointerPosition());
  };

  // Drag a single vertex. The handle Rect is drawn centred on the vertex via
  // its offset, so e.target.x()/y() already IS the vertex position — no manual
  // half-handle correction (getting that wrong is what made dragging drift).
  const onVertexDrag = (i, e, commit) => {
    const newPts = ptsPx.map((p, idx) =>
      idx === i ? [e.target.x(), e.target.y()] : p,
    );
    const norm = polyToNorm(newPts, imageWidth, imageHeight);
    if (commit) onChangeEnd({ points: norm });
    else onChange({ points: norm });
  };

  // Insert a new vertex at an arbitrary point, on whichever edge is closest —
  // this is what a double-click on the shape does. Returns nothing; commits
  // the new geometry so the extra handle appears and can be dragged right away.
  const insertVertexAtPoint = (local) => {
    if (!local) return;
    const p = [local.x, local.y];
    let bestSeg = 0;
    let bestDist = Infinity;
    for (let i = 0; i < ptsPx.length; i++) {
      const next = ptsPx[(i + 1) % ptsPx.length];
      const d = distToSegment(p, ptsPx[i], next);
      if (d < bestDist) {
        bestDist = d;
        bestSeg = i;
      }
    }
    const newPts = [
      ...ptsPx.slice(0, bestSeg + 1),
      p,
      ...ptsPx.slice(bestSeg + 1),
    ];
    onChangeEnd({ points: polyToNorm(newPts, imageWidth, imageHeight) });
  };

  const onBodyDblClick = (e) => {
    e.cancelBubble = true;
    onSelect?.(e);
    insertVertexAtPoint(pointerToImage(e));
  };

  // Alt-click vertex → delete (must keep ≥3 points)
  const onVertexClick = (i, e) => {
    if (e.evt.altKey && ptsPx.length > 3) {
      const newPts = ptsPx.filter((_, idx) => idx !== i);
      onChangeEnd({ points: polyToNorm(newPts, imageWidth, imageHeight) });
      e.cancelBubble = true;
    }
  };

  // Double-click directly on an edge → insert a vertex on THAT exact edge
  // (more precise than the nearest-edge body double-click).
  const onEdgeDblClick = (segIdx, e) => {
    if (!selected) return;
    e.cancelBubble = true;
    const local = pointerToImage(e);
    if (!local) return;
    const newPt = [local.x, local.y];
    const newPts = [
      ...ptsPx.slice(0, segIdx + 1),
      newPt,
      ...ptsPx.slice(segIdx + 1),
    ];
    onChangeEnd({ points: polyToNorm(newPts, imageWidth, imageHeight) });
  };

  // Body drag — translate whole polygon
  // Moving the polygon.
  //
  // This used to recompute every point AND reset the node position on each
  // onDragMove. That wrote to React state mid-drag, which re-rendered the Line
  // and reset the node underneath Konva on every frame — the same fight that
  // made the bbox drift away from the cursor (see EditableBbox for the full
  // explanation). Konva now owns the node position for the whole gesture and
  // the points are recomputed exactly once, on release.
  const onBodyDragStart = () => onChange(ann.geometry);

  const onBodyDragEnd = (e) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 }); // the recomputed points carry the offset
    const newPts = ptsPx.map(([x, y]) => [x + dx, y + dy]);
    onChangeEnd({ points: polyToNorm(newPts, imageWidth, imageHeight) });
  };

  // Keep the whole polygon on the image while dragging.
  function bodyDragBound(pos) {
    const parent = this.getParent();
    if (!parent) return pos;
    const xs = ptsPx.map((p) => p[0]);
    const ys = ptsPx.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const toLocal = parent.getAbsoluteTransform().copy().invert();
    const p = toLocal.point(pos);
    const dx = Math.max(-minX, Math.min(imageWidth - maxX, p.x));
    const dy = Math.max(-minY, Math.min(imageHeight - maxY, p.y));
    return parent.getAbsoluteTransform().point({ x: dx, y: dy });
  }

  return (
    <Group>
      {/* Filled body */}
      <Line
        points={flatten(ptsPx)}
        stroke={color}
        strokeWidth={strokeW}
        fill={fill}
        closed
        dash={selected ? [8 / scale, 4 / scale] : undefined}
        onClick={onSelect}
        onDblClick={onBodyDblClick}
        draggable={selected && !readOnly}
        dragBoundFunc={bodyDragBound}
        onDragStart={onBodyDragStart}
        onDragEnd={onBodyDragEnd}
      />

      {/* Label text */}
      {label && (
        <Text
          x={ptsPx[0][0]}
          y={ptsPx[0][1] - 16 / scale}
          text={label.name}
          fontSize={12 / scale}
          fill={color}
          fontStyle="bold"
          listening={false}
        />
      )}

      {/* Edge insertion hotzones — invisible thick lines on top */}
      {selected &&
        ptsPx.map((p, i) => {
          const next = ptsPx[(i + 1) % ptsPx.length];
          return (
            <Line
              key={`edge-${i}`}
              points={[p[0], p[1], next[0], next[1]]}
              stroke="transparent"
              strokeWidth={12 / scale}
              onClick={onSelect}
              onDblClick={(e) => onEdgeDblClick(i, e)}
              onMouseEnter={(e) => {
                const s = e.target.getStage();
                if (s) s.container().style.cursor = "copy";
              }}
              onMouseLeave={(e) => {
                const s = e.target.getStage();
                if (s) s.container().style.cursor = "default";
              }}
            />
          );
        })}

      {/* Vertex handles */}
      {selected &&
        ptsPx.map(([px, py], i) => (
          <Rect
            key={`v-${i}`}
            x={px}
            y={py}
            width={handleSize * 2}
            height={handleSize * 2}
            offsetX={handleSize}
            offsetY={handleSize}
            fill="#fff"
            stroke={color}
            strokeWidth={1.5 / scale}
            draggable={!readOnly}
            onDragMove={(e) => onVertexDrag(i, e, false)}
            onDragEnd={(e) => onVertexDrag(i, e, true)}
            onClick={(e) => onVertexClick(i, e)}
            onMouseEnter={(e) => {
              const s = e.target.getStage();
              if (s) {
                s.container().style.cursor = e.evt.altKey
                  ? "not-allowed"
                  : "move";
              }
            }}
            onMouseLeave={(e) => {
              const s = e.target.getStage();
              if (s) s.container().style.cursor = "default";
            }}
          />
        ))}
    </Group>
  );
}
