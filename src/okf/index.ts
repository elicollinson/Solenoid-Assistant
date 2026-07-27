// Open Knowledge Format (OKF v0.2) — see specs/okf/spec.md.
//
// Layering mirrors src/imessage: this directory owns the format's semantics and
// is pure, synchronous-to-reason-about, and LLM-free; src/tools/okf.ts is a
// thin `defineTool` surface over it.
export { OkfError, openBundle, normalizeConceptId, normalizeDirId, type Bundle } from "./bundle";
export { parseConcept, parseDocument, serializeConcept, mergeFrontmatter, type Concept } from "./concept";
export { applyBodyOp, findSection, parseSections, sectionContent, type BodyOp } from "./body";
export { conceptLinks, extractLinks, resolveLink, rewriteLinks, relativeTarget } from "./links";
export { regenerateIndex, regenerateIndexChain, renderIndex, declaredVersion, OKF_VERSION } from "./indexFile";
export { appendLogEntry, insertEntry, type LogKind } from "./logFile";
export { listDirectory, scanConcepts, type ScannedConcept } from "./scan";
export {
  isStale,
  isoDate,
  lastVerifiedAt,
  meetsTrust,
  statusOf,
  trustTier,
  verificationEvents,
  type Status,
  type TrustTier,
} from "./trust";
export { validateBundle, type ValidationReport } from "./validate";
export { dumpYaml } from "./yaml";
export {
  OkfStore,
  type ConceptSummary,
  type CreateInput,
  type OkfStoreOptions,
  type PatchInput,
  type ReadResult,
  type SearchInput,
  type SourceEntry,
} from "./store";
