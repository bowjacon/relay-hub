import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicDir = join(root, 'public');
const execFile = promisify(execFileCallback);
const scrypt = promisify(scryptCallback);

const SESSION_COOKIE = 'relay_hub_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const adminSessions = new Map();
const loginAttempts = new Map();

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLogLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const logLevel = Object.hasOwn(LOG_LEVELS, configuredLogLevel) ? configuredLogLevel : 'info';
const logDirectory = resolve(root, process.env.LOG_DIR || 'logs');
const persistentStateFile = resolve(root, process.env.STATE_FILE || 'data/relay-hub-state.json');
const updateRepository = String(process.env.REPO_URL || 'https://github.com/bowjacon/relay-hub.git');
const updateBranch = String(process.env.REPO_BRANCH || 'main');
const updateCommandTimeout = 180000;
const logMaxBytes = Math.max(1024 * 1024, Number(process.env.LOG_MAX_SIZE_MB || 20) * 1024 * 1024);
const logMaxFiles = Math.max(2, Number(process.env.LOG_MAX_FILES || 10));
const logRetentionDays = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 14));
const defaultRequestTimeout = Math.min(600000, Math.max(10000, Number(process.env.REQUEST_TIMEOUT_MS) || 180000));
const proxyAgents = new Map();
const logQueues = new Map();
const runtimeLogMemory = new Map();
let statePersistQueue = Promise.resolve();
let updateOperation = null;

const environmentProxyUrl = () => process.env.http_proxy || process.env.HTTP_PROXY || '';
const proxyUrl = () => {
  const configuredHost = state?.settings?.proxyHost?.trim();
  const configuredPort = Number(state?.settings?.proxyPort);
  if (configuredHost && configuredPort > 0) return `${state.settings.proxyProtocol === 'https' ? 'https' : 'http'}://${configuredHost}:${configuredPort}`;
  return environmentProxyUrl();
};
const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
  return fallback;
};
const safeLogText = (value, max = 300) => String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/(?:sk|key|token)[-_][a-z0-9_-]+/gi, '[REDACTED]').replace(/(https?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@').slice(0, max);
const safeLogValue = (value, depth = 0) => {
  if (depth > 3) return '[TRUNCATED]';
  if (typeof value === 'string') return safeLogText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeLogValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, /authorization|api[-_]?key|token|secret|password|cookie/i.test(key) ? '[REDACTED]' : safeLogValue(item, depth + 1)]));
  return value;
};
const shouldWriteLog = (level) => (LOG_LEVELS[level] ?? LOG_LEVELS.info) <= LOG_LEVELS[logLevel];
const logFileFor = (channel) => join(logDirectory, `${channel}.log`);
const rememberRuntimeLog = (channel, entry) => {
  const entries = runtimeLogMemory.get(channel) || [];
  entries.unshift(entry);
  runtimeLogMemory.set(channel, entries.slice(0, 200));
};
const pruneLogFiles = async (channel) => {
  const names = await readdir(logDirectory).catch(() => []);
  const prefix = `${channel}.log`;
  const files = [];
  for (const name of names.filter((item) => item === prefix || item.startsWith(`${prefix}.`))) {
    const path = join(logDirectory, name);
    const info = await stat(path).catch(() => null);
    if (info) files.push({ path, mtime: info.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
  await Promise.all(files.slice(logMaxFiles).concat(files.filter((file) => file.mtime < cutoff && file.path !== logFileFor(channel))).map((file) => unlink(file.path).catch(() => {})));
};
const writeRuntimeLog = (channel, event = {}) => {
  const level = event.level || 'info';
  if (!shouldWriteLog(level)) return Promise.resolve();
  const entry = { id: event.id || `log_${randomUUID()}`, time: new Date().toISOString(), level, ...safeLogValue(event) };
  rememberRuntimeLog(channel, entry);
  const previous = logQueues.get(channel) || Promise.resolve();
  const task = previous.then(async () => {
    await mkdir(logDirectory, { recursive: true });
    const path = logFileFor(channel);
    const line = `${JSON.stringify(entry)}\n`;
    const currentSize = await stat(path).then((info) => info.size).catch(() => 0);
    if (currentSize + Buffer.byteLength(line) > logMaxBytes) {
      await rename(path, `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID().slice(0, 8)}`).catch(() => {});
    }
    await appendFile(path, line, 'utf8');
    await pruneLogFiles(channel);
  }).catch((error) => console.error(`[relay-hub] cannot write ${channel} log: ${error.message}`));
  logQueues.set(channel, task);
  return task;
};
const readRuntimeLog = async (channel, limit = 100) => {
  const fileEntries = (await readFile(logFileFor(channel), 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).reverse();
  const memoryEntries = runtimeLogMemory.get(channel) || [];
  return [...new Map([...memoryEntries, ...fileEntries].map((entry) => [entry.id, entry])).values()].slice(0, limit);
};
const clearRuntimeLogs = async (channel = null) => {
  const channels = channel ? [channel] : ['app', 'request', 'error', 'audit'];
  await Promise.all(channels.map(async (name) => {
    runtimeLogMemory.delete(name);
    const names = await readdir(logDirectory).catch(() => []);
    await Promise.all(names.filter((file) => file === `${name}.log` || file.startsWith(`${name}.log.`)).map((file) => unlink(join(logDirectory, file)).catch(() => {})));
  }));
};
const fetchThroughSource = async (url, options = {}, source = null) => {
  if (!source?.proxyEnabled) return fetch(url, options);
  const configuredProxy = proxyUrl();
  if (!configuredProxy) throw new Error('该来源已开启代理，但未配置本机代理地址/端口或 http_proxy');
  let dispatcher = proxyAgents.get(configuredProxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(configuredProxy);
    proxyAgents.set(configuredProxy, dispatcher);
  }
  return fetch(url, { ...options, dispatcher });
};

const emptyMetric = () => ({ calls: 0, successes: 0, failures: 0, totalLatency: 0, lastLatency: 0, lastCalledAt: null, probeCalls: 0, probeSuccesses: 0, probeFailures: 0, probeTotalLatency: 0, lastProbeLatency: 0, lastProbeAt: null, lastProbeOk: null, consecutiveFailures: 0, lastError: null });

const MODEL_CATALOG_DEFAULTS = {
  openai: [
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini',
  ],
  anthropic: [
    'claude-opus-4-1', 'claude-opus-4-0', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest',
  ],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-reasoner', 'deepseek-chat'],
};

const OFFICIAL_SOURCE_CONFIG = {
  official_openai: { provider: 'openai', type: 'OpenAI Compatible', baseUrl: 'https://api.openai.com/v1' },
  official_deepseek: { provider: 'deepseek', type: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  official_anthropic: { provider: 'anthropic', type: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
};

const AGENT_ENDPOINTS = {
  codex: '/v1/responses',
  claude: '/v1/messages',
  dsh: '/v1/chat/completions',
};

const createRelayApiKey = () => `rh_${randomBytes(24).toString('hex')}`;
const hashPassword = async (password, salt) => (await scrypt(String(password), salt, 64)).toString('hex');
const ensureAuthCredentials = async () => {
  if (state.auth?.username && /^[0-9a-f]{32}$/i.test(state.auth.passwordSalt || '') && /^[0-9a-f]{128}$/i.test(state.auth.passwordHash || '')) return false;
  const passwordSalt = randomBytes(16).toString('hex');
  state.auth = { username: 'root', passwordSalt, passwordHash: await hashPassword('admin', passwordSalt), passwordChangedAt: null };
  return true;
};
const verifyAdminPassword = async (password) => {
  const expected = Buffer.from(state.auth.passwordHash, 'hex');
  const candidate = Buffer.from(await hashPassword(password, state.auth.passwordSalt), 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
};
const sessionTokenHash = (token) => createHash('sha256').update(token).digest('hex');
const parseCookies = (header = '') => Object.fromEntries(String(header).split(';').map((part) => {
  const [rawKey, ...rawValue] = part.trim().split('=');
  try { return [decodeURIComponent(rawKey || ''), decodeURIComponent(rawValue.join('=') || '')]; } catch { return ['', '']; }
}).filter(([key]) => key));
const requestClientIp = (req) => String(process.env.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : (req.socket.remoteAddress || '')).split(',')[0].trim() || 'unknown';
const getAdminSession = (req) => {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;
  const key = sessionTokenHash(token);
  const session = adminSessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { adminSessions.delete(key); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { ...session, key, token };
};
const setSessionCookie = (res, token, req) => {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
};
const clearSessionCookie = (res) => res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
const createAdminSession = (username) => {
  const token = randomBytes(32).toString('hex');
  adminSessions.set(sessionTokenHash(token), { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
};
const loginRateLimit = (req) => {
  const ip = requestClientIp(req);
  const now = Date.now();
  let record = loginAttempts.get(ip);
  if (!record || record.resetAt <= now) record = { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
  loginAttempts.set(ip, record);
  return { ip, record, blocked: record.failures >= LOGIN_MAX_FAILURES };
};
const recordLoginFailure = (ip, record) => { record.failures += 1; record.resetAt = Math.max(record.resetAt, Date.now() + LOGIN_WINDOW_MS); loginAttempts.set(ip, record); };
const clearLoginFailures = (ip) => loginAttempts.delete(ip);

const modelCatalog = Object.fromEntries(Object.entries(MODEL_CATALOG_DEFAULTS).map(([provider, models]) => [provider, {
  provider,
  models: models.map((id) => ({ id, name: id })),
  updatedAt: null,
  source: 'bundled',
}]));

const state = {
  auth: { username: 'root', passwordSalt: '', passwordHash: '', passwordChangedAt: null },
  settings: {
    defaultSourceId: '',
    defaultModel: '',
    requestTimeout: defaultRequestTimeout,
    proxyHost: '',
    proxyPort: '',
    proxyProtocol: 'http',
  },
  sources: [],
  agents: [
    { id: 'codex', name: 'Codex CLI', short: 'CX', tone: 'cyan', description: 'Responses API', model: '', sourceId: '', fallbackSourceId: '', requests: 0, connected: false, relayApiKey: createRelayApiKey(), apiKeyCreatedAt: new Date().toISOString() },
    { id: 'claude', name: 'Claude Code', short: 'CC', tone: 'coral', description: 'Anthropic Messages API', model: '', sourceId: '', fallbackSourceId: '', requests: 0, connected: false, relayApiKey: createRelayApiKey(), apiKeyCreatedAt: new Date().toISOString() },
    { id: 'dsh', name: 'DSH', short: 'DS', tone: 'lime', description: 'OpenAI-compatible API', model: '', sourceId: '', fallbackSourceId: '', requests: 0, connected: false, relayApiKey: createRelayApiKey(), apiKeyCreatedAt: new Date().toISOString() },
  ],
  logs: [],
};

const stateSnapshot = () => ({
  kind: 'relay-hub-runtime-state',
  version: 1,
  savedAt: new Date().toISOString(),
  auth: { ...state.auth },
  settings: { ...state.settings },
  sources: state.sources.map((source) => ({
    id: source.id,
    name: source.name,
    sourceKind: source.sourceKind || 'third_party',
    provider: source.provider,
    type: source.type,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    proxyEnabled: Boolean(source.proxyEnabled),
    priority: Number(source.priority) || 100,
    enabled: source.enabled !== false,
    models: Array.isArray(source.models) ? source.models.filter(Boolean) : [],
    status: source.status || 'unknown',
    latency: Number(source.latency) || 0,
    lastChecked: source.lastChecked || null,
    modelsUpdatedAt: source.modelsUpdatedAt || null,
    callStats: source.callStats,
    reachability: source.reachability,
    modelStats: source.modelStats,
    requests: Number(source.requests) || 0,
    spend: Number(source.spend) || 0,
  })),
  agents: state.agents.map((agent) => ({
    id: agent.id,
    model: agent.model || '',
    sourceId: agent.sourceId || '',
    fallbackSourceId: agent.fallbackSourceId || '',
    connected: Boolean(agent.connected),
    relayApiKey: agent.relayApiKey,
    apiKeyCreatedAt: agent.apiKeyCreatedAt,
  })),
});

const persistState = () => {
  statePersistQueue = statePersistQueue.then(async () => {
    await mkdir(dirname(persistentStateFile), { recursive: true, mode: 0o700 });
    const temporaryFile = `${persistentStateFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(stateSnapshot(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    await rename(temporaryFile, persistentStateFile);
    await chmod(persistentStateFile, 0o600);
  }).catch((error) => console.error(`[relay-hub] cannot persist state: ${error.message}`));
  return statePersistQueue;
};

const runUpdateCommand = async (command, args, timeout = updateCommandTimeout) => {
  const result = await execFile(command, args, { cwd: root, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return String(result.stdout || '').trim();
};
const safeRepositoryUrl = (value) => {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '[configured repository]';
  }
};
const stateIdentity = (payload) => JSON.stringify({
  auth: { username: payload?.auth?.username, passwordSalt: payload?.auth?.passwordSalt, passwordHash: payload?.auth?.passwordHash, passwordChangedAt: payload?.auth?.passwordChangedAt },
  sources: (payload?.sources || []).map((source) => ({ id: source.id, apiKey: source.apiKey, models: source.models, proxyEnabled: source.proxyEnabled })).sort((a, b) => a.id.localeCompare(b.id)),
  agents: (payload?.agents || []).map((agent) => ({ id: agent.id, relayApiKey: agent.relayApiKey, sourceId: agent.sourceId, model: agent.model })).sort((a, b) => a.id.localeCompare(b.id)),
});
const readPersistedState = async () => JSON.parse(await readFile(persistentStateFile, 'utf8'));
const getUpdateStatus = async () => {
  try {
    const isWorkTree = await runUpdateCommand('git', ['rev-parse', '--is-inside-work-tree'], 15000);
    if (isWorkTree !== 'true') throw new Error('当前部署不是 Git 工作目录');
    const repositoryRoot = resolve(await runUpdateCommand('git', ['rev-parse', '--show-toplevel'], 15000));
    if (repositoryRoot !== root) throw new Error('Git 工作目录与当前服务目录不一致');
    const remote = await runUpdateCommand('git', ['remote', 'get-url', 'origin'], 15000).catch(() => updateRepository);
    const branch = await runUpdateCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 15000);
    const currentCommit = await runUpdateCommand('git', ['rev-parse', 'HEAD'], 15000);
    const currentMessage = await runUpdateCommand('git', ['log', '-1', '--format=%s'], 15000);
    const dirty = Boolean(await runUpdateCommand('git', ['status', '--porcelain', '--untracked-files=no'], 15000));
    const remoteLine = await runUpdateCommand('git', ['ls-remote', remote, `refs/heads/${updateBranch}`], 20000);
    const latestCommit = remoteLine.split(/\s+/)[0] || '';
    const updateAvailable = Boolean(latestCommit && latestCommit !== currentCommit);
    const canUpdate = branch === updateBranch && !dirty && Boolean(latestCommit);
    return { available: true, canUpdate, updateAvailable, currentCommit, currentShortCommit: currentCommit.slice(0, 7), currentMessage, latestCommit, latestShortCommit: latestCommit.slice(0, 7), branch, repository: safeRepositoryUrl(remote), dirty, restartMode: process.env.RELAY_HUB_SUPERVISED === '1' ? 'supervised' : 'manual' };
  } catch (error) {
    return { available: false, canUpdate: false, updateAvailable: false, repository: safeRepositoryUrl(updateRepository), reason: safeLogText(error.message), restartMode: process.env.RELAY_HUB_SUPERVISED === '1' ? 'supervised' : 'manual' };
  }
};
const applyUpdate = async () => {
  if (updateOperation) throw new Error('已有更新任务正在执行');
  updateOperation = (async () => {
    const status = await getUpdateStatus();
    if (!status.available) throw new Error(status.reason || '无法检查远程仓库');
    if (!status.updateAvailable) return { ...status, updated: false, message: '当前已经是最新版本' };
    if (!status.canUpdate) throw new Error(status.dirty ? '当前目录有未提交修改，请先处理后再升级' : `当前分支必须是 ${updateBranch}`);
    await persistState();
    const backupFile = `${persistentStateFile}.before-update-${process.pid}`;
    await copyFile(persistentStateFile, backupFile);
    const beforeIdentity = stateIdentity(await readPersistedState());
    try {
      await runUpdateCommand('git', ['pull', '--ff-only', 'origin', updateBranch], 120000);
      await runUpdateCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], 180000);
      const afterState = await readPersistedState();
      if (stateIdentity(afterState) !== beforeIdentity) throw new Error('升级后检测到来源或 Agent Key 发生变化，已恢复升级前状态');
      await unlink(backupFile).catch(() => {});
      const restartScheduled = process.env.RELAY_HUB_SUPERVISED === '1';
      if (restartScheduled) setTimeout(() => process.exit(75), 800);
      return { ...(await getUpdateStatus()), updated: true, restartScheduled, restartRequired: !restartScheduled, preserved: { sources: afterState.sources.length, agents: afterState.agents.length }, message: restartScheduled ? '升级完成，服务即将自动重启，来源和 API Key 已保留' : '升级文件已完成，需手动重启服务，来源和 API Key 已保留' };
    } catch (error) {
      await copyFile(backupFile, persistentStateFile).catch(() => {});
      throw error;
    } finally {
      await unlink(backupFile).catch(() => {});
    }
  })();
  try { return await updateOperation; } finally { updateOperation = null; }
};

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};

const ensureSourceStats = (source) => {
  source.callStats ||= { calls: 0, successes: 0, failures: 0, totalLatency: 0, lastLatency: 0, lastCalledAt: null };
  source.reachability ||= { checks: 0, successes: 0, lastChecked: null };
  source.modelStats ||= {};
  for (const model of source.models || []) source.modelStats[model] ||= emptyMetric();
  return source;
};

const recordModelCall = (source, success, latency, model) => {
  ensureSourceStats(source);
  const stats = source.callStats;
  const modelStats = source.modelStats[model] ||= emptyMetric();
  for (const target of [stats, modelStats]) {
    target.calls += 1;
    target.successes += success ? 1 : 0;
    target.failures += success ? 0 : 1;
    target.totalLatency += latency;
    target.lastLatency = latency;
    target.lastCalledAt = new Date().toISOString();
  }
};

const recordModelProbe = (source, model, ok, latency, error = null) => {
  ensureSourceStats(source);
  const stats = source.modelStats[model] ||= emptyMetric();
  stats.probeCalls += 1;
  stats.probeSuccesses += ok ? 1 : 0;
  stats.probeFailures += ok ? 0 : 1;
  stats.probeTotalLatency += latency;
  stats.lastProbeLatency = latency;
  stats.lastProbeAt = new Date().toISOString();
  stats.lastProbeOk = ok;
  stats.lastError = ok ? null : error;
  stats.consecutiveFailures = ok ? 0 : stats.consecutiveFailures + 1;
};

const metricView = (stats) => ({ ...stats, averageLatency: stats.calls ? Math.round(stats.totalLatency / stats.calls) : 0, successRate: stats.calls ? Math.round((stats.successes / stats.calls) * 1000) / 10 : null, probeAverageLatency: stats.probeCalls ? Math.round(stats.probeTotalLatency / stats.probeCalls) : 0, probeSuccessRate: stats.probeCalls ? Math.round((stats.probeSuccesses / stats.probeCalls) * 1000) / 10 : null, reachableRate: stats.probeCalls ? Math.round((stats.probeSuccesses / stats.probeCalls) * 1000) / 10 : null, status: stats.lastProbeOk === true ? (stats.consecutiveFailures ? 'degraded' : 'available') : stats.lastProbeOk === false ? (stats.consecutiveFailures >= 5 ? 'unavailable' : 'degraded') : 'unknown' });

const publicSource = (source) => {
  ensureSourceStats(source);
  return {
    ...source,
    proxyEnabled: Boolean(source.proxyEnabled),
    proxyConfigured: Boolean(proxyUrl()),
    sourceKind: source.sourceKind || 'third_party',
    provider: source.provider || providerFromSourceKind(source.sourceKind) || providerFromType(source.type),
    apiKey: source.apiKey && source.apiKey !== '未设置' ? `${source.apiKey.slice(0, 5)}••••${source.apiKey.slice(-4)}` : '未设置',
    callStats: metricView(source.callStats),
    modelStats: Object.fromEntries(Object.entries(source.modelStats).map(([model, stats]) => [model, metricView(stats)])),
    reachability: { ...source.reachability, successRate: source.reachability.checks ? Math.round((source.reachability.successes / source.reachability.checks) * 1000) / 10 : null },
  };
};
const maskSecret = (secret) => secret ? `${secret.slice(0, 7)}••••${secret.slice(-4)}` : '未生成';
const ensureAgentCredentials = (agent) => {
  if (!agent.relayApiKey) agent.relayApiKey = createRelayApiKey();
  agent.apiKeyCreatedAt ||= new Date().toISOString();
  return agent;
};
const publicAgent = (agent) => {
  ensureAgentCredentials(agent);
  return { ...agent, relayApiKey: maskSecret(agent.relayApiKey), endpoint: AGENT_ENDPOINTS[agent.id] || '/v1/chat/completions' };
};
const publicState = () => ({ settings: { ...state.settings, proxyConfigured: Boolean(proxyUrl()), proxySource: state.settings.proxyHost && state.settings.proxyPort ? 'settings' : (environmentProxyUrl() ? 'environment' : 'none'), logLevel }, sources: state.sources.map(publicSource), agents: state.agents.map(publicAgent), logs: state.logs, auth: { username: state.auth.username, passwordChangedAt: state.auth.passwordChangedAt } });

const CONFIG_VERSION = 1;
const isMaskedSecret = (value) => typeof value === 'string' && value.includes('••••');
const exportConfig = (includeSecrets = false) => ({
  kind: 'relay-hub-config',
  version: CONFIG_VERSION,
  exportedAt: new Date().toISOString(),
  settings: {
    defaultSourceId: state.settings.defaultSourceId || '',
    defaultModel: state.settings.defaultModel || '',
    requestTimeout: state.settings.requestTimeout,
  },
  sources: state.sources.map((source) => ({
    id: source.id,
    name: source.name,
    sourceKind: source.sourceKind || 'third_party',
    provider: source.provider,
    type: source.type,
    baseUrl: source.baseUrl,
    ...(includeSecrets && source.apiKey && source.apiKey !== '未设置' ? { apiKey: source.apiKey } : {}),
    proxyEnabled: Boolean(source.proxyEnabled),
    priority: Number(source.priority) || 100,
    enabled: source.enabled !== false,
    models: Array.isArray(source.models) ? source.models.filter(Boolean) : [],
  })),
  agents: state.agents.map((agent) => ({
    id: agent.id,
    model: agent.model || '',
    sourceId: agent.sourceId || '',
    fallbackSourceId: agent.fallbackSourceId || '',
    connected: Boolean(agent.connected),
    ...(includeSecrets ? { relayApiKey: agent.relayApiKey } : {}),
  })),
});

const importConfig = async (payload = {}) => {
  const config = payload.config && typeof payload.config === 'object' ? payload.config : payload;
  if (!config || config.kind !== 'relay-hub-config' || Number(config.version) !== CONFIG_VERSION) throw new Error(`不支持的配置文件版本（需要 ${CONFIG_VERSION}）`);
  if (!Array.isArray(config.sources) || !Array.isArray(config.agents)) throw new Error('配置文件必须包含 sources 和 agents 数组');
  const sources = config.sources.slice(0, 100).map((item, index) => {
    if (!item || typeof item !== 'object' || !String(item.name || '').trim()) throw new Error(`第 ${index + 1} 个来源缺少名称`);
    const normalized = normalizeSourceInput(item);
    if (!normalized.baseUrl) throw new Error(`来源「${item.name}」缺少有效 Base URL`);
    const id = String(item.id || `${item.name}-${Date.now().toString(36)}-${index}`).trim();
    return ensureSourceStats({
      id,
      name: String(item.name).trim(),
      sourceKind: normalized.sourceKind,
      provider: normalized.provider,
      type: normalized.type,
      baseUrl: normalized.baseUrl,
      apiKey: item.apiKey && !isMaskedSecret(item.apiKey) ? String(item.apiKey) : '未设置',
      proxyEnabled: normalized.proxyEnabled,
      priority: Number(item.priority) || 100,
      enabled: item.enabled !== false,
      status: ['healthy', 'degraded', 'offline', 'unknown'].includes(item.status) ? item.status : 'unknown',
      latency: Number(item.latency) || 0,
      lastChecked: item.lastChecked || null,
      models: Array.isArray(item.models) ? [...new Set(item.models.map((model) => String(model).trim()).filter(Boolean))] : [],
      modelsUpdatedAt: item.modelsUpdatedAt || null,
      callStats: item.callStats && typeof item.callStats === 'object' ? item.callStats : { calls: 0, successes: 0, failures: 0, totalLatency: 0, lastLatency: 0, lastCalledAt: null },
      reachability: item.reachability && typeof item.reachability === 'object' ? item.reachability : { checks: 0, successes: 0, lastChecked: null },
      modelStats: item.modelStats && typeof item.modelStats === 'object' ? item.modelStats : {},
      requests: Number(item.requests) || 0,
      spend: Number(item.spend) || 0,
    });
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('配置文件中存在重复的来源 ID');
  const sourceIds = new Set(sources.map((source) => source.id));
  const importedAgents = new Map(config.agents.filter((item) => item && typeof item === 'object').map((item) => [String(item.id), item]));
  state.sources = sources;
  for (const agent of state.agents) {
    const item = importedAgents.get(agent.id);
    if (!item) {
      agent.sourceId = '';
      agent.fallbackSourceId = '';
      agent.model = '';
      agent.connected = false;
      continue;
    }
    agent.sourceId = sourceIds.has(String(item.sourceId || '')) ? String(item.sourceId) : '';
    agent.fallbackSourceId = sourceIds.has(String(item.fallbackSourceId || '')) ? String(item.fallbackSourceId) : '';
    agent.model = String(item.model || '');
    agent.connected = parseBoolean(item.connected, false);
    if (item.relayApiKey && !isMaskedSecret(item.relayApiKey)) agent.relayApiKey = String(item.relayApiKey);
    ensureAgentCredentials(agent);
    agent.requests = 0;
  }
  const settings = config.settings && typeof config.settings === 'object' ? config.settings : {};
  state.settings.defaultSourceId = sourceIds.has(String(settings.defaultSourceId || '')) ? String(settings.defaultSourceId) : '';
  state.settings.defaultModel = String(settings.defaultModel || '');
  state.settings.requestTimeout = Math.min(600000, Math.max(10000, Number(settings.requestTimeout) || defaultRequestTimeout));
  state.logs = [];
  await clearRuntimeLogs();
  addLog('route', 'Configuration imported', `${sources.length} source${sources.length === 1 ? '' : 's'}`);
  return { sources: sources.length, agents: state.agents.length };
};

const providerFromType = (type) => type === 'Anthropic' ? 'anthropic' : type === 'DeepSeek' ? 'deepseek' : 'openai';
const providerFromSourceKind = (sourceKind) => OFFICIAL_SOURCE_CONFIG[sourceKind]?.provider || null;
const normalizeThirdPartyBaseUrl = (value, type) => {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if ((type === 'OpenAI Compatible' || type === 'Anthropic') && (!parsed.pathname || parsed.pathname === '/')) parsed.pathname = '/v1';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
};
const normalizeSourceInput = (body = {}, existing = null) => {
  const sourceKind = body.sourceKind || existing?.sourceKind || 'third_party';
  const official = OFFICIAL_SOURCE_CONFIG[sourceKind];
  if (official) return { sourceKind, ...official, proxyEnabled: parseBoolean(body.proxyEnabled, existing?.proxyEnabled || false) };
  const type = body.type || existing?.type || 'OpenAI Compatible';
  return {
    sourceKind: 'third_party',
    provider: providerFromType(type),
    type,
    baseUrl: normalizeThirdPartyBaseUrl(body.baseUrl ?? existing?.baseUrl ?? '', type),
    proxyEnabled: parseBoolean(body.proxyEnabled, existing?.proxyEnabled || false),
  };
};

const loadPersistentState = async () => {
  const raw = await readFile(persistentStateFile, 'utf8').catch(() => '');
  if (!raw) return false;
  let saved;
  try { saved = JSON.parse(raw); } catch (error) {
    console.error(`[relay-hub] cannot parse state file: ${error.message}`);
    return false;
  }
  if (saved?.kind !== 'relay-hub-runtime-state' || Number(saved.version) !== 1) return false;

  if (saved.auth && typeof saved.auth === 'object' && saved.auth.username && saved.auth.passwordSalt && saved.auth.passwordHash) {
    state.auth = {
      username: String(saved.auth.username),
      passwordSalt: String(saved.auth.passwordSalt),
      passwordHash: String(saved.auth.passwordHash),
      passwordChangedAt: saved.auth.passwordChangedAt ? String(saved.auth.passwordChangedAt) : null,
    };
  }

  const restoredSources = Array.isArray(saved.sources) ? saved.sources.slice(0, 100).map((item, index) => {
    if (!item || typeof item !== 'object' || !String(item.name || '').trim()) return null;
    const normalized = normalizeSourceInput(item);
    if (!normalized.baseUrl) return null;
    return ensureSourceStats({
      id: String(item.id || `${item.name}-${index}`).trim(),
      name: String(item.name).trim(),
      sourceKind: normalized.sourceKind,
      provider: normalized.provider,
      type: normalized.type,
      baseUrl: normalized.baseUrl,
      apiKey: item.apiKey && !isMaskedSecret(item.apiKey) ? String(item.apiKey) : '未设置',
      proxyEnabled: normalized.proxyEnabled,
      priority: Number(item.priority) || 100,
      enabled: item.enabled !== false,
      status: ['healthy', 'degraded', 'offline', 'unknown'].includes(item.status) ? item.status : 'unknown',
      latency: Number(item.latency) || 0,
      lastChecked: item.lastChecked || null,
      models: Array.isArray(item.models) ? [...new Set(item.models.map((model) => String(model).trim()).filter(Boolean))] : [],
      modelsUpdatedAt: item.modelsUpdatedAt || null,
      callStats: item.callStats && typeof item.callStats === 'object' ? item.callStats : { calls: 0, successes: 0, failures: 0, totalLatency: 0, lastLatency: 0, lastCalledAt: null },
      reachability: item.reachability && typeof item.reachability === 'object' ? item.reachability : { checks: 0, successes: 0, lastChecked: null },
      modelStats: item.modelStats && typeof item.modelStats === 'object' ? item.modelStats : {},
      requests: Number(item.requests) || 0,
      spend: Number(item.spend) || 0,
    });
  }).filter(Boolean) : [];
  const uniqueSources = new Map();
  for (const source of restoredSources) if (!uniqueSources.has(source.id)) uniqueSources.set(source.id, source);
  state.sources = [...uniqueSources.values()];
  const sourceIds = new Set(state.sources.map((source) => source.id));
  const savedSettings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};
  state.settings = {
    ...state.settings,
    defaultSourceId: sourceIds.has(String(savedSettings.defaultSourceId || '')) ? String(savedSettings.defaultSourceId) : '',
    defaultModel: String(savedSettings.defaultModel || ''),
    requestTimeout: Math.min(600000, Math.max(10000, Number(savedSettings.requestTimeout) || defaultRequestTimeout)),
    proxyHost: String(savedSettings.proxyHost || '').trim(),
    proxyPort: savedSettings.proxyPort === '' || savedSettings.proxyPort === undefined ? '' : Math.min(65535, Math.max(1, Number(savedSettings.proxyPort) || 1)),
    proxyProtocol: savedSettings.proxyProtocol === 'https' ? 'https' : 'http',
  };
  if (!process.env.REQUEST_TIMEOUT_MS && Number(savedSettings.requestTimeout) === 30000) state.settings.requestTimeout = defaultRequestTimeout;
  const savedAgents = new Map(Array.isArray(saved.agents) ? saved.agents.filter((item) => item && typeof item === 'object').map((item) => [String(item.id), item]) : []);
  for (const agent of state.agents) {
    const item = savedAgents.get(agent.id);
    if (!item) continue;
    if (typeof item.relayApiKey === 'string' && item.relayApiKey && !isMaskedSecret(item.relayApiKey)) agent.relayApiKey = item.relayApiKey;
    if (item.apiKeyCreatedAt) agent.apiKeyCreatedAt = String(item.apiKeyCreatedAt);
    agent.model = String(item.model || '');
    agent.sourceId = sourceIds.has(String(item.sourceId || '')) ? String(item.sourceId) : '';
    agent.fallbackSourceId = sourceIds.has(String(item.fallbackSourceId || '')) ? String(item.fallbackSourceId) : '';
    agent.connected = parseBoolean(item.connected, false);
    ensureAgentCredentials(agent);
  }
  return true;
};

const relayRequestAuth = (req, body) => {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || req.headers['x-api-key'];
  const requestedAgent = req.headers['x-relay-agent'] || body?.agent;
  const byKey = bearer ? state.agents.find((agent) => agent.relayApiKey === bearer) : null;
  if (bearer && !byKey) return { error: 'Invalid relay API key' };
  if (byKey && requestedAgent && byKey.id !== requestedAgent) return { error: 'API key does not match requested agent' };
  const agent = byKey || state.agents.find((item) => item.id === requestedAgent);
  return { agent, authenticated: Boolean(byKey) };
};
const isDryRunRequest = (url, req) => url.searchParams.get('dry_run') === 'true' || req.headers['x-relay-dry-run'] === 'true';
const endpointAllowed = (agent, endpoint) => !agent || AGENT_ENDPOINTS[agent.id] === endpoint;

const catalogPayload = (provider) => modelCatalog[provider] || null;

const getJson = async (url, headers = {}, source = null) => {
  const response = await fetchThroughSource(url, { headers, signal: AbortSignal.timeout(12000) }, source);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.error || `模型接口返回 ${response.status}`);
  return body;
};

const fetchOfficialModels = async (provider, apiKey, baseUrl = '', source = null) => {
  if (!apiKey) throw new Error('未提供 API Key，使用后台缓存目录');
  if (provider === 'anthropic') {
    const models = [];
    let after = '';
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '1000' });
      if (after) query.set('after_id', after);
      const body = await getJson(`https://api.anthropic.com/v1/models?${query}`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, source);
      models.push(...(body.data || []).map((item) => ({ id: item.id, name: item.display_name || item.id })));
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return models;
  }
  const endpoint = provider === 'deepseek' ? 'https://api.deepseek.com/models' : `${baseUrl || 'https://api.openai.com/v1'}/models`;
  const body = await getJson(endpoint.replace(/([^:]\/)\/+/, '$1'), { Authorization: `Bearer ${apiKey}` }, source);
  return (body.data || []).map((item) => ({ id: item.id, name: item.name || item.id }));
};

const refreshCatalog = async (provider, apiKey, baseUrl = '', source = null) => {
  const current = modelCatalog[provider];
  try {
    const models = await fetchOfficialModels(provider, apiKey, baseUrl, source);
    if (models.length) Object.assign(current, { models, updatedAt: new Date().toISOString(), source: 'official' });
    return { ...current, fetched: models.length > 0 };
  } catch (error) {
    return { ...current, fetched: false, warning: error.message };
  }
};

const refreshCatalogFromEnvironment = async () => {
  const configs = [
    ['openai', process.env.OPENAI_API_KEY, ''],
    ['anthropic', process.env.ANTHROPIC_API_KEY, ''],
    ['deepseek', process.env.DEEPSEEK_API_KEY, ''],
  ];
  await Promise.all(configs.filter(([, key]) => key).map(([provider, key, baseUrl]) => refreshCatalog(provider, key, baseUrl)));
};

const refreshConfiguredSourceModels = async () => {
  await Promise.all(state.sources.filter((source) => source.enabled && source.apiKey && source.apiKey !== '未设置').map(async (source) => {
    const provider = source.provider || providerFromSourceKind(source.sourceKind) || providerFromType(source.type);
    const result = await refreshCatalog(provider, source.apiKey, source.baseUrl, source);
    if (result.fetched) {
      source.models = result.models.map((model) => model.id);
      source.modelsUpdatedAt = result.updatedAt;
    }
  }));
};

const refreshModelProbes = async () => {
  await Promise.all(state.sources.filter((source) => source.enabled && source.models.length).map((source) => probeSourceModels(source)));
};

const probeSource = async (source) => {
  const started = Date.now();
  const endpoint = `${source.baseUrl.replace(/\/$/, '')}/models`;
  const headers = source.type === 'Anthropic'
    ? { 'x-api-key': source.apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${source.apiKey}` };
  try {
    const response = await fetchThroughSource(endpoint, { headers, signal: AbortSignal.timeout(5000) }, source);
    const latency = Date.now() - started;
    return { ok: response.ok, latency, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, latency: Date.now() - started, error: error.message };
  }
};

const probeModel = async (source, model) => {
  const started = Date.now();
  const sourceIsAnthropic = source.type === 'Anthropic';
  const targetPath = sourceIsAnthropic ? '/messages' : '/chat/completions';
  const headers = sourceIsAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': source.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${source.apiKey}` };
  const body = sourceIsAnthropic
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 };
  try {
    const response = await fetchThroughSource(`${source.baseUrl.replace(/\/$/, '')}${targetPath}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }, source);
    const latency = Date.now() - started;
    const error = response.ok ? null : `HTTP ${response.status}`;
    recordModelProbe(source, model, response.ok, latency, error);
    return { model, ok: response.ok, latency, error };
  } catch (error) {
    const latency = Date.now() - started;
    recordModelProbe(source, model, false, latency, error.message);
    return { model, ok: false, latency, error: error.message };
  }
};

const probeSourceModels = async (source, models = source.models) => {
  ensureSourceStats(source);
  return Promise.all(models.filter(Boolean).map((model) => probeModel(source, model)));
};

const parseBody = async (req) => {
  let data = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 32 * 1024 * 1024) {
      const error = new Error('请求体超过 32MB 限制，请减少对话上下文后重试');
      error.statusCode = 413;
      throw error;
    }
    data += chunk;
  }
  if (!data) return {};
  try { return JSON.parse(data); } catch { return null; }
};

const publicFile = async (pathname, res) => {
  let relative = pathname === '/' ? '/index.html' : pathname;
  relative = normalize(relative).replace(/^\.\.(\/|\\|$)/, '');
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { json(res, 404, { error: 'Not found' }); }
};

const addLog = (kind, message, meta) => {
  const entry = { id: randomUUID(), kind, message, meta, time: new Date().toISOString() };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 30);
  writeRuntimeLog('audit', { level: kind === 'warning' ? 'warn' : 'info', event: kind, message, meta });
};

const pickSource = (model, preferredId) => {
  const preferred = state.sources.find((source) => source.id === preferredId && source.enabled);
  if (preferred && (!model || preferred.models.includes(model))) return preferred;
  const ordered = state.sources.filter((source) => source.enabled).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return ordered.find((source) => !model || source.models.includes(model))
    ?? ordered[0]
    ?? null;
};

const getSourceCandidates = (model, preferredId, agentId) => {
  const agent = state.agents.find((item) => item.id === agentId);
  // The Agent route is authoritative for CLI requests. Claude Code can send a
  // client-side alias which does not exist in the selected source's model list.
  const routeModel = agent?.model || model;
  const supportsRoute = (source) => !routeModel || source.models.length === 0 || source.models.includes(routeModel) || (model && source.models.includes(model));
  const ids = [agent?.sourceId, agent?.fallbackSourceId, preferredId].filter(Boolean);
  const configured = ids.map((id) => state.sources.find((source) => source.id === id && source.enabled && supportsRoute(source))).filter(Boolean);
  const ordered = state.sources.filter((source) => source.enabled && supportsRoute(source)).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return [...new Map([...configured, ...ordered].map((source) => [source.id, source])).values()];
};

const normalizeModel = (source, model) => {
  if (!model) return source.models[0];
  const aliases = { 'deepseek-reasoner': 'deepseek-reasoner', 'claude-3-7-sonnet-latest': 'claude-3-7-sonnet' };
  return aliases[model] || model;
};

const resolveUpstreamModel = (source, requestedModel, agent) => {
  const configuredModel = agent?.model;
  const candidates = [configuredModel, requestedModel, source.models[0]].filter(Boolean);
  const selected = candidates.find((model) => !source.models.length || source.models.includes(model)) || candidates[0];
  return normalizeModel(source, selected);
};

const inputToMessages = (input) => {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === 'string') return { role: 'user', content: item };
    if (item?.role && item?.content !== undefined) return { role: item.role, content: item.content };
    if (item?.type === 'message' && item?.content !== undefined) return { role: item.role || 'user', content: item.content };
    return { role: 'user', content: item?.text || '' };
  });
};

const anthropicToolToOpenAI = (tool) => {
  if (!tool || tool.type === 'function') return tool;
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  };
};

const anthropicContentToOpenAI = (content) => {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block?.type === 'text') return block;
    if (block?.type === 'image' && block.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    return block;
  });
};

const anthropicMessagesToOpenAI = (messages = []) => messages.map((message) => ({
  ...message,
  content: anthropicContentToOpenAI(message.content),
}));

const anthropicToolChoiceToOpenAI = (choice) => {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice === 'any') return 'required';
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  return choice;
};

const toOpenAIRequest = (body, protocol, model) => {
  if (protocol === 'responses') {
    return { model, messages: inputToMessages(body.input), ...(body.instructions ? { messages: [{ role: 'system', content: body.instructions }, ...inputToMessages(body.input)] } : {}), ...(body.max_output_tokens ? { max_tokens: body.max_output_tokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.stream !== undefined ? { stream: body.stream } : {}) };
  }
  const system = body.system ? [{ role: 'system', content: body.system }] : [];
  const messages = [...system, ...anthropicMessagesToOpenAI(body.messages || [])];
  return {
    model,
    messages,
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map(anthropicToolToOpenAI) } : {}),
    ...(body.tool_choice ? { tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice) } : {}),
  };
};

const fromOpenAIResponse = (payload, protocol, model) => {
  const choice = payload?.choices?.[0];
  const text = Array.isArray(choice?.message?.content) ? choice.message.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('') : choice?.message?.content || '';
  if (protocol === 'responses') return { id: payload.id || `resp-${Date.now()}`, object: 'response', status: 'completed', model: payload.model || model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, usage: payload.usage };
  return { id: payload.id || `msg-${Date.now()}`, type: 'message', role: 'assistant', model: payload.model || model, content: [{ type: 'text', text }], stop_reason: choice?.finish_reason || 'end_turn', usage: payload.usage ? { input_tokens: payload.usage.prompt_tokens, output_tokens: payload.usage.completion_tokens } : undefined };
};
const normalizeOpenAIResponse = (text, protocol, model) => {
  if (!String(text || '').trim()) throw new Error('上游返回空响应');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('上游返回的不是有效 JSON（可能是错误页面或代理拦截）'); }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices) || !payload.choices[0]?.message) throw new Error('上游返回格式不兼容，缺少 choices.message');
  return fromOpenAIResponse(payload, protocol, model);
};
const writeAnthropicStream = (res, message) => {
  const text = message.content?.[0]?.text || '';
  const inputTokens = Number(message.usage?.input_tokens || 0);
  const outputTokens = Number(message.usage?.output_tokens || 0);
  const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  writeEvent('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null } });
  writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  if (text) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
  writeEvent('message_stop', { type: 'message_stop' });
  res.end();
};
const streamOpenAIAsAnthropic = async (res, upstream, model) => {
  if (!upstream.body?.getReader) throw new Error('上游没有可读取的流响应');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let messageId = `msg_${randomUUID()}`;
  const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  writeEvent('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const processLine = (line) => {
    const data = line.trim().replace(/^data:\s*/, '');
    if (!data || data === '[DONE]') return data === '[DONE]';
    let payload;
    try { payload = JSON.parse(data); } catch { return false; }
    const choice = payload.choices?.[0];
    const delta = choice?.delta?.content;
    const content = Array.isArray(delta) ? delta.map((part) => typeof part === 'string' ? part : part?.text || '').join('') : delta;
    if (content) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } });
    if (choice?.finish_reason) finishReason = choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    if (payload.usage) usage = { input_tokens: Number(payload.usage.prompt_tokens || payload.usage.input_tokens || 0), output_tokens: Number(payload.usage.completion_tokens || payload.usage.output_tokens || 0) };
    if (payload.id) messageId = String(payload.id);
    return false;
  };
  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) if (processLine(line)) { done = true; break; }
  }
  if (buffer.trim()) processLine(buffer);
  writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage });
  writeEvent('message_stop', { type: 'message_stop' });
  res.end();
};

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const requestId = `req_${randomUUID()}`;
  const requestStarted = Date.now();
  req.relayLog = { requestId, route: pathname, method: req.method };
  res.setHeader('x-request-id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.on('finish', () => {
    const shouldRecord = pathname.startsWith('/v1/') || pathname.startsWith('/api/sources') || res.statusCode >= 400;
    if (shouldRecord) writeRuntimeLog('request', { level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', ...req.relayLog, status: res.statusCode, latencyMs: Date.now() - requestStarted });
    if (res.statusCode < 400 && ['POST', 'PATCH', 'DELETE'].includes(req.method) && (/^\/api\/(?:sources|agents|settings|config\/import)/.test(pathname))) persistState();
  });

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const session = getAdminSession(req);
    return json(res, 200, { authenticated: Boolean(session), username: session?.username || null, passwordChanged: Boolean(state.auth.passwordChangedAt) });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const { ip, record, blocked } = loginRateLimit(req);
    if (blocked) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((record.resetAt - Date.now()) / 1000)));
      return json(res, 429, { error: '登录失败次数过多，请稍后再试' });
    }
    const body = await parseBody(req);
    const username = String(body?.username || '');
    const password = String(body?.password || '');
    const usernameMatches = username === state.auth.username;
    const passwordMatches = await verifyAdminPassword(password);
    if (!usernameMatches || !passwordMatches) {
      recordLoginFailure(ip, record);
      writeRuntimeLog('audit', { level: 'warn', event: 'admin_login_failed', ip });
      return json(res, 401, { error: '用户名或密码错误' });
    }
    clearLoginFailures(ip);
    const token = createAdminSession(state.auth.username);
    setSessionCookie(res, token, req);
    addLog('route', 'Admin login succeeded', state.auth.username);
    return json(res, 200, { authenticated: true, username: state.auth.username, passwordChanged: Boolean(state.auth.passwordChangedAt) });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = getAdminSession(req);
    if (session) adminSessions.delete(session.key);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/') && !getAdminSession(req)) return json(res, 401, { error: '请先登录' });

  if (pathname === '/api/auth/password' && req.method === 'POST') {
    const session = getAdminSession(req);
    const body = await parseBody(req);
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');
    if (newPassword.length < 8) return json(res, 400, { error: '新密码至少需要 8 个字符' });
    if (newPassword === currentPassword) return json(res, 400, { error: '新密码不能与当前密码相同' });
    if (!(await verifyAdminPassword(currentPassword))) return json(res, 401, { error: '当前密码错误' });
    const passwordSalt = randomBytes(16).toString('hex');
    state.auth.passwordSalt = passwordSalt;
    state.auth.passwordHash = await hashPassword(newPassword, passwordSalt);
    state.auth.passwordChangedAt = new Date().toISOString();
    adminSessions.clear();
    const token = createAdminSession(state.auth.username);
    setSessionCookie(res, token, req);
    addLog('route', 'Admin password changed', session?.username || state.auth.username);
    await persistState();
    return json(res, 200, { ok: true, username: state.auth.username, passwordChanged: true });
  }

  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, publicState());

  if (pathname === '/api/config/export' && req.method === 'GET') {
    const includeSecrets = parseBoolean(url.searchParams.get('includeSecrets'), false);
    const payload = exportConfig(includeSecrets);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="relay-hub-config-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (pathname === '/api/config/import' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const result = await importConfig(body || {});
      return json(res, 200, { ok: true, ...result, state: publicState() });
    } catch (error) {
      return json(res, 400, { error: safeLogText(error.message) });
    }
  }

  if (pathname === '/api/update/check' && req.method === 'GET') return json(res, 200, await getUpdateStatus());
  if (pathname === '/api/update/apply' && req.method === 'POST') {
    try {
      const result = await applyUpdate();
      return json(res, 200, result);
    } catch (error) {
      return json(res, 409, { error: safeLogText(error.message) });
    }
  }

  if (pathname === '/api/runtime-logs' && req.method === 'GET') {
    const channel = ['app', 'request', 'error', 'audit'].includes(url.searchParams.get('channel')) ? url.searchParams.get('channel') : 'request';
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    return json(res, 200, { channel, logs: await readRuntimeLog(channel, limit), config: { directory: logDirectory, maxBytes: logMaxBytes, maxFiles: logMaxFiles, retentionDays: logRetentionDays, level: logLevel } });
  }
  if (pathname === '/api/runtime-logs' && req.method === 'DELETE') {
    await clearRuntimeLogs();
    state.logs = [];
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/models/catalog' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'openai';
    const catalog = catalogPayload(provider);
    if (!catalog) return json(res, 400, { error: 'Unsupported model catalog provider' });
    return json(res, 200, catalog);
  }

  if (pathname === '/api/models/refresh' && req.method === 'POST') {
    const body = await parseBody(req);
    const source = body?.sourceId ? state.sources.find((item) => item.id === body.sourceId) : null;
    const provider = body?.provider || source?.provider || providerFromSourceKind(body?.sourceKind) || providerFromType(source?.type || body?.type);
    const apiKey = body?.apiKey || source?.apiKey;
    const baseUrl = body?.baseUrl || source?.baseUrl || '';
    const catalog = catalogPayload(provider);
    if (!catalog) return json(res, 400, { error: 'Unsupported model catalog provider' });
    const requestSource = source || { proxyEnabled: parseBoolean(body?.proxyEnabled, false) };
    req.relayLog.model = body?.model || null;
    req.relayLog.proxyEnabled = Boolean(requestSource.proxyEnabled);
    const result = await refreshCatalog(provider, apiKey, baseUrl, requestSource);
    if (source && result.fetched) {
      source.models = result.models.map((model) => model.id);
      source.modelsUpdatedAt = result.updatedAt;
    }
    return json(res, 200, result);
  }

  const modelCheckMatch = pathname.match(/^\/api\/sources\/([^/]+)\/models\/check$/);
  if (modelCheckMatch && req.method === 'POST') {
    const source = state.sources.find((item) => item.id === modelCheckMatch[1]);
    if (!source) return json(res, 404, { error: 'Source not found' });
    const body = await parseBody(req);
    const models = body?.model ? [body.model] : source.models;
    req.relayLog.sourceId = source.id;
    req.relayLog.sourceName = source.name;
    req.relayLog.proxyEnabled = Boolean(source.proxyEnabled);
    const results = source.enabled ? await probeSourceModels(source, models) : models.map((model) => ({ model, ok: false, latency: 0, error: 'source disabled' }));
    req.relayLog.model = models.length === 1 ? models[0] : `${models.length} models`;
    req.relayLog.error = results.filter((result) => result.error).map((result) => safeLogText(result.error)).join('; ') || undefined;
    addLog(results.every((result) => result.ok) ? 'success' : 'warning', `${source.name} model probe completed`, `${results.filter((result) => result.ok).length}/${results.length} reachable`);
    return json(res, 200, { sourceId: source.id, source: source.name, results, models: publicSource(source).modelStats });
  }

  if (pathname === '/api/sources' && req.method === 'POST') {
    const body = await parseBody(req);
    const normalized = normalizeSourceInput(body || {});
    if (!body || !body.name || !normalized.baseUrl) return json(res, 400, { error: 'name and baseUrl are required for third-party sources' });
    const source = {
      id: body.id || `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`,
      name: body.name,
      sourceKind: normalized.sourceKind,
      provider: normalized.provider,
      type: normalized.type,
      baseUrl: normalized.baseUrl,
      proxyEnabled: normalized.proxyEnabled,
      apiKey: body.apiKey || '未设置',
      priority: Number(body.priority) || 100,
      enabled: body.enabled !== false,
      status: 'unknown',
      latency: 0,
      lastChecked: null,
      models: Array.isArray(body.models) ? body.models.filter(Boolean) : [],
      modelsUpdatedAt: null,
      callStats: { calls: 0, successes: 0, failures: 0, totalLatency: 0, lastLatency: 0, lastCalledAt: null },
      reachability: { checks: 0, successes: 0, lastChecked: null },
      requests: 0,
      spend: 0,
    };
    state.sources.unshift(source);
    addLog('route', 'New API source added', `${source.name} · ${source.type}`);
    return json(res, 201, publicSource(source));
  }

  const modelStatusMatch = pathname.match(/^\/api\/sources\/([^/]+)\/models\/status$/);
  if (modelStatusMatch && req.method === 'GET') {
    const source = state.sources.find((item) => item.id === modelStatusMatch[1]);
    if (!source) return json(res, 404, { error: 'Source not found' });
    return json(res, 200, { sourceId: source.id, source: source.name, models: publicSource(source).modelStats });
  }

  const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (sourceMatch && req.method === 'PATCH') {
    const source = state.sources.find((item) => item.id === sourceMatch[1]);
    if (!source) return json(res, 404, { error: 'Source not found' });
    const body = await parseBody(req);
    const patch = { ...(body || {}) };
    if (!patch.apiKey) delete patch.apiKey;
    if (Object.hasOwn(patch, 'proxyEnabled')) patch.proxyEnabled = parseBoolean(patch.proxyEnabled);
    if (patch.models && !Array.isArray(patch.models)) patch.models = String(patch.models).split(',').map((model) => model.trim()).filter(Boolean);
    const normalized = normalizeSourceInput({ ...source, ...patch }, source);
    if (!normalized.baseUrl) return json(res, 400, { error: 'baseUrl is required for third-party sources' });
    Object.assign(source, patch, normalized);
    if (body?.priority !== undefined) source.priority = Number(body.priority) || 100;
    addLog('route', `Source ${source.enabled ? 'enabled' : 'paused'}`, source.name);
    return json(res, 200, publicSource(source));
  }
  if (sourceMatch && req.method === 'DELETE') {
    const index = state.sources.findIndex((item) => item.id === sourceMatch[1]);
    if (index < 0) return json(res, 404, { error: 'Source not found' });
    const [source] = state.sources.splice(index, 1);
    if (state.settings.defaultSourceId === source.id) state.settings.defaultSourceId = state.sources.find((item) => item.enabled)?.id || '';
    addLog('warning', 'API source removed', source.name);
    return json(res, 200, { ok: true });
  }
  const checkMatch = pathname.match(/^\/api\/sources\/([^/]+)\/check$/);
  if (checkMatch && req.method === 'POST') {
    const source = state.sources.find((item) => item.id === checkMatch[1]);
    if (!source) return json(res, 404, { error: 'Source not found' });
    ensureSourceStats(source);
    req.relayLog.sourceId = source.id;
    req.relayLog.sourceName = source.name;
    req.relayLog.proxyEnabled = Boolean(source.proxyEnabled);
    const result = source.enabled ? await probeSource(source) : { ok: false, latency: 0, error: 'source disabled' };
    source.lastChecked = new Date().toISOString();
    source.latency = result.latency;
    source.status = !source.enabled ? 'offline' : result.ok ? (result.latency > 600 ? 'degraded' : 'healthy') : 'degraded';
    source.reachability.checks += 1;
    source.reachability.successes += result.ok ? 1 : 0;
    source.reachability.lastChecked = source.lastChecked;
    req.relayLog.error = result.error ? safeLogText(result.error) : undefined;
    addLog(result.ok ? 'success' : 'warning', `${source.name} health check ${result.ok ? 'passed' : 'failed'}`, `${Math.round(result.latency)}ms${result.error ? ` · ${result.error}` : ''}`);
    return json(res, 200, publicSource(source));
  }

  const agentKeyMatch = pathname.match(/^\/api\/agents\/([^/]+)\/key$/);
  if (agentKeyMatch && req.method === 'GET') {
    const agent = state.agents.find((item) => item.id === agentKeyMatch[1]);
    if (!agent) return json(res, 404, { error: 'Agent not found' });
    ensureAgentCredentials(agent);
    return json(res, 200, { ...publicAgent(agent), apiKey: agent.relayApiKey });
  }
  if (agentKeyMatch && req.method === 'POST') {
    const agent = state.agents.find((item) => item.id === agentKeyMatch[1]);
    if (!agent) return json(res, 404, { error: 'Agent not found' });
    ensureAgentCredentials(agent);
    agent.relayApiKey = createRelayApiKey();
    agent.apiKeyCreatedAt = new Date().toISOString();
    addLog('route', `${agent.name} API key rotated`, agent.endpoint || AGENT_ENDPOINTS[agent.id]);
    return json(res, 200, { ...publicAgent(agent), apiKey: agent.relayApiKey });
  }

  if (pathname === '/api/agents' && req.method === 'PATCH') {
    const body = await parseBody(req);
    const agent = state.agents.find((item) => item.id === body?.id);
    if (!agent) return json(res, 404, { error: 'Agent not found' });
    if (body.sourceId) agent.sourceId = body.sourceId;
    if (body.fallbackSourceId !== undefined) agent.fallbackSourceId = body.fallbackSourceId;
    if (body.model) agent.model = body.model;
    if (typeof body.connected === 'boolean') agent.connected = body.connected;
    addLog('route', `${agent.name} route updated`, `${agent.model} via ${state.sources.find((s) => s.id === agent.sourceId)?.name || 'unknown'}`);
    return json(res, 200, publicAgent(agent));
  }

  if (pathname === '/api/settings' && req.method === 'PATCH') {
    const body = await parseBody(req);
    const patch = body || {};
    const nextProxyHost = patch.proxyHost !== undefined ? String(patch.proxyHost || '').trim() : state.settings.proxyHost;
    const nextProxyPort = patch.proxyPort !== undefined ? (patch.proxyPort === '' ? '' : Math.min(65535, Math.max(1, Number(patch.proxyPort) || 1))) : state.settings.proxyPort;
    if ((nextProxyHost && !nextProxyPort) || (!nextProxyHost && nextProxyPort)) return json(res, 400, { error: '本机代理地址和端口必须同时填写，或同时留空' });
    if (patch.requestTimeout !== undefined) state.settings.requestTimeout = Math.min(120000, Math.max(1000, Number(patch.requestTimeout) || 30000));
    if (patch.defaultSourceId !== undefined) state.settings.defaultSourceId = String(patch.defaultSourceId || '');
    if (patch.defaultModel !== undefined) state.settings.defaultModel = String(patch.defaultModel || '');
    if (patch.proxyHost !== undefined) state.settings.proxyHost = nextProxyHost;
    if (patch.proxyPort !== undefined) state.settings.proxyPort = nextProxyPort;
    if (patch.proxyProtocol !== undefined) state.settings.proxyProtocol = patch.proxyProtocol === 'https' ? 'https' : 'http';
    return json(res, 200, state.settings);
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    const auth = relayRequestAuth(req);
    if (!auth.authenticated) return json(res, 401, { error: { message: auth.error || 'Relay API key required', type: 'authentication_error' } });
    const data = state.sources.filter((s) => s.enabled).flatMap((s) => s.models.map((id) => ({ id, object: 'model', owned_by: s.type.toLowerCase().replaceAll(' ', '-') })));
    return json(res, 200, { object: 'list', data: [...new Map(data.map((item) => [item.id, item])).values()] });
  }

  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    req.relayLog.payloadBytes = Buffer.byteLength(JSON.stringify(body));
    const auth = relayRequestAuth(req, body);
    if (!auth.authenticated) return json(res, 401, { error: { message: auth.error || 'Relay API key required', type: 'authentication_error' } });
    const agent = auth.agent;
    if (!endpointAllowed(agent, '/v1/chat/completions')) return json(res, 403, { error: { message: 'This API key must use its assigned agent endpoint', type: 'invalid_endpoint' } });
    const candidates = getSourceCandidates(body.model, req.headers['x-relay-source'], agent?.id);
    const source = candidates[0];
    if (!source) return json(res, 503, { error: { message: 'No enabled API source is available', type: 'service_unavailable' } });
    const upstreamModel = resolveUpstreamModel(source, body.model, agent);
    req.relayLog.agentId = agent.id;
    req.relayLog.model = upstreamModel;
    req.relayLog.sourceId = source.id;
    req.relayLog.sourceName = source.name;
    req.relayLog.proxyEnabled = Boolean(source.proxyEnabled);
    if (agent) agent.requests += 1;
    addLog('success', 'Compatible API request routed', `${body.model || 'default'} → ${source.name}`);
    // Keep the control plane useful before upstream credentials are configured.
    if (isDryRunRequest(url, req)) return json(res, 200, { id: `relay-${Date.now()}`, object: 'chat.completion', relay: { source: source.name, baseUrl: source.baseUrl, model: upstreamModel, agent: agent.id } });
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        const candidateModel = resolveUpstreamModel(candidate, body.model, agent);
        const upstream = await fetchThroughSource(`${candidate.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` }, body: JSON.stringify({ ...body, model: candidateModel }), signal: AbortSignal.timeout(state.settings.requestTimeout) }, candidate);
        const text = await upstream.text();
        recordModelCall(candidate, upstream.ok, Date.now() - started, candidateModel);
        candidate.requests += 1;
        if (upstream.ok || candidate === candidates.at(-1)) { res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' }); return res.end(text); }
        addLog('warning', 'Primary source failed, trying fallback', `${candidate.name} → ${candidates[candidates.indexOf(candidate) + 1]?.name || 'none'}`);
      } catch (error) {
        req.relayLog.error = safeLogText(error.message);
        recordModelCall(candidate, false, Date.now() - started, resolveUpstreamModel(candidate, body.model, agent));
        candidate.requests += 1;
        if (candidate === candidates.at(-1)) return json(res, 502, { error: { message: `Upstream request failed: ${error.message}`, type: 'upstream_error' }, relay: { source: candidate.name } });
      }
    }
  }

  const relayCompatibleRequest = async (protocol) => {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    req.relayLog.payloadBytes = Buffer.byteLength(JSON.stringify(body));
    const auth = relayRequestAuth(req, body);
    if (!auth.authenticated) return json(res, 401, { error: { message: auth.error || 'Relay API key required', type: 'authentication_error' } });
    const agent = auth.agent;
    const expectedEndpoint = protocol === 'responses' ? '/v1/responses' : '/v1/messages';
    if (!endpointAllowed(agent, expectedEndpoint)) return json(res, 403, { error: { message: 'This API key must use its assigned agent endpoint', type: 'invalid_endpoint' } });
    const candidates = getSourceCandidates(body.model, req.headers['x-relay-source'], agent?.id);
    const source = candidates[0];
    if (!source) return json(res, 503, { error: { message: 'No enabled API source is available', type: 'service_unavailable' } });
    const upstreamModel = resolveUpstreamModel(source, body.model, agent);
    req.relayLog.agentId = agent.id;
    req.relayLog.protocol = protocol;
    req.relayLog.model = upstreamModel;
    req.relayLog.sourceId = source.id;
    req.relayLog.sourceName = source.name;
    req.relayLog.proxyEnabled = Boolean(source.proxyEnabled);
    addLog('success', `${protocol} request routed`, `${body.model || 'default'} → ${source.name}`);
    if (isDryRunRequest(url, req)) {
      return json(res, 200, { id: `relay-${Date.now()}`, object: protocol === 'responses' ? 'response' : 'message', relay: { source: source.name, baseUrl: source.baseUrl, model: upstreamModel, protocol, agent: agent.id } });
    }
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        req.relayLog.retryCount = candidates.indexOf(candidate);
        req.relayLog.sourceId = candidate.id;
        req.relayLog.sourceName = candidate.name;
        req.relayLog.proxyEnabled = Boolean(candidate.proxyEnabled);
        const sourceIsAnthropic = candidate.type === 'Anthropic';
        const targetProtocol = protocol === 'anthropic' && sourceIsAnthropic ? 'anthropic' : 'openai';
        const targetPath = targetProtocol === 'anthropic' ? '/messages' : '/chat/completions';
        const candidateModel = resolveUpstreamModel(candidate, body.model, agent);
        const upstreamBody = targetProtocol === 'openai' ? toOpenAIRequest(body, protocol, candidateModel) : { ...body, model: candidateModel };
        const upstream = await fetchThroughSource(`${candidate.baseUrl}${targetPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json', Authorization: `Bearer ${candidate.apiKey}`, 'x-api-key': candidate.apiKey, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' }, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(state.settings.requestTimeout) }, candidate);
        req.relayLog.upstreamStatus = upstream.status;
        req.relayLog.upstreamContentType = upstream.headers.get('content-type') || '';
        if (upstream.ok && targetProtocol === 'openai' && body.stream && upstream.headers.get('content-type')?.includes('text/event-stream')) {
          recordModelCall(candidate, true, Date.now() - started, candidateModel);
          candidate.requests += 1;
          res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          try { return await streamOpenAIAsAnthropic(res, upstream, candidateModel); } catch (error) { req.relayLog.error = safeLogText(error.message); if (!res.headersSent) return json(res, 502, { error: { message: error.message, type: 'upstream_error' }, relay: { source: candidate.name, protocol } }); res.end(); return; }
        }
        const text = await upstream.text();
        recordModelCall(candidate, upstream.ok, Date.now() - started, candidateModel);
        candidate.requests += 1;
        if (upstream.ok || candidate === candidates.at(-1)) {
          if (!upstream.ok || targetProtocol !== 'openai') {
            res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
            return res.end(text);
          }
          try {
            const normalizedResponse = normalizeOpenAIResponse(text, protocol, candidateModel);
            if (body.stream && protocol === 'anthropic') {
              res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
              return writeAnthropicStream(res, normalizedResponse);
            }
            res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(normalizedResponse));
          } catch (error) {
            req.relayLog.error = safeLogText(error.message);
            if (candidate !== candidates.at(-1)) {
              addLog('warning', 'Primary source returned malformed response, trying fallback', `${candidate.name} → ${candidates[candidates.indexOf(candidate) + 1]?.name || 'none'}`);
              continue;
            }
            return json(res, 502, { error: { message: error.message, type: 'upstream_error' }, relay: { source: candidate.name, protocol } });
          }
        }
        addLog('warning', 'Primary source failed, trying fallback', `${candidate.name} → ${candidates[candidates.indexOf(candidate) + 1]?.name || 'none'}`);
      } catch (error) {
        req.relayLog.error = safeLogText(error.message);
        recordModelCall(candidate, false, Date.now() - started, resolveUpstreamModel(candidate, body.model, agent));
        candidate.requests += 1;
        if (candidate === candidates.at(-1)) return json(res, 502, { error: { message: `Upstream request failed: ${error.message}`, type: 'upstream_error' }, relay: { source: candidate.name, protocol } });
      }
    }
  };

  if (pathname === '/v1/responses' && req.method === 'POST') return relayCompatibleRequest('responses');
  if (pathname === '/v1/messages' && req.method === 'POST') return relayCompatibleRequest('anthropic');

  return publicFile(pathname, res);
};

const server = http.createServer((req, res) => handler(req, res).catch((error) => {
  writeRuntimeLog('error', { level: 'error', requestId: req.relayLog?.requestId, route: req.relayLog?.route || req.url, method: req.method, error: error.message });
  return json(res, error.statusCode || 500, { error: error.message });
}));
const port = Number(process.env.PORT || 4173);
await loadPersistentState();
await ensureAuthCredentials();
await persistState();
server.listen(port, () => {
  console.log(`Relay Hub running at http://localhost:${port}`);
  writeRuntimeLog('app', { level: 'info', event: 'server_started', port, proxyConfigured: Boolean(proxyUrl()), logDirectory });
});
refreshCatalogFromEnvironment().catch(() => {});
setInterval(() => Promise.all([refreshCatalogFromEnvironment(), refreshConfiguredSourceModels()]).catch(() => {}), 6 * 60 * 60 * 1000).unref();
setInterval(() => refreshModelProbes().catch(() => {}), 5 * 60 * 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(key);
  for (const [ip, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(ip);
}, 15 * 60 * 1000).unref();
