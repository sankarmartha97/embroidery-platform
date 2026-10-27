import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { strictify } from '../../src/http/validate.js';

describe('strictify', () => {
  it('inlines refs and forbids unknown fields at every object level', () => {
    const schema = strictify({ $ref: '#/components/schemas/UserMachineCreate' });
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.hoops.items.additionalProperties, false);
    assert.deepEqual(schema.properties.hoops.items.required, ['name', 'widthMm', 'heightMm']);
  });
  it('does not treat a properties map as a schema', () => {
    const schema = strictify({ type: 'object', properties: { type: { type: 'string' } } });
    assert.equal(schema.properties.additionalProperties, undefined);
    assert.equal(schema.additionalProperties, false);
  });
});
