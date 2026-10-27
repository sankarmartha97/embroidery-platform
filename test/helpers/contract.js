// Response contract checks against contracts/openapi.yaml. Responses may carry extra fields
// (clients must ignore unknown fields, 04-api/conventions.md), so unknown fields are allowed;
// types, required fields, enums and formats are enforced.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

export const openapi = YAML.parse(readFileSync('contracts/openapi.yaml', 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi.json', components: openapi.components });

/** Rewrites local component refs so inline response schemas resolve against the contract. */
function rebase(node) {
  if (Array.isArray(node)) return node.map(rebase);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi.json${v}` : rebase(v),
    ]),
  );
}

function responseSchema(method, route, status) {
  const op = openapi.paths[route]?.[method.toLowerCase()];
  if (!op) throw new Error(`No ${method} ${route} in the contract`);
  let response = op.responses?.[String(status)];
  if (!response) throw new Error(`${method} ${route} has no ${status} response in the contract`);
  if (response.$ref) {
    response = openapi.components.responses[response.$ref.split('/').pop()];
  }
  return response.content?.['application/json']?.schema ?? null;
}

const compiled = new Map();

/** @returns {string[]} contract violations (empty when the body matches) */
export function contractErrors(method, route, status, body) {
  const key = `${method} ${route} ${status}`;
  if (!compiled.has(key)) {
    const schema = responseSchema(method, route, status);
    compiled.set(key, schema ? ajv.compile(rebase(schema)) : null);
  }
  const validate = compiled.get(key);
  if (!validate) return [`${key} has no response schema in the contract`];
  return validate(body) ? [] : validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}
