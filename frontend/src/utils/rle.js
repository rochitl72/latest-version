// Run-Length Encoding for binary masks.
//
// Format (string): "h,w|len0,len1,len2,..."
//   - First number is run of background (0), then alternating fg/bg.
//   - h,w prefix lets us validate dimensions on decode.
//
// This is column-major like COCO's RLE, so it interoperates with pycocotools
// when you convert on the backend.

export function rleEncodeFromCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);

  // Column-major scan, threshold alpha > 0
  const runs = [];
  let current = 0;
  let curVal = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const idx = (y * w + x) * 4 + 3;
      const v = data[idx] > 0 ? 1 : 0;
      if (v === curVal) {
        current++;
      } else {
        runs.push(current);
        current = 1;
        curVal = v;
      }
    }
  }
  runs.push(current);

  // Check we have at least one foreground run
  const hasFg = runs.some((r, i) => i % 2 === 1 && r > 0);
  if (!hasFg) return "";

  return `${h},${w}|${runs.join(",")}`;
}

// Decode an RLE string into a row-major binary mask (Uint8Array, 1 = foreground).
// Shared by the canvas tinting below and by hit-testing (which mask a click landed on).
export function rleDecode(rle, size) {
  const [h, w] = size;
  const mask = new Uint8Array(h * w);
  if (!rle) return mask;
  const [, payload] = rle.split("|");
  if (!payload) return mask;
  const runs = payload.split(",").map(Number);
  let value = 0;
  let pixel = 0;
  for (const r of runs) {
    if (value === 1) {
      // Runs are column-major (COCO style); map back to row-major indices.
      for (let p = pixel; p < pixel + r; p++) {
        const x = Math.floor(p / h);
        const y = p % h;
        if (x < w && y < h) mask[y * w + x] = 1;
      }
    }
    pixel += r;
    value = 1 - value;
  }
  return mask;
}

export function rleDecodeToCanvas(rle, size, ctx, hexColor, alpha = 0.5) {
  if (!rle) return;
  const [h, w] = size;
  const mask = rleDecode(rle, size);

  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const j = i * 4;
      img.data[j] = r;
      img.data[j + 1] = g;
      img.data[j + 2] = b;
      img.data[j + 3] = Math.max(img.data[j + 3], Math.round(255 * alpha));
    }
  }
  ctx.putImageData(img, 0, 0);
}
