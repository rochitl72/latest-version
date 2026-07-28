// ToolHintBar.jsx — contextual how-to hints for the active drawing tool.
// The HINTS map holds the step-by-step text shown for polygon/brush/bbox/etc.

const HINTS = {
  polygon: {
    title: "Polygon tool",
    steps: [
      "Click each corner of the object.",
      "Scroll to pan · ⌘+scroll to zoom · Space+drag to pan.",
      "Click Finish (or double-click / Enter) when you have at least 3 points.",
    ],
  },
  brush: {
    title: "Brush mask",
    steps: ["Click and drag to paint.", "[ ] change size · X = erase."],
  },
  bbox: {
    title: "Bounding box",
    steps: ["Click and drag to draw a rectangle."],
  },
  keypoint: {
    title: "Keypoints",
    steps: ["Click to place each joint.", "Press Enter or Finish when done."],
  },
};

export default function ToolHintBar({ tool, hasLabel, embedded }) {
  const hint = HINTS[tool];
  if (!hint) return null;

  return (
    <div className={`tool-hint-bar ${embedded ? "embedded" : ""}`}>
      <strong>{hint.title}</strong>
      {!hasLabel && (
        <span className="hint-warn">
          Add a label class first (right panel → +)
        </span>
      )}
      <ul>
        {hint.steps.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
