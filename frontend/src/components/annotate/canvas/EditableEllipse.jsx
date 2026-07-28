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

  // Same approach as EditableBbox: let Konva apply the constraint during the
  // drag so the node and the pointer can never drift apart. Clamping inside
  // onDragMove instead would write the clamped value back to state mid-drag
  // and permanently offset the shape from the cursor.
  //
  // Normal function: Konva binds `this` to the dragged node.
  function dragBoundFunc(pos) {
    const parent = this.getParent();
    if (!parent) return pos;
    const toLocal = parent.getAbsoluteTransform().copy().invert();
    const p = toLocal.point(pos);
    // The ellipse is positioned by its CENTRE, so the limits are inset by the
    // radii — that keeps the whole shape on the image.
    const nx = Math.max(rx, Math.min(imageWidth - rx, p.x));
    const ny = Math.max(ry, Math.min(imageHeight - ry, p.y));
    return parent.getAbsoluteTransform().point({ x: nx, y: ny });
  }

  const onBodyDrag = (e, commit) => {
    const geo = normalize(e.target.x(), e.target.y(), rx, ry);
    if (commit) onChangeEnd(geo);
    else onChange(geo);
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

    // Don't let a resize push the shape off the image.
    nrx = Math.max(2, Math.min(nrx, Math.min(cx, imageWidth - cx)));
    nry = Math.max(2, Math.min(nry, Math.min(cy, imageHeight - cy)));

    const geo = normalize(cx, cy, nrx, nry);
    if (commit) onChangeEnd(geo);
    else onChange(geo);
  };

  const handleSize = 8 / scale;
  const strokeW = 2 / scale;

  const CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

  return (
    <Group onClick={onSelect}>
      <Ellipse
        x={cx}
        y={cy}
        radiusX={rx}
        radiusY={ry}
        stroke={color}
        strokeWidth={strokeW}
        fill={fill}
        dash={selected ? [8 / scale, 4 / scale] : undefined}
        draggable={selected && !readOnly}
        dragBoundFunc={dragBoundFunc}
        onDragMove={(e) => onBodyDrag(e, false)}
        onDragEnd={(e) => onBodyDrag(e, true)}
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

      {selected && (
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
              draggable={!readOnly}
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
