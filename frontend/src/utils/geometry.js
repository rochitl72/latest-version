// Coordinate conversions between normalized (0-1) and pixel space.

export const toPixel = (norm, dim) => norm * dim;
export const toNorm = (px, dim) => px / dim;

export const boxToPixel = (b, w, h) => ({
  x: b.x * w,
  y: b.y * h,
  w: b.w * w,
  h: b.h * h,
});

export const boxToNorm = (b, w, h) => ({
  x: b.x / w,
  y: b.y / h,
  w: b.w / w,
  h: b.h / h,
});

export const polyToPixel = (pts, w, h) =>
  pts.map(([px, py]) => [px * w, py * h]);

export const polyToNorm = (pts, w, h) =>
  pts.map(([px, py]) => [px / w, py / h]);

// Flatten [[x,y], ...] → [x,y,x,y,...] for Konva Line / Polygon
export const flatten = (pts) => pts.reduce((acc, p) => acc.concat(p), []);

/** True when point lies on the image (pixel coords), not letterbox padding. */
export const isInsideImage = (x, y, imageWidth, imageHeight) =>
  imageWidth > 0 &&
  imageHeight > 0 &&
  x >= 0 &&
  x <= imageWidth &&
  y >= 0 &&
  y <= imageHeight;

export const clampToImage = (x, y, imageWidth, imageHeight) => ({
  x: Math.max(0, Math.min(imageWidth, x)),
  y: Math.max(0, Math.min(imageHeight, y)),
});
