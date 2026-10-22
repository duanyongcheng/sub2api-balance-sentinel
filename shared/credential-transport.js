export function withCredentialTransport(location, send) {
  const protocol = String(location?.protocol || '').toLowerCase();
  const host = String(location?.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const parts = host.split('.');
  const loopback = host === 'localhost' || host === '::1' ||
    (parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255));
  if (protocol !== 'https:' && !(protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for account credentials outside the local loopback interface');
  }
  return send();
}
