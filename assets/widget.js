/**
 * dsh-aliyun-balance-multi 前端挂件（原生 DOM，不依赖 React / dsh.client）。
 *
 * 多账号版：一账号一行「名字 ☰ ¥金额」，点 ☰ 开面板，名字可在面板里就地改。
 * 由宿主在 /dsh-aliyun-balance-multi/widget.js 原样回吐。
 */
(function () {
  'use strict'

  var OVERVIEW_URL = '/dsh-aliyun-balance-multi/overview.json'
  var SETTINGS_URL = '/dsh-aliyun-balance-multi/settings.json'
  var CLIENT_URL = OVERVIEW_URL + '?client=1'
  var POLL_MS = 60000
  var UI_ID = 'dsh-aliyun-balance-multi-root'
  var PREFS_KEY = 'dshabm.prefs'
  var POS_KEY = 'dshabm.chipPos'
  var SECTIONS_KEY = 'dshabm.panelSections'

  var CLIENT_VERSION = '0.1.0'

  // ---------- 小工具 ----------

  function h(tag, style, text) {
    var n = document.createElement(tag)
    if (style) for (var k in style) if (Object.prototype.hasOwnProperty.call(style, k)) n.style[k] = style[k]
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function lsOp(op, key, val) {
    try {
      if (op === 'get') return window.localStorage.getItem(key)
      if (op === 'set') return window.localStorage.setItem(key, val)
      if (op === 'del') return window.localStorage.removeItem(key)
    } catch (e) { /* 隐私模式等 */ }
    return null
  }

  function money(sym, v) {
    if (v === undefined || v === null || v === '') return sym + '—'
    return sym + v
  }

  var CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£' }
  function curSym(code) {
    var c = String(code || 'CNY').toUpperCase()
    return CURRENCY_SYMBOL[c] || (c ? c + ' ' : '¥')
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    try {
      var d = new Date(Number(ms))
      if (isNaN(d.getTime())) return '—'
      return d.toLocaleString('zh-CN', { hour12: false })
    } catch (e) { return '—' }
  }

  function fmtStamp(ms) {
    if (!ms) return '—'
    try {
      var d = new Date(Number(ms))
      var p = function (n) { return (n < 10 ? '0' : '') + n }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '—' }
  }

  function errText(e) { return String((e && e.message) || e || '未知错误') }

  /** 诊断回打：只记事件名，不带任何凭据或金额 */
  function ping(stage) {
    try {
      fetch(CLIENT_URL + '&stage=' + encodeURIComponent(String(stage || '')) + '&v=' + CLIENT_VERSION, { cache: 'no-store' })
        .catch(function () {})
    } catch (e) { /* 忽略 */ }
  }

  // 计价时段的展示口径（千问平台）：22:00–08:00 为闲时
  function peakWindow(nowMs) {
    var d = new Date(Number(nowMs) || Date.now())
    var hh = d.getHours() + d.getMinutes() / 60
    var offPeak = hh < 8 || hh >= 22
    var minsLeft
    if (offPeak) {
      minsLeft = hh < 8 ? (8 - hh) * 60 : (24 - hh + 8) * 60
    } else {
      minsLeft = (22 - hh) * 60
    }
    return { offPeak: offPeak, minsLeft: Math.max(1, Math.round(minsLeft)) }
  }
  function fmtDur(mins) {
    var m = Math.max(0, Math.round(mins))
    var hh = Math.floor(m / 60)
    var mm = m % 60
    if (hh <= 0) return mm + '分钟'
    return hh + '小时' + (mm ? mm + '分' : '')
  }

  // ---------- 主题令牌（全部带 var() 回退，跟随明暗主题） ----------
  var T = {
    card: 'var(--dsw-alias-bg-layer-2, rgba(28,32,42,.92))',
    overlay: 'var(--dsw-alias-bg-layer-3, rgba(53,54,56,.97))',
    panel: 'var(--dsw-alias-bg-layer-3, rgba(53,54,56,.97))',
    bgBase: 'var(--dsw-alias-bg-base, rgba(0,0,0,.25))',
    stroke: 'var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
    text: 'var(--dsw-alias-label-primary, #e8ecf4)',
    text2: 'var(--dsw-alias-label-secondary, #aab4c6)',
    text3: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #7c8798))',
    brand: 'var(--dsw-alias-brand-primary, #60a5fa)',
    brandBiz: 'var(--dsw-alias-state-business-primary, #4d93f8)',
    ok: 'var(--dsw-alias-state-success-primary, #4ade80)',
    warn: 'var(--dsw-alias-state-warn-primary, #fbbf24)',
    err: 'var(--dsw-alias-state-error-primary, #f87171)',
    shadow: '0 4px 16px rgba(0,0,0,.22)',
    shadowLg: '0 12px 40px rgba(0,0,0,.35)',
    font: 'inherit',
  }

  var CHIP_H = 32
  var CHIP_W_MIN = 172

  // ---------- 外观偏好 ----------
  var PREFS_DEFAULT = { locked: false, bg: '', text: '', opacity: 100, hideBorder: false, showPeak: true }
  var prefs = {}
  function defaultPrefs() {
    var o = {}
    for (var k in PREFS_DEFAULT) o[k] = PREFS_DEFAULT[k]
    return o
  }
  prefs = defaultPrefs()

  function loadPrefs() {
    try {
      var o = JSON.parse(lsOp('get', PREFS_KEY) || 'null')
      if (o && typeof o === 'object') {
        if (typeof o.locked === 'boolean') prefs.locked = o.locked
        if (typeof o.bg === 'string') prefs.bg = o.bg
        if (typeof o.text === 'string') prefs.text = o.text
        if (typeof o.hideBorder === 'boolean') prefs.hideBorder = o.hideBorder
        if (typeof o.showPeak === 'boolean') prefs.showPeak = o.showPeak
        if (typeof o.opacity === 'number' && isFinite(o.opacity)) {
          prefs.opacity = Math.max(0, Math.min(100, Math.round(o.opacity)))
        }
      }
    } catch (e) { /* 坏数据当默认 */ }
  }
  function savePrefs() {
    lsOp('set', PREFS_KEY, JSON.stringify(prefs))
  }

  function chipTextColor() {
    return /^#[0-9a-fA-F]{6}$/.test(prefs.text) ? prefs.text : null
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!m) return null
    var n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  function fadeColor(hex, alpha) {
    var c = hexToRgb(hex)
    if (!c) return null
    var a = Math.max(0, Math.min(1, Number(alpha) || 0))
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'
  }
  function fadeShadow(shadow, alpha) {
    if (!shadow) return 'none'
    var a = Math.max(0, Math.min(1, Number(alpha) || 0))
    return String(shadow).replace(/rgba\(0,0,0,[\d.]+\)/g, 'rgba(0,0,0,' + a + ')')
  }
  function borderFor(hex) {
    var c = hexToRgb(hex)
    if (!c) return null
    var lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255
    return lum > 0.6 ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.22)'
  }

  function paintChipText(node, c) {
    var kids = (node && node.children) || []
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i]
      if (!k || !k.style) continue
      var cn = (k.className && k.className.toString) ? k.className.toString() : ''
      if (cn.indexOf('dshabm-menu') >= 0) continue
      k.style.color = c
      paintChipText(k, c)
    }
  }

  // ---------- 状态与派生 ----------
  var S = {
    payload: null,
    loading: true,
    error: null,
    open: false,
    settings: null,
    sections: null,
    mode: 'float',
    dragging: false,
    suppressClick: false,
    refreshing: false,
    hoverId: null,      // 当前悬停的账号 id
    busy: '',
    message: null,
    draft: {},          // accountId -> { ak, sk }
    editName: null,     // 正在改名的账号 id
  }

  function deriveAccount(p, acc) {
    var d = {
      id: acc.id, name: acc.name,
      kind: 'loading', stale: false, currency: 'CNY',
      availableCoupons: [], allCoupons: [], errors: [], dataAsOf: {},
    }
    if (!p || p.loading === true || !acc) return d
    d.stale = acc.stale === true
    d.currency = (acc.balance && acc.balance.currency) || p.currency || 'CNY'
    d.dataAsOf = acc.dataAsOf || {}
    d.balance = acc.balance || null
    d.coupons = acc.coupons || null
    var items = (acc.coupons && Array.isArray(acc.coupons.items)) ? acc.coupons.items : []
    d.allCoupons = items
    d.availableCoupons = items.filter(function (it) {
      var st = String((it && it.status) || '').trim().toLowerCase()
      return st === 'available' || st === 'availabletouse'
    })
    d.errors = Array.isArray(acc.errors) ? acc.errors.filter(Boolean) : []
    var credErr = d.errors.some(function (e) { return String(e.scope) === 'credentials' })
    if (credErr) d.kind = 'no-credentials'
    else if (d.stale) d.kind = 'stale'
    else if (d.errors.length) d.kind = 'partial'
    else if (!items.length && !d.balance) d.kind = 'no-coupons'
    else d.kind = 'ok'
    return d
  }

  function totalAvailable(d) {
    var hasC = !!(d.coupons && d.coupons.availableBalance !== undefined && d.coupons.availableBalance !== null)
    var hasB = !!(d.balance && d.balance.available !== undefined && d.balance.available !== null)
    if (!hasC && !hasB) return null
    var c = hasC ? Number(d.coupons.availableBalance) : 0
    var b = hasB ? Number(d.balance.available) : 0
    if (!isFinite(c)) c = 0
    if (!isFinite(b)) b = 0
    return (c + b).toFixed(2)
  }

  function symOf(d) { return curSym(d && d.currency) }

  function rowValueText(d) {
    if (d.kind === 'loading') return '加载中…'
    if (d.kind === 'no-credentials') return '未配置'
    var t = totalAvailable(d)
    return t === null ? symOf(d) + '—' : symOf(d) + t
  }

  // ---------- DOM ----------
  var el = {}

  function ensureStyle() {
    if (document.getElementById('dshabm-style')) return
    var st = document.createElement('style')
    st.id = 'dshabm-style'
    st.textContent = [
      '@keyframes dshabm-breathe{0%,100%{opacity:1}50%{opacity:.45}}',
      '.dshabm-breathe{animation:dshabm-breathe 1.2s ease-in-out infinite}',
      '#dsh-aliyun-balance-multi-root{background:transparent !important;border:0 !important;outline:0 !important;box-shadow:none !important}',
      '.dshabm-row{transition:background .12s ease}',
      '.dshabm-row:hover{background-image:linear-gradient(var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)),var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))) !important}',
      '.dshabm-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#60a5fa) !important}',
      '.dshabm-menu{position:relative;transition:color .12s ease,background .12s ease}',
      '.dshabm-menu::after{content:\'菜单\';position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);' +
        'padding:3px 8px;border-radius:6px;white-space:nowrap;' +
        'background:var(--dsw-alias-bg-layer-3,rgba(53,54,56,.97));color:var(--dsw-alias-label-primary,#e8ecf4);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));box-shadow:0 4px 12px rgba(0,0,0,.22);' +
        'font-size:11px;line-height:1.4;font-weight:400;opacity:0;pointer-events:none;transition:opacity .12s ease}',
      '.dshabm-menu:hover::after,.dshabm-menu:focus-visible::after{opacity:1}',
      '.dshabm-menu:hover,.dshabm-menu:focus-visible{color:var(--dsw-alias-brand-primary,#60a5fa) !important;' +
        'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)) !important}',
      '.dshabm-btn{transition:background .12s ease,opacity .12s ease}',
      '.dshabm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)) !important}',
      '.dshabm-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d93f8) !important}',
      '@keyframes dshabm-pop{from{opacity:0;transform:scale(.97) translateY(8px)}to{opacity:1;transform:none}}',
      '.dshabm-pop{animation:dshabm-pop .2s cubic-bezier(.34,1.3,.6,1);transform-origin:bottom right}',
      '.dshabm-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .18s ease}',
      '.dshabm-collapse-open{grid-template-rows:1fr}',
      '.dshabm-collapse>div{min-height:0;overflow:hidden;transition:visibility .18s ease}',
      '.dshabm-collapse:not(.dshabm-collapse-open)>div{visibility:hidden}',
    ].join('')
    var host = document.head || document.body || document.documentElement
    if (host && host.appendChild) host.appendChild(st)
  }

  // ---------- 定位 ----------
  function defaultPos() {
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    return { right: 16, bottom: 76 }
  }
  function clampPos(x, y, w, hh, vw, vh) {
    var M = 8
    return {
      x: Math.max(M, Math.min(vw - w - M, x)),
      y: Math.max(M, Math.min(vh - hh - M, y)),
    }
  }
  function applyPosition() {
    if (!el.root) return
    var rec = null
    try { rec = JSON.parse(lsOp('get', POS_KEY) || 'null') } catch (e) { rec = null }
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    var rb = null
    try { rb = el.root.getBoundingClientRect() } catch (e) { rb = null }
    var rw = (rb && rb.width) || CHIP_W_MIN
    var rh = (rb && rb.height) || CHIP_H
    // 同一个轴只能留一边：left 和 right 同时有值会把元素拉满视口（透明遮罩，吃掉所有点击）
    el.root.style.right = 'auto'; el.root.style.bottom = 'auto'
    el.root.style.left = 'auto'; el.root.style.top = 'auto'
    if (rec && typeof rec.x === 'number' && typeof rec.y === 'number') {
      var c = clampPos(rec.x, rec.y, rw, rh, vw, vh)
      el.root.style.left = c.x + 'px'; el.root.style.top = c.y + 'px'
    } else if (rec && typeof rec.b === 'number' && typeof rec.x === 'number') {
      el.root.style.left = Math.max(8, Math.min(vw - rw - 8, rec.x)) + 'px'
      el.root.style.bottom = Math.max(8, Math.min(vh - rh - 8, rec.b)) + 'px'
    } else {
      var d = defaultPos()
      el.root.style.right = d.right + 'px'
      el.root.style.bottom = d.bottom + 'px'
    }
  }

  // ---------- 那一行 ----------
  function makeRowShell() {
    var row = h('div', {
      display: 'inline-flex', alignItems: 'center', gap: '6px', height: CHIP_H + 'px',
      padding: '0 8px', borderRadius: '8px', boxSizing: 'border-box', cursor: 'pointer',
      background: T.card, color: T.text2, border: '1px solid ' + T.stroke,
      boxShadow: T.shadow, fontFamily: 'inherit', fontSize: '12px', lineHeight: '1', whiteSpace: 'nowrap',
      minWidth: CHIP_W_MIN + 'px',
    }, null)
    row.className = 'dshabm-row'
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    return row
  }

  function renderRows(p) {
    if (!el.rows) return
    el.rows.textContent = ''
    var list = (p && Array.isArray(p.accounts)) ? p.accounts : []
    if (!list.length) return
    for (var i = 0; i < list.length; i++) {
      // let 而不是 var：否则所有行的闭包共享同一个 acc，全都指向最后一个账号
      let acc = list[i]
      let d = deriveAccount(p, acc)
      var row = makeRowShell()
      row.setAttribute('data-account', acc.id)
      row.setAttribute('aria-label', (acc.name || '账号') + '，悬停看明细，按住可拖动；点菜单按钮看设置，单击立即刷新')
      row.style.marginTop = i === 0 ? '0' : '6px'

      var label = h('span', { flex: '0 0 auto', color: chipTextColor() || T.text2 }, acc.name || '账号')

      var menuBtn = h('span', {
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: '20px', minWidth: '20px', padding: '0', boxSizing: 'border-box',
        borderRadius: '4px', color: T.text3, cursor: 'pointer',
      }, null)
      menuBtn.className = 'dshabm-menu'
      menuBtn.setAttribute('role', 'button')
      menuBtn.setAttribute('aria-label', '菜单')
      menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/></svg>'
      menuBtn.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        if (S.suppressClick) return
        if (S.open) closePanel()
        else openPanel()
      })

      var tone = chipTextColor() || ((d.kind === 'no-credentials' || d.kind === 'stale') ? T.warn : T.text)
      var val = h('span', { marginLeft: 'auto', flex: '0 0 auto', color: tone }, rowValueText(d))

      row.appendChild(label)
      if (i === 0) row.appendChild(menuBtn)   // 菜单只挂在第一行（主号），避免多行各挂一个互相抢
      row.appendChild(val)
      applyRowVisual(row)

      row.addEventListener('click', function (ev) {
        if (S.suppressClick) return
        manualRefresh()
      })
      row.addEventListener('dblclick', function () {
        if (prefs.locked) return
        lsOp('del', POS_KEY)
        el.root.style.right = ''; el.root.style.bottom = ''
        applyPosition()
        render()
      })
      row.addEventListener('mouseenter', function () {
        cancelHideHover()
        S.hoverId = acc.id
        showHover(d)
      })
      row.addEventListener('mouseleave', hideHoverSoon)
      row.addEventListener('focus', function () {
        cancelHideHover()
        S.hoverId = acc.id
        showHover(d)
      })
      row.addEventListener('blur', hideHover)

      if (S.loading || S.refreshing) row.classList.add('dshabm-breathe')
      el.rows.appendChild(row)
    }
    if (el.root.classList) {
      if (S.loading || S.refreshing) el.root.classList.add('dshabm-breathe')
      else el.root.classList.remove('dshabm-breathe')
    }
  }

  function applyRowVisual(row) {
    if (!row) return
    var cs = row.style
    var alpha = Math.max(0, Math.min(1, (typeof prefs.opacity === 'number' ? prefs.opacity : 100) / 100))
    cs.color = chipTextColor() || T.text2
    if (chipTextColor()) paintChipText(row, chipTextColor())
    var edge = prefs.hideBorder ? 'transparent' : (prefs.bg ? borderFor(prefs.bg) : null)
    cs.border = '1px solid ' + (edge || T.stroke)
    if (alpha >= 1) {
      cs.background = (prefs.bg && fadeColor(prefs.bg, 1)) || T.card
      cs.boxShadow = T.shadow
    } else {
      var bgRgb = prefs.bg ? fadeColor(prefs.bg, alpha) : fadeColor('#232324', alpha)
      cs.background = bgRgb || 'transparent'
      cs.boxShadow = fadeShadow(T.shadow, alpha) || 'none'
    }
  }
  function applyAllRows() {
    if (!el.rows) return
    for (var i = 0; i < el.rows.children.length; i++) applyRowVisual(el.rows.children[i])
  }

  // ---------- 悬停卡片 ----------
  function hoverLines(d) {
    var L = []
    var sym = symOf(d)
    if (d.balance) {
      L.push(['现金 / 信控', money(sym, d.balance.cash) + ' / ' + money(sym, d.balance.credit)])
    }
    var face = 0
    var exp = null
    d.availableCoupons.forEach(function (it) {
      face += Number(it.nominalValue) || 0
      var s = String((it && it.expiryTime) || '')
      if (s && (!exp || s < exp)) exp = s
    })
    var balN = Number(d.coupons && d.coupons.availableBalance) || 0
    if (face > 0) {
      L.push(['券面值 / 已用', money(sym, face.toFixed(2)) + ' / ' + money(sym, Math.max(0, face - balN).toFixed(2))])
    }
    if (exp) L.push(['券失效时间', exp.slice(0, 10)])
    if (prefs.showPeak !== false) {
      var pw = peakWindow(Date.now())
      L.push(['计价时段', (pw.offPeak ? '闲时（便宜）' : '忙时（较贵）') + ' · ' + fmtDur(pw.minsLeft) + '后' + (pw.offPeak ? '转忙' : '转闲')])
    }
    var asOf = d.dataAsOf.coupons || d.dataAsOf.balance
    if (asOf) L.push(['数据时间', fmtTime(asOf)])
    return L
  }

  function escopeLabel(scope) {
    if (scope === 'balance') return '余额'
    if (scope === 'coupons') return '代金券'
    if (scope === 'credentials') return '凭据'
    return '错误'
  }

  function buildHoverContent(d) {
    var box = el.hover
    if (!box) return
    box.textContent = ''
    var sym = symOf(d)
    var head = h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }, null)
    head.appendChild(h('span', { color: T.text2, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, d.name || '账号'))
    head.appendChild(h('span', { color: T.text3, fontSize: '11px' }, '可用合计（券 + 阿里云余额）'))
    box.appendChild(head)

    box.appendChild(h('div', {
      fontSize: '20px', color: T.text, lineHeight: '1.25',
      fontVariantNumeric: 'tabular-nums', marginTop: '2px',
    }, rowValueText(d)))

    var parts = []
    if (d.coupons && d.coupons.availableBalance !== undefined && d.coupons.availableBalance !== null) parts.push('券 ' + money(sym, d.coupons.availableBalance))
    if (d.balance && d.balance.available !== undefined && d.balance.available !== null) parts.push('阿里云余额 ' + money(sym, d.balance.available))
    box.appendChild(h('div', { color: T.text3, fontSize: '11px', marginTop: '2px' }, parts.length ? parts.join('　·　') : '尚未取到数据'))

    var rows = h('div', { marginTop: '8px', paddingTop: '7px', borderTop: '1px solid ' + T.stroke }, null)
    hoverLines(d).forEach(function (pair) {
      var row = h('div', { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px', lineHeight: '18px' }, null)
      row.appendChild(h('span', { flex: '0 0 auto', color: T.text3 }, pair[0]))
      row.appendChild(h('span', { textAlign: 'right', color: T.text2, fontVariantNumeric: 'tabular-nums' }, pair[1]))
      rows.appendChild(row)
    })
    box.appendChild(rows)

    d.errors.forEach(function (e) {
      if (String(e.scope) === 'credentials') return
      box.appendChild(h('div', { color: T.err, fontSize: '11px', marginTop: '4px' }, '[' + escopeLabel(e.scope) + '] ' + (e.message || e.code || '取数失败')))
    })
    if (d.kind === 'no-credentials') {
      box.appendChild(h('div', { color: T.warn, fontSize: '11px', marginTop: '4px' }, '未配置 AK/SK：点 ☰ 打开设置'))
    }
  }

  function showHover(d) {
    if (!el.hover || S.open || S.dragging) return
    buildHoverContent(d)
    el.hover.style.display = 'block'
    placeHover()
  }
  function hideHover() {
    if (el.hover) el.hover.style.display = 'none'
  }
  // 离开时延迟收，鼠标在同组行之间挪动不会闪
  var hoverTimer = 0
  function hideHoverSoon() {
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(function () { hoverTimer = 0; hideHover() }, 140)
  }
  function cancelHideHover() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0 }
  }

  function currentRowRect() {
    if (!el.rows || !S.hoverId) return null
    var rows = el.rows.children
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-account') === S.hoverId) {
        try { return rows[i].getBoundingClientRect() } catch (e) { return null }
      }
    }
    return null
  }

  function placeHover() {
    if (!el.hover) return
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    var cr = el.chip ? el.chip.getBoundingClientRect() : null
    var rr = currentRowRect()
    var anchor = rr || cr
    if (!anchor) return
    var hr = null
    try { hr = el.hover.getBoundingClientRect() } catch (e) { hr = null }
    var hh = (hr && hr.height) || 180
    var hw = (hr && hr.width) || 288
    var M = 8
    var rightPx = Math.max(M, Math.round(vw - anchor.right))
    var maxRight = Math.max(M, Math.round(vw - M - hw))
    if (rightPx > maxRight) rightPx = maxRight
    var topPx = Math.round(anchor.top - hh - M)
    if (topPx < M) topPx = Math.max(M, Math.round(Math.min(vh - hh - M, anchor.bottom + M)))
    // 无论如何不许盖住锚点那一行：盖住就会 mouseleave → 卡片消失 → 又 mouseenter，来回闪
    if (topPx + hh > anchor.top - 4) topPx = Math.max(M, Math.round(anchor.top - hh - 4))
    el.hover.style.left = 'auto'
    el.hover.style.right = rightPx + 'px'
    el.hover.style.top = topPx + 'px'
    el.hover.style.bottom = 'auto'
  }

  // ---------- 面板 ----------
  var secEls = {}
  function sectionsState() {
    if (S.sections) return S.sections
    var out = { accounts: true, prefs: false, display: false }
    var saved = null
    // 优先读宿主设置：桌面版每次重启端口都变，origin 一变 localStorage 就空了，
    // 只靠 SECTIONS_KEY 的话「记住上次」实际等于每次都忘。
    var stHost = (S.settings && S.settings.settings) || {}
    if (stHost.panelSections && typeof stHost.panelSections === 'object') {
      saved = stHost.panelSections
    } else {
      try { saved = JSON.parse(lsOp('get', SECTIONS_KEY) || 'null') } catch (e) { saved = null }
    }
    if (saved && typeof saved === 'object') {
      for (var k in out) if (typeof saved[k] === 'boolean') out[k] = saved[k]
    }
    S.sections = out
    return out
  }
  function toggleSection(key) {
    var st = sectionsState()
    st[key] = !st[key]
    lsOp('set', SECTIONS_KEY, JSON.stringify(st))
    // 同时写进宿主设置：端口变了 origin 就变，localStorage 保不住，宿主持久化才跨重启
    try {
      putSettings({ panelSections: st })
        .then(function (j) { if (j && j.settings) S.settings = j })
        .catch(function () { /* 存不上不影响这次展开，下次再点会重试 */ })
    } catch (e) { /* 无 */ }
    var hit = secEls[key]
    if (hit && hit.shell && hit.caret && hit.head) {
      var open = st[key] === true
      hit.shell.className = open ? 'dshabm-collapse dshabm-collapse-open' : 'dshabm-collapse'
      hit.caret.textContent = open ? '▾' : '▸'
      try { hit.head.setAttribute('aria-expanded', open ? 'true' : 'false') } catch (e) { /* 无 */ }
    } else render()
  }

  function section(key, title, summary, opts) {
    opts = opts || {}
    var st = sectionsState()
    var open = st[key] === true
    var wrap = h('div', { marginTop: '8px' }, null)
    var head = h('div', {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '6px',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07))', cursor: 'pointer',
      userSelect: 'none',
    }, null)
    head.setAttribute('role', 'button')
    head.setAttribute('tabindex', '0')
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
    var caret = h('span', { color: T.text3, fontSize: '10px', flex: '0 0 auto', width: '10px' }, open ? '▾' : '▸')
    var titleEl = h('span', { color: T.text2, fontSize: '12px', flex: '0 0 auto' }, title)
    var sumEl = h('span', { color: T.text3, fontSize: '11px', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, summary || '')
    head.appendChild(caret)
    head.appendChild(titleEl)
    head.appendChild(sumEl)
    if (opts.checkbox) {
      var chk = h('input', { flex: '0 0 auto', margin: '0 0 0 4px' }, null)
      chk.type = 'checkbox'
      chk.checked = opts.checkbox.checked === true
      chk.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation() })
      chk.addEventListener('change', function () { if (opts.checkbox.onChange) opts.checkbox.onChange(chk.checked) })
      head.appendChild(chk)
    }
    head.addEventListener('click', function () { toggleSection(key) })
    head.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleSection(key) }
    })
    wrap.appendChild(head)
    var shell = h('div', null, null)
    // h() 的第二个参数只写内联样式（n.style[k]=v），className 必须单独赋值。
    // 塞进 h() 会变成 style.className，元素上等于没有这个类，折叠 CSS 全部失效 —— 于是永远全展开。
    shell.className = open ? 'dshabm-collapse dshabm-collapse-open' : 'dshabm-collapse'
    var body = h('div', { padding: '2px 0 0 10px' }, null)
    shell.appendChild(body)
    wrap.appendChild(shell)
    secEls[key] = { head: head, caret: caret, shell: shell, body: body }
    return { wrap: wrap, body: body }
  }

  function button(label, onClick, primary) {
    var b = h('button', {
      padding: '5px 10px', borderRadius: '6px', border: primary ? '1px solid ' + T.brandBiz : '1px solid ' + T.stroke,
      background: primary ? T.brandBiz : T.stroke, color: primary ? '#fff' : T.text2,
      fontSize: '12px', lineHeight: '1.2', cursor: 'pointer', fontFamily: 'inherit',
    }, label)
    b.type = 'button'
    b.className = 'dshabm-btn' + (primary ? ' dshabm-btn-primary' : '')
    b.addEventListener('click', function (ev) { if (onClick) onClick(ev) })
    return b
  }

  function note(text, tone) {
    return h('div', { color: tone || T.text3, fontSize: '11px', lineHeight: '1.5', marginTop: '4px' }, text)
  }

  function input(placeholder, value, onInput) {
    var i = h('input', {
      width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px',
      border: '1px solid ' + T.stroke, background: T.bgBase, color: T.text,
      fontSize: '12px', fontFamily: 'inherit', outline: 'none',
    }, null)
    i.className = 'dshabm-input'
    i.type = 'text'
    i.placeholder = placeholder || ''
    i.value = value || ''
    i.addEventListener('input', function () { if (onInput) onInput(i.value) })
    return i
  }

  function field(label, control) {
    var w = h('div', { marginBottom: '8px' }, null)
    w.appendChild(h('div', { color: T.text2, marginBottom: '4px', fontSize: '12px' }, label))
    w.appendChild(control)
    return w
  }

  function render() {
    if (!el.rows) return
    renderRows(S.payload)
    if (el.hover && el.hover.style.display === 'block') {
      var p = S.payload
      var acc = p && (p.accounts || []).filter(function (a) { return a.id === S.hoverId })[0]
      if (acc) { buildHoverContent(deriveAccount(p, acc)); placeHover() }
      else hideHover()
    }
    if (!S.open) return
    placePanel()
    renderPanel()
  }

  function renderPanel() {
    var p = el.panel
    if (!p) return
    p.textContent = ''
    secEls = {}

    var head = h('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }, null)
    head.appendChild(h('div', {
      flex: '1 1 auto', minWidth: '0', fontSize: '14px', fontWeight: '600', color: T.text,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, '阿里云券 / 余额（多账号）'))
    head.appendChild(h('div', { flex: '0 0 auto', color: T.text3, fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
      fmtStamp(S.payload && S.payload.generatedAt)))
    var closeBtn = h('button', {
      flex: '0 0 auto', width: '24px', height: '24px', padding: '0', border: 'none',
      background: 'none', color: T.text3, fontSize: '16px', lineHeight: '1', cursor: 'pointer',
      borderRadius: '6px', fontFamily: 'inherit',
    }, '×')
    closeBtn.type = 'button'
    closeBtn.setAttribute('aria-label', '关闭面板')
    closeBtn.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); closePanel() })
    head.appendChild(closeBtn)
    p.appendChild(head)

    var notes = h('div', { marginTop: '2px' }, null)
    if (S.error) notes.appendChild(note('拉取失败：' + S.error, T.err))
    var allErrs = (S.payload && S.payload.errors) || []
    allErrs.forEach(function (e) {
      if (String(e.scope) === 'credentials') return
      notes.appendChild(note('[' + (e.accountId || '?') + '] ' + escopeLabel(e.scope) + '：' + (e.message || e.code), T.err))
    })
    p.appendChild(notes)

    var st0 = (S.settings && S.settings.settings) || {}
    var accs = Array.isArray(st0.accounts) ? st0.accounts : []
    var configured = 0
    var names = []
    for (var i = 0; i < accs.length; i++) {
      if (accs[i].hasAk && accs[i].hasSk) configured++
      names.push(accs[i].name)
    }
    var sum = accs.length ? (accs.length + ' 个账号 · ' + configured + ' 个已配') : '未配置'

    p.appendChild(panelAccountsSection(sum))
    p.appendChild(panelPrefsSection())
    p.appendChild(panelDisplaySection())
  }

  // ---- 账号区 ----
  function panelAccountsSection(summary) {
    var sec = section('accounts', '账号', summary)
    var body = sec.body
    body.appendChild(note('每个账号一组只读 AK/SK，写进 DSH 凭据服务（明文落盘 ~/.dsh/.credentials.yaml，请用只读子账号）。', T.text3))

    var st0 = (S.settings && S.settings.settings) || {}
    var accs = Array.isArray(st0.accounts) ? st0.accounts : []

    accs.forEach(function (acc) {
      var box = h('div', { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid ' + T.stroke }, null)

      // 名称行：显示名字；点一下就地变成输入框（气泡），回车/失焦保存
      var nameRow = h('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }, null)
      if (S.editName === acc.id) {
        var ni = h('input', {
          flex: '1 1 auto', boxSizing: 'border-box', padding: '4px 8px', borderRadius: '6px',
          border: '1px solid ' + T.brandBiz, background: T.bgBase, color: T.text,
          fontSize: '12px', fontFamily: 'inherit', outline: 'none',
        }, null)
        ni.type = 'text'
        ni.maxLength = 24
        ni.value = acc.name
        ni.className = 'dshabm-input'
        ni.addEventListener('keydown', function (ev) {
          if (ev && ev.key === 'Enter') { ev.preventDefault(); saveAccountName(acc.id, ni.value) }
          if (ev && ev.key === 'Escape') { S.editName = null; render() }
        })
        ni.addEventListener('blur', function () { saveAccountName(acc.id, ni.value) })
        nameRow.appendChild(ni)
        setTimeout(function () { try { ni.focus(); ni.select() } catch (e) { /* 无 */ } }, 0)
      } else {
        var nameBtn = h('span', {
          flex: '1 1 auto', color: T.text, fontSize: '12px', padding: '2px 4px', borderRadius: '4px',
          cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }, acc.name)
        nameBtn.title = '点一下改名字'
        nameBtn.addEventListener('click', function () { S.editName = acc.id; render() })
        nameRow.appendChild(nameBtn)
        var status = acc.hasAk && acc.hasSk ? '已配置' : (acc.hasAk || acc.hasSk ? '凭据不完整' : '未配置')
        nameRow.appendChild(h('span', { flex: '0 0 auto', color: (acc.hasAk && acc.hasSk) ? T.ok : T.text3, fontSize: '11px' }, status))
        if (accs.length > 1) {
          var del = h('span', { flex: '0 0 auto', color: T.text3, fontSize: '14px', cursor: 'pointer', padding: '0 2px' }, '×')
          del.title = '删除这个账号（不改动已存凭据）'
          del.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); removeAccount(acc.id) })
          nameRow.appendChild(del)
        }
      }
      box.appendChild(nameRow)

      var dr = S.draft[acc.id] || {}
      box.appendChild(field('AccessKey ID（留空则不覆盖已保存的值）',
        input('LTAI...', dr.ak || '', function (v) { S.draft[acc.id] = S.draft[acc.id] || {}; S.draft[acc.id].ak = v })))
      box.appendChild(field('AccessKey Secret（留空则不覆盖）',
        input('...', dr.sk || '', function (v) { S.draft[acc.id] = S.draft[acc.id] || {}; S.draft[acc.id].sk = v })))

      var btnRow = h('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }, null)
      btnRow.appendChild(button('保存', function () { saveAccountCreds(acc.id) }, true))
      btnRow.appendChild(button('测试连接', function () { testAccountCreds(acc.id) }))
      box.appendChild(btnRow)
      body.appendChild(box)
    })

    var addRow = h('div', { marginTop: '12px' }, null)
    addRow.appendChild(button('+ 添加账号', function () { addAccount() }))
    body.appendChild(addRow)

    var stRefresh = (S.settings && S.settings.settings) || {}
    body.appendChild(note('余额每 ' + Math.round((stRefresh.balanceRefreshMs || 300000) / 60000) + ' 分钟自动刷新', T.text3))
    if (S.busy) body.appendChild(note('处理中：' + S.busy + '…', T.text3))
    if (S.message) body.appendChild(note(S.message.text, S.message.tone))
    return sec.wrap
  }

  function panelPrefsSection() {
    var bits = [prefs.locked ? '已锁定' : '可拖动']
    bits.push(prefs.bg || prefs.text ? '已自定义' : '默认外观')
    var sec = section('prefs', '外观与挂件', bits.join(' · '))
    var body = sec.body

    var lockRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    var lockChk = h('input', { flex: '0 0 auto' }, null)
    lockChk.type = 'checkbox'
    lockChk.checked = prefs.locked === true
    lockChk.addEventListener('change', function () {
      prefs.locked = lockChk.checked === true
      savePrefs()
      render()
    })
    lockRow.appendChild(lockChk)
    lockRow.appendChild(h('span', { color: T.text2, fontSize: '12px' }, '锁定位置（勾选后无法拖动，双击复位也停用）'))
    body.appendChild(lockRow)

    var nbRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    var nbChk = h('input', { flex: '0 0 auto' }, null)
    nbChk.type = 'checkbox'
    nbChk.checked = prefs.hideBorder === true
    nbChk.addEventListener('change', function () {
      prefs.hideBorder = nbChk.checked === true
      savePrefs()
      applyAllRows()
    })
    nbRow.appendChild(nbChk)
    nbRow.appendChild(h('span', { color: T.text2, fontSize: '12px' }, '隐藏边框（更融入背景）'))
    body.appendChild(nbRow)

    function pickRow(labelText, control) {
      var row = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
      row.appendChild(h('span', { color: T.text2, fontSize: '12px', flex: '0 0 auto' }, labelText))
      control.style.flex = '0 0 auto'
      row.appendChild(control)
      return row
    }
    var bgPick = h('input', {}, null)
    bgPick.type = 'color'
    bgPick.value = prefs.bg || '#232324'
    bgPick.addEventListener('input', function () { prefs.bg = bgPick.value; savePrefs(); applyAllRows() })
    bgPick.addEventListener('change', function () { render() })
    body.appendChild(pickRow('背景色', bgPick))

    var textPick = h('input', {}, null)
    textPick.type = 'color'
    textPick.value = prefs.text || '#aeb2b7'
    textPick.addEventListener('input', function () { prefs.text = textPick.value; savePrefs(); applyAllRows() })
    textPick.addEventListener('change', function () { render() })
    body.appendChild(pickRow('文字色', textPick))

    var opPick = h('input', {}, null)
    opPick.type = 'range'
    opPick.min = '0'; opPick.max = '100'; opPick.step = '5'
    opPick.value = String(typeof prefs.opacity === 'number' ? prefs.opacity : 100)
    var opRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    opRow.appendChild(h('span', { color: T.text2, fontSize: '12px', flex: '0 0 auto' }, '不透明度'))
    opPick.style.flex = '1 1 auto'
    opRow.appendChild(opPick)
    var opVal = h('span', { color: T.text3, fontSize: '12px', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' },
      (typeof prefs.opacity === 'number' ? prefs.opacity : 100) + '%')
    opRow.appendChild(opVal)
    opPick.addEventListener('input', function () {
      prefs.opacity = Number(opPick.value) || 0
      savePrefs()
      applyAllRows()
      opVal.textContent = prefs.opacity + '%'
    })
    opPick.addEventListener('change', function () { render() })
    body.appendChild(opRow)

    body.appendChild(button('恢复默认外观', function () {
      prefs.bg = ''; prefs.text = ''; prefs.opacity = 100; prefs.hideBorder = false
      savePrefs()
      render()
    }))
    return sec.wrap
  }

  function panelDisplaySection() {
    var pwNow = peakWindow(Date.now())
    var sumPeak = prefs.showPeak === false ? '已隐藏'
      : ((pwNow.offPeak ? '闲时（便宜）' : '忙时（较贵）') + ' · ' + fmtDur(pwNow.minsLeft) + '后' + (pwNow.offPeak ? '转忙' : '转闲'))
    var sec = section('display', '计价时段', sumPeak, {
      checkbox: {
        checked: prefs.showPeak !== false,
        onChange: function (on) { prefs.showPeak = on; savePrefs(); render() },
      },
    })
    sec.body.appendChild(note('关闭后，悬停明细里不再出现「计价时段」那一行。', T.text3))
    sec.body.appendChild(note('这是千问平台的口径（闲时 22:00–08:00，东八区），且只对按闲忙双档计价的模型成立。', T.text3))
    return sec.wrap
  }

  function openPanel() {
    hideHover()
    S.open = true
    if (el.panel) {
      el.panel.style.display = 'block'
      try {
        el.panel.classList.remove('dshabm-pop')
        void el.panel.offsetWidth
        el.panel.classList.add('dshabm-pop')
      } catch (e) { /* 无 */ }
    }
    load(false)
    loadSettings()
    render()
  }
  function closePanel() {
    S.open = false
    if (el.panel) el.panel.style.display = 'none'
    if (el.panel && el.panel.classList) el.panel.classList.remove('dshabm-pop')
    render()
  }

  function placePanel() {
    if (!el.panel || !el.root) return
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    var rr = null
    try { rr = el.root.getBoundingClientRect() } catch (e) { rr = null }
    if (!rr) return
    var M = 8
    var w = 340
    var left = Math.max(M, Math.min(vw - w - M, rr.left))
    var maxH = Math.min(560, Math.max(160, rr.top - M * 2))
    el.panel.style.left = Math.round(left) + 'px'
    el.panel.style.right = 'auto'
    el.panel.style.top = 'auto'
    el.panel.style.bottom = Math.round(vh - rr.top + M) + 'px'
    el.panel.style.maxHeight = Math.round(maxH) + 'px'
  }

  // ---------- 数据 ----------
  var inflight = null
  function load(force) {
    if (inflight) return inflight
    S.loading = !S.payload
    S.refreshing = force === true && !!S.payload
    render()
    inflight = fetch(OVERVIEW_URL + (force ? '?refresh=1' : ''), { cache: 'no-store' })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error('HTTP ' + (res && res.status))
        return res.json()
      })
      .then(function (json) { S.payload = json; S.error = null; return json })
      .catch(function (e) {
        ping('load-fail')
        S.error = '连不上宿主（插件可能还在加载）。刷新页面或重开客户端再试。'
        return S.payload
      })
      .then(function (json) {
        inflight = null
        S.loading = false
        S.refreshing = false
        render()
        return json
      })
    return inflight
  }

  function loadSettings() {
    return fetch(SETTINGS_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok === false ? null : r.json() })
      .then(function (j) { S.settings = j; S.sections = null; render(); return j })
      .catch(function () { return null })
  }

  function putSettings(patch) {
    return fetch(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch || {}),
    }).then(function (r) {
      return r.json().catch(function () { return null }).then(function (j) {
        if (!r || r.ok === false) {
          var e1 = new Error('HTTP ' + (r && r.status))
          e1.code = 'HTTP ' + (r && r.status)
          throw e1
        }
        if (j && j.ok === false) {
          var e2 = new Error(j.message || j.error || '写入失败')
          e2.code = j.error || ''
          throw e2
        }
        return j
      })
    })
  }

  // ---------- 账号操作 ----------
  function accountList() {
    var st = (S.settings && S.settings.settings) || {}
    return (Array.isArray(st.accounts) ? st.accounts : []).map(function (a) {
      return { id: a.id, name: a.name, akRef: a.akRef, skRef: a.skRef }
    })
  }

  function saveAccounts(list, extra) {
    var patch = { accounts: list }
    if (extra) for (var k in extra) patch[k] = extra[k]
    return putSettings(patch)
  }

  function saveAccountName(id, name) {
    // 设置还没拉回来时别写：空列表会被当成「删光所有账号」
    if (!S.settings) { loadSettings().then(function () { saveAccountName(id, name) }); return }
    var clean = String(name || '').trim().slice(0, 24)
    S.editName = null
    if (!clean) { render(); return }
    var list = accountList()
    for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].name = clean
    S.message = null
    saveAccounts(list)
      .then(function (j) { S.settings = j; S.message = { text: '名字已保存', tone: T.ok }; load(false) })
      .catch(function (e) { S.message = { text: '改名失败：' + errText(e), tone: T.err } })
      .then(function () { render() })
  }

  function addAccount() {
    // 同上：拿不到现有列表就绝不 PUT，否则会把已配好的账号抹掉
    if (!S.settings) { loadSettings().then(function () { addAccount() }); return }
    var list = accountList()
    var id = 'acc-' + Math.random().toString(36).slice(2, 6)
    list.push({ id: id, name: '账号' + (list.length + 1), akRef: '', skRef: '' })
    S.busy = '添加账号'
    render()
    saveAccounts(list)
      .then(function (j) {
        S.settings = j
        S.busy = ''
        S.editName = id
        S.message = { text: '已添加，填 AK/SK 并保存', tone: T.ok }
        load(false)
      })
      .catch(function (e) { S.busy = ''; S.message = { text: '添加失败：' + errText(e), tone: T.err } })
      .then(function () { render() })
  }

  function removeAccount(id) {
    var list = accountList().filter(function (a) { return a.id !== id })
    S.busy = '删除账号'
    render()
    saveAccounts(list)
      .then(function (j) { S.settings = j; S.busy = ''; S.message = { text: '账号已移除', tone: T.ok }; load(false) })
      .catch(function (e) { S.busy = ''; S.message = { text: '删除失败：' + errText(e), tone: T.err } })
      .then(function () { render() })
  }

  function saveAccountCreds(id) {
    var dr = S.draft[id] || {}
    if (!dr.ak && !dr.sk) {
      S.message = { text: '请先填入 AK 或 SK（留空不会覆盖已保存的值）', tone: T.warn }
      render()
      return
    }
    S.busy = '保存凭据'
    S.message = null
    render()
    var patch = { accountId: id }
    if (dr.ak) patch.ak = dr.ak
    if (dr.sk) patch.sk = dr.sk
    putSettings(patch)
      .then(function (j) {
        var st = (j && j.settings) || {}
        var acc = (st.accounts || []).filter(function (a) { return a.id === id })[0]
        if ((dr.ak && acc && !acc.hasAk) || (dr.sk && acc && !acc.hasSk)) {
          throw new Error('写入后读回为空，凭据多半没保存成功')
        }
        S.draft[id] = { ak: '', sk: '' }
        S.settings = j
        S.message = { text: '凭据已保存，正在刷新…', tone: T.ok }
        return load(true)
      })
      .then(function () { S.message = { text: '已保存并刷新完成', tone: T.ok } })
      .catch(function (e) {
        ping('save-fail')
        S.message = { text: '保存失败：' + errText(e), tone: T.err }
      })
      .then(function () { S.busy = ''; render(); loadSettings() })
  }

  function accountNameOf(id) {
    var st = (S.settings && S.settings.settings) || {}
    var list = Array.isArray(st.accounts) ? st.accounts : []
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return String(list[i].name || '').trim() || '账号'
    }
    return '账号'
  }

  function testAccountCreds(id) {
    var dr = S.draft[id] || {}
    var hasDraft = !!(dr.ak || dr.sk)
    var nm = accountNameOf(id)
    S.busy = '测试连接（' + nm + '）'
    S.message = { text: hasDraft ? '正在用「' + nm + '」表单里的凭据调用一次 QueryAccountBalance…' : '正在用「' + nm + '」已保存的凭据调用一次 QueryAccountBalance…', tone: T.text3 }
    render()
    var patch = { accountId: id }
    if (dr.ak) patch.ak = dr.ak
    if (dr.sk) patch.sk = dr.sk
    if (hasDraft) patch.test = 'true'
    var work = hasDraft
      ? putSettings(patch).then(function (j) {
          if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || '连接失败')
          return j
        })
      : load(true)
    work
      .then(function (json) {
        if (hasDraft) {
          S.draft[id] = { ak: '', sk: '' }
          S.message = { text: '「' + nm + '」连接正常，凭据已保存', tone: T.ok }
          return load(true)
        }
        var p = S.payload
        var acc = p && (p.accounts || []).filter(function (a) { return a.id === id })[0]
        var bad = acc && (acc.errors || []).filter(function (e) { return String(e.scope) === 'credentials' || String(e.scope) === 'balance' })[0]
        if (bad) { S.message = { text: '「' + nm + '」测试连接失败：' + (bad.message || bad.code), tone: T.err }; return }
        if (!acc || !acc.balance) { S.message = { text: '「' + nm + '」连接正常，但没返回余额字段（检查 RAM 权限）', tone: T.warn }; return }
        var d = deriveAccount(p, acc)
        S.message = { text: '「' + nm + '」连接正常：可用额度 ' + symOf(d) + acc.balance.available + '（' + fmtTime(acc.dataAsOf && acc.dataAsOf.balance) + '）', tone: T.ok }
      })
      .catch(function (e) {
        ping('test-fail')
        S.message = { text: '「' + nm + '」测试连接失败：' + errText(e), tone: T.err }
      })
      .then(function () { S.busy = ''; render() })
  }

  function manualRefresh() {
    S.busy = '强制刷新'
    S.message = { text: '正在绕过缓存直查阿里云…', tone: T.text3 }
    render()
    load(true).then(function () {
      var errs = (S.payload && S.payload.errors) || []
      S.message = errs.length
        ? { text: '刷新完成，但有 ' + errs.length + ' 个错误', tone: T.warn }
        : { text: '刷新完成', tone: T.ok }
      S.busy = ''
      render()
    }).catch(function (e) {
      ping('manual-fail')
      S.message = { text: '刷新失败：' + errText(e), tone: T.err }
      S.busy = ''
      render()
    })
  }

  // ---------- 拖动 ----------
  function wireDrag() {
    var dragStart = null
    function boxOf(node) {
      try { return (node && node.getBoundingClientRect) ? node.getBoundingClientRect() : null } catch (e) { return null }
    }
    function markRoot(cls, on) {
      try {
        var r = document.documentElement
        if (!r || !r.classList) return
        if (on) r.classList.add(cls)
        else r.classList.remove(cls)
      } catch (e) { /* 无 */ }
    }
    el.rows.addEventListener('pointerdown', function (ev) {
      if (prefs.locked) return
      var lx = parseFloat(el.root.style.left)
      var ty = parseFloat(el.root.style.top)
      var rb = boxOf(el.root)
      dragStart = {
        x: ev.clientX, y: ev.clientY,
        rootLeft: isFinite(lx) ? lx : ((rb && rb.left) || 0),
        rootTop: isFinite(ty) ? ty : ((rb && rb.top) || 0),
        moved: false,
      }
      markRoot('dshabm-noselect', true)
    })
    el.rows.addEventListener('mousedown', function (ev) {
      if (!ev) return
      if (ev.button !== undefined && ev.button !== 0) return
      if (ev.preventDefault) ev.preventDefault()
    })
    document.addEventListener('pointermove', function (ev) {
      if (!dragStart) return
      if (ev && ev.buttons === 0) { endDrag(); return }
      var dx = ev.clientX - dragStart.x
      var dy = ev.clientY - dragStart.y
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      dragStart.moved = true
      S.dragging = true
      markRoot('dshabm-grabbing', true)
      hideHover()
      if (S.open) closePanel()
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
      var rb2 = boxOf(el.root)
      var rw = (rb2 && rb2.width) || CHIP_W_MIN
      var rh = (rb2 && rb2.height) || CHIP_H
      var c = clampPos(dragStart.rootLeft + dx, dragStart.rootTop + dy, rw, rh, vw, vh)
      el.root.style.right = 'auto'; el.root.style.bottom = 'auto'
      el.root.style.left = c.x + 'px'; el.root.style.top = c.y + 'px'
    })
    function endDrag() {
      if (dragStart && dragStart.moved) {
        var sx = parseFloat(el.root.style.left) || 0
        var sy = parseFloat(el.root.style.top) || 0
        lsOp('set', POS_KEY, JSON.stringify({ x: sx, y: sy }))
      }
      var wasDrag = !!(dragStart && dragStart.moved)
      dragStart = null
      S.dragging = false
      markRoot('dshabm-noselect', false)
      markRoot('dshabm-grabbing', false)
      if (wasDrag) { S.suppressClick = true; setTimeout(function () { S.suppressClick = false }, 0) }
    }
    document.addEventListener('pointerup', endDrag)
    document.addEventListener('pointercancel', endDrag)
    try { if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('blur', endDrag) } catch (e) { /* 无 */ }
  }

  // ---------- 建壳 ----------
  function buildShell() {
    var root = h('div', {
      position: 'fixed', left: 'auto', top: 'auto', right: '16px', bottom: '76px',
      zIndex: '2147483000', fontFamily: T.font, fontSize: '12px', color: T.text,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
    }, null)
    root.id = UI_ID

    var rows = h('div', { display: 'flex', flexDirection: 'column', alignItems: 'stretch' }, null)
    rows.id = UI_ID + '-rows'
    root.appendChild(rows)

    var hover = h('div', {
      display: 'none', position: 'fixed', right: '16px', top: '0px', width: '288px',
      maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
      // 只当展示层：不接鼠标，否则卡片压住挂件 → mouseleave → 卡片消失 → 又 mouseenter，无限闪
      pointerEvents: 'none',
      padding: '10px 12px', borderRadius: '10px',
      background: T.overlay, color: T.text2, boxShadow: T.shadowLg,
      fontFamily: T.font, textAlign: 'left', lineHeight: '1.5', zIndex: '2147483001',
    }, null)
    hover.className = 'dshabm-hover'

    var panel = h('div', {
      display: 'none', position: 'fixed', right: '0', bottom: '34px',
      width: 'min(340px, calc(100vw - 24px))', boxSizing: 'border-box',
      maxHeight: 'min(70vh, 560px)', overflowY: 'auto', overflowX: 'hidden',
      padding: '10px 12px', borderRadius: '10px',
      background: T.panel, color: T.text, boxShadow: T.shadowLg,
      textAlign: 'left', lineHeight: '1.6', fontFamily: T.font, zIndex: '2147482999',
    }, null)
    panel.className = 'dshabm-panel'

    return { root: root, rows: rows, hover: hover, panel: panel }
  }

  function wireCloseOnOutside() {
    function isInside(node, target) {
      try {
        var cur = target
        for (var i = 0; cur && i < 40; i++) {
          if (cur === node) return true
          cur = cur.parentNode
        }
      } catch (e) { /* 无 */ }
      return false
    }
    document.addEventListener('pointerdown', function (ev) {
      if (!S.open) return
      var t = ev && ev.target
      if (isInside(el.panel, t) || isInside(el.root, t) || isInside(el.hover, t)) return
      closePanel()
    }, true)
    document.addEventListener('keydown', function (ev) {
      if (!S.open) return
      if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closePanel()
    })
  }

  function build() {
    if (document.getElementById(UI_ID)) return
    ensureStyle()
    var nodes = buildShell()

    // 第一行先建，后面的行由 renderRows 补
    var initial = makeRowShell()
    initial.addEventListener('mouseenter', function () { S.hoverId = null })
    nodes.rows.appendChild(initial)
    nodes.rows.addEventListener('mouseleave', hideHoverSoon)

    var host = document.body || document.documentElement
    host.appendChild(nodes.hover)
    host.appendChild(nodes.panel)
    host.appendChild(nodes.root)

    el.root = nodes.root
    el.rows = nodes.rows
    el.chip = nodes.rows
    el.hover = nodes.hover
    el.panel = nodes.panel

    wireCloseOnOutside()
    wireDrag()
    ping('dom-ready')
  }

  // ---------- 启动 ----------
  try {
    ping('apply')
    function boot() {
      loadPrefs()
      build()
      applyPosition()
      render()
      load()
      loadSettings()
      setInterval(function () { load() }, POLL_MS)

      // 看门狗：节点被 React 重渲染摘掉就补回去；位置没自选就持续跟底
      setInterval(function () {
        if (!el.root) return
        if (S.dragging) return
        if (!el.root.isConnected) {
          try { (document.body || document.documentElement).appendChild(el.root) } catch (e) { /* 无 */ }
        } else if (!lsOp('get', POS_KEY)) {
          applyPosition()
        }
      }, 2000)

      // 缩放窗口后重定位
      try {
        var lastVp = window.innerWidth + 'x' + window.innerHeight
        var rzPending = false
        function rzRun() {
          rzPending = false
          try {
            if (window.innerWidth + 'x' + window.innerHeight === lastVp) return
            lastVp = window.innerWidth + 'x' + window.innerHeight
            if (S.dragging) return
            applyPosition()
          } catch (e) { /* 无 */ }
        }
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('resize', function () {
            if (rzPending) return
            rzPending = true
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(rzRun)
            else setTimeout(rzRun, 16)
          })
        }
      } catch (e) { /* 无 */ }

      ping('booted')
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
    else boot()
  } catch (e) {
    ping('error')
  }
})()