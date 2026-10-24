import { config } from '../config.js';
import { isIP } from 'node:net';
import { instanceIdentity } from './instance.js';

const MAX_RESPONSE_BYTES = 1_048_576;

export class Sub2ApiError extends Error {
  constructor(message, { httpStatus = null, code = null, kind = 'error' } = {}) {
    super(message);
    this.name = 'Sub2ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    // kind: 'rejected' = server definitely did not apply the change
    //       'unknown'  = we cannot tell whether the server applied it
    this.kind = kind;
  }
}

export class Sub2ApiClient {
  constructor({ baseUrl = config.baseUrl, instanceId = config.instanceId, adminKey = config.adminKey, timeoutMs = config.requestTimeoutMs } = {}) {
    this.baseUrl = baseUrl ? instanceIdentity({ baseUrl, instanceId }).baseUrl : baseUrl;
    this.instanceId = instanceId;
    this.adminKey = adminKey;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(120_000, timeoutMs) : 15_000;
    if (this.baseUrl) {
      const target = new URL(this.baseUrl);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
        throw new Sub2ApiError('SUB2API_BASE_URL must be an http(s) URL without embedded credentials, query, or fragment', { kind: 'rejected' });
      }
      const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const loopback = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
      const insecureAllowed = ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_INSECURE_SUB2API_HTTP || '').toLowerCase());
      if (target.protocol === 'http:' && !loopback && !insecureAllowed) {
        throw new Sub2ApiError('Plain HTTP to non-loopback Sub2Api hosts is disabled', { kind: 'rejected' });
      }
    }
  }

  async request(method, apiPath, { body, idempotencyKey } = {}) {
    if (!this.baseUrl) throw new Sub2ApiError('SUB2API_BASE_URL is not configured', { kind: 'rejected' });
    if (!this.adminKey) throw new Sub2ApiError('SUB2API_ADMIN_API_KEY is not configured', { kind: 'rejected' });
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/v1/admin/')) {
      throw new Sub2ApiError('Refusing to call an unapproved Sub2Api path', { kind: 'rejected' });
    }
    const apiUrl = new URL(apiPath, 'http://sentinel.invalid');
    const pathname = apiUrl.pathname;
    const validPath = /^\/api\/v1\/admin\/users(?:\/\d+(?:\/(?:balance|balance-history))?)?$/.test(pathname);
    if (!validPath || apiUrl.hash || apiUrl.username || apiUrl.password ||
        [...apiUrl.searchParams.keys()].some((key) => !['search', 'page', 'page_size'].includes(key))) {
      throw new Sub2ApiError('Refusing to call an unapproved Sub2Api path', { kind: 'rejected' });
    }
    if (!['GET', 'POST'].includes(method) || (method === 'POST' && (!pathname.endsWith('/balance') || body?.operation !== 'add' || !idempotencyKey))) {
      throw new Sub2ApiError('Refusing an unapproved Sub2Api operation', { kind: 'rejected' });
    }

    const url = new URL(this.baseUrl + apiPath);
    // Defence in depth: never send the admin key anywhere but the configured host.
    const expected = new URL(this.baseUrl);
    if (url.origin !== expected.origin) {
      throw new Sub2ApiError(`Refusing to send admin key to foreign origin ${url.origin}`, { kind: 'rejected' });
    }

    const headers = { 'x-api-key': this.adminKey, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Required by the supported Sub2API admin write contract. Deployment-side
    // enforcement still depends on its version and idempotency configuration.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // Never let an upstream redirect carry the administrator credential to
        // another URL or origin.
        redirect: 'error',
      });
      const text = await readBodyLimited(res, MAX_RESPONSE_BYTES);
      return this.parseResponse(method, apiPath, res, text);
    } catch (err) {
      if (err instanceof Sub2ApiError) throw err;
      // Abort/network error: the request may still have reached the server.
      throw new Sub2ApiError(this.redact(`Network error calling ${method} ${apiPath}: ${err.message}`), { kind: 'unknown' });
    } finally {
      clearTimeout(timer);
    }
  }

  parseResponse(method, apiPath, res, text) {
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // fall through, handled below
    }

    const jsonContent = /^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') || '');
    if (!res.ok) {
      const message = this.redact(json?.message || json?.reason || text || `HTTP ${res.status}`);
      const code = json?.reason || json?.code || null;
      // 409 can mean an earlier idempotent write is still processing. An HTML
      // proxy error is not proof that a balance mutation was rejected either.
      const definitelyRejected = jsonContent && isObject(json) && json.code === res.status &&
        [400, 401, 403, 404, 405, 413, 415, 422].includes(res.status);
      throw new Sub2ApiError(`${method} ${apiPath} failed: ${message}`, {
        httpStatus: res.status,
        code,
        kind: definitelyRejected ? 'rejected' : 'unknown',
      });
    }

    if (res.status !== 200 || !jsonContent || !isObject(json) || json.code !== 0 || !isObject(json.data)) {
      throw new Sub2ApiError(`${method} ${apiPath} returned an unrecognized Sub2Api response`, {
        httpStatus: res.status,
        code: isObject(json) ? json.code ?? null : null,
        kind: method === 'POST' ? 'unknown' : 'rejected',
      });
    }

    return {
      data: json.data,
      replay: res.headers.get('x-idempotency-replayed') === 'true',
      status: res.status,
    };
  }

  /** Read a single user (admin view). */
  async getUser(userId) {
    const id = normalizeUserId(userId);
    const result = await this.request('GET', `/api/v1/admin/users/${encodeURIComponent(id)}`);
    validateUser(result, id, 'rejected');
    const { data } = result;
    return data;
  }

  /** Find users by email/username. Used to resolve an email to a user id. */
  async searchUsers(search, pageSize = 20) {
    if (typeof search !== 'string' || search.length > 200) throw new Sub2ApiError('Search text is invalid', { kind: 'rejected' });
    pageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
    const qs = new URLSearchParams({ search: String(search), page: '1', page_size: String(pageSize) });
    const { data } = await this.request('GET', `/api/v1/admin/users?${qs}`);
    return Array.isArray(data?.items) ? data.items : [];
  }

  /**
   * Atomically add `amount` to a user's balance.
   *
   * `operation: "add"` maps to `AdjustBalance` server-side (UPDATE ... balance + $1),
   * so this client never performs a read-modify-write "set". Never automatically
   * retry an ambiguous write: upstream idempotency enforcement must be verified.
   */
  async addBalance(userId, amount, { idempotencyKey, notes = '' } = {}) {
    const id = normalizeUserId(userId);
    if (!Number.isFinite(amount) || !(amount > 0)) throw new Sub2ApiError(`Refusing non-positive or invalid top-up amount ${amount}`, { kind: 'rejected' });
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      throw new Sub2ApiError('A valid Idempotency-Key is required for balance writes', { kind: 'rejected' });
    }
    if (typeof notes !== 'string' || notes.length > 1000) throw new Sub2ApiError('Top-up notes are invalid', { kind: 'rejected' });
    const result = await this.request('POST', `/api/v1/admin/users/${encodeURIComponent(id)}/balance`, {
      body: { balance: amount, operation: 'add', notes },
      idempotencyKey,
    });
    validateUser(result, id, 'unknown');
    return result;
  }

  async getBalanceHistory(userId, pageSize = 100, page = 1) {
    const id = normalizeUserId(userId);
    pageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 10)));
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Sub2ApiError('History page is invalid', { kind: 'rejected' });
    const { data } = await this.request(
      'GET',
      `/api/v1/admin/users/${encodeURIComponent(id)}/balance-history?page=${page}&page_size=${pageSize}`,
    );
    if (!Array.isArray(data.items) || data.items.length > pageSize || data.page !== page || data.page_size !== pageSize ||
        !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pages) || data.pages < 1 ||
        data.pages !== Math.max(1, Math.ceil(data.total / pageSize)) ||
        data.items.some((entry) => !isObject(entry) || !Number.isSafeInteger(entry.id) || entry.id <= 0)) {
      throw new Sub2ApiError('Sub2Api balance history has an invalid pagination or record structure', { kind: 'rejected' });
    }
    return data;
  }

  redact(value) {
    const text = String(value);
    return this.adminKey ? text.split(this.adminKey).join('[REDACTED]') : text;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateUser(result, userId, kind) {
  if (!Number.isSafeInteger(result.data?.id) || result.data.id !== userId ||
      typeof result.data.balance !== 'number' || !Number.isFinite(result.data.balance)) {
    throw new Sub2ApiError('Sub2Api user response has an invalid user ID or balance', {
      kind, httpStatus: result.status,
    });
  }
}

async function readBodyLimited(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error(`Sub2Api response exceeds ${limit} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`Sub2Api response exceeds ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function normalizeUserId(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Sub2ApiError('User ID must be a positive integer', { kind: 'rejected' });
  }
  return id;
}
