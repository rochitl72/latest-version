// OnboardingGuide.jsx — first-run tutorial overlay.
// Walks a new annotator through labels, drawing and saving. Remembers dismissal
// in localStorage so it only appears once.

import { useState, useEffect } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "rbg_annotation_onboarding_v1";

const STEPS = [
  {
    title: "1. Create a label class",
    body: "In the right panel, type a class name (e.g. cell, defect) and press +. You must pick a label before drawing.",
  },
  {
    title: "2. Draw annotations",
    body: "B = box · P = polygon · K = brush · S = Smart Select · T = Text Prompting.",
  },
  {
    title: "3. Smart Select & Text Prompting",
    body: "S: Smart Select (purple mask). T: Text prompt. Hover tools on the right for names.",
  },
  {
    title: "4. Save & finish",
    body: "Bottom bar: Save shape · Undo · Delete · Mark image done. Select (V) any shape to drag and edit.",
  },
];

export function shouldShowOnboarding() {
  return localStorage.getItem(STORAGE_KEY) !== "done";
}

export function markOnboardingDone() {
  localStorage.setItem(STORAGE_KEY, "done");
}

export default function OnboardingGuide({ onDismiss }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const finish = () => {
    markOnboardingDone();
    onDismiss();
  };

  const s = STEPS[step];

  return (
    <div className="onboarding-backdrop">
      <div className="onboarding-card">
        <button
          className="onboarding-close"
          onClick={finish}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <h2>Quick start — RBG Annotation</h2>
        <p className="onboarding-step-label">
          Step {step + 1} of {STEPS.length}
        </p>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="onboarding-actions">
          {step > 0 && (
            <button className="btn-secondary" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn-primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="btn-primary" onClick={finish}>
              Start annotating
            </button>
          )}
        </div>
        <button className="onboarding-skip" onClick={finish}>
          Skip guide — don&apos;t show again
        </button>
      </div>
    </div>
  );
}
