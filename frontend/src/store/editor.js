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
  // Keep the current selection ONLY if that label still exists in the incoming
  // list; otherwise fall back to the first label.
  //
  // This used to be `s.activeLabelId ?? l[0]?.id ?? null`, which kept any
  // non-null id forever. Because this store is a module-level singleton that
  // outlives the annotate screen, opening a DIFFERENT project left
  // activeLabelId pointing at a label belonging to the previous project. Every
  // shape then POSTed a label_id the new project does not own, the API
  // answered 404 "Label not found", and drawing appeared broken for every
  // tool at once. Deleting the active label caused the same thing.
  setLabels: (l) =>
    set((s) => {
      const stillThere = l.some((x) => x.id === s.activeLabelId);
      return {
        labels: l,
        activeLabelId: stillThere ? s.activeLabelId : (l[0]?.id ?? null),
      };
    }),
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

  /** Clear everything tied to the image you were just looking at.
   *
   * Call this when navigating to another image or project. Without it, a
   * half-drawn polygon or an open selection survived the navigation, because
   * this store is a singleton — so the next Save committed points you drew on
   * the PREVIOUS image onto the new one.
   */
  resetForNewImage: () =>
    set({
      draftBox: null,
      draftPolygon: [],
      draftKeypoints: [],
      selectedIds: new Set(),
      annotations: [],
    }),
}));
