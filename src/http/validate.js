import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
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
  const isObject = out.type === 'object' || out.properties;
  const composed = out.allOf || out.oneOf || out.anyOf;
  if (isObject && !composed && !('additionalProperties' in out)) out.additionalProperties = false;
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

function toDetails(ajvErrors) {
  return ajvErrors.map((e) => {
    let where = e.instancePath || '';
    if (e.keyword === 'required') where += `/${e.params.missingProperty}`;
    if (e.keyword === 'additionalProperties') where += `/${e.params.additionalProperty}`;
    const message = e.keyword === 'additionalProperties' ? 'is not an allowed field' : e.message;
    return { path: where || '/', message };
  });
}

/** Validates req.body against an OpenAPI component schema. */
export function validateBody(schemaName) {
  const validate = validatorFor(schemaName);
  return function validateBodyMiddleware(req, _res, next) {
    if (!validate(req.body ?? {})) return next(errors.validation(toDetails(validate.errors)));
    next();
  };
}
