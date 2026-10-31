// dsh-aliyun-balance-multi —— 多账号版后端
//
// 改自 dsh-aliyun-balance 0.1.4（单账号）。改动核心：
//   · settings 从「一组 akRef/skRef」变成「账号列表 accounts[]」
//   · 每个账号各自一套取数状态、错误、刷新时间
//   · overview.json 返回 accounts 数组，前端一账号一行
// 接口契约（路径前缀、注入方式、只读 BSS）保持与上游一致的形态。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { callBss as callBssStatic } from './bss-client.js'
import { freshness } from './cache.js'
import { normalizeBalance, normalizeCoupons } from './normalize.js'

const BSS_FILE = fileURLToPath(new URL('./bss-client.js', import.meta.url))
let bssCache = { mtime: 0, callBss: null }

/** 按文件 mtime 破坏模块缓存再动态 import：改 bss-client.js 后刷新页面即生效 */
async function loadBss() {
  try {
    const st = fs.statSync(BSS_FILE)
    if (bssCache.callBss && bssCache.mtime === st.mtimeMs) return bssCache.callBss
    const mod = await import(`./bss-client.js?ts=${st.mtimeMs}`)
    if (typeof mod.callBss !== 'function') return callBssStatic
    bssCache = { mtime: st.mtimeMs, callBss: mod.callBss }
    return mod.callBss
  } catch {
    return callBssStatic
  }
}

/** 旧单账号版用的固定引用名。迁移时首个账号继续沿用，已配好的凭据不用重填 */
export const AK_REF = 'ALIYUN_BILLING_AK'
export const SK_REF = 'ALIYUN_BILLING_SK'

export const OVERVIEW_PATH = '/dsh-aliyun-balance-multi/overview.json'
export const SETTINGS_PATH = '/dsh-aliyun-balance-multi/settings.json'
export const WIDGET_PATH = '/dsh-aliyun-balance-multi/widget.js'

/** 落盘路径。每次调用时求值，测试可各自指向不同 DSH_HOME */
export function paths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return {
    settings: path.join(home, '.dsh-aliyun-balance-multi-settings.json'),
    log: path.join(home, '.dsh-aliyun-balance-multi.log'),
  }
}

const LOG_MAX_LINES = 200
export function logLine(obj) {
  try {
    const file = paths().log
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch { /* 首次运行 */ }
    lines.push(JSON.stringify({ ts: Date.now(), ...obj }))
    if (lines.length > LOG_MAX_LINES) lines = lines.slice(-LOG_MAX_LINES)
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch { /* 记日志失败不影响主流程 */ }
}

export const DEFAULT_SETTINGS = {
  endpoint: 'business.aliyuncs.com',
  paramLocation: 'query',
  balanceRefreshMs: 300000,
  accounts: [],
  // 面板三段折叠的展开状态。放在宿主侧而不是 localStorage：
  // 桌面版每次重启端口都会变（56693 → 54253 → 49215…），origin 一变 localStorage 就是空的，
  // 于是「记住上次」实际等于每次都忘。
  panelSections: { accounts: true, prefs: false, display: false },
}

/** 折叠状态只认这三个键，值必须是布尔 */
export const PANEL_SECTION_KEYS = ['accounts', 'prefs', 'display']

export function sanitizePanelSections(v) {
  const out = { accounts: true, prefs: false, display: false }
  if (!v || typeof v !== 'object') return out
  for (const k of PANEL_SECTION_KEYS) if (typeof v[k] === 'boolean') out[k] = v[k]
  return out
}

/** settings PUT 可写键白名单（accounts 单独走 sanitizeAccounts） */
export const WRITABLE_SETTINGS_KEYS = new Set(['endpoint', 'paramLocation', 'balanceRefreshMs', 'accounts', 'panelSections'])

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const ENDPOINT_PATTERN = new RegExp('^' + LABEL + '(?:\\.' + LABEL + ')*\\.aliyuncs\\.com$')
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function isValidSetting(key, value) {
  switch (key) {
    case 'endpoint':
      return typeof value === 'string' && ENDPOINT_PATTERN.test(value.trim())
    case 'paramLocation':
      return value === 'query' || value === 'body'
    case 'balanceRefreshMs': {
      const n = Number(value)
      return Number.isFinite(n) && n >= 30000
    }
    case 'panelSections':
      return !!value && typeof value === 'object' && !Array.isArray(value)
    default:
      return false
  }
}

// ---------- 落盘 ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function makeId(seed) {
  const base = String(seed || 'acc').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'acc'
  return base + '-' + Math.random().toString(36).slice(2, 6)
}

function refFor(id, side) {
  const clean = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'ACC'
  return 'ALIYUN_BILLING_' + side + '_' + clean
}

/** 账号列表的清洗与补全：id / name / akRef / skRef 一律合法、唯一 */
export function sanitizeAccounts(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue
    let id = String(raw.id || '').trim()
    if (!ACCOUNT_ID_PATTERN.test(id) || seen.has(id)) id = makeId(raw.name)
    if (seen.has(id)) continue
    seen.add(id)
    const name = String(raw.name || '').trim().slice(0, 24) || '账号' + (out.length + 1)
    const akRef = REF_PATTERN.test(String(raw.akRef || '')) ? String(raw.akRef) : refFor(id, 'AK')
    const skRef = REF_PATTERN.test(String(raw.skRef || '')) ? String(raw.skRef) : refFor(id, 'SK')
    out.push({ id, name, akRef, skRef })
  }
  return out
}

/** 账号列表（含迁移）：磁盘上没有 accounts 时，用旧单账号字段合成一个「主号」 */
export function effectiveAccounts(settings) {
  const s = settings || {}
  const list = Array.isArray(s.accounts) ? sanitizeAccounts(s.accounts) : []
  if (list.length) return list
  return [{ id: 'default', name: '主号', akRef: s.akRef || AK_REF, skRef: s.skRef || SK_REF }]
}

export function loadSettings() {
  const raw = readJson(paths().settings, {})
  const s = raw && typeof raw === 'object' ? raw : {}
  const known = {}
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in s) known[k] = s[k]
  // 旧版字段（单账号）保留在内存里，供迁移用；不写回新文件
  if (s.akRef) known.akRef = s.akRef
  if (s.skRef) known.skRef = s.skRef
  if (!Array.isArray(known.accounts)) known.accounts = []
  return { ...DEFAULT_SETTINGS, ...known, accounts: sanitizeAccounts(known.accounts), panelSections: sanitizePanelSections(known.panelSections) }
}

export function saveSettings(next) {
  const s = { ...DEFAULT_SETTINGS, ...(next || {}) }
  const clean = {
    endpoint: s.endpoint,
    paramLocation: s.paramLocation,
    balanceRefreshMs: s.balanceRefreshMs,
    accounts: sanitizeAccounts(s.accounts),
    panelSections: sanitizePanelSections(s.panelSections),
  }
  try {
    fs.writeFileSync(paths().settings, JSON.stringify(clean, null, 2), 'utf8')
  } catch (err) {
    logLine({ event: 'settings-write-fail', message: String((err && err.message) || err).slice(0, 200) })
  }
  return clean
}

// ---------- 状态 ----------

export function createState(settings = loadSettings()) {
  return {
    settings,
    accounts: {},     // id -> { at: {}, data: {balance, coupons}, errors: [] }
    inflight: {},
  }
}

function accountState(state, id) {
  if (!state.accounts[id]) state.accounts[id] = { at: {}, data: { balance: null, coupons: null }, errors: [] }
  return state.accounts[id]
}

/**
 * 读一个账号的凭据。缺任何一侧都返回 null（与上游 resolveCreds 语义一致）。
 * 永远不记录、不回显密钥：只写「缺哪一侧」这类事实。
 */
export async function resolveCreds(ctx, account) {
  const svc = ctx && ctx.credentials
  if (!svc || typeof svc.resolve !== 'function') return null
  try {
    const ak = await svc.resolve(account.akRef)
    const sk = await svc.resolve(account.skRef)
    if (ak && ak.value && sk && sk.value) return { ak: String(ak.value), sk: String(sk.value) }
    return null
  } catch (err) {
    if (throttled('resolve-throw:' + account.id, 300000)) {
      logLine({ event: 'resolve-miss', reason: 'throw', id: account.id, code: (err && err.code) || '' })
    }
    return null
  }
}

async function readCredSide(ctx, ref) {
  try {
    const svc = ctx && ctx.credentials
    if (!svc || typeof svc.resolve !== 'function') return null
    const r = await svc.resolve(ref)
    return (r && r.value) ? String(r.value) : null
  } catch { return null }
}

// 日志节流：诊断日志是 200 行环形缓冲，失败风暴会把起点冲掉
const logThrottle = new Map()
function throttled(key, ms) {
  const now = Date.now()
  const last = logThrottle.get(key) || 0
  if (now - last < ms) return false
  logThrottle.set(key, now)
  if (logThrottle.size > 500) logThrottle.clear()
  return true
}

function noteError(st, accountId, scope, res) {
  st.errors = st.errors.filter((e) => e.scope !== scope)
  st.errors.push({ accountId, scope, code: (res && res.code) || 'Error', message: (res && res.message) || '' })
  const code = (res && res.code) || 'Error'
  if (throttled('note:' + accountId + ':' + scope + ':' + code, 300000)) {
    logLine({ event: 'refresh-fail', id: accountId, scope, code, message: String((res && res.message) || '').slice(0, 200) })
  }
}

function clearError(st, scope) {
  st.errors = st.errors.filter((e) => e.scope !== scope)
}

async function refreshScope(ctx, state, account, scope, force) {
  const key = account.id + ':' + scope
  if (state.inflight[key]) return state.inflight[key]
  const st = accountState(state, account.id)
  const ttl = Number(state.settings.balanceRefreshMs) || 300000
  if (!force && freshness(st.at[scope], Date.now(), ttl) === 'fresh') return

  const run = (async () => {
    const settings = state.settings
    const callBss = await loadBss()
    const c = await resolveCreds(ctx, account)
    if (!c) {
      noteError(st, account.id, 'credentials', { code: 'NoCredentials', message: '未配置阿里云只读 AK/SK' })
      return
    }
    if (scope === 'balance') {
      const res = await callBss({ ...c, action: 'QueryAccountBalance', params: {}, endpoint: settings.endpoint, paramLocation: settings.paramLocation })
      if (!res.ok) return noteError(st, account.id, scope, res)
      st.data.balance = normalizeBalance(res.data)
      st.at.balance = Date.now()
      clearError(st, scope)
    } else if (scope === 'coupons') {
      const base = { ...c, action: 'QueryCashCoupons', endpoint: settings.endpoint, paramLocation: settings.paramLocation }
      const res = await callBss({ ...base, params: {} })
      let data = res && res.ok ? res.data : null
      if (res && res.ok) {
        const items = normalizeCoupons(res.data).items
        if (!items.length) {
          // 省略 EffectiveOrNot 时返回范围未经验证：为空就 true/false 各取一次合并
          const [a, b] = await Promise.all([
            callBss({ ...base, params: { EffectiveOrNot: 'true' } }),
            callBss({ ...base, params: { EffectiveOrNot: 'false' } }),
          ])
          const merged = []
          for (const r of [a, b]) {
            if (r && r.ok) {
              const d = r.data && r.data.Data
              const arr = Array.isArray(d) ? d : Array.isArray(d && d.CashCoupon) ? d.CashCoupon : []
              merged.push(...arr)
            }
          }
          if (merged.length) data = { Data: merged }
        }
      }
      if (!res.ok) return noteError(st, account.id, scope, res)
      st.data.coupons = normalizeCoupons(data || { Data: [] })
      st.at.coupons = Date.now()
      clearError(st, scope)
    }
  })()
  state.inflight[key] = run
  try {
    await run
  } finally {
    delete state.inflight[key]
  }
}

// ---------- 组装 ----------

export async function buildPayload(ctx, state, { force = false } = {}) {
  const accounts = effectiveAccounts(state.settings)
  const ttl = Number(state.settings.balanceRefreshMs) || 300000

  const jobs = []
  for (const a of accounts) {
    for (const scope of ['balance', 'coupons']) {
      jobs.push(refreshScope(ctx, state, a, scope, force).catch((err) => {
        noteError(accountState(state, a.id), a.id, scope, err)
      }))
    }
  }
  await Promise.all(jobs)

  const out = accounts.map((a) => {
    const st = accountState(state, a.id)
    const stale = ['balance', 'coupons'].some((k) => st.at[k] && freshness(st.at[k], Date.now(), ttl) === 'stale')
    const credErr = st.errors.some((e) => e.scope === 'credentials')
    return {
      id: a.id,
      name: a.name,
      ok: !credErr,
      stale,
      balance: st.data.balance || null,
      coupons: st.data.coupons || null,
      errors: st.errors.slice(),
      dataAsOf: { balance: st.at.balance || null, coupons: st.at.coupons || null },
    }
  })

  const allErrors = []
  for (const a of out) for (const e of a.errors) allErrors.push(e)

  return {
    ok: out.every((a) => a.ok),
    stale: out.some((a) => a.stale),
    generatedAt: Date.now(),
    nowMs: Date.now(),
    accounts: out,
    errors: allErrors,
  }
}

async function settingsWithFlags(ctx, state) {
  const accounts = effectiveAccounts(state.settings)
  const list = []
  for (const a of accounts) {
    const ak = await readCredSide(ctx, a.akRef)
    const sk = await readCredSide(ctx, a.skRef)
    list.push({ id: a.id, name: a.name, akRef: a.akRef, skRef: a.skRef, hasAk: !!ak, hasSk: !!sk })
  }
  return {
    ok: true,
    settings: {
      endpoint: state.settings.endpoint,
      paramLocation: state.settings.paramLocation,
      balanceRefreshMs: state.settings.balanceRefreshMs,
      // 前端要靠这个字段还原上次的展开状态；漏了它，前端就只能回退 localStorage，
      // 而桌面版每次重启 origin 都变，回退等于没记。
      panelSections: sanitizePanelSections(state.settings.panelSections),
      accounts: list,
    },
  }
}

// ---------- 写请求的跨站防护 ----------

function loopbackHost(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '').split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}
function portOf(host) {
  const i = String(host || '').lastIndexOf(':')
  return i < 0 ? '' : String(host).slice(i + 1)
}
function sameSiteHost(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (loopbackHost(a) && loopbackHost(b)) return portOf(a) === portOf(b)
  return false
}
function originHostOf(req) {
  const raw = req && req.headers ? req.headers.origin : undefined
  if (raw === undefined || raw === null || raw === '') return null
  try { return new URL(String(raw)).host || '' } catch { return '' }
}
function writeGuardReason(req) {
  const headers = (req && req.headers) || {}
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin') return 'sec-fetch-site=' + site
  const origin = originHostOf(req)
  if (origin !== null) {
    const host = String(headers.host || '')
    if (!origin || !sameSiteHost(origin, host)) return 'origin=' + (origin || '(unparsable)')
  }
  const ct = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (ct !== 'application/json') return 'content-type=' + (ct || '(none)')
  return null
}

async function readBody(req, max = 65536) {
  if (req && req.body && typeof req.body === 'object') return req.body
  let size = 0
  const chunks = []
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > max) break
      chunks.push(chunk)
    }
  } catch {
    return {}
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function noteCredWriteFail(ref, err) {
  const code = (err && err.code) || ''
  const message = String((err && err.message) || err).slice(0, 200)
  logLine({ event: 'cred-write-fail', ref, code, message })
  return { ref, code, message }
}

/** 取 PUT 里指定的账号；没给 accountId 就用第一个 */
function pickAccount(settings, accountId) {
  const accounts = effectiveAccounts(settings)
  if (!accountId) return accounts[0]
  return accounts.find((a) => a.id === accountId) || accounts[0]
}

// ---------- 插件入口 ----------

const WIDGET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'widget.js')

// 官方桌面端（Electron）唯一生效的注入通道：推一条内联 script 行，由它自己建 <script src>。
const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + WIDGET_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function serveWidget(req, res) {
  try {
    const body = fs.readFileSync(WIDGET_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('widget not found')
  }
}

const liveDisposers = []
function disposeLive() {
  const list = liveDisposers.splice(0)
  for (const d of list) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }
}

export function apply(root, config = {}) {
  const state = createState({ ...loadSettings(), ...(config && config.settings ? config.settings : {}) })
  logLine({
    event: 'apply',
    profile: process.env.DSH_PROFILE || null,
    endpoint: state.settings.endpoint,
    accounts: effectiveAccounts(state.settings).length,
    seq: liveDisposers.length === 0 ? 1 : 2,
  })
  disposeLive()

  const disposers = []

  // ① 立刻注册注入行（不依赖任何服务）
  if (typeof root.on === 'function') {
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === WIDGET_PATH) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
      } catch { /* 注入失败不影响宿主 */ }
    }))
  }

  const start = (ctx) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WIDGET_PATH,
      handler: serveWidget,
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: OVERVIEW_PATH,
      handler: async (req, res) => {
        const t0 = Date.now()
        try {
          const url = new URL(req.url || OVERVIEW_PATH, 'http://localhost')
          if (url.searchParams.get('client') === '1') {
            const stage = url.searchParams.get('stage') || ''
            if (throttled('ping:' + stage, 10000)) logLine({ event: 'client-ping', stage })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, pong: true }))
            return
          }
          const force = url.searchParams.get('refresh') === '1'
          const payload = await buildPayload(ctx, state, { force })
          if (throttled('overview:' + (payload.ok ? 'ok' : 'bad') + ':' + (force ? 'f' : 'n'), 30000)) {
            logLine({
              event: 'overview',
              ok: payload.ok,
              accounts: payload.accounts.length,
              refresh: force,
              ms: Date.now() - t0,
              errors: payload.errors.map((e) => `${e.accountId}:${e.scope}:${e.code}`),
            })
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, accounts: [], errors: [{ scope: 'overview', code: 'Error', message: String((err && err.message) || err) }] }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: async (req, res) => {
        try {
          const method = (req.method || 'GET').toUpperCase()
          if (method === 'PUT' || method === 'POST') {
            const guard = writeGuardReason(req)
            if (guard) {
              if (throttled('settings-guard', 10000)) logLine({ event: 'settings-guard', reason: guard, method })
              res.writeHead(guard.startsWith('content-type') ? 415 : 403, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'Forbidden', message: '跨站写请求已被拒绝' }))
              return
            }
            const body = await readBody(req)
            const next = { ...state.settings }

            for (const [k, v] of Object.entries(body || {})) {
              if (k === 'ak' || k === 'sk' || k === 'test' || k === 'accountId') continue
              if (k === 'accounts') continue // 单独处理
              if (!WRITABLE_SETTINGS_KEYS.has(k) || !isValidSetting(k, v)) {
                if (throttled('settings-reject', 10000)) logLine({ event: 'settings-reject', key: k })
                continue
              }
              next[k] = v
            }
            if (Array.isArray(body && body.accounts)) {
              next.accounts = sanitizeAccounts(body.accounts)
            }

            const isTest = !!(body && body.test === 'true')

            if (!isTest) {
              const writeFail = []
              const target = pickAccount(next, body && body.accountId)
              if (body && typeof body.ak === 'string' && body.ak) {
                try { await ctx.credentials.set(target.akRef, body.ak) }
                catch (err) { writeFail.push(noteCredWriteFail(target.akRef, err)) }
              }
              if (body && typeof body.sk === 'string' && body.sk) {
                try { await ctx.credentials.set(target.skRef, body.sk) }
                catch (err) { writeFail.push(noteCredWriteFail(target.skRef, err)) }
              }
              state.settings = saveSettings(next)
              const out = await settingsWithFlags(ctx, state)
              if (writeFail.length) {
                out.ok = false
                out.error = 'CredWriteFailed'
                out.message = '凭据写入失败（其余设置已保存）：' + writeFail.map((f) => f.code || f.message).join(' / ')
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(out))
              return
            }

            // 测试连接：只测不落盘；测通了才写凭据
            const target = pickAccount(next, body && body.accountId)
            const akTry = (typeof body.ak === 'string' && body.ak) ? body.ak : await readCredSide(ctx, target.akRef)
            const skTry = (typeof body.sk === 'string' && body.sk) ? body.sk : await readCredSide(ctx, target.skRef)
            const send = (obj) => {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(obj))
            }
            if (!akTry || !skTry) {
              send({ ok: false, error: 'NoCredentials', saved: false, message: '缺少 AK 或 SK（输入框为空且没有已保存的值）' })
              return
            }
            let r
            try {
              r = await (await loadBss())({
                ak: akTry, sk: skTry, action: 'QueryAccountBalance', params: {},
                endpoint: next.endpoint, paramLocation: next.paramLocation,
              })
            } catch (err) {
              send({ ok: false, error: String((err && err.message) || err), saved: false, message: '测试请求本身失败' })
              return
            }
            if (!r.ok) {
              send({ ok: false, error: r.code, message: r.message, saved: false })
              return
            }
            const writeFail = []
            if (typeof body.ak === 'string' && body.ak) {
              try { await ctx.credentials.set(target.akRef, body.ak) }
              catch (err) { writeFail.push(noteCredWriteFail(target.akRef, err)) }
            }
            if (typeof body.sk === 'string' && body.sk) {
              try { await ctx.credentials.set(target.skRef, body.sk) }
              catch (err) { writeFail.push(noteCredWriteFail(target.skRef, err)) }
            }
            state.settings = saveSettings(next)
            if (writeFail.length) {
              send({ ok: false, error: 'CredWriteFailed', saved: false, message: '连接正常，但凭据写入失败：' + writeFail.map((f) => f.code || f.message).join(' / ') })
              return
            }
            send({ ok: true, error: null, message: '连接正常', saved: !!(typeof body.ak === 'string' && body.ak) || !!(typeof body.sk === 'string' && body.sk) })
            return
          }

          const out = await settingsWithFlags(ctx, state)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(out))
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))

    // 定时刷新：固定间隔（默认 5 分钟，下限 30s），不做退避
    const schedule = (fn, ttl) => {
      const timer = setInterval(async () => {
        try { await fn() } catch { /* 忽略 */ }
      }, Math.max(30000, Number(ttl) || 300000))
      if (timer && typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const stop = schedule(() => buildPayload(ctx, state, { force: false }), state.settings.balanceRefreshMs)
        disposers.push(stop)
        return stop
      })
    }
  }

  const cleanup = () => { for (const d of disposers) { try { d && d() } catch { /* 忽略 */ } } }
  liveDisposers.push(cleanup)

  if (typeof root.inject === 'function') {
    const fiber = root.inject(['webServer', 'credentials'], start)
    const cancel = typeof fiber === 'function' ? fiber
      : (fiber && typeof fiber.dispose === 'function') ? () => fiber.dispose()
        : null
    if (cancel) disposers.push(cancel)
  } else start(root)

  return cleanup
}