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

  const normalize = (px, py, pw, ph) => ({
    x: Math.max(0, Math.min(1, px / imageWidth)),
    y: Math.max(0, Math.min(1, py / imageHeight)),
    w: Math.max(0.001, Math.min(1, pw / imageWidth)),
    h: Math.max(0.001, Math.min(1, ph / imageHeight)),
  });

  const handleBodyDrag = (e) => {
    const node = e.target;
    const nx = node.x();
    const ny = node.y();
    onChange(normalize(nx, ny, w, h));
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
    // Prevent flip
    if (nw < 4) nw = 4;
    if (nh < 4) nh = 4;
    const g2 = normalize(nx, ny, nw, nh);
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
        draggable={selected}
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
              draggable
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
