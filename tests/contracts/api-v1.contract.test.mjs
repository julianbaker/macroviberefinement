import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.CONTRACT_BASE_URL;

function endpoint(path) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function fetchJson(path, init = {}) {
  const response = await fetch(endpoint(path), init);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

async function maybeDelay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (!baseUrl) {
  test('contract suite skipped', { skip: true }, () => {});
} else {
  test('GET /api/v1/session/init returns contract or INSUFFICIENT_POOL', async () => {
    const { response, data } = await fetchJson('/api/v1/session/init?device=mobile&reset=1', {
      method: 'GET',
    });

    assert.ok([200, 503].includes(response.status));

    if (response.status === 503) {
      assert.equal(data?.error?.code, 'INSUFFICIENT_POOL');
      return;
    }

    assert.equal(typeof data?.sessionToken, 'string');
    assert.equal(typeof data?.sessionSize, 'number');
    assert.equal(typeof data?.degraded, 'boolean');
    assert.ok(Array.isArray(data?.tracks));

    if (data.tracks.length > 0) {
      assert.equal(typeof data.tracks[0].trackId, 'string');
      assert.equal(typeof data.tracks[0].streamUrl, 'string');
      assert.ok('artworkUrl' in data.tracks[0]);
      assert.equal(typeof data.tracks[0].seed, 'string');
    }
  });

  test('POST /api/v1/placements enforces session token precedence mismatch', async () => {
    const { response, data } = await fetchJson('/api/v1/placements', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': 'header-token',
      },
      body: JSON.stringify({
        sessionToken: 'body-token',
        trackId: 'track-1',
        binCode: 'VELLUM',
        clientTs: Date.now(),
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(data?.error?.code, 'SESSION_TOKEN_MISMATCH');
  });

  test('POST /api/v1/placements accepts first placement and rejects duplicate', async () => {
    const initResult = await fetchJson('/api/v1/session/init?device=mobile&reset=1', {
      method: 'GET',
    });

    if (initResult.response.status !== 200) {
      assert.equal(initResult.response.status, 503);
      assert.equal(initResult.data?.error?.code, 'INSUFFICIENT_POOL');
      return;
    }

    const sessionToken = initResult.data.sessionToken;
    const track = initResult.data.tracks?.[0];
    assert.ok(sessionToken);

    if (!track) {
      return;
    }

    const firstPlacement = await fetchJson('/api/v1/placements', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': sessionToken,
      },
      body: JSON.stringify({
        trackId: track.trackId,
        binCode: 'VELLUM',
        clientTs: Date.now(),
      }),
    });

    if (firstPlacement.response.status === 503) {
      assert.equal(firstPlacement.data?.error?.code, 'PLACEMENTS_DISABLED');
      return;
    }

    assert.equal(firstPlacement.response.status, 200);
    assert.equal(firstPlacement.data?.ok, true);

    await maybeDelay(350);

    const duplicatePlacement = await fetchJson('/api/v1/placements', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': sessionToken,
      },
      body: JSON.stringify({
        trackId: track.trackId,
        binCode: 'VELLUM',
        clientTs: Date.now(),
      }),
    });

    assert.equal(duplicatePlacement.response.status, 409);
    assert.equal(duplicatePlacement.data?.error?.code, 'DUPLICATE_PLACEMENT');
  });

  test('GET /api/v1/archive/bins returns six fixed bins', async () => {
    const { response, data } = await fetchJson('/api/v1/archive/bins', {
      method: 'GET',
    });

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(data?.bins));

    const codes = new Set(data.bins.map((row) => row.binCode));
    for (const code of ['VELLUM', 'BRINE', 'HEAT', 'STATIC', 'HALO', 'GRIT']) {
      assert.ok(codes.has(code));
    }
  });

  test('GET /api/v1/archive/bin/:binCode honors contract', async () => {
    const { response, data } = await fetchJson('/api/v1/archive/bin/VELLUM', {
      method: 'GET',
    });

    assert.equal(response.status, 200);
    assert.equal(data?.binCode, 'VELLUM');
    assert.ok(Array.isArray(data?.tracks));

    if (data.tracks.length > 0) {
      const first = data.tracks[0];
      assert.equal(typeof first.trackId, 'string');
      assert.ok('assignedAt' in first);
      assert.equal(typeof first.streamUrl, 'string');
    }
  });
}
