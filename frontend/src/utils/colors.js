// Colours for label classes and the shapes drawn with them.
//
// These used to ignore the label's colour and return one fixed purple for
// everything, which made every class look identical on canvas — the whole
// point of per-class colours is telling two classes apart at a glance. The
// label's own colour is now honoured, with the purple kept only as the
// fallback for a label that somehow has no colour set.

export const MASK_PURPLE = "#6B4EFF";
export const MASK_PURPLE_DARK = "#5A3FE0";

/** #abc → #aabbcc; anything unusable → the fallback purple. */
function normalizeHex(color) {
  if (typeof color !== "string") return MASK_PURPLE;
  let c = color.trim();
  if (!c.startsWith("#")) c = `#${c}`;
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  return MASK_PURPLE;
}

/** Darken a hex colour by `amount` (0..1). Used for the selected state. */
function darken(hex, amount = 0.18) {
  const c = normalizeHex(hex);
  const n = parseInt(c.slice(1), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 255) * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Outline colour for a shape of this label. */
export function maskStroke(labelColor, selected = false) {
  const base = normalizeHex(labelColor);
  return selected ? darken(base) : base;
}

/** Semi-transparent fill for a shape of this label.
 *  Selected shapes are more opaque so the active one reads as active. */
export function maskFill(labelColor, selected = false) {
  const base = normalizeHex(labelColor);
  return selected ? `${base}99` : `${base}55`;
}

/** Readable text colour on top of a given background. */
export function contrastText(hex) {
  const c = normalizeHex(hex);
  const n = parseInt(c.slice(1), 16);
  // Perceived luminance (ITU-R BT.601 weights).
  const lum =
    (0.299 * ((n >> 16) & 255) +
      0.587 * ((n >> 8) & 255) +
      0.114 * (n & 255)) /
    255;
  return lum > 0.6 ? "#1f2430" : "#ffffff";
}

/** The palette offered when creating a label class.
 *
 * Deliberately spread across hues rather than shades of one colour: these
 * exist to distinguish classes, and six near-identical purples cannot. Ordered
 * so consecutive picks are far apart in hue, which keeps the auto-assigned
 * colours distinguishable when someone adds several classes quickly.
 */
export const LABEL_PALETTE = [
  "#6B4EFF", // violet
  "#F43F5E", // rose
  "#10B981", // emerald
  "#F59E0B", // amber
  "#3B82F6", // blue
  "#EC4899", // pink
  "#14B8A6", // teal
  "#8B5CF6", // purple
  "#EF4444", // red
  "#22C55E", // green
  "#0EA5E9", // sky
  "#A855F7", // fuchsia
  "#F97316", // orange
  "#84CC16", // lime
  "#6366F1", // indigo
  "#64748B", // slate
];

/** Kept as an alias so older imports keep working. */
export const LABEL_PURPLE_PALETTE = LABEL_PALETTE;

/** Next palette colour that no existing label is already using. */
export function suggestLabelColor(existingLabels = []) {
  const taken = new Set(
    existingLabels.map((l) => normalizeHex(l?.color).toLowerCase()),
  );
  const free = LABEL_PALETTE.find((c) => !taken.has(c.toLowerCase()));
  return free || LABEL_PALETTE[existingLabels.length % LABEL_PALETTE.length];
}
