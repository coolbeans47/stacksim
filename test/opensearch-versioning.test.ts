import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedSearchEngine } from '../src/opensearch/engine.js';

test('External document versions survive delete, refresh and restart and reject stale writes without mutations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-search-version-'));
  let engine = new EmbeddedSearchEngine(join(root, 'search.sqlite'));
  const call = (method: string, path: string, body?: any) => engine.request(method, path, Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)), 'alice');
  try {
    assert.equal((await call('PUT', '/events/_doc/a?version=10&version_type=external', { text: 'latest' })).body._version, 10);
    for (const version of [9, 10]) await assert.rejects(call('PUT', `/events/_doc/a?version=${version}&version_type=external`, { text: 'stale', rejected: true }), { status: 409 });
    assert.equal((await call('GET', '/events/_doc/a')).body._seq_no, 0);
    assert.equal((await call('PUT', '/events/_doc/a?version=10&version_type=external_gte&refresh=true', { text: 'same version' })).body._version, 10);
    assert.equal((await call('DELETE', '/events/_doc/a?version=12&version_type=external&refresh=true')).body._version, 12);
    engine.close(); engine = new EmbeddedSearchEngine(join(root, 'search.sqlite'));
    await assert.rejects(call('PUT', '/events/_doc/a?version=11&version_type=external', { text: 'resurrection' }), { status: 409 });
    assert.equal((await call('GET', '/events/_doc/a')).status, 404);
    assert.equal((await call('DELETE', '/missing/_doc/a?version=20&version_type=external')).status, 404);
    await assert.rejects(call('PUT', '/missing/_doc/a?version=19&version_type=external', {}), { status: 409 });
    assert.equal((await call('PUT', '/events/_doc/a?version=13&version_type=external', { text: 'new' })).body._version, 13);
    assert.equal((await call('PUT', '/events/_doc/a?version=13', { text: 'internal cas' })).body._version, 14);
    await assert.rejects(call('DELETE', '/events/_doc/a?version=13'), { status: 409 });
    for (const query of ['version_type=external', 'version=-1&version_type=external', 'version=9007199254740992&version_type=external', 'version=10&version_type=force', 'version=10&if_seq_no=0&if_primary_term=1']) await assert.rejects(call('PUT', `/invalid/_doc/a?${query}`, {}), { status: 400 });
    assert.equal(engine.indexes().some(index => index.name === 'invalid'), false);
    const body = '{"index":{"_id":"a","version":15,"version_type":"external"}}\n{"text":"bulk"}\n{"delete":{"_id":"a","version":14,"version_type":"external"}}\n{"update":{"_id":"a","version":15}}\n{"doc":{"text":"invalid"}}\n{"create":{"_id":"b","version":2,"version_type":"external"}}\n{}\n';
    const bulk = (await call('POST', '/events/_bulk?refresh=true', body)).body;
    assert.deepEqual(bulk.items.map((item: any) => Object.values<any>(item)[0].status), [200, 409, 400, 400]);
    assert.equal((await call('GET', '/events/_doc/a')).body._source.text, 'bulk');
    assert.equal((await call('GET', '/events/_doc/a')).body._version, 15);
    await call('PUT', '/zero/_doc/a?version=0&version_type=external', { text: 'zero version' });
    engine.restoreSnapshot(engine.exportSnapshot({ indices: 'zero' }), { rename_pattern: '^zero$', rename_replacement: 'restored-zero' });
    assert.equal((await call('GET', '/restored-zero/_doc/a')).body._version, 0);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
