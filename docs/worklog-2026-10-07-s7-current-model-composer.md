# S7 current-model composer repair — 2026-10-07

The composer previously offered its explicit current-model choice only when account model discovery had no readable list. A healthy catalog therefore caused ordinary sends to carry a concrete model and `modelChoice: explicit`, even when the operator wanted ChatGPT's current model.

The existing composer model owner now offers the deliberate current-model choice alongside a healthy catalog. It keeps that choice across catalog pushes within the active composer scope and clears it when the user selects a concrete model or changes scope. The send pair is `model: null` and `reasoningEffort: null`; the existing renderer provenance calculation consequently emits `modelChoice: current`. No S7 authority or extension Send code changed.

Regression coverage was added before implementation. The initial RED run had three expected failures: healthy catalog omitted the choice, catalog refresh replaced an explicit current choice, and the renderer submission seam could not choose current. The final run of the five required Vitest files passed 347 tests. `npm run typecheck`, `npm run build`, and `git diff --check` passed. This is source and test evidence only; no package, install, or live send was performed.
