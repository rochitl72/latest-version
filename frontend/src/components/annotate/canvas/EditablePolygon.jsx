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
  const onBodyDrag = (e, commit) => {
    const dx = e.target.x();
    const dy = e.target.y();
    const newPts = ptsPx.map(([x, y]) => [x + dx, y + dy]);
    if (commit) {
      onChangeEnd({ points: polyToNorm(newPts, imageWidth, imageHeight) });
      e.target.position({ x: 0, y: 0 });
    } else {
      onChange({ points: polyToNorm(newPts, imageWidth, imageHeight) });
      e.target.position({ x: 0, y: 0 });
    }
  };

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
        draggable={selected}
        onDragMove={(e) => onBodyDrag(e, false)}
        onDragEnd={(e) => onBodyDrag(e, true)}
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
            draggable
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
