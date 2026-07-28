// Editable bbox — drag body to move, drag any of 8 handles to resize.
// All math is in IMAGE PIXEL space; conversion to/from normalized happens
// in the parent canvas at create/save time.

import { useRef } from "react";
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

  // Track drag state to compute new dims live
  const startRef = useRef(null);

  // Pixels → normalized. Deliberately does NOT clamp the position.
  //
  // It used to clamp x/y into [0,1], and that broke dragging: onDragMove wrote
  // the clamped value straight back to state, React re-rendered the Rect at
  // that clamped position while Konva was still dragging it, and from then on
  // the shape sat at a fixed offset from the cursor for the rest of the drag.
  // The bound was wrong too — clamping the ORIGIN to 1.0 ignores the box's own
  // width, so a box could end up almost entirely off the image.
  //
  // Containment is now enforced by dragBoundFunc below (for moves) and by
  // clampBox (for resizes), both of which keep the node and the pointer in
  // agreement.
  const normalize = (px, py, pw, ph) => ({
    x: px / imageWidth,
    y: py / imageHeight,
    w: Math.max(0.001, Math.min(1, pw / imageWidth)),
    h: Math.max(0.001, Math.min(1, ph / imageHeight)),
  });

  /** Keep the WHOLE box inside the image (used by the resize path). */
  const clampBox = (px, py, pw, ph) => {
    const cw = Math.max(4, Math.min(imageWidth, pw));
    const ch = Math.max(4, Math.min(imageHeight, ph));
    return {
      px: Math.max(0, Math.min(imageWidth - cw, px)),
      py: Math.max(0, Math.min(imageHeight - ch, py)),
      pw: cw,
      ph: ch,
    };
  };

  // Konva calls this during a drag with the proposed ABSOLUTE (stage) position
  // and uses whatever we return, so the node can never leave the image and the
  // pointer stays locked to it. Converting through the parent's absolute
  // transform makes it correct at any zoom or pan offset.
  //
  // Must be a normal function: Konva binds `this` to the dragged node.
  function dragBoundFunc(pos) {
    const parent = this.getParent();
    if (!parent) return pos;
    const toLocal = parent.getAbsoluteTransform().copy().invert();
    const local = toLocal.point(pos);
    const cx = Math.max(0, Math.min(imageWidth - w, local.x));
    const cy = Math.max(0, Math.min(imageHeight - h, local.y));
    return parent.getAbsoluteTransform().point({ x: cx, y: cy });
  }

  const handleBodyDrag = (e) => {
    const node = e.target;
    onChange(normalize(node.x(), node.y(), w, h));
  };
  const handleBodyDragEnd = (e) => {
    const node = e.target;
    onChangeEnd(normalize(node.x(), node.y(), w, h));
  };

  // Resize handle drag → compute new x/y/w/h from corner
  const handleResize = (which, e, commit) => {
    const px = e.target.x();
    const py = e.target.y();
    let nx = x,
      ny = y,
      nw = w,
      nh = h;
    switch (which) {
      case "nw":
        nx = px;
        ny = py;
        nw = x + w - px;
        nh = y + h - py;
        break;
      case "n":
        ny = py;
        nh = y + h - py;
        break;
      case "ne":
        ny = py;
        nw = px - x;
        nh = y + h - py;
        break;
      case "w":
        nx = px;
        nw = x + w - px;
        break;
      case "e":
        nw = px - x;
        break;
      case "sw":
        nx = px;
        nw = x + w - px;
        nh = py - y;
        break;
      case "s":
        nh = py - y;
        break;
      case "se":
        nw = px - x;
        nh = py - y;
        break;
    }
    // Prevent flip, and keep the resized box inside the image.
    const c = clampBox(nx, ny, nw, nh);
    const g2 = normalize(c.px, c.py, c.pw, c.ph);
    if (commit) onChangeEnd(g2);
    else onChange(g2);
  };

  const handleSize = 8 / scale;
  const strokeW = 2 / scale;
  const labelOffset = 16 / scale;

  return (
    <Group onClick={onSelect}>
      <Rect
        x={x}
        y={y}
        width={w}
        height={h}
        stroke={color}
        strokeWidth={strokeW}
        fill={fill}
        draggable={selected && !readOnly}
        dragBoundFunc={dragBoundFunc}
        onDragMove={handleBodyDrag}
        onDragEnd={handleBodyDragEnd}
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

      {/* 8 resize handles — only when selected */}
      {selected && (
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
          ].map(([h, hx, hy]) => (
            <Rect
              key={h}
              x={hx}
              y={hy}
              width={handleSize}
              height={handleSize}
              offsetX={handleSize / 2}
              offsetY={handleSize / 2}
              fill="#fff"
              stroke={color}
              strokeWidth={1.5 / scale}
              draggable={!readOnly}
              onDragMove={(e) => handleResize(h, e, false)}
              onDragEnd={(e) => handleResize(h, e, true)}
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) {
                  const cursors = {
                    nw: "nwse-resize",
                    n: "ns-resize",
                    ne: "nesw-resize",
                    w: "ew-resize",
                    e: "ew-resize",
                    sw: "nesw-resize",
                    s: "ns-resize",
                    se: "nwse-resize",
                    body: "move",
                  };
                  stage.container().style.cursor = cursors[h];
                }
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
