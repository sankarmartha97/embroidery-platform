// Ajv errors → error-envelope details ({ path, issue }, 04-api/openapi.yaml ErrorEnvelope).

export function ajvErrorsToDetails(ajvErrors) {
  return ajvErrors.map((e) => {
    let where = e.instancePath || '';
    if (e.keyword === 'required') where += `/${e.params.missingProperty}`;
    if (e.keyword === 'additionalProperties') where += `/${e.params.additionalProperty}`;
    const issue = e.keyword === 'additionalProperties' ? 'is not an allowed field' : e.message;
    return { path: where || '/', issue };
  });
}
