/**
 * Gateway 通道化自测：起 fake local hub + gateway server + agent，
 * 验证 client/worker 双通道复用、/worker query 透传、旧协议拒绝。
 * 运行：npx tsx scripts/e2e-check.ts
 */
import { WebSocketServer, WebSocket } from 'ws';
import { startServer } from '../src/server.js';
import { startAgent } from '../src/agent.js';

const HUB_ID = 'testhub-0123456789abcdef';
const PUBLIC_TOKEN = 'pub-' + 'a'.repeat(45);
const GATEWAY_TOKEN = 'gw-' + 'b'.repeat(45);
const ADMIN_TOKEN = 'adm-' + 'c'.repeat(45);
const CONN_TOKEN = 'conn-' + 'd'.repeat(43);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

// fake local hub：记录连接 path，echo 回包
const localSeen: { url: string }[] = [];
const localHub = new WebSocketServer({ port: 18787 });
localHub.on('connection', (ws, req) => {
  localSeen.push({ url: req.url ?? '' });
  ws.on('message', (d) => ws.send(`echo:${String(d)}`));
});

startServer({ port: 9001, host: '127.0.0.1', gatewayToken: GATEWAY_TOKEN, adminToken: ADMIN_TOKEN, maxClientsPerHub: 5 });
await sleep(300);
startAgent({
  hubId: HUB_ID,
  gatewayUrl: 'ws://127.0.0.1:9001',
  gatewayToken: GATEWAY_TOKEN,
  publicToken: PUBLIC_TOKEN,
  localHubUrl: 'ws://127.0.0.1:18787',
  hubToken: 'dev-token',
});
await sleep(600);

const nextMsg = (ws: WebSocket, timeout = 4000): Promise<string> =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), timeout);
    ws.once('message', (d) => { clearTimeout(t); res(String(d)); });
  });

// 1. client 通道
const client = new WebSocket(`ws://127.0.0.1:9001/hub/${HUB_ID}?public_token=${PUBLIC_TOKEN}`);
await new Promise((r) => client.once('open', r));
client.send('{"id":1,"method":"ping"}');
const cReply = await nextMsg(client);
check('client data round-trip', cReply === 'echo:{"id":1,"method":"ping"}');

// 2. worker 通道：query 透传到本地 /worker
const worker = new WebSocket(
  `ws://127.0.0.1:9001/hub/${HUB_ID}/worker?public_token=${PUBLIC_TOKEN}&token=${CONN_TOKEN}&multiplex=1&agent=devin`,
);
await new Promise((r) => worker.once('open', r));
worker.send('{"type":"worker-hello"}');
const wReply = await nextMsg(worker);
check('worker data round-trip', wReply === 'echo:{"type":"worker-hello"}');

const workerConn = localSeen.find((c) => c.url.startsWith('/worker'));
check('worker path forwarded', !!workerConn);
check(
  'worker query passthrough',
  !!workerConn &&
    workerConn.url.includes(`token=${CONN_TOKEN}`) &&
    workerConn.url.includes('multiplex=1') &&
    workerConn.url.includes('agent=devin'),
);

// 3. 客户端本地连接 token 由 agent 注入 hubToken，不透出
// announce 控制连接同样走 /?token=，需排除：取带 via=gateway 的中继客户端通道
const clientConn = localSeen.find((c) => c.url.startsWith('/?') && c.url.includes('via=gateway'));
check('client local conn uses hubToken', !!clientConn && clientConn.url.includes('token=dev-token'));
check('client via=gateway', !!clientConn);
check('worker via=gateway-worker', !!workerConn && workerConn.url.includes('via=gateway-worker'));

// 4. 旧协议 agent（转发非信封原文）被拒；用独立 hubId 避免顶替真 agent 槽位
const legacy = new WebSocket(`ws://127.0.0.1:9001/control/legacy-0123456789abcde`, {
  headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, 'X-Public-Token': PUBLIC_TOKEN },
});
await new Promise((r) => legacy.once('open', r));
legacy.send('{"id":1,"method":"ping"}');
const legacyClose = await new Promise<number>((r) => legacy.once('close', (c) => r(c)));
check('legacy agent rejected (1008)', legacyClose === 1008);

// 5. 公共路径拒绝错误 token
const bad = new WebSocket(`ws://127.0.0.1:9001/hub/${HUB_ID}?public_token=wrong`);
const badClose = await new Promise<number>((r) => bad.once('close', (c) => r(c)));
check('bad public token rejected (1008)', badClose === 1008);

client.close();
worker.close();
localHub.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
