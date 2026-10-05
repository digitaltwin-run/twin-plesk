import fs from 'node:fs';
import { resolvePleskCredential, revokePleskLease } from './vault.mjs';

/**
 * Machine-enforce the AQL/founder delegation before any credential is touched.
 *
 * A grant (the capability the founder/operator delegated) authorizes *scope +
 * access* before Vault or Plesk is touched. Harvest of credentials from allowed
 * sources into private Vault is a separate grant scope (`credential.harvest`);
 * this guard covers verify/configure for the live ticket flow.
 *
 * @param {object} grant  {state, scope:[], resource, expires_at}
 * @param {object} need   {action, resource, now?}
 */
export function assertGrantAllows(grant, { action, resource, now = new Date() } = {}) {
  if (!grant || typeof grant !== 'object') {
    throw httpError('grant_required', 403);
  }
  if (grant.state !== 'issued') {
    throw httpError(`grant_not_active:${grant.state || 'missing'}`, 403);
  }
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  if (grant.expires_at && nowIso >= String(grant.expires_at)) {
    throw httpError('grant_expired', 403);
  }
  if (resource && grant.resource && String(grant.resource) !== String(resource)) {
    throw httpError('grant_resource_mismatch', 403);
  }
  const scope = Array.isArray(grant.scope) ? grant.scope : [];
  if (action && !scope.includes(action)) {
    throw httpError(`grant_scope_missing:${action}`, 403);
  }
  return true;
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Authenticated verification of a Plesk admin profile (§4.1).
 *
 * Given a resolved credential (from Vault, never from a browser), performs a
 * read-only authenticated call to the Plesk REST API and reports the outcome as
 * a structured result plus a Digital Twin update. The password is used only in
 * the Authorization header and never appears in the return value, in a URL, or
 * in any log line — consistent with twin-plesk never surfacing secrets.
 */

/**
 * @param {object} args
 * @param {string} args.baseUrl                 Plesk base URL, e.g. "https://panel.example.com:8443"
 * @param {{username: string, password: string}} args.credential
 * @param {string} [args.host]                  Logical host id for the twin update
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ok: boolean, checks: Array<{name:string, ok:boolean, detail:string}>, twinUpdate: object}>}
 */
export async function verifyAdminProfile({ baseUrl, credential, host, fetchImpl }) {
  if (!baseUrl) throw new Error('verifyAdminProfile requires baseUrl');
  if (!credential || !credential.username || !credential.password) {
    throw new Error('verifyAdminProfile requires credential.username and credential.password');
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch implementation available');

  const hostId = host || safeHost(baseUrl);
  const checks = [];
  const authHeader = 'Basic ' + Buffer.from(`${credential.username}:${credential.password}`).toString('base64');

  let status = 0;
  let unevaluable = false;
  let errorClass = '';
  try {
    const response = await doFetch(`${trimTrailingSlash(baseUrl)}/api/v2/server`, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    status = response.status;
  } catch (error) {
    unevaluable = true;
    errorClass = error instanceof Error ? error.message : String(error);
  }

  if (unevaluable) {
    checks.push({ name: 'reachable', ok: false, detail: `plesk_unreachable: ${errorClass}` });
    checks.push({ name: 'authenticated', ok: false, detail: 'not_evaluated' });
  } else {
    const reachable = status > 0;
    const authenticated = status >= 200 && status < 300;
    checks.push({ name: 'reachable', ok: reachable, detail: `HTTP ${status}` });
    checks.push({
      name: 'authenticated',
      ok: authenticated,
      detail: authenticated
        ? 'admin credential accepted'
        : status === 401 || status === 403
          ? 'admin credential rejected'
          : `unexpected status HTTP ${status}`,
    });
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    checks,
    twinUpdate: {
      component: 'twin-plesk',
      host: hostId,
      status: ok ? 'admin_profile_verified' : unevaluable ? 'unevaluable' : 'admin_profile_unverified',
      // Reference material only — never the secret itself.
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Load a ticket -> vault path routing table (JSON). Keeps twin-plesk free of a
 * YAML dependency. Shape: { routes: { "PLF-3816": { vault_path, base_url, ... } } }.
 * @param {string} filePath
 * @returns {{routes: Record<string, {vault_path: string, base_url: string, scope?: string[], max_ttl?: number}>}}
 */
export function loadSecretsRoutes(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.routes !== 'object') {
    throw new Error(`${filePath}: expected { routes: { <ticket>: {...} } }`);
  }
  return parsed;
}

/**
 * End-to-end for one ticket: route -> Vault credential -> Plesk verify -> twin
 * update. Returns a result safe to record in the hub audit (AuthCheckPerformed);
 * carries only references (vault_path, lease id) and check outcomes, no secret.
 *
 * @param {object} args
 * @param {string} args.ticket
 * @param {{routes: Record<string, any>}} args.routes
 * @param {{addr: string, token: string}} args.vault
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<object>}
 */
export async function verifyPleskForTicket({ ticket, routes, vault, grant, fetchImpl }) {
  const route = routes?.routes?.[ticket];
  if (!route) throw new Error(`no secrets route for ticket ${ticket}`);
  if (!route.vault_path || !route.base_url) {
    throw new Error(`route for ${ticket} needs vault_path and base_url`);
  }
  // Enforce the founder/AQL delegation first: no live grant of scope 'verify'
  // for this resource -> refuse before touching Vault or Plesk.
  assertGrantAllows(grant, { action: 'verify', resource: route.host || ticket });
  let credential = null;
  try {
    credential = await resolvePleskCredential({
      vaultAddr: vault.addr,
      vaultToken: vault.token,
      vaultPath: route.vault_path,
      fetchImpl,
    });
    const result = await verifyAdminProfile({
      baseUrl: route.base_url,
      credential,
      host: route.host || ticket,
      fetchImpl,
    });
    return {
      ticket,
      vault_path: route.vault_path,
      lease_id: credential.leaseId,
      ok: result.ok,
      checks: result.checks,
      twinUpdate: result.twinUpdate,
    };
  } finally {
    if (credential?.leaseId) {
      await revokePleskLease({
        vaultAddr: vault.addr,
        vaultToken: vault.token,
        leaseId: credential.leaseId,
        fetchImpl,
      }).catch(() => ({ ok: false }));
    }
  }
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'unknown-host';
  }
}
