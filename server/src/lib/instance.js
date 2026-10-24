export class InstanceBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceBindingError';
    this.httpStatus = 409;
  }
}

/** Preserve the base path: two deployments on one origin are not one ledger. */
export function instanceIdentity({ baseUrl, instanceId = '' } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch {
    throw new InstanceBindingError('A valid configured Sub2API instance base URL is required');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InstanceBindingError('Instance base URL must be an http(s) URL without credentials, query, or fragment');
  }
  const id = String(instanceId).trim();
  if (id.length > 200 || !/^[A-Za-z0-9._:-]*$/.test(id)) {
    throw new InstanceBindingError('SENTINEL_INSTANCE_ID must contain at most 200 letters, digits, dot, underscore, colon, or hyphen');
  }
  return { baseUrl: url.href.replace(/\/+$/, ''), instanceId: id };
}

export function compatibleRecordedTarget(recorded, identity) {
  if (!recorded) return true;
  try {
    const canonical = instanceIdentity({ baseUrl: recorded }).baseUrl;
    // Older attempts only stored origin. Legacy binding must be confirmed
    // locally before those records can be queried against a base-path target.
    return canonical === identity.baseUrl || canonical === new URL(identity.baseUrl).origin;
  } catch {
    return false;
  }
}
