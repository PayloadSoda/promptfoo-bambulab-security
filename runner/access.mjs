function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function configuredOrigin(value) {
  if (!value) return null;
  const url = parseOrigin(value);
  if (!url) throw new Error('RUNNER_ORIGIN 必须是完整站点地址，例如 https://runner.example.com，不包含路径。');
  return url.origin;
}

export function allowsRequest(headers, publicOrigin = null) {
  if (typeof headers.host !== 'string') return false;
  const request = parseOrigin(`http://${headers.host}`);
  if (!request) return false;
  const hostname = request.hostname.replace(/\.$/, '');
  // Loopback aliases and forwarded ports still refer to this local service.
  const local = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(hostname);
  const configuredHost = publicOrigin && new URL(publicOrigin).host;
  if (!local && request.host !== configuredHost) return false;
  if (!headers.origin) return true;
  const origin = parseOrigin(headers.origin);
  if (!origin) return false;
  if (publicOrigin && origin.origin === publicOrigin) return true;
  return local && origin.host === request.host;
}
