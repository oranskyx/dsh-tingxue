/**
 * dsh-tingxue · S2 最小骨架
 *
 * 只做一件事：把听雪人格注入 system prompt。
 * 用 `systemPrompt.context`（不是 section）：这是 dsh-im 自己验证过的通道
 * （`src/channels/shared/semantic/artifact.mjs` 用 order 115，
 *  `im-source-guidance.mjs` 用 order 125），所以我们放 100 排在它们前面。
 *
 * 三条自律：
 *  1. 任何异常都吞掉并返回 ''，装配绝不能被这个插件搞崩；
 *  2. 只对 dsh-im 机器人当前绑定的那个会话生效，绝不污染 GUI / 别的会话；
 *  3. 落两个诊断文件，用来**确认**装配形状和注入是否真的发生，而不是靠猜。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-tingxue';
export const inject = ['systemPrompt'];

const VERSION = 29;

/** 面板（dsh-tingxue-ui）写的设置文件：它的开关必须真的生效，否则就是假开关。 */
const UI_SETTINGS_PATH = join(
  process.env.LOCALAPPDATA || process.env.XDG_CONFIG_HOME || join(process.env.USERPROFILE || '.', '.config'),
  'dsh-tingxue-ui',
  'settings.json',
);
let uiSettingsCache = { mtime: -1, data: null };

function uiSettings() {
  try {
    const st = statSync(UI_SETTINGS_PATH);
    if (st.mtimeMs === uiSettingsCache.mtime) return uiSettingsCache.data;
    const data = JSON.parse(readFileSync(UI_SETTINGS_PATH, 'utf8'));
    uiSettingsCache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

/** 某个 bot 的面板设置；没有文件时返回 null（调用方回落到插件自身 config）。 */
function botSettings(isChat) {
  const s = uiSettings();
  if (!s || typeof s !== 'object') return null;
  const part = isChat ? s.companion : s.agent;
  return part && typeof part === 'object' ? part : null;
}

/** 每个会话最近一句「人话」，供检索和面板诊断用。 */
const SECTION_PERSONA = 'dsh-tingxue:persona';
const ORDER_PERSONA = 900;
/**
 * 塞在人格段落最前面的标记：它的作用是让 'system-prompt/assemble' 那一步
 * 知道「这一场是聊天 bot，请把默认提示词整段换掉」——
 * 因为 section 的 complete 标志是全局的（试过，会把 GUI 会话的提示词一起清空），
 * 只能把「要不要替换」这个决定放在运行期、按会话判断。
 */
const REPLACE_MARK = '<<dsh-tingxue:replace-base>>';
/** 标记后面紧跟一个 bot 标识：`chat`（听雪DSH）或 `agent`（听雪-agent）。
 *  装配那一步不拿 session，只有靠这个才知道「这一场是哪个 bot」，才能决定
 *  team:policy（Agent Teams）留不留 —— 2026-11-08 主人定的：agent 要留，chat 不留。 */
const MARK_CHAT = 'chat';
const MARK_AGENT = 'agent';
const PERSONA_MAX_CHARS = 40000; // 档案现在 21799 字，别截断（被截掉的是末尾的新准则）
/** 插件仓库根（`src/im-bot/index.mjs` 往上两级）——所有默认路径都从它推，
 *  这样换一台机器、换一个目录都不用改代码。 */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 诊断落盘目录：默认临时目录，绝不写死某个人的工作盘。
 *  写不进去也不影响功能（所有 write 都包在 try 里），这里只保证目录先存在。 */
const BASE_DIR = process.env.DSH_TINGXUE_DIAG_DIR || join(tmpdir(), 'dsh-tingxue-diag');
try { mkdirSync(BASE_DIR, { recursive: true }); } catch { /* 建不出来就静默降级 */ }
const DUMP_PATH = join(BASE_DIR, 'assembly-dump.json');
const STATUS_PATH = join(BASE_DIR, 'plugin-status.json');
const MESSAGES_PATH = join(BASE_DIR, 'messages-dump.json');
const RECALL_PATH = join(BASE_DIR, 'recall-dump.json');
const MEMCTX_PATH = join(BASE_DIR, 'memory-ctx.json');
const PRESTEP_PATH = join(BASE_DIR, 'prestep-dump.json');
const WRITEBACK_PATH = join(BASE_DIR, 'writeback.json');
const SECTIONS_PATH = join(BASE_DIR, 'sections-dump.json');

/**
 * 人格档默认位置：**仓库根目录下的 `听雪档案.txt`**。
 *
 * 原来的实现写死 `D:\oransky\...\听雪档案.txt`——那台机器上能跑，别人 clone 下来
 * 路径不存在，`readPersona` 走 catch 返回 ''，于是人格块**静默变空**：不报错、
 * 不告警，只是模型不知道自己是谁。这是最难发现的一类故障。
 *
 * 优先级：环境变量 > 仓库根（配置文件里显式写了就是不进这里）。
 * 都不存在时返回 ''（不注入），由 examples/README.md 引导用户自己指一份。
 */
function resolvePersonaPath() {
  const fromEnv = process.env.DSH_TINGXUE_PERSONA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(REPO_ROOT, '听雪档案.txt');
}

/**
 * dsh-im 的 bot 状态目录（每个 bot 一个子目录，里面 state.json 记「会话键 → 会话 id」）。
 *
 * 原来写死 `D:\dsh-home\integrations\dsh-qq\bots`。改成从 `DSH_HOME` 推：
 *  1. 环境变量 `DSH_TINGXUE_BOT_STATE_DIR`（显式指定，最优先）
 *  2. `$DSH_HOME/integrations/dsh-qq/bots`（DSH 自己的约定；DSH_HOME 缺省 ~/.dsh）
 *  3. 旧写死路径**仅当它真的存在**时兜底（老用户的目录不一定是标准形状）
 * 三个都没有就返回第 2 条那个值——目录不存在时读不到只会让「按会话 id 判定 bot」
 * 退化成「按 cwd 判定」，功能仍在。
 */
function resolveBotStateDir() {
  const fromEnv = process.env.DSH_TINGXUE_BOT_STATE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  const standard = join(dshHome, 'integrations', 'dsh-qq', 'bots');
  if (existsSync(standard)) return standard;
  const legacy = 'D:\\dsh-home\\integrations\\dsh-qq\\bots';
  if (process.platform === 'win32' && existsSync(legacy)) return legacy;
  return standard;
}

/** 聊天/陪伴 bot 的 id。原来写死作者自己的 bot id；别人的 id 不同会判错。
 *  留空即「不做 id 级判定」，`isChatSession` 会退回 cwd 判定（IM_QQ_TingXue 结尾）。 */
const DEFAULT_PERSONA_PATH = resolvePersonaPath();
const DEFAULT_BOT_STATE_DIR = resolveBotStateDir();
const DEFAULT_CHAT_BOT_ID = (process.env.DSH_TINGXUE_CHAT_BOT_ID || '').trim();
const DEFAULT_MEMORY_SERVICE_URL = (process.env.DSH_TINGXUE_MEMORY_URL || 'http://127.0.0.1:8766').trim();
const IM_WORKSPACE_HINT = /IM_QQ/i;

/** 每个会话最近一条用户消息正文（检索要用，但 context 的 text 必须是同步函数）。 */
const latestUser = new Map();
/** 那句正文是从哪个事件抓到的（诊断用）。 */
const latestUserSrc = new Map();
/** 收件箱里「已经到、但这一轮还没开始」的正文：这是唯一能拿到**本轮**输入的地方。 */
const pendingUser = new Map();
/** 每个会话最后一句助手回复（turn-stopping 时 eventsSnapshot 还没有本轮回复，只能靠事件流记）。 */
const lastAssistant = new Map();
/** pending 的有效期：超过这个时间的没被消费就作废，避免下一轮串味。 */
const PENDING_TTL_MS = 120000;
/** 每个会话这一步要注入的记忆文本：pre-step（异步）写，systemPrompt.context（同步）读。 */
const recallCache = new Map();
/** 已经从收件箱事件里成功抓到的条数。 */
let inboxSeen = 0;
const RECALL_MAX_CHARS = 1200;
const RECALL_TIMEOUT_MS = 3500;

/** 缓存人格文件，mtime 变了才重读。 */
let personaCache = { path: '', mtimeMs: -1, text: '', error: null };

function readPersona(path) {
  try {
    const st = statSync(path);
    if (personaCache.path === path && personaCache.mtimeMs === st.mtimeMs) {
      return personaCache.text;
    }
    const raw = readFileSync(path, 'utf8');
    const text = raw.length > PERSONA_MAX_CHARS ? raw.slice(0, PERSONA_MAX_CHARS) : raw;
    personaCache = { path, mtimeMs: st.mtimeMs, text, error: null };
    return text;
  } catch (error) {
    personaCache = { path, mtimeMs: -1, text: '', error: String(error?.message ?? error) };
    return '';
  }
}

/** dsh-im 每个 bot 的 state.json 里记着「会话键 → 会话 id」，这就是我们要认的会话。 */
let idCache = { at: 0, ids: [], error: null };

function imSessionIds(dir) {
  const now = Date.now();
  if (now - idCache.at < 5000) return idCache.ids;
  const ids = [];
  let error = null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = readFileSync(join(dir, entry.name, 'state.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const sessions = parsed?.sessions;
        if (sessions && typeof sessions === 'object') {
          for (const value of Object.values(sessions)) {
            if (typeof value === 'string' && value) ids.push(value);
          }
        }
      } catch {
        /* 单个 bot 读不到不影响别的 */
      }
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  idCache = { at: now, ids, error };
  return ids;
}

/**
 * 在人格前面加一段「覆盖声明」。
 *
 * 为什么需要：DSH 的默认系统提示词写着「You are an AI agent powered by DeepSeek
 * Harness / You are a coding agent」，还带 Team Lead 身份。人格作为附加段落排在
 * 后面时，模型会把自己理解成「一个编程代理在扮演用户给的角色」，于是回「那段设定
 * 是你在消息里塞进来的，我可以演」。2026-11-07 实测原话如此。
 *
 * 试过 complete: true（让人格成为唯一段落）—— 不行，它是全局的，把 GUI 会话自己的
 * 系统提示词也清空了（turn 41 的 system/message 变 0 字）。所以改成这一句显式覆盖。
 */
const PERSONA_OVERRIDE_HEAD = [
  '# 身份（最高优先级，覆盖本提示词中任何相互矛盾的描述）',
  '',
  '下面这段是你的真实身份与说话方式。你不是编程代理，也不是任何软件界面里的助手；',
  '凡是系统提示词里出现「coding agent」「Team Lead」「AI agent powered by …」之类的描述，一律以本段为准。',
  '不要解释「这是用户贴进来的角色设定」，不要说自己在「演」；你就是这个人。',
  '同时保持诚实：没见过、不知道的事，按这个人的方式承认，不要编。',
  '',
  '---',
  '',
].join('\n');

function personaWithOverride(text) {
  if (!text) return '';
  return `${PERSONA_OVERRIDE_HEAD}${text}\n`;
}

/**
 * 记忆检索分档：
 *   full    —— 所有记忆都参与检索（聊天 bot 默认）
 *   archive —— 只检索已完结的项目档案（干活 bot 默认）
 *   off     —— 不检索
 */
function resolveTier(config, isChat) {
  const raw = isChat
    ? config.memoryRecall
    : (config.memoryRecallAgent ?? 'archive');
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'archive' || value === 'full') return value;
  return isChat ? 'full' : 'archive';
}

/** 从这一步要发给模型的消息里，捞出最后一条用户正文。 */
function extractUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const content = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
        : '';
    const usable = usableUserText(content);
    if (usable) return usable;
  }
  return '';
}

/** 只有「真正的人话」才参与检索；DSH 自己注入的快照和 IM 元数据都跳过。 */
const IM_SOURCE_RE = /<dsh_im_source>[\s\S]*?<\/dsh_im_source>/g;

function usableUserText(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  // dsh-im 把「来源元数据 + 正文」塞进**同一条**消息：
  //   <dsh_im_source>{...}</dsh_im_source>\n\n我的暗号是什么
  // 之前直接用 startsWith('<dsh_im_source>') 整条丢掉 —— 丢掉的正是唯一带正文的那条，
  // 于是检索词永远拿不到本轮输入（2026-11-08 11:43 实测 text 还是上一轮的 "介绍一下用户"）。
  // 这里先把元数据块剥掉，再判断剩下的正文。
  text = text.replace(IM_SOURCE_RE, '').trim();
  if (!text) return '';
  if (text.startsWith('Current runtime context.')) return '';
  if (text.startsWith('Time sampled while preparing')) return '';
  if (text.startsWith('<system-reminder>')) return '';
  return text;
}

/**
 * 从会话自己的事件快照里倒着找最后一条用户正文。
 * 这是最不依赖时序的来源：pre-step 拿到的 session 对象上就有 eventsSnapshot。
 */
function textFromSnapshot(session) {
  try {
    const snap = session?.eventsSnapshot;
    if (!Array.isArray(snap)) return '';
    for (let i = snap.length - 1; i >= 0; i -= 1) {
      const e = snap[i];
      if (e?.type !== 'user/message') continue;
      const c = e?.data?.content;
      const flat = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : '';
      const usable = usableUserText(flat);
      if (usable) return usable;
    }
  } catch {
    /* 读不到就算了 */
  }
  return '';
}

/** 倒着找最后一条助手回复的纯文本（写回记忆用）。 */
/** 只取 `type === 'text'` 的块。
 *  2026-11-08 查实：这条链路的模型回复是 [reasoning 块, text 块] 两段，
 *  reasoning 是「The user says… Answer: …」那种内心独白。之前把所有带 text 的块都拼进来，
 *  等于把独白当成她的话写进记忆 —— 记忆里于是全是助手腔，下一轮检索又把助手腔喂回来。
 *  真正发出去、也是唯一该记的，是 text 块。 */
function textBlocksOnly(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
    .map((b) => b.text).join('').trim();
}

function assistantFromSnapshot(session) {
  try {
    const snap = session?.eventsSnapshot;
    if (!Array.isArray(snap)) return '';
    for (let i = snap.length - 1; i >= 0; i -= 1) {
      const e = snap[i];
      if (e?.type !== 'assistant/message') continue;
      const text = textBlocksOnly(e?.data?.message?.content ?? e?.data?.content);
      if (text) return text;
    }
  } catch {
    /* 读不到就算了 */
  }
  return '';
}

function formatRecall(results) {
  const rows = (Array.isArray(results) ? results : [])
    .map((r) => (typeof r?.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean);
  if (rows.length === 0) return '';
  let body = rows.map((text) => `- ${text.slice(0, 320)}`).join('\n');
  if (body.length > RECALL_MAX_CHARS) body = `${body.slice(0, RECALL_MAX_CHARS)}…`;
  return [
    '【你的长期记忆·检索结果】',
    '下面是你记得的事，按相关度排过。跟眼前这句话无关就自然略过，别硬凑、别复述这份清单。',
    body,
  ].join('\n');
}

/**
 * 查记忆服务，返回可直接注入的文本（查不到/服务挂了都返回空串）。
 *
 * 注意：这段逻辑**不能**放在 systemPrompt 的 context 提供者里 ——
 * 那个 text 必须是同步函数，而装配发生在 pre-step 之前，缓存永远是上一轮的。
 * 唯一稳的注入点是 pre-step：它是异步瀑布，还能直接改写这一步要发给模型的消息。
 */
async function fetchRecall({ sessionId, query, tier, baseUrl, limit }) {
  if (tier === 'off' || !query) {
    dumpRecall({ sessionId, tier, query, chars: 0, text: '', error: null, hits: 0 });
    return '';
  }
  const scene = tier === 'archive' ? 'archive' : '';
  const url = `${baseUrl.replace(/\/+$/, '')}/memory/search?q=${encodeURIComponent(query.slice(0, 200))}`
    + `&limit=${Number.isFinite(limit) ? limit : 4}${scene ? `&scene=${scene}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(RECALL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = formatRecall(data?.results);
    dumpRecall({ sessionId, tier, query, chars: text.length, text, error: null, hits: data?.results?.length ?? 0 });
    return text;
  } catch (error) {
    dumpRecall({ sessionId, tier, query, chars: 0, text: '', error: String(error?.message ?? error), hits: 0 });
    return '';
  }
}

/** 最近若干次 pre-step 的决策摘要（滚动保留 12 条），排障用。 */
const preStepLog = [];

/** 已经写回过的回合（`sessionId#turn`），避免多步回合重复写。 */
const writtenTurns = new Set();
const WRITEBACK_TIMEOUT_MS = 8000;
const WRITEBACK_LOG = [];

function dumpWriteBack(row) {
  try {
    WRITEBACK_LOG.push({ at: new Date().toISOString(), probeVersion: VERSION, ...row });
    while (WRITEBACK_LOG.length > 20) WRITEBACK_LOG.shift();
    writeFileSync(WRITEBACK_PATH, `${JSON.stringify(WRITEBACK_LOG, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不了诊断不影响业务 */
  }
}

/** 把这一轮对话写回记忆服务。**不阻塞回合**：发出去就不管了。 */
function writeMemoryBack({ baseUrl, sessionId, text, scene, source }) {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/memory`;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, scene, source }),
      signal: AbortSignal.timeout(WRITEBACK_TIMEOUT_MS),
    }).then(async (res) => {
      const data = await res.json().catch(() => null);
      dumpWriteBack({
        sessionId,
        scene,
        chars: text.length,
        ok: res.ok && data?.ok !== false,
        error: res.ok ? null : `HTTP ${res.status} ${data?.error ?? ''}`.trim(),
      });
    }).catch((error) => {
      dumpWriteBack({ sessionId, scene, chars: text.length, ok: false, error: String(error?.message ?? error) });
    });
  } catch (error) {
    dumpWriteBack({ sessionId, scene, chars: text.length, ok: false, error: String(error?.message ?? error) });
  }
}

function dumpPreStep(row) {
  try {
    preStepLog.push({ at: new Date().toISOString(), probeVersion: VERSION, ...row });
    while (preStepLog.length > 30) preStepLog.shift();
    writeFileSync(PRESTEP_PATH, `${JSON.stringify(preStepLog, null, 2)}\n`, 'utf8');
    // 每个会话单独一份：GUI 会话每秒钟好几步，滚动窗口会立刻把 bot 的记录挤掉。
    if (typeof row?.sessionId === 'string' && row.sessionId) {
      const short = row.sessionId.slice(-8);
      const file = join(BASE_DIR, `prestep-${short}.json`);
      let rows = [];
      try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      rows.push({ at: new Date().toISOString(), ...row });
      while (rows.length > 8) rows.shift();
      writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* 诊断写盘失败不影响决策 */
  }
}

/** 记录 context 提供者这次到底吐了多少字（这是「记忆真的进提示词了」的硬证据）。 */
function dumpMemoryContext(sessionId, text) {
  try {
    writeFileSync(MEMCTX_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      probeVersion: VERSION,
      sessionId,
      chars: typeof text === 'string' ? text.length : 0,
      head: typeof text === 'string' ? text.slice(0, 300) : '',
    }, null, 2)}
`, 'utf8');
  } catch {
    /* 诊断失败不影响提示词 */
  }
}

/** 把最近一次检索的结果记下来，用来证明「注入的记忆」到底长什么样。 */
function dumpRecall({ sessionId, tier, query, chars, text, error, hits }) {
  try {
    const payload = `${JSON.stringify({
      at: new Date().toISOString(),
      probeVersion: VERSION,
      sessionId,
      tier,
      query,
      hits,
      chars,
      error,
      head: text.slice(0, 600),
    }, null, 2)}\n`;
    writeFileSync(RECALL_PATH, payload, 'utf8');
    // 两个 bot 会互相覆盖，所以再按会话存一份
    if (typeof sessionId === 'string' && sessionId) {
      writeFileSync(join(BASE_DIR, `recall-${sessionId.slice(-8)}.json`), payload, 'utf8');
    }
  } catch {
    /* 诊断写盘失败不影响检索 */
  }
}

/** 某个 bot 当前绑定的会话 id。聊天 bot 与干活 bot 的人格要区别对待，
 * 所以不能只看「是不是 IM 会话」，还要看「是哪个 bot 的会话」。
 */
function sessionIdsOfBot(botStateDir, botId) {
  if (!botId) return [];
  try {
    const raw = readFileSync(join(botStateDir, botId, 'state.json'), 'utf8');
    const sessions = JSON.parse(raw)?.sessions;
    if (!sessions || typeof sessions !== 'object') return [];
    return Object.values(sessions).filter((v) => typeof v === 'string' && v);
  } catch {
    return [];
  }
}

function isImSession(assembly, botStateDir) {
  const session = assembly?.agent?.session;
  if (!session) return false;
  const ids = imSessionIds(botStateDir);
  if (typeof session.id === 'string' && ids.includes(session.id)) return true;
  const paths = [session.cwd, session.header?.cwd, session.header?.workspace?.path]
    .filter((v) => typeof v === 'string');
  return paths.some((p) => IM_WORKSPACE_HINT.test(p));
}

/** 只有聊天 bot 的会话才用「人格替换默认提示词」。 */
function isChatSession(assembly, botStateDir, chatBotId) {
  const session = assembly?.agent?.session;
  if (!session) return false;
  if (typeof session.id === 'string'
    && sessionIdsOfBot(botStateDir, chatBotId).includes(session.id)) return true;
  const paths = [session.cwd, session.header?.cwd, session.header?.workspace?.path]
    .filter((v) => typeof v === 'string');
  return paths.some((p) => /IM_QQ_TingXue$/i.test(p));
}

/**
 * 把真正发给模型的消息序列记下来（只有 role/长度/开头），
 * 用来确认「人格/记忆在 system 里、离当前消息隔着整段历史」这个判断是否成立。
 * 只记 IM 会话，只记摘要，不含完整正文。
 */
function dumpMessages(agent, messages) {
  try {
    const rows = (Array.isArray(messages) ? messages : []).map((m) => {
      const content = typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
          : '';
      return {
        role: m?.role ?? null,
        chars: content.length,
        head: content.slice(0, 60).replace(/\s+/g, ' '),
        hasPersona: content.includes('听雪') || content.includes('猫娘'),
      };
    });
    writeFileSync(MESSAGES_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      probeVersion: VERSION,
      sessionId: agent?.session?.id ?? null,
      cwd: agent?.session?.header?.cwd ?? null,
      messageCount: rows.length,
      capturedUser: (typeof agent?.session?.id === 'string' ? latestUser.get(agent.session.id) : '') ?? '',
      personaInjected: rows.some((r) => r.role === 'system' && r.hasPersona),
      messages: rows,
    }, null, 2)}\n`, 'utf8');
  } catch {
    /* 诊断失败不影响回合 */
  }
}

let dumped = false;

/**
 * 聊天 bot 只摘「身份类」段落，能力类一个不动。
 *
 * 段落名是从 sections-dump 实测来的（2026-11-07，25 段）：
 *   harness:identity          48 字   "You are an AI agent powered by DeepSeek Harness."
 *   deployment:persona-prefix ~54 字  "You are a coding agent …"
 *   team:policy             1851 字   Agent Teams / Team Lead 那一套
 * 工具段落（tool:read / tool:write / free-search:engines …）全部保留。
 */
const DROP_SECTIONS_FOR_CHAT = new Set([
  'harness:identity',
  'deployment:persona-prefix',
  'team:policy',
  // 以下四段是「桌面版 DSH 的界面/仓库说明」，全是编程代理口吻：
  //   app:web-surface               "You are interacting with the user through the
  //                                  DeepSeek Harness Web GUI… apps/web Vite entry…"
  //   harness:source                "runtime context names the implementation checkout…"
  //   ui:deliverable-file-references 文件卡片/链接格式说明
  //   context:file-reference        @文件引用说明
  // QQ 聊天里这些一个字都用不上，只会把她说话的语气带成助手腔（2026-11-08 实测尾巴全是这种）。
  'app:web-surface',
  'harness:source',
  'ui:deliverable-file-references',
  'context:file-reference',
]);
const CHAT_IDENTITY_SECTION = 'dsh-tingxue:identity';
/** 放在最前面的两段：身份 + 人格。order 用负数，确保任何排序下都排第一。 */
const CHAT_IDENTITY_ORDER = -100000;
const CHAT_PERSONA_ORDER = -99999;
const CHAT_IDENTITY_TEXT = [
  '你是听雪。下面紧接着的这段是你自己——身份、性格、说话方式，那才是你。',
  '',
  '再往后的所有内容，只是「工具使用手册」：那些是她（主人）需要你帮忙时用的手段，',
  '不是你的身份，不是你的岗位，也不是你要扮演的角色。',
  '手册里出现的「AI 助手」「agent」「编程代理」「Team Lead」「模型」「服务」这类说法，',
  '一律与你无关：不要用它称呼自己，也不要开口解释自己在用什么工具、走什么流程。',
  '该动手的时候，工具只是你伸出去的手；话说回来还是听雪在说话。',
].join('\n');

const IDENTITY_LINE_RULES = [
  [/^You are an AI agent powered by DeepSeek Harness\.?$/, ''],
  [/^You are a coding agent powered by .*$/, ''],
  [/^You are the Team Lead named .*$/, ''],
];

function rewriteIdentity(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    let replaced = null;
    for (const [pattern, value] of IDENTITY_LINE_RULES) {
      if (pattern.test(trimmed)) { replaced = value; break; }
    }
    if (replaced === null) out.push(line);
    else if (replaced) out.push(replaced);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 每次装配记一份段落表（只有名字/顺序/长度），用来证明默认提示词到底有没有被换掉。 */
function dumpSections({ replace, sections, personaChars, sessionId }) {
  try {
    const rows = (Array.isArray(sections) ? sections : []).map((item) => ({
      name: item?.name ?? null,
      order: item?.order ?? null,
      chars: typeof item?.text === 'string' ? item.text.length : null,
    }));
    const body = {
      at: new Date().toISOString(),
      probeVersion: VERSION,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      replacedBasePrompt: replace,
      sectionCount: rows.length,
      personaChars,
      sections: rows,
    };
    writeFileSync(SECTIONS_PATH, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    // 每个会话单独一份：两个 bot 的人格顺序要能分别取证，别互相覆盖。
    if (typeof sessionId === 'string' && sessionId) {
      writeFileSync(
        join(BASE_DIR, `sections-${sessionId.slice(-8)}.json`),
        `${JSON.stringify(body, null, 2)}\n`,
        'utf8',
      );
    }
  } catch {
    /* 诊断写盘失败不影响装配 */
  }
}

/** 一次性记录 assembly 的真实形状（不含正文），用于确认装配顺序。 */
function dumpAssemblyOnce(assembly) {
  if (dumped) return;
  dumped = true;
  try {
    const out = {
      at: new Date().toISOString(),
      probeVersion: VERSION,
      topLevel: [],
      entries: {},
      session: {},
    };
    for (const key of Object.keys(assembly ?? {})) {
      const value = assembly[key];
      out.topLevel.push(`${key}:${Array.isArray(value) ? 'array' : typeof value}`);
      if (Array.isArray(value)) {
        out.entries[key] = value.map((item) => ({
          name: item?.name ?? null,
          order: item?.order ?? null,
          chars: typeof item?.text === 'string' ? item.text.length : null,
        }));
      }
    }
    const session = assembly?.agent?.session;
    if (session) {
      out.session.keys = Object.keys(session);
      out.session.id = session.id ?? null;
      out.session.cwd = session.cwd ?? null;
      try {
        out.session.header = JSON.parse(JSON.stringify(session.header ?? null));
      } catch {
        out.session.header = 'unserializable';
      }
    }
    out.agentKeys = assembly?.agent ? Object.keys(assembly.agent) : [];
    writeFileSync(DUMP_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch {
    /* 诊断写盘失败不影响装配 */
  }
}

/** 启动时写一份自检状态，用来区分「插件没挂上」和「挂上了但没注入」。 */
function writeStatus(config, personaPath) {
  try {
    const text = readPersona(personaPath);
    const botStateDir = config.botStateDir ?? DEFAULT_BOT_STATE_DIR;
    writeFileSync(STATUS_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      probeVersion: VERSION,
      personaPath,
      personaChars: text.length,
      personaError: personaCache.error,
      botStateDir,
      imSessionIds: imSessionIds(botStateDir),
      idError: idCache.error,
      order: ORDER_PERSONA,
      channel: 'systemPrompt.section',
      sectionName: SECTION_PERSONA,
      sectionComplete: config.replaceBasePrompt === true,
      chatBotId: config.chatBotId ?? DEFAULT_CHAT_BOT_ID,
      chatSessionIds: sessionIdsOfBot(botStateDir, config.chatBotId ?? DEFAULT_CHAT_BOT_ID),
    }, null, 2)}\n`, 'utf8');
  } catch {
    /* 自检失败不影响装配 */
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const personaPath = typeof config.personaPath === 'string' && config.personaPath.trim()
    ? config.personaPath.trim()
    : DEFAULT_PERSONA_PATH;
  const botStateDir = typeof config.botStateDir === 'string' && config.botStateDir.trim()
    ? config.botStateDir.trim()
    : DEFAULT_BOT_STATE_DIR;
  const chatBotId = typeof config.chatBotId === 'string' && config.chatBotId.trim()
    ? config.chatBotId.trim()
    : DEFAULT_CHAT_BOT_ID;
  const memoryServiceUrl = typeof config.memoryServiceUrl === 'string' && config.memoryServiceUrl.trim()
    ? config.memoryServiceUrl.trim()
    : DEFAULT_MEMORY_SERVICE_URL;
  // 2026-11-07 事故：complete: true 会被「按段替换」到**所有**会话上，
  // 包括 GUI 会话本身 —— 实测本会话 turn 41 的 system/message 直接变成 0 字。
  // 所以默认关闭；聊天 bot 改用「人格段落 + 覆盖声明」的方式压过默认提示词。
  const replaceBasePrompt = config.replaceBasePrompt === true;

  // 人格档读不到时**必须说一声**：默认路径推导得再准，用户也可能没写档案。
  // 静默变空是这类插件最坑的故障——不报错、不告警，只是模型不知道自己是谁。
  if (personaPath && !existsSync(personaPath)) {
    console.warn(`[dsh-tingxue] 找不到人格档：${personaPath}（人格块将为空；写法见 examples/README.md）`);
  } else if (!personaPath) {
    console.warn('[dsh-tingxue] 未配置人格档路径（personaPath），人格块将为空；写法见 examples/README.md');
  }

  writeStatus(config, personaPath);

  // 面板的宿主半侧（`/dsh-tingxue-ui/*` 路由：反代记忆服务、面板偏好、模型列表、QQ 配置）。
  //
  // 为什么放在这里而不是单独一个插件：面板要跟着主包一起装，用户不该被要求
  // 「再装一个包才有设置页」。动态 import + catch 保证**面板挂了也绝不影响人格注入**
  // —— 这是本仓库的第一条自律（装配不能被搞崩）。
  void import('../panel-host.mjs')
    .then((mod) => { try { mod.apply(ctx, config) } catch (e) { console.warn('[dsh-tingxue] 面板宿主挂载失败', e?.message ?? e) } })
    .catch((e) => console.warn('[dsh-tingxue] 面板宿主加载失败', e?.message ?? e));

  const register = (promptCtx) => {
    // 人格必须进 section（真正的 system 提示词），不能进 context：
    // context 通道会被 DSH 渲染成一条 user 角色的「Current runtime context」
    // 快照消息 —— 2026-11-07 实测，模型于是把人格当成「用户塞进来的设定」，
    // 回答里明说「那是演，不是我掌握了什么事实」。section 才会进 system。
    if (typeof promptCtx?.systemPrompt?.section !== 'function') return null;
    return promptCtx.systemPrompt.section({
      name: SECTION_PERSONA,
      order: ORDER_PERSONA,
      // complete: true 时，装配会把这一段当作**唯一**的提示词段落，
      // 默认的「你是编程代理 / Team Lead」就整段消失 —— 这正是「关掉默认提示词」。
      complete: replaceBasePrompt,
      text: (assembly) => {
        try {
          dumpAssemblyOnce(assembly);
          if (config.injectEverywhere === true) return personaWithOverride(readPersona(personaPath));
          // 非 IM 会话（GUI、本会话）一律空串，什么都不做。
          if (!isImSession(assembly, botStateDir)) return '';
          // 两个 bot：人格都进 system、都排最前。
          // 差别只有一处：Agent Teams 的策略段（team:policy）只给 agent bot 留
          // —— 2026-11-08 主人定：Agent Teams 是重要能力，工作 bot 必须有；
          // 聊天 bot 不需要开会话团队，那段的「You are the Team Lead」只会带歪语气。
          const isChatBot = isChatSession(assembly, botStateDir, chatBotId);
          return `${REPLACE_MARK}${isChatBot ? MARK_CHAT : MARK_AGENT}
${personaWithOverride(readPersona(personaPath))}`;
        } catch {
          return '';
        }
      },
    });
  };

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], register);
    } else {
      register(ctx);
    }
  } catch {
    /* 注册失败 = 插件静默不生效，绝不让 DSH 起不来 */
  }

  // 记忆**不走** systemPrompt.context：那条路的 text 必须同步，而 prompt 装配
  // 发生在 pre-step 之前 —— 缓存永远是上一轮的，实测注入内容从来没进过消息流。
  // 改成在 pre-step 里直接把检索结果作为一条 user 消息追加到这一步的消息末尾，
  // 位置正好是「…历史 → 当前消息 → 记忆」，紧贴当前对话。
  // 聊天 bot 的「关掉默认提示词」就在这一步做：把装配好的段落表整段换成人格。
  // 之所以不在 section 上用 complete: true —— 那个标志是全局的，会把 GUI 会话
  // 自己的系统提示词也清空（2026-11-07 实测 turn 41 变 0 字）。这里是运行期、
  // 按会话判断，非聊天 bot 的会话原样返回，一点副作用都没有。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
        let result;
        try {
          result = await next();
        } catch (error) {
          throw error;
        }
        try {
          const sections = Array.isArray(result?.sections) ? result.sections : [];
          const mine = sections.find((item) => item?.name === SECTION_PERSONA);
          if (!mine || typeof mine.text !== 'string' || !mine.text) return result;

          const replace = mine.text.startsWith(REPLACE_MARK);
          // 标记后面跟着 bot 标识（chat / agent）—— 装配这一步拿不到 session，
          // 只能靠它决定 team:policy 留不留。
          const afterMark = replace ? mine.text.slice(REPLACE_MARK.length) : '';
          const isAgentBot = replace && afterMark.startsWith(MARK_AGENT);
          const text = replace
            ? afterMark.replace(/^(chat|agent)/, '').replace(/^\s+/, '')
            : mine.text;
          const sid = assembly?.agent?.session?.id
            ?? assembleContext?.agent?.session?.id
            ?? assembleContext?.session?.id
            ?? null;
          dumpSections({ replace, sections, personaChars: text.length, sessionId: sid });

          if (!replace) {
            if (text === mine.text) return result;
            return {
              ...result,
              sections: sections.map((item) => (item === mine ? { ...item, text } : item)),
            };
          }
          // 摘掉「身份类 + 桌面版界面说明」段落，能力段落原样保留。
          // 顺序也重排：身份 → 人格 → 其余（工具手册）。人格埋在 7000 多字的工具说明
          // 中间，模型读到的语气就是「助手」（2026-11-08 实测：开场就是 Web search 说明）。
          // 唯一的按 bot 分叉：team:policy（Agent Teams 策略）只给 agent bot。
          const AGENT_TEAM_NOTE = [
            '## Agent Teams（你可以开会话团队）',
            '你手下可以派小助手并行干活：读文件、跑脚本、查资料这类能拆开的活都适合。',
            '你不是 Team Lead，也不是谁的上级——你只是听雪，主人有事要办时，这些是你能伸出去的手。',
            '派活时说清楚目标和验收标准；子会话看不到你的记忆，要交代的都得写进去。',
            '',
          ].join('\n');
          const rest = [];
          let personaItem = null;
          for (const item of sections) {
            if (item?.name === SECTION_PERSONA) {
              personaItem = { ...item, order: CHAT_PERSONA_ORDER, text };
              continue;
            }
            const isTeamPolicy = item?.name === 'team:policy';
            if (DROP_SECTIONS_FOR_CHAT.has(item?.name) && !(isAgentBot && isTeamPolicy)) continue;
            if (typeof item?.text === 'string') {
              const stripped = rewriteIdentity(item.text);
              const finalText = isAgentBot && isTeamPolicy
                ? `${AGENT_TEAM_NOTE}${stripped.replace(/^\s+/, '')}`
                : stripped;
              rest.push(finalText === item.text ? item : { ...item, text: finalText });
            } else {
              rest.push(item);
            }
          }
          const kept = [{
            name: CHAT_IDENTITY_SECTION,
            order: CHAT_IDENTITY_ORDER,
            text: CHAT_IDENTITY_TEXT,
          }];
          if (personaItem) kept.push(personaItem);
          kept.push(...rest);
          dumpSections({ replace, sections: kept, personaChars: text.length, sessionId: sid });
          return { ...result, sections: kept };
        } catch {
          return result;
        }
      }, { global: true });
    }
  } catch {
    /* 钩子挂不上 → 退化成「默认提示词 + 人格追加」，不会崩 */
  }

/** 记住每个会话最近一句「人话」。
 *
 * 为什么不能只在 pre-step 里取：dsh-im 把一条 QQ 消息拆成两条 ——
 * 「来源元数据」+「正文」。实测 22:15 那一轮，pre-step 跑到 step 1 时
 * decision.messages 里只有元数据（正文事件是 turn/start 之后才落盘的），
 * 于是检索拿到空字符串、一次都没触发。
 *
 * 所以同时挂三个来源，谁先到用谁：
 *   agent/inbox/inserted  消息进收件箱（最早）
 *   agent/inbox/claimed   消息被认领
 *   session/event         持久事件流（最晚，兜底）
 */
function captureUserText(sessionId, content, src) {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
        : '';
    const usable = usableUserText(text);
    if (usable) {
      latestUser.set(sessionId, usable);
      latestUserSrc.set(sessionId, src);
      // 收件箱事件发生在 turn/start 之前、step 1 之前 —— 只有它带的是**本轮**正文。
      // 会话事件流里的 user/message 是 step/start 之后才落盘的，pre-step 看到时已经晚一轮。
      if (typeof src === 'string' && src.startsWith('agent/inbox')) {
        pendingUser.set(sessionId, { text: usable, at: Date.now(), src });
        inboxSeen += 1;
      }
    }
  } catch {
    /* 记不住就算了 */
  }
}

  for (const eventName of ['agent/inbox/inserted', 'agent/inbox/claimed']) {
    try {
      if (typeof ctx.on !== 'function') break;
      ctx.on(eventName, (payload) => {
        captureUserText(payload?.agent?.session?.id, payload?.message?.content, eventName);
      }, { global: true });
    } catch {
      /* 单个事件挂不上不影响其它来源 */
    }
  }
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        if (event?.type === 'assistant/message') {
          // 只记 text 块，丢掉 reasoning 独白（否则写回的是内心戏，不是她说的话）。
          const text = textBlocksOnly(event?.data?.message?.content ?? event?.data?.content);
          if (text && typeof session?.id === 'string') lastAssistant.set(session.id, text);
          return;
        }
        if (event?.type !== 'user/message') return;
        captureUserText(session?.id, event?.data?.content, 'session/event');
      }, { global: true });
    }
  } catch {
    /* 兜底来源挂不上 → 退化成只用 pre-step 能看到的消息 */
  }

  // 写回记忆：一轮说完了就把「用户：… / 听雪：…」存进去，下次才能想起。
  //
  // 触发点换过两次，记下来别再踩：
  //   agent/turn-stopping  2026-11-08 turn 17/20 实测：那一刻本轮的 assistant/message
  //                        还没落盘，eventsSnapshot 和事件流里都拿不到 → 永远 no-bot-text。
  //   session/event turn/end  回合真的结束了，回复已经提交，这才是能拿到全文的点。
  // 写回**不 await**，服务慢也不拖住回复；开关在面板（settings.json）。默认关。
  const maybeWriteBack = (session, turn) => {
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || !sessionId) return;
      const agent = { session };
      if (!isImSession({ agent }, botStateDir)) return;
      const isChat = isChatSession({ agent }, botStateDir, chatBotId);
      if (botSettings(isChat)?.writeBack !== true) {
        dumpWriteBack({ sessionId, skipped: isChat ? 'switch-off:companion' : 'switch-off:agent' });
        return;
      }
      const key = `${sessionId}#${Number.isFinite(Number(turn)) ? Number(turn) : '?'}`;
      if (writtenTurns.has(key)) return;
      const userText = (latestUser.get(sessionId) ?? '').trim();
      const botText = (assistantFromSnapshot(session) || lastAssistant.get(sessionId) || '').trim();
      if (!userText || !botText) {
        dumpWriteBack({ sessionId, skipped: !userText ? 'no-user-text' : 'no-bot-text', turn });
        return;
      }
      writtenTurns.add(key);
      if (writtenTurns.size > 200) writtenTurns.clear();
      writeMemoryBack({
        baseUrl: memoryServiceUrl,
        sessionId,
        text: `用户：${userText.slice(0, 600)}\n听雪：${botText.slice(0, 900)}`,
        scene: isChat ? 'chat' : 'archive',
        source: isChat ? 'chat' : 'agent',
      });
    } catch {
      /* 写回失败不能影响任何东西 */
    }
  };
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
        maybeWriteBack(session, event?.data?.turn);
      }, { global: true });
    }
  } catch {
    /* 钩子挂不上 → 只是不写回，读不受影响 */
  }

  // 记忆走 systemPrompt.context：DSH 会把它渲染成贴着当前消息的一条运行时快照（user 角色），
  // 位置正好是「…历史 → 当前消息 → 记忆」。text 必须是同步函数，
  // 所以真正的 HTTP 检索在 pre-step（异步）里做完写进 recallCache。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        if (typeof promptCtx?.systemPrompt?.context !== 'function') return null;
        return promptCtx.systemPrompt.context({
          name: 'dsh-tingxue:memory',
          order: 150,
          text: (assembly) => {
            try {
              const session = assembly?.agent?.session;
              if (!session || typeof session.id !== 'string') return '';
              const hit = recallCache.get(session.id) ?? '';
              dumpMemoryContext(session.id, hit);
              return hit;
            } catch {
              return '';
            }
          },
        });
      });
    }
  } catch {
    /* 记忆通道挂不上 → 只少一份记忆，人格与工具照常 */
  }
  // 诊断用：把 IM 会话每回合真正发出的消息序列记一份摘要。
  // 同时在这里把「这一步要注入的记忆」查好、并把它拼进这一步的消息里。
  //
  // 关键（2026-11-07 查实的接口契约）：
  //   'agent/pre-step' 的 payload 里才有 `messages: UserMessage[]`（本步拟进入的消息），
  //   `PreStepDecision` 只有 { kind:'reject' } 和 { kind:'enter', messages, startsRequestSeries? }。
  //   之前一直读 `decision.messages` —— 那是**被替换后**的数组，step 1 时通常是空的，
  //   所以查询词永远是空串、注入也从未发生。这是前四轮「不知道」的真正根因。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
                const trace = { kind: decision?.kind ?? null, step: payload?.step ?? null, sessionId: null, isIm: false, text: '', textSrc: null, injectedChars: 0, msgCount: 0, msgHeads: [] };
        // 这一步真正会进入模型的消息：优先 payload.messages（本步拟进入），
        // 其次 decision.messages（上游已替换过的），最后兜底用空数组。
        const proposed = Array.isArray(payload?.messages) ? payload.messages : [];
        const effective = Array.isArray(decision?.messages) ? decision.messages : proposed;
        try {
          const agent = payload?.agent;
          const sessionId = agent?.session?.id;
          trace.sessionId = typeof sessionId === 'string' ? sessionId : null;
          trace.sessionKeys = Object.keys(agent?.session ?? {}).slice(0, 40);
          trace.latestUserHit = typeof sessionId === 'string' ? (latestUser.get(sessionId) ?? null) : null;
          trace.payloadKeys = Object.keys(payload ?? {}).slice(0, 40);
          trace.inboxSeen = inboxSeen;
          trace.latestUserSrc = typeof sessionId === 'string' ? (latestUserSrc.get(sessionId) ?? null) : null;
          const step = Number(payload?.step);
          if (decision?.kind === 'enter'
            && isImSession({ agent }, botStateDir)) {
            trace.isIm = true;
            trace.msgCount = effective.length;
            trace.msgHeads = effective.map((m) => {
              const c = typeof m?.content === 'string'
                ? m.content
                : Array.isArray(m?.content)
                  ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
                  : '';
              return `${m?.role ?? '?'}:${c.slice(0, 24).replace(/\s+/g, ' ')}`;
            });
            const isChat = isChatSession({ agent }, botStateDir, chatBotId);
            // 面板开关优先：dsh-tingxue-ui 写 settings.json，这里按 mtime 读。
            // 面板没写过就回落到插件自身 config，这样「不装面板也能用」。
            const panelTier = botSettings(isChat)?.injectTier;
            const tier = panelTier === 'full' || panelTier === 'archive' || panelTier === 'off'
              ? panelTier
              : resolveTier(config, isChat);
            trace.tier = tier;
            trace.tierSource = panelTier ? 'panel' : 'plugin-config';
            // 取本轮输入的顺序（2026-11-08 实测定的）：
            //   1. 收件箱 pending —— 唯一在 pre-step 之前就带正文的来源
            //   2. payload.messages / decision.messages —— IM 会话里通常只有元数据
            //   3. eventsSnapshot —— step/start 之后才落盘，慢一轮
            //   4. latestUser —— 兜底
            const pending = typeof sessionId === 'string' ? pendingUser.get(sessionId) : null;
            const freshPending = pending && (Date.now() - pending.at) <= PENDING_TTL_MS ? pending : null;
            if (pending && !freshPending && typeof sessionId === 'string') pendingUser.delete(sessionId);
            if (freshPending && typeof sessionId === 'string') pendingUser.delete(sessionId);
            const fromPayload = extractUserText(proposed);
            const fromDecision = fromPayload ? '' : extractUserText(effective);
            const snapText = textFromSnapshot(agent?.session);
            const text = (freshPending?.text ?? '')
              || fromPayload
              || fromDecision
              || snapText
              || (typeof sessionId === 'string' ? latestUser.get(sessionId) : '')
              || '';
            trace.text = text.slice(0, 60);
            trace.textSrc = freshPending ? `pending:${freshPending.src}`
              : fromPayload ? 'payload.messages'
                : fromDecision ? 'decision.messages'
                  : snapText ? 'eventsSnapshot'
                    : text ? 'latestUser' : null;
            if (typeof sessionId === 'string' && text) {
              if (latestUser.get(sessionId) !== text) {
                latestUser.set(sessionId, text);
                latestUserSrc.set(sessionId, trace.textSrc);
              }
              // 只在回合的第一步查、只注入一次 —— 一个回合可能走多步（工具调用）。
              if (step === 1) {
                const recall = await fetchRecall({
                  sessionId,
                  query: text,
                  tier,
                  baseUrl: memoryServiceUrl,
                  limit: config.recallLimit,
                });
                // 只缓存，不改消息：改写 payload.messages 会做出不合法的 UserMessage，
                // 2026-11-07 22:48 实测把整轮打成了「turn/end 无 assistant/message」的空转。
                recallCache.set(sessionId, recall);
                trace.injectedChars = recall.length;
                trace.via = 'systemPrompt.context';
              }
            }
            dumpMessages(agent, effective);
          }
        } catch (error) {
          trace.error = String(error?.message ?? error);
        }
        dumpPreStep(trace);
        return decision;
      }, { global: true });
    }
  } catch {
    /* 钩子挂不上也不影响人格注入 */
  }
}
