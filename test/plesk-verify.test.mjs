import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertGrantAllows,
  loadSecretsRoutes,
  verifyAdminProfile,
  verifyPleskForTicket,
} from '../src/plesk-verify.mjs';
import { resolvePleskCredential, revokePleskLease } from '../src/vault.mjs';

const SECRET_PASSWORD = 'sup3r-s3cret-plesk-pw';

// A live grant of scope 'verify' for the resource, as the founder delegated via AQL.
const LIVE_GRANT = {
  state: 'issued',
  scope: ['verify', 'configure'],
  resource: 'plesk-host-x',
  expires_at: '2999-01-01T00:00:00+00:00',
};

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function fakeVaultFetch({ status = 200, secret } = {}) {
  return async (url, options) => {
    assert.equal(options.headers['X-Vault-Token'], 'vault-token');
    if (String(url).includes('/sys/leases/revoke')) {
      assert.equal(options.method, 'PUT');
      return { status: 204, ok: true, json: async () => ({}) };
    }
    assert.ok(url.includes('/v1/'), 'vault url should hit KV path');
    if (status !== 200) return jsonResponse(status, {});
    return jsonResponse(200, {
      lease_id: 'lease-123',
      lease_duration: 900,
      data: { data: secret ?? { username: 'admin', password: SECRET_PASSWORD } },
    });
  };
}

test('resolvePleskCredential reads KV v2 secret and lease', async () => {
  const credential = await resolvePleskCredential({
    vaultAddr: 'https://vault.internal:8200/',
    vaultToken: 'vault-token',
    vaultPath: 'secret/data/plesk/admin/host-X',
    fetchImpl: fakeVaultFetch(),
  });
  assert.equal(credential.username, 'admin');
  assert.equal(credential.password, SECRET_PASSWORD);
  assert.equal(credential.leaseId, 'lease-123');
  assert.equal(credential.ttl, 900);
});

test('resolvePleskCredential maps vault errors to typed messages', async () => {
  await assert.rejects(
    () => resolvePleskCredential({
      vaultAddr: 'https://v', vaultToken: 'vault-token', vaultPath: 'secret/data/x',
      fetchImpl: fakeVaultFetch({ status: 403 }),
    }),
    /vault_forbidden/,
  );
  await assert.rejects(
    () => resolvePleskCredential({
      vaultAddr: 'https://v', vaultToken: 'vault-token', vaultPath: 'secret/data/x',
      fetchImpl: fakeVaultFetch({ status: 404 }),
    }),
    /vault_not_found/,
  );
  await assert.rejects(
    () => resolvePleskCredential({
      vaultAddr: 'https://v', vaultToken: 'vault-token', vaultPath: 'secret/data/x',
      fetchImpl: fakeVaultFetch({ secret: { username: 'admin' } }),
    }),
    /vault_incomplete/,
  );
});

test('revokePleskLease calls sys/leases/revoke', async () => {
  let revokedBody = null;
  const fetchImpl = async (url, options) => {
    assert.ok(String(url).endsWith('/v1/sys/leases/revoke'));
    revokedBody = JSON.parse(options.body);
    return { status: 204, ok: true, json: async () => ({}) };
  };
  const result = await revokePleskLease({
    vaultAddr: 'https://vault.internal:8200',
    vaultToken: 'vault-token',
    leaseId: 'lease-123',
    fetchImpl,
  });
  assert.equal(result.revoked, true);
  assert.deepEqual(revokedBody, { lease_id: 'lease-123' });
});

test('verifyAdminProfile accepts a valid admin credential and never leaks the password', async () => {
  const plesk = async (url, options) => {
    assert.ok(url.endsWith('/api/v2/server'));
    assert.ok(options.headers.Authorization.startsWith('Basic '));
    // The password must travel only in the auth header, never in the URL.
    assert.ok(!url.includes(SECRET_PASSWORD));
    return jsonResponse(200, { server: { hostname: 'panel' } });
  };
  const result = await verifyAdminProfile({
    baseUrl: 'https://panel.example.com:8443',
    credential: { username: 'admin', password: SECRET_PASSWORD },
    host: 'plesk-host-x',
    fetchImpl: plesk,
  });
  assert.equal(result.ok, true);
  assert.equal(result.twinUpdate.status, 'admin_profile_verified');
  assert.equal(result.twinUpdate.host, 'plesk-host-x');
  // The whole structured result must not contain the secret anywhere.
  assert.ok(!JSON.stringify(result).includes(SECRET_PASSWORD));
});

test('verifyAdminProfile reports rejected credential without failing hard', async () => {
  const plesk = async () => jsonResponse(401, {});
  const result = await verifyAdminProfile({
    baseUrl: 'https://panel.example.com:8443',
    credential: { username: 'admin', password: 'wrong' },
    fetchImpl: plesk,
  });
  assert.equal(result.ok, false);
  assert.equal(result.twinUpdate.status, 'admin_profile_unverified');
  const auth = result.checks.find((c) => c.name === 'authenticated');
  assert.equal(auth.ok, false);
  assert.match(auth.detail, /rejected/);
});

test('verifyAdminProfile treats a network error as unevaluable, not failing', async () => {
  const plesk = async () => { throw new Error('ECONNREFUSED'); };
  const result = await verifyAdminProfile({
    baseUrl: 'https://panel.example.com:8443',
    credential: { username: 'admin', password: 'x' },
    fetchImpl: plesk,
  });
  assert.equal(result.ok, false);
  assert.equal(result.twinUpdate.status, 'unevaluable');
});

test('verifyPleskForTicket wires route -> vault -> verify and returns only references', async () => {
  const routes = {
    routes: {
      'PLF-3816': {
        vault_path: 'secret/data/plesk/admin/host-X',
        base_url: 'https://panel.example.com:8443',
        host: 'plesk-host-x',
        scope: ['verify'],
        max_ttl: 900,
      },
    },
  };
  let revokeSeen = false;
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/sys/leases/revoke')) {
      revokeSeen = true;
      return fakeVaultFetch()(url, options);
    }
    if (url.includes('/v1/')) return fakeVaultFetch()(url, options);
    return jsonResponse(200, { server: {} });
  };
  const result = await verifyPleskForTicket({
    ticket: 'PLF-3816',
    routes,
    vault: { addr: 'https://vault.internal:8200', token: 'vault-token' },
    grant: LIVE_GRANT,
    fetchImpl,
  });
  assert.equal(result.ticket, 'PLF-3816');
  assert.equal(result.ok, true);
  assert.equal(result.vault_path, 'secret/data/plesk/admin/host-X');
  assert.equal(result.lease_id, 'lease-123');
  assert.equal(revokeSeen, true, 'lease must be revoked after verify');
  // The orchestration result is audit-safe: no secret value present.
  assert.ok(!JSON.stringify(result).includes(SECRET_PASSWORD));
});

test('assertGrantAllows accepts a live in-scope grant and rejects the rest', () => {
  assert.equal(assertGrantAllows(LIVE_GRANT, { action: 'verify', resource: 'plesk-host-x' }), true);

  assert.throws(() => assertGrantAllows(null, { action: 'verify' }), /grant_required/);
  assert.throws(
    () => assertGrantAllows({ ...LIVE_GRANT, state: 'revoked' }, { action: 'verify' }),
    /grant_not_active/,
  );
  assert.throws(
    () => assertGrantAllows({ ...LIVE_GRANT, expires_at: '2000-01-01T00:00:00+00:00' }, { action: 'verify' }),
    /grant_expired/,
  );
  assert.throws(
    () => assertGrantAllows({ ...LIVE_GRANT, scope: ['configure'] }, { action: 'verify' }),
    /grant_scope_missing:verify/,
  );
  assert.throws(
    () => assertGrantAllows(LIVE_GRANT, { action: 'verify', resource: 'plesk-host-y' }),
    /grant_resource_mismatch/,
  );
});

test('verifyPleskForTicket refuses before Vault when the grant is missing or wrong', async () => {
  const routes = {
    routes: {
      'PLF-3816': {
        vault_path: 'secret/data/plesk/admin/host-X',
        base_url: 'https://panel.example.com:8443',
        host: 'plesk-host-x',
      },
    },
  };
  let vaultTouched = false;
  const fetchImpl = async (url, options) => {
    vaultTouched = vaultTouched || url.includes('/v1/');
    if (url.includes('/v1/')) return fakeVaultFetch()(url, options);
    return jsonResponse(200, { server: {} });
  };

  // No grant at all -> refused, and Vault must never be contacted.
  await assert.rejects(
    () => verifyPleskForTicket({
      ticket: 'PLF-3816', routes,
      vault: { addr: 'https://vault.internal:8200', token: 'vault-token' },
      grant: null, fetchImpl,
    }),
    /grant_required/,
  );
  assert.equal(vaultTouched, false, 'guard must fail closed before Vault');

  // Revoked grant -> refused.
  await assert.rejects(
    () => verifyPleskForTicket({
      ticket: 'PLF-3816', routes,
      vault: { addr: 'https://vault.internal:8200', token: 'vault-token' },
      grant: { ...LIVE_GRANT, state: 'revoked' }, fetchImpl,
    }),
    /grant_not_active/,
  );
});

test('verifyPleskForTicket refuses an unknown ticket', async () => {
  await assert.rejects(
    () => verifyPleskForTicket({
      ticket: 'UNKNOWN',
      routes: { routes: {} },
      vault: { addr: 'https://v', token: 't' },
      fetchImpl: async () => jsonResponse(200, {}),
    }),
    /no secrets route for ticket UNKNOWN/,
  );
});

test('loadSecretsRoutes parses a routing table', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'twin-plesk-'));
  const file = path.join(dir, 'secrets-routes.json');
  await fs.writeFile(file, JSON.stringify({
    routes: { 'PLF-3816': { vault_path: 'secret/data/x', base_url: 'https://p' } },
  }), 'utf8');
  const routes = loadSecretsRoutes(file);
  assert.equal(routes.routes['PLF-3816'].vault_path, 'secret/data/x');
});
