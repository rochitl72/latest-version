// EditableKeypoint.jsx — Konva layer for a keypoint/skeleton annotation.
// Renders points and skeleton edges; each point is draggable. All coordinates
// are converted between normalized (0-1) and image-pixel space.

import { Group, Line, Circle, Text } from "react-konva";

export default function EditableKeypoint({
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
  const color = label?.color || "#6B4EFF";
  const pts = ann.geometry?.points || [];
  const edges = label?.skeleton_edges || [];

  const toNorm = (pxPts) => ({
    points: pxPts.map((p) => ({
      name: p.name,
      x: p.x / imageWidth,
      y: p.y / imageHeight,
      v: p.v,
    })),
  });

  const px = pts.map((p) => ({
    ...p,
    x: p.x * imageWidth,
    y: p.y * imageHeight,
  }));

  const lines = [];
  for (const [a, b] of edges) {
    if (px[a] && px[b]) lines.push(px[a].x, px[a].y, px[b].x, px[b].y);
  }

  const onVertexDrag = (i, e, commit) => {
    const newPx = px.map((p, idx) =>
      idx === i ? { ...p, x: e.target.x(), y: e.target.y() } : p,
    );
    const geo = toNorm(newPx);
    if (commit) onChangeEnd(geo);
    else onChange(geo);
  };

  return (
    <Group onClick={onSelect}>
      {lines.length > 0 && (
        <Line
          points={lines}
          stroke={color}
          strokeWidth={2 / scale}
          opacity={0.85}
        />
      )}
      {px.map((p, i) => (
        <Circle
          key={i}
          x={p.x}
          y={p.y}
          radius={selected ? 7 / scale : 5 / scale}
          fill={p.v === 0 ? "#444" : color}
          stroke="#fff"
          strokeWidth={1.5 / scale}
          draggable={selected && !readOnly}
          onDragMove={(e) => onVertexDrag(i, e, false)}
          onDragEnd={(e) => onVertexDrag(i, e, true)}
        />
      ))}
      {label && px[0] && (
        <Text
          x={px[0].x}
          y={px[0].y - 16 / scale}
          text={label.name}
          fontSize={11 / scale}
          fill={color}
          listening={false}
        />
      )}
    </Group>
  );
}
