// Behavioural tests for patches/baileys+7.0.0-rc14.patch.
//
// They build a real Baileys socket (makeWASocket) over a fake WebSocket that
// never connects to WhatsApp: frames the client sends are captured and decoded,
// and server stanzas are injected by emitting the same `CB:*` events Baileys'
// frame dispatcher emits. No network, no credentials.
//
// Each test fails on an unpatched Baileys rc14.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

process.env.BAILEYS_OFFLINE_BATCH_IDLE_MS = '60';

const baileys = await import('baileys');
const { WebSocketClient } = await import('baileys/lib/Socket/Client/websocket.js');

const makeWASocket = baileys.default;
const { initAuthCreds, decodeBinaryNode, makeCacheableSignalKeyStore } = baileys;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fake transport ---------------------------------------------------------
const sentFrames = [];
WebSocketClient.prototype.connect = function () {
  this.socket = { readyState: 1 /* OPEN */ };
};
WebSocketClient.prototype.send = function (data, cb) {
  sentFrames.push(Buffer.from(data));
  cb?.();
  return true;
};
WebSocketClient.prototype.close = async function () {
  this.socket = null;
};

// Before the noise handshake finishes Baileys sends frames unencrypted:
// [intro header on the first frame][3-byte length][binary node].
async function decodeFrame(buf) {
  for (let offset = 0; offset + 3 <= buf.length; offset++) {
    if (buf.readUIntBE(offset, 3) === buf.length - offset - 3) {
      try {
        return await decodeBinaryNode(buf.subarray(offset + 3));
      } catch {
        // not the real boundary, keep looking
      }
    }
  }
  return undefined;
}

async function sentNodes() {
  const nodes = [];
  for (const frame of sentFrames) {
    const node = await decodeFrame(frame);
    if (node) nodes.push(node);
  }
  return nodes;
}

const childTags = (node) => (Array.isArray(node?.content) ? node.content.map((c) => c.tag) : []);
const isOfflineBatch = (node) => node.tag === 'ib' && childTags(node).includes('offline_batch');

// --- in-memory auth state ---------------------------------------------------
function memoryKeys() {
  const data = {};
  return {
    data,
    get: async (type, ids) => Object.fromEntries(ids.map((id) => [id, data[`${type}-${id}`]])),
    set: async (values) => {
      for (const type in values) {
        for (const id in values[type]) {
          const value = values[type][id];
          if (value) data[`${type}-${id}`] = value;
          else delete data[`${type}-${id}`];
        }
      }
    },
  };
}

function silentLogger() {
  const logger = {
    level: 'silent',
    lines: [],
    child: () => logger,
  };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    logger[level] = (obj, msg) => logger.lines.push({ level, msg: typeof obj === 'string' ? obj : msg });
  }
  return logger;
}

let sock;
let keys;

beforeEach(() => {
  sentFrames.length = 0;
  keys = memoryKeys();
  const creds = initAuthCreds();
  creds.me = { id: '5511900000000:1@s.whatsapp.net', lid: '100000000000000:1@lid', name: 'test' };
  const logger = silentLogger();
  sock = makeWASocket({
    auth: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: false,
    defaultQueryTimeoutMs: 60_000,
  });
});

afterEach(async () => {
  await sock.end(undefined);
  delete process.env.BAILEYS_PROFILE_PIC_TCTOKEN;
});

describe('bug 3: offline sync asks for every batch', () => {
  test('asks for another offline_batch after a quiet period until <ib><offline> arrives', async () => {
    sock.ws.emit('CB:ib,,offline_preview', {
      tag: 'ib',
      attrs: {},
      content: [{ tag: 'offline_preview', attrs: { count: '350', message: '350' } }],
    });
    await sleep(10);
    assert.equal((await sentNodes()).filter(isOfflineBatch).length, 1, 'first batch requested at once');

    // Offline items keep arriving: no extra request while they flow.
    for (let i = 0; i < 4; i++) {
      sock.ws.emit('CB:receipt', {
        tag: 'receipt',
        attrs: { id: `R${i}`, from: '5511911111111@s.whatsapp.net', offline: '1', t: '1700000000' },
      });
      await sleep(25);
    }
    assert.equal((await sentNodes()).filter(isOfflineBatch).length, 1, 'no extra batch while items flow');

    // Quiet period: the client asks for the next batch (upstream never does).
    await sleep(200);
    const afterQuiet = (await sentNodes()).filter(isOfflineBatch).length;
    assert.ok(afterQuiet >= 2, `expected a follow-up offline_batch, got ${afterQuiet}`);

    // Server says the offline sync is over: no more requests.
    sock.ws.emit('CB:ib,,offline', {
      tag: 'ib',
      attrs: {},
      content: [{ tag: 'offline', attrs: { count: '350' } }],
    });
    const atDone = (await sentNodes()).filter(isOfflineBatch).length;
    await sleep(250);
    assert.equal((await sentNodes()).filter(isOfflineBatch).length, atDone, 'stops after <ib><offline>');
  });

  test('never asks for a batch the server did not announce with <offline_preview>', async () => {
    sock.ws.emit('CB:receipt', {
      tag: 'receipt',
      attrs: { id: 'R-no-preview', from: '5511911111111@s.whatsapp.net', offline: '0', t: '1700000000' },
    });
    await sleep(250);
    assert.equal((await sentNodes()).filter(isOfflineBatch).length, 0);
  });

  test('stops asking once the socket ends', async () => {
    sock.ws.emit('CB:ib,,offline_preview', { tag: 'ib', attrs: {}, content: [{ tag: 'offline_preview', attrs: {} }] });
    await sleep(10);
    await sock.end(undefined);
    const atEnd = (await sentNodes()).filter(isOfflineBatch).length;
    await sleep(250);
    assert.equal((await sentNodes()).filter(isOfflineBatch).length, atEnd);
  });
});

describe('issue #2778: top-level <status> stanzas are acked', () => {
  test('online <status> gets a plain ack', async () => {
    sock.ws.emit('CB:status', {
      tag: 'status',
      attrs: { id: 'STATUS1', from: '5511922222222@s.whatsapp.net', type: 'text', t: '1700000000' },
    });
    await sleep(20);
    const ack = (await sentNodes()).find((n) => n.tag === 'ack' && n.attrs.id === 'STATUS1');
    assert.ok(ack, 'an ack was sent for the status stanza');
    assert.equal(ack.attrs.class, 'status');
    assert.equal(ack.attrs.to, '5511922222222@s.whatsapp.net');
    assert.equal(ack.attrs.error, undefined, 'plain ack, not a nack');
  });

  test('offline <status> is acked through the offline queue', async () => {
    sock.ws.emit('CB:status', {
      tag: 'status',
      attrs: { id: 'STATUS2', from: '5511933333333@s.whatsapp.net', type: 'media', offline: '1', t: '1700000000' },
    });
    await sleep(20);
    const ack = (await sentNodes()).find((n) => n.tag === 'ack' && n.attrs.id === 'STATUS2');
    assert.ok(ack, 'an ack was sent for the offline status stanza');
    assert.equal(ack.attrs.class, 'status');
  });
});

describe('bug 2: profile picture IQ without <tctoken>', () => {
  // A LID JID resolves its tctoken storage key locally (a PN would trigger a usync LID lookup).
  const target = '123456789012345@lid';

  async function profilePictureIq() {
    // Stored privacy token for the contact, as after a normal exchange of messages.
    await keys.set({
      tctoken: { [target]: { token: Buffer.from('tctoken-bytes'), timestamp: String(Math.floor(Date.now() / 1000)) } },
    });
    // Nobody answers the IQ here; a short timeout ends the wait.
    await sock.profilePictureUrl(target, 'image', 50).catch(() => undefined);
    const iq = (await sentNodes()).find((n) => n.tag === 'iq' && n.attrs.xmlns === 'w:profile:picture');
    assert.ok(iq, 'the profile picture IQ was sent');
    // The token travels as a child of <picture>.
    const picture = iq.content.find((c) => c.tag === 'picture');
    assert.ok(picture, 'the IQ asks for a <picture>');
    return picture;
  }

  test('does not attach <tctoken> by default', async () => {
    const picture = await profilePictureIq();
    assert.ok(!childTags(picture).includes('tctoken'), `unexpected children: ${childTags(picture)}`);
  });

  test('BAILEYS_PROFILE_PIC_TCTOKEN=true restores the upstream behaviour', async () => {
    process.env.BAILEYS_PROFILE_PIC_TCTOKEN = 'true';
    const picture = await profilePictureIq();
    assert.ok(childTags(picture).includes('tctoken'), `expected a tctoken child, got: ${childTags(picture)}`);
  });
});
