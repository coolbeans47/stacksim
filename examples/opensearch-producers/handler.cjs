const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
const { OpenSearchClient, DescribeDomainCommand } = require('@aws-sdk/client-opensearch');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');

// Resolve the managed endpoint with the function's current execution credentials.
// No simulator state or host filesystem access is needed by the function.
async function searchClient(context) {
  const credentials = () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN });
  const control = new OpenSearchClient({ region: process.env.AWS_REGION, credentials, maxAttempts: 1 });
  let domain;
  try { domain = (await control.send(new DescribeDomainCommand({ DomainName: process.env.SEARCH_DOMAIN }))).DomainStatus; }
  finally { control.destroy(); }
  if (!domain?.Endpoint || domain.Deleted || domain.Processing) throw new Error('Search domain is not ready');
  return new Client({ node: `https://${domain.Endpoint}`, maxRetries: 0,
    requestTimeout: Math.max(1, Math.min(10000, (context?.getRemainingTimeInMillis?.() ?? 11000) - 1000)),
    ...(process.env.SEARCH_CA_PEM ? { ssl: { ca: process.env.SEARCH_CA_PEM } } : {}),
    ...AwsSigv4Signer({ region: process.env.AWS_REGION, service: 'es', getCredentials: async () => credentials() }),
  });
}

exports.product = async (event, context) => {
  if (!event || !['put', 'get', 'search', 'delete'].includes(event.operation)) throw new Error('operation must be put, get, search or delete');
  if (event.operation !== 'search' && (typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id))) throw new Error('A bounded product id is required');
  if (event.operation === 'put' && (!event.document || typeof event.document !== 'object' || Array.isArray(event.document) || Buffer.byteLength(JSON.stringify(event.document)) > 65536)) throw new Error('document must be an object up to 64 KiB');
  if (event.operation === 'search' && (typeof event.text !== 'string' || event.text.length > 1000)) throw new Error('text must be a string up to 1000 characters');
  const client = await searchClient(context);
  try {
    if (event.operation === 'put') return (await client.index({ index: 'products', id: event.id, body: event.document, refresh: true })).body;
    if (event.operation === 'get') return (await client.get({ index: 'products', id: event.id })).body;
    if (event.operation === 'delete') return (await client.delete({ index: 'products', id: event.id, refresh: true })).body;
    return (await client.search({ index: 'products', body: { size: 20, query: { match: { title: event.text } } } })).body;
  } finally { await client.close(); }
};

exports.logs = async (event, context) => {
  if (typeof event?.awslogs?.data !== 'string' || event.awslogs.data.length > 8 * 1024 * 1024) throw new Error('A bounded CloudWatch Logs envelope is required');
  const payload = JSON.parse(gunzipSync(Buffer.from(event.awslogs.data, 'base64'), { maxOutputLength: 10 * 1024 * 1024 }).toString('utf8'));
  if (payload.messageType === 'CONTROL_MESSAGE') return { ignored: true };
  if (payload.messageType !== 'DATA_MESSAGE' || !Array.isArray(payload.logEvents) || payload.logEvents.length > 10000 || !['owner', 'logGroup', 'logStream'].every(key => typeof payload[key] === 'string')) throw new Error('Invalid CloudWatch Logs envelope');
  const namespace = createHash('sha256').update(JSON.stringify([payload.owner, payload.logGroup, payload.logStream])).digest('hex');
  const records = payload.logEvents.map(item => {
    if (typeof item.id !== 'string' || item.id.length > 1024 || typeof item.message !== 'string' || Buffer.byteLength(item.message) > 256 * 1024 || !Number.isSafeInteger(item.timestamp) || item.timestamp < 0 || item.timestamp > 8640000000000000) throw new Error('Invalid log event');
    const date = new Date(item.timestamp).toISOString();
    return { action: { index: { _index: `logs-${date.slice(0, 10).replace(/-/g, '.')}`, _id: createHash('sha256').update(`${namespace}:${item.id}`).digest('hex') } },
      document: { '@timestamp': date, message: item.message, owner: payload.owner, log_group: payload.logGroup, log_stream: payload.logStream, event_id: item.id } };
  });
  if (!records.length) return { indexed: 0 };
  const client = await searchClient(context);
  try {
    // Bound each request to 500 records / 5 MiB. A failed batch throws so Lambda's
    // asynchronous queue can retry it; stable IDs make successful replays upserts.
    let body = [], bytes = 0, index;
    const flush = async () => {
      if (!body.length) return;
      const response = (await client.bulk({ index, body })).body;
      if (response.errors) {
        const failed = response.items.flatMap(item => Object.values(item)).filter(item => item.error);
        throw new Error(`Search bulk failed for ${failed.length} items (status ${failed[0]?.status})`);
      }
      body = []; bytes = 0;
    };
    for (const record of records) {
      const size = Buffer.byteLength(JSON.stringify(record.action)) + Buffer.byteLength(JSON.stringify(record.document)) + 2;
      if (body.length >= 1000 || bytes + size > 5 * 1024 * 1024 || index !== record.action.index._index) await flush();
      index = record.action.index._index;
      body.push(record.action, record.document); bytes += size;
    }
    await flush(); return { indexed: records.length };
  } finally { await client.close(); }
};
