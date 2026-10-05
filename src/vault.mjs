/**
 * Vault credential resolver for twin-plesk (§4.1).
 *
 * Reads a Plesk admin credential from HashiCorp Vault KV v2 at runtime, given a
 * vault path — the credential a human placed there once via the one-time Vault
 * form (PLF-3816). The secret lives only in the returned object in memory; the
 * token and the secret are never logged, never placed in a URL, and never
 * written anywhere. Runtime use always goes through Vault (lease), whether the
 * secret was placed by human intake, API mint, or grant-gated harvest from an
 * isolated account password store.
 */

/**
 * @param {object} args
 * @param {string} args.vaultAddr   Base address, e.g. "https://vault.internal:8200"
 * @param {string} args.vaultToken  Vault token (kept in memory, never logged)
 * @param {string} args.vaultPath   KV v2 data path, e.g. "secret/data/plesk/admin/host-X"
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{username: string, password: string, leaseId: string|null, ttl: number|null, vaultPath: string}>}
 */
export async function resolvePleskCredential({ vaultAddr, vaultToken, vaultPath, fetchImpl }) {
  if (!vaultAddr || !vaultToken || !vaultPath) {
    throw new Error('resolvePleskCredential requires vaultAddr, vaultToken and vaultPath');
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('no fetch implementation available');
  }
  const url = `${trimTrailingSlash(vaultAddr)}/v1/${encodeVaultPath(vaultPath)}`;
  let response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { 'X-Vault-Token': vaultToken },
    });
  } catch (error) {
    // Do not echo the token or path detail beyond the class of failure.
    throw new Error(`vault_unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 403) {
    throw new Error('vault_forbidden: token lacks read on the requested path');
  }
  if (response.status === 404) {
    throw new Error('vault_not_found: no secret at the requested path');
  }
  if (!response.ok) {
    throw new Error(`vault_error: HTTP ${response.status}`);
  }
  const body = await response.json();
  const data = body?.data?.data ?? {};
  const username = typeof data.username === 'string' ? data.username : '';
  const password = typeof data.password === 'string' ? data.password : '';
  if (!username || !password) {
    throw new Error('vault_incomplete: secret is missing username or password');
  }
  return {
    username,
    password,
    leaseId: typeof body.lease_id === 'string' && body.lease_id ? body.lease_id : null,
    ttl: typeof body.lease_duration === 'number' ? body.lease_duration : null,
    vaultPath,
  };
}

/**
 * Revoke a Vault lease by id (best-effort; never logs the token).
 * @returns {Promise<{ok: boolean, revoked: boolean, status: number|null, reason?: string}>}
 */
export async function revokePleskLease({ vaultAddr, vaultToken, leaseId, fetchImpl }) {
  if (!leaseId) {
    return { ok: true, revoked: false, status: null, reason: 'no_lease' };
  }
  if (!vaultAddr || !vaultToken) {
    throw new Error('revokePleskLease requires vaultAddr and vaultToken');
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('no fetch implementation available');
  }
  const url = `${trimTrailingSlash(vaultAddr)}/v1/sys/leases/revoke`;
  let response;
  try {
    response = await doFetch(url, {
      method: 'PUT',
      headers: {
        'X-Vault-Token': vaultToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lease_id: String(leaseId) }),
    });
  } catch (error) {
    throw new Error(`vault_unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 204 / 200 = revoked; 400/404 lease not found is treated as already gone.
  if (response.ok || response.status === 204) {
    return { ok: true, revoked: true, status: response.status };
  }
  if (response.status === 400 || response.status === 404) {
    return { ok: true, revoked: false, status: response.status, reason: 'lease_absent' };
  }
  return {
    ok: false,
    revoked: false,
    status: response.status,
    reason: `vault_error: HTTP ${response.status}`,
  };
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function encodeVaultPath(vaultPath) {
  return vaultPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
