// Editable ellipse — drag body to move, drag any of 4 handles to resize.
//
// Mirrors EditableBbox deliberately: before this existed, an ellipse could be
// drawn but never moved or resized, while boxes and polygons could. Every
// shape type now behaves the same way — select it, drag the body, drag the
// handles — so the tool behaves predictably whichever one you reach for.
//
// Geometry: {cx, cy, rx, ry}, all normalized 0..1. Rendered in image pixels.

import { Group, Ellipse, Rect, Text } from "react-konva";
import { maskFill, maskStroke } from "../../../utils/colors";

export default function EditableEllipse({
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

  const g = ann.geometry;
  const cx = g.cx * imageWidth;
  const cy = g.cy * imageHeight;
  const rx = g.rx * imageWidth;
  const ry = g.ry * imageHeight;

  const normalize = (ncx, ncy, nrx, nry) => ({
    cx: ncx / imageWidth,
    cy: ncy / imageHeight,
    rx: Math.max(0.0005, Math.min(0.5, nrx / imageWidth)),
    ry: Math.max(0.0005, Math.min(0.5, nry / imageHeight)),
  });

  // Moving: the whole Group is dragged so the outline, label and handles
  // travel together, and NOTHING is written to state until release. Writing
  // during onDragMove made React assign x/y back onto the node Konva was
  // dragging, which drifted the shape away from the cursor — see the long
  // comment in EditableBbox.
  //
  // Normal function: Konva binds `this` to the dragged node.
  function bodyDragBound(pos) {
    const parent = this.getParent();
    if (!parent) return pos;
    const toLocal = parent.getAbsoluteTransform().copy().invert();
    const p = toLocal.point(pos);
    // Group offsets, bounded so the ellipse stays fully on the image. It is
    // positioned by its CENTRE, so the limits are inset by the radii.
    const dx = Math.max(rx - cx, Math.min(imageWidth - rx - cx, p.x));
    const dy = Math.max(ry - cy, Math.min(imageHeight - ry - cy, p.y));
    return parent.getAbsoluteTransform().point({ x: dx, y: dy });
  }

  const handleDragStart = () => onChange(g);

  const handleDragEnd = (e) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 });
    onChangeEnd(normalize(cx + dx, cy + dy, rx, ry));
  };

  // Handles sit at the four cardinal points. Dragging one changes that radius
  // only, keeping the centre fixed — the behaviour people expect from an
  // ellipse, and the analogue of the bbox edge handles.
  const onHandleDrag = (which, e, commit) => {
    const hx = e.target.x();
    const hy = e.target.y();
    let nrx = rx;
    let nry = ry;
    if (which === "e") nrx = Math.abs(hx - cx);
    if (which === "w") nrx = Math.abs(cx - hx);
    if (which === "s") nry = Math.abs(hy - cy);
    if (which === "n") nry = Math.abs(cy - hy);

    nrx = Math.max(2, nrx);
    nry = Math.max(2, nry);

    const geo = normalize(cx, cy, nrx, nry);
    if (commit) onChangeEnd(geo);
    else onChange(geo);
  };

  // Each cardinal handle is locked to its own axis, and bounded so a resize
  // cannot push the ellipse off the image.
  const handleBound = (which) =>
    function (pos) {
      const parent = this.getParent();
      if (!parent) return pos;
      const toLocal = parent.getAbsoluteTransform().copy().invert();
      const p = toLocal.point(pos);
      let px = cx;
      let py = cy;
      if (which === "e") px = Math.min(imageWidth, Math.max(cx + 2, p.x));
      if (which === "w") px = Math.max(0, Math.min(cx - 2, p.x));
      if (which === "s") py = Math.min(imageHeight, Math.max(cy + 2, p.y));
      if (which === "n") py = Math.max(0, Math.min(cy - 2, p.y));
      return parent.getAbsoluteTransform().point({ x: px, y: py });
    };

  const handleSize = 8 / scale;
  const strokeW = 2 / scale;

  const CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

  return (
    <Group
      onClick={onSelect}
      draggable={selected && !readOnly}
      dragBoundFunc={bodyDragBound}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <Ellipse
        x={cx}
        y={cy}
        radiusX={rx}
        radiusY={ry}
        stroke={color}
        strokeWidth={strokeW}
        fill={fill}
        dash={selected ? [8 / scale, 4 / scale] : undefined}
      />

      {label && (
        <Text
          x={cx - rx}
          y={cy - ry - 16 / scale}
          text={label.name}
          fontSize={12 / scale}
          fill={color}
          fontStyle="bold"
          listening={false}
        />
      )}

      {selected && !readOnly && (
        <>
          {[
            ["n", cx, cy - ry],
            ["s", cx, cy + ry],
            ["w", cx - rx, cy],
            ["e", cx + rx, cy],
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
              onDragMove={(e) => onHandleDrag(which, e, false)}
              onDragEnd={(e) => onHandleDrag(which, e, true)}
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
