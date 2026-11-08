// 记忆注入链路的离线验证：不发 QQ 消息，直接对着真记忆服务跑一遍。
//
// 判据（缺一条就算失败）：
//   1. pre-step **绝不改写** decision（改写会做出非法 UserMessage：
//      2026-11-07 22:48 实测把整轮打成 turn/end 却没有 assistant/message 的空转）
//   2. pre-step 会把检索结果写进缓存，systemPrompt.context 的 text 读到同一段文本
//   3. 记忆文本里含「紫色海豚-7319」
//   4. 非 IM 会话 → context 返回空串
//   5. 记忆服务不可达 → context 返回空串、不抛异常
//
// 用法：node test/prestep-recall.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIAG = mkdtempSync(join(tmpdir(), 'tingxue-diag-'));
process.env.DSH_TINGXUE_DIAG_DIR = DIAG;
// 面板设置也要隔离：写回开关从这里读，不能动线上那份。
const LOCAL = mkdtempSync(join(tmpdir(), 'tingxue-local-'));
mkdirSync(join(LOCAL, 'dsh-tingxue-ui'), { recursive: true });
writeFileSync(join(LOCAL, 'dsh-tingxue-ui', 'settings.json'), JSON.stringify({
  companion: { injectTier: 'full', writeBack: true },
  agent: { injectTier: 'archive', writeBack: false },
}), 'utf8');
process.env.LOCALAPPDATA = LOCAL;

const PLUGIN = 'file:///D:/oransky/Desktop/oransky/dsh/dsh-tingxue/src/im-bot/index.mjs';
const mod = await import(PLUGIN);

const CHAT_SESSION = 'session-c732ae5c-11bb-4559-ba8b-7a2ba79dd235';
const USER_TEXT = '我的暗号是什么';

function mount(baseUrl) {
  const handlers = new Map();
  const contexts = [];
  const ctx = {
    // 真 Cordis 允许同一个事件挂多个监听；这里必须也攒成数组，
    // 否则后注册的会顶掉先注册的（session/event 现在有两个监听）。
    on(name, fn) {
      const arr = handlers.get(name) ?? [];
      arr.push(fn);
      handlers.set(name, arr);
      return () => {};
    },
    inject(_deps, cb) {
      try {
        cb({
          systemPrompt: {
            section: () => () => {},
            context: (spec) => { contexts.push(spec); return () => {}; },
          },
        });
      } catch { /* 忽略 */ }
    },
  };
  mod.apply(ctx, {
    personaPath: 'D:\\oransky\\Desktop\\oransky\\dsh\\dsh-tingxue\\听雪档案.txt',
    botStateDir: 'D:\\dsh-home\\integrations\\dsh-qq\\bots',
    memoryServiceUrl: baseUrl,
    memoryRecall: 'full',
  });
  const fire = async (name, ...args) => {
    const arr = handlers.get(name) ?? [];
    for (const fn of arr) await fn(...args);
  };
  const prestep = handlers.get('agent/pre-step')?.[0];
  assert.ok(prestep, 'pre-step 钩子没注册');
  const memoryCtx = contexts.find((c) => c?.name === 'dsh-tingxue:memory');
  assert.ok(memoryCtx, 'systemPrompt.context 没注册');
  return { prestep, memoryCtx, handlers, fire };
}

const mkPayload = (sessionId, step, cwd) => ({
  agent: { session: { id: sessionId, header: { cwd } } },
  messages: [{ role: 'user', content: [{ type: 'text', text: USER_TEXT }] }],
  step,
  turn: 1,
  signal: new AbortController().signal,
});
const asAssembly = (sessionId, cwd) => ({ agent: { session: { id: sessionId, header: { cwd } } } });

const results = [];

// 1 + 2 + 3. 真实链路：pre-step 只缓存，context 吐文本
{
  const { prestep, memoryCtx } = mount('http://127.0.0.1:8766');
  const payload = mkPayload(CHAT_SESSION, 1, 'D:\\oransky\\IM_QQ_TingXue');
  // 先看 context 在没有缓存时是否为空
  assert.equal(memoryCtx.text(asAssembly(CHAT_SESSION, 'D:\\oransky\\IM_QQ_TingXue')), '', '缓存为空时 context 不应有内容');
  const decision = { kind: 'enter', messages: payload.messages };
  const out = await prestep(payload, async () => decision);
  assert.equal(out, decision, 'pre-step 改写了 decision（非法 UserMessage，会把整轮打空）');
  assert.equal(out.messages, decision.messages, 'pre-step 动了 messages 数组');
  const text = memoryCtx.text(asAssembly(CHAT_SESSION, 'D:\\oransky\\IM_QQ_TingXue'));
  assert.ok(text.length > 0, 'context 没吐出记忆文本');
  assert.match(text, /紫色海豚-7319/, '记忆文本里没有暗号');
  results.push(['pre-step 只缓存不改消息', 'decision 原样返回', 'PASS']);
  results.push(['context 吐出记忆', `${text.length} 字，含暗号`, 'PASS']);
}

// 4. 非 IM 会话
{
  const { memoryCtx } = mount('http://127.0.0.1:8766');
  const text = memoryCtx.text(asAssembly('session-00000000-0000-0000-0000-000000000000', 'D:\\somewhere\\not-im'));
  assert.equal(text, '', '非 IM 会话不该拿到记忆');
  results.push(['非 IM 会话不注入', 'context 空串', 'PASS']);
}

// 5. 服务不可达
{
  const { prestep, memoryCtx } = mount('http://127.0.0.1:1');
  const payload = mkPayload(CHAT_SESSION, 1, 'D:\\oransky\\IM_QQ_TingXue');
  await prestep(payload, async () => ({ kind: 'enter', messages: payload.messages }));
  assert.equal(memoryCtx.text(asAssembly(CHAT_SESSION, 'D:\\oransky\\IM_QQ_TingXue')), '', '服务不可达时不该有内容');
  results.push(['记忆服务不可达', 'context 空串、不抛异常', 'PASS']);
}

// 6. 真实 IM 形态：step=1 的 payload.messages 只有 <dsh_im_source> 元数据，
//    用户正文只在会话 eventsSnapshot 里 —— 这条不通过，线上就等于没查记忆。
{
  const { prestep, memoryCtx } = mount('http://127.0.0.1:8766');
  const META = '<dsh_im_source>{"channel":"qq","conversationType":"direct"}</dsh_im_source>';
  const metaOnly = {
    agent: {
      session: {
        id: CHAT_SESSION,
        header: { cwd: 'D:\\oransky\\IM_QQ_TingXue' },
        eventsSnapshot: [
          { type: 'turn/start', data: {} },
          { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }] } },
          { type: 'user/message', data: { content: [{ type: 'text', text: META }] } },
        ],
      },
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: META }] }],
    step: 1,
    turn: 1,
    signal: new AbortController().signal,
  };
  const decision = { kind: 'enter', messages: metaOnly.messages };
  const out = await prestep(metaOnly, async () => decision);
  assert.equal(out, decision, '元数据形态下 pre-step 改写了 decision');
  const text = memoryCtx.text(asAssembly(CHAT_SESSION, 'D:\\oransky\\IM_QQ_TingXue'));
  assert.ok(text.length > 0, 'payload.messages 只有元数据时回退抓正文失败 → 线上等于没查记忆');
  assert.match(text, /紫色海豚-7319/, '回退路径拿到的记忆里没有暗号');
  results.push(['payload 只有元数据', `回退 eventsSnapshot，${text.length} 字含暗号`, 'PASS']);
}

// 7. 线上真实形态（2026-11-08 11:43 实测）：payload.messages = [来源元数据, 运行上下文]，
//    正文根本不在里面；eventsSnapshot 只有上一轮的正文。本轮正文只在收件箱事件里。
//    这条不通过，线上检索词就是上一轮的话（「介绍一下用户」），记忆永远慢一拍。
{
  const { prestep, memoryCtx, handlers, fire } = mount('http://127.0.0.1:8766');
  const META = '<dsh_im_source>{"channel":"qq","conversationType":"direct"}</dsh_im_source>';
  assert.ok((handlers.get('agent/inbox/inserted') ?? []).length > 0, 'agent/inbox/inserted 钩子没注册');
  const session = {
    id: CHAT_SESSION,
    header: { cwd: 'D:\\oransky\\IM_QQ_TingXue' },
    eventsSnapshot: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '介绍一下用户' }] } },
    ],
  };
  // 收件箱事件：元数据和正文在同一条消息里
  await fire('agent/inbox/inserted', { agent: { session }, message: { role: 'user', content: [{ type: 'text', text: `${META}\n\n${USER_TEXT}` }] }, turn: 9 });
  const payload = {
    agent: { session },
    messages: [
      { role: 'user', content: [{ type: 'text', text: META }] },
      { role: 'user', content: [{ type: 'text', text: 'Current runtime context. cwd=D:\\oransky\\IM_QQ_TingXue' }] },
    ],
    step: 1,
    turn: 9,
    signal: new AbortController().signal,
  };
  const decision = { kind: 'enter', messages: payload.messages };
  const out = await prestep(payload, async () => decision);
  assert.equal(out, decision, '真实形态下 pre-step 改写了 decision');
  const text = memoryCtx.text(asAssembly(CHAT_SESSION, 'D:\\oransky\\IM_QQ_TingXue'));
  assert.ok(text.length > 0, '收件箱正文没被用上 → 本轮检索还是空/旧');
  assert.match(text, /紫色海豚-7319/, '检索词没用本轮正文（拿到的记忆里没有暗号）');
  results.push(['正文只在收件箱里', `用本轮正文检索，${text.length} 字含暗号`, 'PASS']);
}

// 8. 写回：一轮说完要把「用户：… / 听雪：…」POST 到 /memory。
//    用本地假服务收包，判据是「真的收到了这条 body」，不是「调用没抛异常」。
{
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'stub' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const { prestep, handlers, fire } = mount(`http://127.0.0.1:${port}`);
  assert.ok((handlers.get('agent/inbox/inserted') ?? []).length > 0, 'agent/inbox/inserted 钩子没注册');
  assert.ok((handlers.get('session/event') ?? []).length > 0, 'session/event 钩子没注册');
  const META = '<dsh_im_source>{"channel":"qq"}</dsh_im_source>';
  const session = {
    id: CHAT_SESSION,
    header: { cwd: 'D:\\oransky\\IM_QQ_TingXue' },
    // 线上实测（2026-11-08 11:56 turn 17）：turn-stopping 时 eventsSnapshot 里还没有本轮回复，
    // 所以回复只能从 session/event 事件流里记。
    eventsSnapshot: [
      { type: 'user/message', data: { content: [{ type: 'text', text: `${META}\n\n写了长一点的答复` }] } },
    ],
  };
  await fire('agent/inbox/inserted', { agent: { session }, message: { role: 'user', content: [{ type: 'text', text: `${META}\n\n写了长一点的答复` }] }, turn: 11 });
  const payload = { agent: { session }, messages: [{ role: 'user', content: [{ type: 'text', text: META }] }], step: 1, turn: 11, signal: new AbortController().signal };
  await prestep(payload, async () => ({ kind: 'enter', messages: payload.messages }));
  // 线上真实形态：assistant/message 是 [reasoning, text] 两段。
  // 写回必须只取 text 段，独白不能进记忆（否则记忆里全是「The user says…」的助手腔）。
  await fire('session/event', session, {
    type: 'assistant/message',
    data: {
      content: [
        { type: 'reasoning', text: 'The user says passphrase. Answer: 紫色海豚-7319. Keep short.' },
        { type: 'text', text: '暗号是紫色海豚-7319。' },
      ],
    },
  });
  // 写回触发点：turn/end（turn-stopping 那一刻回复还没落盘，2026-11-08 实测）
  await fire('session/event', session, { type: 'turn/end', data: { turn: 11 } });
  let posts = [];
  for (let i = 0; i < 60; i += 1) {
    posts = got.filter((g) => g.method === 'POST');
    if (posts.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  server.close();
  assert.equal(posts.length, 1, `写回请求没发出去（收到 ${posts.length} 条 POST）`);
  assert.match(posts[0].url, /^\/memory$/, '写回路径不对');
  const sent = JSON.parse(posts[0].body);
  assert.match(sent.text, /用户：写了长一点的答复/, '写回 body 里没有用户这句');
  assert.match(sent.text, /听雪：暗号是紫色海豚-7319/, '写回 body 里没有听雪的回复');
  assert.equal(sent.scene, 'chat', '聊天 bot 的 scene 应该是 chat');
  assert.ok(!/The user says/.test(sent.text), '写回把 reasoning 独白也写进记忆了（助手腔污染源头）');
  results.push(['写回 /memory', `stub 收到 1 条，${sent.text.length} 字`, 'PASS']);
}

// 9. 人格排第一 + 摘掉助手腔：装配后的段落顺序必须是
//    [听雪身份, 人格, …工具手册]，且没有 Web GUI / Team Lead / 文件卡片这些编程代理说明。
{
  const { handlers } = mount('http://127.0.0.1:8766');
  const assemble = handlers.get('system-prompt/assemble')?.[0];
  assert.ok(assemble, 'system-prompt/assemble 钩子没注册');
  const MARK = '<<dsh-tingxue:replace-base>>';
  const raw = [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'free-search:engines', text: '## Web search (free-search)' },
    { name: 'dsh-tingxue:persona', text: `${MARK}\n你是听雪，一只白毛猫娘。` },
    { name: 'app:web-surface', text: 'You are interacting with the user through the DeepSeek Harness Web GUI.' },
    { name: 'harness:source', text: 'The runtime context names the DeepSeek Harness implementation checkout.' },
    { name: 'ui:deliverable-file-references', text: 'Use ![Description](path)' },
    { name: 'team:policy', text: 'You are the Team Lead named "lead".' },
    { name: 'tool:read', text: 'Use the read tool' },
  ];
  const out = await assemble({ sections: raw }, {}, async () => ({ sections: raw }));
  const names = out.sections.map((x) => x.name);
  assert.equal(names[0], 'dsh-tingxue:identity', `第一段不是听雪身份，而是 ${names[0]}`);
  assert.equal(names[1], 'dsh-tingxue:persona', `第二段不是人格，而是 ${names[1]}`);
  for (const gone of ['app:web-surface', 'harness:source', 'ui:deliverable-file-references', 'team:policy', 'harness:identity']) {
    assert.ok(!names.includes(gone), `${gone} 没被摘掉`);
  }
  assert.ok(names.includes('tool:read') && names.includes('free-search:engines'), '工具段落被误删了（能力不能砍）');
  const identity = out.sections[0].text;
  assert.match(identity, /工具使用手册/, '身份段没说明工具只是手册');
  assert.match(identity, /不是你的身份/, '身份段没撇清「工具人」身份');
  assert.ok(out.sections[1].text.startsWith('你是听雪'), '人格段开头不是听雪');
  assert.ok(!out.sections[1].text.includes(MARK), '人格段里的替换标记没去掉');
  results.push(['人格排第一 + 去助手腔', `${names[0]} → ${names[1]}，摘掉 5 段编程代理说明`, 'PASS']);
}

// 10. 听雪-agent：人格同样排第一，但 Agent Teams 策略段（team:policy）必须留着，
//     并且「You are the Team Lead named …」那句要被换掉（主人 2026-11-08 定：
//     Agent Teams 是重要能力，工作 bot 不能没有；但别让它自称 Team Lead）。
{
  const { handlers } = mount('http://127.0.0.1:8766');
  const assemble = handlers.get('system-prompt/assemble')?.[0];
  const MARK = '<<dsh-tingxue:replace-base>>';
  const raw = [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'team:policy', text: 'You are the Team Lead named "lead".\n\nUse spawn_teammate to create teammates.' },
    { name: 'dsh-tingxue:persona', text: `${MARK}agent\n你是听雪，一只白毛猫娘。` },
    { name: 'tool:read', text: 'Use the read tool' },
  ];
  const out = await assemble({ sections: raw }, {}, async () => ({ sections: raw }));
  const names = out.sections.map((x) => x.name);
  assert.equal(names[0], 'dsh-tingxue:identity', `agent 第一段不是身份，而是 ${names[0]}`);
  assert.equal(names[1], 'dsh-tingxue:persona', `agent 第二段不是人格，而是 ${names[1]}`);
  assert.ok(names.includes('team:policy'), 'agent bot 的 Agent Teams 策略被摘掉了（重要能力不能砍）');
  const team = out.sections.find((x) => x.name === 'team:policy').text;
  assert.ok(!/You are the Team Lead named/.test(team), 'team:policy 里还留着「You are the Team Lead named」');
  assert.match(team, /Agent Teams/, 'team:policy 丢了 Agent Teams 说明');
  assert.match(team, /你不是 Team Lead/, '没把 Team Lead 身份改写成「你是听雪」');
  assert.match(team, /spawn_teammate/, 'team:policy 的可用手段（spawn_teammate）被顺手删掉了');
  assert.ok(out.sections[1].text.startsWith('你是听雪'), 'agent 人格段开头不是听雪');
  results.push(['agent 保留 Agent Teams', `team:policy 保留且改写，${team.length} 字`, 'PASS']);
}

console.log('用例'.padEnd(28), '证据'.padEnd(36), '结果');
for (const row of results) console.log(row[0].padEnd(28), row[1].padEnd(36), row[2]);
console.log(`\n${results.length}/${results.length} 通过`);
