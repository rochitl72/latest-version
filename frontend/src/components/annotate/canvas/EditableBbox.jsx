// Editable bbox — drag body to move, drag any of 8 handles to resize.
// All math is in IMAGE PIXEL space; conversion to/from normalized happens
// in the parent canvas at create/save time.
//
// ─── Why the drag is written this way ───────────────────────────────
// The shape used to update React state on every onDragMove. That state write
// re-rendered the Rect, and react-konva then assigned x/y back onto the very
// node Konva was mid-drag on. React 18 batches renders, so the write landed a
// frame late carrying a stale value, and Konva's next drag step — which works
// from the node's current position plus the pointer delta — compounded the
// error. The shape drifted further from the cursor the longer you dragged.
//
// Konva already moves the node itself, so React does not need to re-render for
// the shape to follow the pointer. The whole Group is now draggable (so the
// outline, its label and the handles all travel together), nothing is written
// to state during the drag, and the new geometry is committed once on release.

import { Group, Rect, Text } from "react-konva";
import { maskFill, maskStroke } from "../../../utils/colors";

export default function EditableBbox({
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

  // Geometry is stored normalized → render in pixels
  const g = ann.geometry;
  const x = g.x * imageWidth;
  const y = g.y * imageHeight;
  const w = g.w * imageWidth;
  const h = g.h * imageHeight;

  const normalize = (px, py, pw, ph) => ({
    x: px / imageWidth,
    y: py / imageHeight,
    w: Math.max(0.001, Math.min(1, pw / imageWidth)),
    h: Math.max(0.001, Math.min(1, ph / imageHeight)),
  });

  // ─── Moving the whole box ──────────────────────────────────────────
  // The Group starts at (0,0) and its children sit at absolute image
  // coordinates, so a drag offsets everything by (dx, dy). Konva is left in
  // sole control of the node position for the duration.
  //
  // Normal function: Konva binds `this` to the dragged node.
  function bodyDragBound(pos) {
    const parent = this.getParent();
    if (!parent) return pos;
    const toLocal = parent.getAbsoluteTransform().copy().invert();
    const p = toLocal.point(pos);
    // Allowed offsets keep the box fully on the image.
    const dx = Math.max(-x, Math.min(imageWidth - w - x, p.x));
    const dy = Math.max(-y, Math.min(imageHeight - h - y, p.y));
    return parent.getAbsoluteTransform().point({ x: dx, y: dy });
  }

  // Snapshot the original geometry for undo without altering anything: the
  // parent stores the first value it sees during a gesture.
  const handleDragStart = () => onChange(g);

  const handleDragEnd = (e) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 }); // children carry the new absolute position
    onChangeEnd(normalize(x + dx, y + dy, w, h));
  };

  // ─── Resizing ──────────────────────────────────────────────────────
  // Handles keep live feedback — you need to see the box follow as you drag a
  // corner. That is safe because a handle's re-rendered position is derived
  // from where you dragged it, so there is nothing to fight. Containment lives
  // in each handle's dragBoundFunc rather than in the state write, for the
  // same reason as above.
  const handleBound = (which) =>
    function (pos) {
      const parent = this.getParent();
      if (!parent) return pos;
      const toLocal = parent.getAbsoluteTransform().copy().invert();
      const p = toLocal.point(pos);
      let px = Math.max(0, Math.min(imageWidth, p.x));
      let py = Math.max(0, Math.min(imageHeight, p.y));
      // Edge handles move on one axis only — lock the other so the handle
      // cannot wander off the edge it belongs to.
      if (which === "n" || which === "s") px = which === "n" ? x + w / 2 : x + w / 2;
      if (which === "e" || which === "w") py = y + h / 2;
      return parent.getAbsoluteTransform().point({ x: px, y: py });
    };

  const handleResize = (which, e, commit) => {
    const px = e.target.x();
    const py = e.target.y();
    let nx = x,
      ny = y,
      nw = w,
      nh = h;
    switch (which) {
      case "nw":
        nx = px; ny = py; nw = x + w - px; nh = y + h - py; break;
      case "n":
        ny = py; nh = y + h - py; break;
      case "ne":
        ny = py; nw = px - x; nh = y + h - py; break;
      case "w":
        nx = px; nw = x + w - px; break;
      case "e":
        nw = px - x; break;
      case "sw":
        nx = px; nw = x + w - px; nh = py - y; break;
      case "s":
        nh = py - y; break;
      case "se":
        nw = px - x; nh = py - y; break;
    }
    // Guard against inverting the box; position is already bounded above.
    const minPx = 4;
    if (nw < minPx) { nw = minPx; if (nx > x) nx = x + w - minPx; }
    if (nh < minPx) { nh = minPx; if (ny > y) ny = y + h - minPx; }

    const g2 = normalize(nx, ny, nw, nh);
    if (commit) onChangeEnd(g2);
    else onChange(g2);
  };

  const handleSize = 8 / scale;
  const strokeW = 2 / scale;
  const labelOffset = 16 / scale;

  const CURSORS = {
    nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize",
    w: "ew-resize", e: "ew-resize",
    sw: "nesw-resize", s: "ns-resize", se: "nwse-resize",
  };

  return (
    <Group
      onClick={onSelect}
      draggable={selected && !readOnly}
      dragBoundFunc={bodyDragBound}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <Rect
        x={x}
        y={y}
        width={w}
        height={h}
        stroke={color}
        strokeWidth={strokeW}
        fill={fill}
        dash={selected ? [8 / scale, 4 / scale] : undefined}
      />

      {label && (
        <Text
          x={x}
          y={y - labelOffset}
          text={label.name}
          fontSize={12 / scale}
          fill={color}
          fontStyle="bold"
          listening={false}
        />
      )}

      {/* 8 resize handles — only when selected and editable */}
      {selected && !readOnly && (
        <>
          {[
            ["nw", x, y],
            ["n", x + w / 2, y],
            ["ne", x + w, y],
            ["w", x, y + h / 2],
            ["e", x + w, y + h / 2],
            ["sw", x, y + h],
            ["s", x + w / 2, y + h],
            ["se", x + w, y + h],
          ].map(([which, hx, hy]) => (
            <Rect
              key={which}
              x={hx}
              y={hy}
              width={handleSize}
              height={handleSize}
              offsetX={handleSize / 2}
              offsetY={handleSize / 2}
              fill="#fff"
              stroke={color}
              strokeWidth={1.5 / scale}
              draggable
              dragBoundFunc={handleBound(which)}
              onDragStart={() => onChange(g)}
              onDragMove={(e) => handleResize(which, e, false)}
              onDragEnd={(e) => handleResize(which, e, true)}
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = CURSORS[which];
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "default";
              }}
            />
          ))}
        </>
      )}
    </Group>
  );
}
