// Format registry (05-digitizing-engine/format-support.md).
// Adding a format = registry entry + writer + golden tests, with no DB migration.
// `productionEnabled` flips only when every row of the production enablement gate is approved.

export const FORMATS = Object.freeze([
  {
    code: 'DST',
    name: 'Tajima DST',
    extension: 'dst',
    colourInfo: 'stops-only',
    maxStitchMm: 12.1,
    productionEnabled: false,
  },
  {
    code: 'PES',
    name: 'Brother PES',
    extension: 'pes',
    colourInfo: 'embedded-palette',
    maxStitchMm: null,
    productionEnabled: false,
  },
  {
    code: 'JEF',
    name: 'Janome JEF',
    extension: 'jef',
    colourInfo: 'palette-index',
    maxStitchMm: 12.7,
    productionEnabled: false,
  },
]);

const byCode = new Map(FORMATS.map((f) => [f.code, f]));

export function isKnownFormat(code) {
  return byCode.has(code);
}

/** Formats a caller may use: gated formats only, unless ungated formats are allowed (dev/staging). */
export function availableFormats({ allowUngated }) {
  return FORMATS.filter((f) => f.productionEnabled || allowUngated);
}
