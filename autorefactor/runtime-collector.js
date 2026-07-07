(function() {
  var FOCUS_PATHS = [
    'src/layout',
    'src/views/login',
    'src/views/dashboard',
    'src/views/form',
    'src/views/table',
    'src/views/tree',
    'src/views/nested',
    'src/views/404',
    'src/components/Breadcrumb',
    'src/components/Hamburger'
  ]
  var FLUSH_URL = '/api/runtime-dump'
  var registry = new Map()
  var _hookCount = 0
  var _autoFlushTimer = null

  function scheduleAutoFlush() {
    if (_autoFlushTimer) clearTimeout(_autoFlushTimer)
    _autoFlushTimer = setTimeout(function() {
      window.__flushRuntimeDump()
    }, 1500)
  }

  function collectVm(vm) {
    _hookCount++
    if (_hookCount <= 10) {
      var _opts = vm.$options || {}
      var _file = _opts.__file ||
        (vm.constructor && vm.constructor.options && vm.constructor.options.__file) ||
        '(no __file)'
      var _name = _opts.name || _opts.__name || '?'
      console.log('[RC] hook#' + _hookCount, 'uid=' + vm._uid, 'name=' + _name, 'file=' + _file)
    }

    var opts = vm.$options
    if (!opts) return
    var file = opts.__file ||
      (vm.constructor && vm.constructor.options && vm.constructor.options.__file)
    if (!file) return
    var normFile = file.replace(/\\/g, '/')
    if (!FOCUS_PATHS.some(function(p) { return normFile.includes(p) })) return

    var uid = vm._uid
    if (registry.has(uid)) return

    registry.set(uid, {
      file: normFile,
      name: opts.name || opts.__name || '',
      props: Object.keys(opts.props || {}),
      emits: Object.keys(opts.emits || {}),
      inject: Object.keys(opts.inject || {}),
      data: opts.data ? ['(function)'] : [],
      computed: Object.keys(opts.computed || {}),
      watch: Object.keys(opts.watch || {}),
      methods: Object.keys(opts.methods || {}),
      mixins: (opts.mixins || []).map(function(m) {
        return m.__file || m.name || '(anonymous)'
      }),
      uid: uid
    })
    console.log('[RC] collected:', normFile)
    scheduleAutoFlush()
  }

  try {
    var Vue = require('vue')
    if (Vue && Vue.default) Vue = Vue.default
    console.log('[RuntimeCollector] Vue type:', typeof Vue, 'mixin:', typeof Vue.mixin)
    Vue.mixin({
      created: function() { collectVm(this) },
      updated: function() { collectVm(this) }
    })
    console.log('[RuntimeCollector] Vue.mixin injected')
  } catch (e) {
    console.warn('[RuntimeCollector] inject failed:', e.message)
  }

  window.__flushRuntimeDump = function() {
    var data = Array.from(registry.values())
    console.log('[RuntimeCollector] flush ' + data.length + ' components -> ' + FLUSH_URL)
    return fetch(FLUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function(r) { return r.json() })
      .then(function(r) { console.log('[RuntimeCollector] result:', r) })
  }

  window.addEventListener('beforeunload', function() {
    if (registry.size === 0) return
    var blob = new Blob(
      [JSON.stringify(Array.from(registry.values()))],
      { type: 'application/json' }
    )
    navigator.sendBeacon(FLUSH_URL, blob)
  })
})()
