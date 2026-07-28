/** Roboflow-style purple for all annotation masks & shapes on canvas. */
export const MASK_PURPLE = "#6B4EFF";
export const MASK_PURPLE_DARK = "#5A3FE0";

export function maskStroke(_labelColor, selected = false) {
  return selected ? MASK_PURPLE_DARK : MASK_PURPLE;
}

export function maskFill(_labelColor, selected = false) {
  return selected ? MASK_PURPLE + "99" : MASK_PURPLE + "66";
}

/** Default palette when creating new label classes (all purple family). */
export const LABEL_PURPLE_PALETTE = [
  "#6B4EFF",
  "#7C3AED",
  "#8B5CF6",
  "#9333EA",
  "#6366F1",
  "#A78BFA",
];
