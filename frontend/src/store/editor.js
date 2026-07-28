// Editor state store (Zustand).
//
// This is the single in-memory source of truth for the annotation screen: the
// current viewport (zoom/pan), which tool is active, the label classes, the
// annotations currently on the image, the selection, and any in-progress
// "draft" shape the user is mid-way through drawing.
//
// Components read slices of this state and call the setter actions below; React
// re-renders whatever depends on the slice that changed. Persistence to the
// backend does NOT happen here — that's the history store's job (history.js),
// which wraps each change in an undo/redo command that also calls the API.

import { create } from "zustand";

export const useEditor = create((set) => ({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  imageWidth: 0,
  imageHeight: 0,
  setViewport: (v) => set((s) => ({ ...s, ...v })),
  setImageSize: (w, h) => set({ imageWidth: w, imageHeight: h }),

  activeTool: "select",
  setTool: (t) =>
    set({
      activeTool: t,
      draftBox: null,
      draftPolygon: [],
      draftKeypoints: [],
    }),

  imageStatus: "unannotated",
  readOnly: false,
  setImageStatus: (s) => set({ imageStatus: s, readOnly: s === "approved" }),

  labels: [],
  activeLabelId: null,
  setLabels: (l) =>
    set((s) => ({
      labels: l,
      activeLabelId: s.activeLabelId ?? l[0]?.id ?? null,
    })),
  setActiveLabel: (id) => set({ activeLabelId: id }),

  annotations: [],
  setAnnotations: (a) => set({ annotations: a }),
  addAnnotation: (a) => set((s) => ({ annotations: [...s.annotations, a] })),
  updateAnnotationLocal: (id, patch) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    })),
  removeAnnotation: (id) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => a.id !== id),
      selectedIds: new Set([...s.selectedIds].filter((x) => x !== id)),
    })),

  selectedIds: new Set(),
  selectId: (id, additive = false) =>
    set((s) => {
      const next = new Set(additive ? s.selectedIds : []);
      if (id !== null) {
        next.has(id) ? next.delete(id) : next.add(id);
      } else if (!additive) {
        return { selectedIds: new Set() };
      }
      return { selectedIds: next };
    }),
  selectAll: () =>
    set((s) => ({ selectedIds: new Set(s.annotations.map((a) => a.id)) })),
  clearSelection: () => set({ selectedIds: new Set() }),

  clipboard: [],
  setClipboard: (items) => set({ clipboard: items }),

  draftBox: null,
  setDraftBox: (b) => set({ draftBox: b }),

  draftPolygon: [],
  appendPolyPoint: (p) =>
    set((s) => ({ draftPolygon: [...s.draftPolygon, p] })),
  resetPolyDraft: () => set({ draftPolygon: [] }),

  draftKeypoints: [],
  appendKeypoint: (p) =>
    set((s) => ({ draftKeypoints: [...s.draftKeypoints, { ...p, v: 2 }] })),
  resetKeypointDraft: () => set({ draftKeypoints: [] }),
}));
