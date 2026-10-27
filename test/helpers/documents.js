// Small valid project documents for tests.

export function heartDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    units: 'mm',
    canvas: { width: 100, height: 100 },
    threads: [
      { id: 't1', hex: '#CC3344' },
      { id: 't2', hex: '#2244AA' },
    ],
    objects: [
      {
        id: 'outline',
        type: 'embroidery-path',
        name: 'Heart outline',
        geometry: {
          kind: 'path',
          d: 'M50 30 C 50 20 30 20 30 35 C 30 50 50 60 50 70 C 50 60 70 50 70 35 C 70 20 50 20 50 30 Z',
          closed: true,
        },
        stitch: { type: 'satin', threadId: 't1' },
        sequence: 1,
      },
      {
        id: 'underline',
        type: 'embroidery-path',
        geometry: { kind: 'path', d: 'M30 80 h 40', closed: false },
        stitch: { type: 'running', threadId: 't2', stitchLengthMm: 2.5 },
        sequence: 2,
      },
    ],
    ...overrides,
  };
}
