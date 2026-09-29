'use strict';
// 授权核对全栈应用：零依赖 Node 后端（HTTP API + SSE 实时推送 + 静态页面）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ---------- 领域模型 ----------
// 授权声明：{ id, source, role, resource, action, effect, note }
//   source: 'role'(角色授权) | 'ownership'(资源归属) | 'deny'(拒绝声明)
//   effect: 'allow' | 'deny'
//   role/resource/action 支持 '*' 通配
let nextId = 1;
let statements = [];
const history = []; // 撤销栈：{ label, snapshot }

const PAGES = [
  { id: 'orders', name: '订单管理', ops: [
    { resource: 'order', action: 'view' },
    { resource: 'order', action: 'edit' },
    { resource: 'order', action: 'delete' },
    { resource: 'order', action: 'export' },
  ]},
  { id: 'reports', name: '报表中心', ops: [
    { resource: 'report', action: 'view' },
    { resource: 'report', action: 'export' },
    { resource: 'report', action: 'share' },
  ]},
  { id: 'users', name: '用户管理', ops: [
    { resource: 'user', action: 'view' },
    { resource: 'user', action: 'edit' },
    { resource: 'user', action: 'delete' },
  ]},
  { id: 'settings', name: '系统设置', ops: [
    { resource: 'system', action: 'view' },
    { resource: 'system', action: 'config' },
  ]},
];

const SEED_ROLES = ['admin', 'editor', 'viewer'];

function seed() {
  const add = (source, role, resource, action, effect, note) =>
    statements.push({ id: nextId++, source, role, resource, action, effect, note });
  add('role', 'admin', '*', '*', 'allow', '角色授权：管理员全量放行');
  add('role', 'editor', 'order', 'view', 'allow', '角色授权：编辑可看订单');
  add('role', 'editor', 'order', 'edit', 'allow', '角色授权：编辑可改订单');
  add('role', 'editor', 'report', 'view', 'allow', '角色授权：编辑可看报表');
  add('role', 'viewer', 'order', 'view', 'allow', '角色授权：访客只读订单');
  add('ownership', 'viewer', 'report', 'view', 'allow', '资源归属：访客拥有本人报表');
  add('ownership', 'editor', 'report', 'export', 'allow', '资源归属：编辑可导出自己的报表');
  add('deny', 'editor', 'order', 'delete', 'deny', '拒绝声明：编辑禁止删单');
  add('deny', '*', 'user', 'delete', 'deny', '拒绝声明：任何人禁止删用户');
  add('deny', 'admin', 'system', 'config', 'deny', '拒绝声明：审计期冻结系统配置');
}

// ---------- 推导 ----------
const match = (pattern, value) => pattern === '*' || pattern === value;

function derive(role, resource, action) {
  const matched = statements.filter(s =>
    match(s.role, role) && match(s.resource, resource) && match(s.action, action));
  const allows = matched.filter(s => s.effect === 'allow');
  const denies = matched.filter(s => s.effect === 'deny');
  const conflict = allows.length > 0 && denies.length > 0;
  // 冲突时拒绝优先（deny-wins），两方依据都保留
  const verdict = denies.length > 0 ? 'deny' : (allows.length > 0 ? 'allow' : 'deny');
  const basis = denies.length > 0
    ? (conflict ? '冲突：允许与拒绝并存，按拒绝优先判定' : '拒绝：存在拒绝声明')
    : (allows.length > 0 ? '允许：存在允许依据' : '拒绝：无任何允许依据（默认拒绝）');
  return { verdict, visible: verdict === 'allow', conflict, basis, allows, denies };
}

function allRoles() {
  const set = new Set(SEED_ROLES);
  statements.forEach(s => { if (s.role !== '*') set.add(s.role); });
  return [...set];
}

// 全量结论：{ [role]: { [pageId]: { [resource:action]: deriveResult } } }
function computeConclusions() {
  const out = {};
  for (const role of allRoles()) {
    out[role] = {};
    for (const page of PAGES) {
      out[role][page.id] = {};
      for (const op of page.ops) {
        out[role][page.id][`${op.resource}:${op.action}`] = derive(role, op.resource, op.action);
      }
    }
  }
  return out;
}

// 对比前后结论，找出受影响页面及具体变化
function diffConclusions(before, after) {
  const affected = {};
  for (const role of Object.keys(after)) {
    for (const page of PAGES) {
      for (const op of page.ops) {
        const key = `${op.resource}:${op.action}`;
        const b = before[role] && before[role][page.id] && before[role][page.id][key];
        const a = after[role][page.id][key];
        if (!b || b.visible !== a.visible || b.conflict !== a.conflict) {
          affected[page.id] = affected[page.id] || [];
          affected[page.id].push({
            role, op: key,
            from: b ? (b.visible ? '可见' : '隐藏') : '无',
            to: a.visible ? '可见' : '隐藏',
          });
        }
      }
    }
  }
  return affected;
}

function snapshot() { return JSON.parse(JSON.stringify(statements)); }

function mutate(label, fn) {
  const before = computeConclusions();
  history.push({ label, snapshot: snapshot(), at: new Date().toISOString() });
  fn();
  const after = computeConclusions();
  broadcast({ label, affected: diffConclusions(before, after) });
}

function undo() {
  const entry = history.pop();
  if (!entry) return null;
  const before = computeConclusions();
  statements = entry.snapshot;
  nextId = statements.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const after = computeConclusions();
  broadcast({ label: `撤销：${entry.label}`, affected: diffConclusions(before, after), undone: true });
  return entry.label;
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(change) {
  const payload = JSON.stringify(buildState(change));
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

function buildState(change) {
  return {
    statements,
    pages: PAGES,
    roles: allRoles(),
    conclusions: computeConclusions(),
    history: history.map((h, i) => ({ seq: i + 1, label: h.label, at: h.at })),
    change: change || null,
  };
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const SOURCE_SET = new Set(['role', 'ownership', 'deny']);
function validateStatement(s) {
  if (!s || typeof s !== 'object') return '请求体无效';
  if (!SOURCE_SET.has(s.source)) return 'source 必须是 role/ownership/deny';
  if (!['allow', 'deny'].includes(s.effect)) return 'effect 必须是 allow/deny';
  for (const k of ['role', 'resource', 'action']) {
    if (typeof s[k] !== 'string' || !s[k].trim()) return `${k} 不能为空`;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(buildState(null))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, buildState(null));
    }
    if (url.pathname === '/api/statements' && req.method === 'POST') {
      const body = await readBody(req);
      const err = validateStatement(body);
      if (err) return sendJson(res, 400, { error: err });
      const st = {
        id: nextId++, source: body.source, effect: body.effect,
        role: body.role.trim(), resource: body.resource.trim(), action: body.action.trim(),
        note: (body.note || '').trim(),
      };
      mutate(`新增声明 #${st.id}（${st.source} ${st.effect} ${st.role} ${st.resource}:${st.action}）`,
        () => statements.push(st));
      return sendJson(res, 201, st);
    }
    if (parts[0] === 'api' && parts[1] === 'statements' && parts[2]) {
      const id = Number(parts[2]);
      const idx = statements.findIndex(s => s.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '声明不存在' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const merged = { ...statements[idx], ...body, id };
        const err = validateStatement(merged);
        if (err) return sendJson(res, 400, { error: err });
        mutate(`修改声明 #${id}`, () => { statements[idx] = { ...merged, note: (merged.note || '').trim() }; });
        return sendJson(res, 200, statements[idx]);
      }
      if (req.method === 'DELETE') {
        mutate(`删除声明 #${id}`, () => statements.splice(idx, 1));
        return sendJson(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/undo' && req.method === 'POST') {
      const label = undo();
      if (!label) return sendJson(res, 409, { error: '没有可撤销的调整' });
      return sendJson(res, 200, { ok: true, undone: label });
    }
    // 静态资源
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const fp = path.join(__dirname, 'public', path.normalize(file));
    if (!fp.startsWith(path.join(__dirname, 'public'))) return sendJson(res, 403, { error: 'forbidden' });
    fs.readFile(fp, (e, buf) => {
      if (e) return sendJson(res, 404, { error: 'not found' });
      const type = file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(buf);
    });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

seed();
server.listen(PORT, () => console.log(`授权核对应用已启动: http://localhost:${PORT}`));
