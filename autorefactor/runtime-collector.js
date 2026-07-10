(function() {
  function parseFocusPaths(input) {
    if (Array.isArray(input)) return input
    if (typeof input !== 'string') return []
    return input.split(',').map(function(p) {
      return p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    }).filter(Boolean)
  }

  function envFocus() {
    if (typeof process === 'undefined' || !process.env) return ''
    return process.env.REFACTOR_FOCUS || process.env.VUE_APP_REFACTOR_FOCUS || ''
  }

  var FOCUS_PATHS = parseFocusPaths(window.__RUNTIME_COLLECTOR_FOCUS)
  if (!FOCUS_PATHS.length) FOCUS_PATHS = parseFocusPaths(envFocus())
  if (!FOCUS_PATHS.length) FOCUS_PATHS = ['src/']
  var FLUSH_URL = '/api/runtime-dump'
  var registry = new Map()
  var _hookCount = 0
  var _autoFlushTimer = null

  function uniq(arr) {
    var seen = {}
    return (arr || []).filter(function(item) {
      if (!item || seen[item]) return false
      seen[item] = true
      return true
    }).sort()
  }

  function optionKeys(opt) {
    if (!opt) return []
    if (Array.isArray(opt)) return opt
    if (typeof opt === 'function') return ['(function)']
    if (typeof opt === 'object') return Object.keys(opt)
    return []
  }

  function providedKeys(vm, opts) {
    var keys = []
    if (vm._provided) keys = keys.concat(Object.keys(vm._provided))
    keys = keys.concat(optionKeys(opts.provide))
    return uniq(keys)
  }

  function pluginProperties(vm) {
    var builtin = {
      $attrs: true,
      $children: true,
      $createElement: true,
      $data: true,
      $el: true,
      $isServer: true,
      $listeners: true,
      $options: true,
      $parent: true,
      $props: true,
      $refs: true,
      $root: true,
      $scopedSlots: true,
      $slots: true,
      $ssrContext: true,
      $vnode: true
    }
    var keys = []
    for (var k in vm) {
      if (k.charAt(0) !== '$') continue
      if (builtin[k]) continue
      if (/^\$(_|vnode|options|parent|root|children|refs|slots|scopedSlots|attrs|listeners|el)/.test(k)) continue
      keys.push(k)
    }
    return uniq(keys)
  }

  function mergeEntry(prev, next) {
    if (!prev) return next
    Object.keys(next).forEach(function(k) {
      if (Array.isArray(next[k])) {
        prev[k] = uniq((prev[k] || []).concat(next[k]))
      } else if (next[k] !== undefined && next[k] !== null && next[k] !== '') {
        prev[k] = next[k]
      }
    })
    return prev
  }

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

    var snapshot = {
      file: normFile,
      name: opts.name || opts.__name || '',
      props: optionKeys(opts.props),
      emits: optionKeys(opts.emits),
      inject: optionKeys(opts.inject),
      provide: providedKeys(vm, opts),
      data: optionKeys(vm.$data || (opts.data ? ['(function)'] : [])),
      computed: optionKeys(opts.computed),
      watch: optionKeys(opts.watch),
      methods: optionKeys(opts.methods),
      mixins: (opts.mixins || []).map(function(m) {
        return m.__file || m.name || '(anonymous)'
      }),
      refs: optionKeys(vm.$refs),
      slots: optionKeys(vm.$slots),
      scopedSlots: optionKeys(vm.$scopedSlots),
      attrs: optionKeys(vm.$attrs),
      listeners: optionKeys(vm.$listeners),
      pluginProperties: pluginProperties(vm),
      uids: [vm._uid]
    }
    registry.set(normFile, mergeEntry(registry.get(normFile), snapshot))
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
