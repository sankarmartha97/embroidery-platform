import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { ajvErrorsToDetails } from '../lib/ajv-details.js';
import { errors } from './errors.js';

// Request bodies are validated with the same schemas as OpenAPI (04-api/conventions.md).
// contracts/openapi.yaml is a copy of the docs repo file; refresh it with `npm run contracts:sync`.
const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts');
const openapi = YAML.parse(readFileSync(path.join(contractsDir, 'openapi.yaml'), 'utf8'));
const components = openapi.components?.schemas ?? {};

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: true });
addFormats(ajv);

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs']);

/**
 * Inlines component $refs and rejects unknown fields on every object
 * ("Unknown fields are rejected → 422 VALIDATION_FAILED").
 */
export function strictify(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => strictify(n, seen));
  if (!node || typeof node !== 'object') return node;

  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    const name = node.$ref.slice('#/components/schemas/'.length);
    if (seen.has(name)) throw new Error(`Recursive schema ${name} is not supported`);
    if (!components[name]) throw new Error(`Unknown schema ${name}`);
    return strictify(components[name], new Set([...seen, name]));
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = SCHEMA_MAPS.has(key)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictify(v, seen)]))
      : strictify(value, seen);
  }
  // Objects that declare their fields reject unknown ones. Free-form objects ({ type: object }
  // with no properties, e.g. job settings) stay free-form.
  const composed = out.allOf || out.oneOf || out.anyOf;
  if (out.properties && !composed && !('additionalProperties' in out)) {
    out.additionalProperties = false;
  }
  return out;
}

const compiled = new Map();
function validatorFor(schemaName) {
  if (!compiled.has(schemaName)) {
    compiled.set(
      schemaName,
      ajv.compile(strictify({ $ref: `#/components/schemas/${schemaName}` })),
    );
  }
  return compiled.get(schemaName);
}

/**
 * Validates req.body against an OpenAPI component schema (by name), or against an inline
 * request schema copied from openapi.yaml when the contract does not name it.
 */
export function validateBody(schema) {
  const validate =
    typeof schema === 'string' ? validatorFor(schema) : ajv.compile(strictify(schema));
  return function validateBodyMiddleware(req, _res, next) {
    if (!validate(req.body ?? {})) {
      return next(errors.validation(ajvErrorsToDetails(validate.errors)));
    }
    next();
  };
}
