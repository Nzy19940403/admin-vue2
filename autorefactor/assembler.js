'use strict'

const fs   = require('fs')
const path = require('path')

const VUE_SRC  = path.resolve(__dirname, '../src')
const VUE3_OUT = path.resolve(__dirname, '../../../vue-test/src')
const AST_DIR  = path.resolve(__dirname, 'ast')

function normPath(p) { return p.replace(/\\/g, '/') }

// src/views/xxx or src/layout/xxx or src/components/xxx -> vue manifest
function buildManifest(graph) {
  const seen = {}
  const manifest = []
  Object.keys(graph).forEach(function(absFile) {
    // 处理 webpack scope hoisting 产生的 "file.vue + N modules" key
    const cleanFile = absFile.replace(/ \+ \d+ modules$/, '')
    if (!cleanFile.endsWith('.vue')) return
    absFile = cleanFile
    const norm = normPath(absFile)
    const rel  = norm.replace(normPath(VUE_SRC) + '/', '')

    let out
    if (rel.startsWith('views/')) {
      out = rel
    } else if (rel.startsWith('layout/') || rel.startsWith('components/')) {
      const base = path.basename(rel, '.vue')
      const name = base === 'index' ? path.basename(path.dirname(rel)) : base
      out = 'components/admin/' + name + '.vue'
    } else {
      return
    }

    if (seen[out]) return
    seen[out] = true

    const key = out.replace(/[/\\]/g, '_').replace('.vue', '')
    manifest.push({ key, file: rel, out })
  })
  return manifest
}

// src/store/modules/xxx.js -> stores/useXxxStore.ts
function buildStoreManifest() {
  const storeDir = path.join(VUE_SRC, 'store/modules')
  if (!fs.existsSync(storeDir)) return []
  return fs.readdirSync(storeDir)
    .filter(function(f) { return f.endsWith('.js') })
    .map(function(f) {
      const name = f.replace('.js', '')
      // camelCase -> PascalCase, handle hyphens
      const pascal = name.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase() })
        .replace(/^./, function(c) { return c.toUpperCase() })
      const out = 'stores/use' + pascal + 'Store.ts'
      const key = 'store_' + name.replace(/-/g, '_')
      return { key, file: 'store/modules/' + f, out }
    })
}

function assemble() {
  const depGraphPath = path.join(AST_DIR, 'dep-graph.json')
  if (!fs.existsSync(depGraphPath)) {
    throw new Error(
      '[assembler] dep-graph.json does not exist!\n' +
      'Run: npm run dev in vue-element-admin, browse a few pages, then Ctrl-C.\n' +
      'Expected path: ' + depGraphPath
    )
  }
  const { graph } = JSON.parse(fs.readFileSync(depGraphPath, 'utf-8'))

  const MANIFEST = buildManifest(graph).concat(buildStoreManifest())
  console.log('[assembler] found', MANIFEST.length, 'components+stores')

  const absToKey = {}
  MANIFEST.forEach(function(m) {
    absToKey[normPath(path.join(VUE_SRC, m.file))] = m.key
  })

  var runtimeByFile = {}
  const runtimePath = path.join(AST_DIR, 'runtime-dump.json')
  if (fs.existsSync(runtimePath)) {
    const dump = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'))
    dump.forEach(function(entry) {
      runtimeByFile[normPath(entry.file)] = {
        props:  entry.props  || [],
        emits:  entry.emits  || [],
        inject: entry.inject || [],
      }
    })
  }

  return MANIFEST.map(function(m) {
    const absFile     = path.join(VUE_SRC, m.file)
    const normAbsFile = normPath(absFile)

    // 合并所有以该文件路径开头的 key（处理 webpack scope hoisting 产生的 "file + N modules" 后缀）
    const allDeps = new Set()
    Object.keys(graph).forEach(function(k) {
      const normK = normPath(k)
      if (normK === normAbsFile || normK.startsWith(normAbsFile + ' +')) {
        ;(graph[k] || []).forEach(function(d) { allDeps.add(d) })
      }
    })
    const rawDeps = Array.from(allDeps)
    const deps = rawDeps
      .map(function(d) { return absToKey[normPath(d)] })
      .filter(function(k) { return k && k !== m.key })

    var source = ''
    try { source = fs.readFileSync(absFile, 'utf-8') }
    catch (e) { console.warn('[assembler] read failed:', absFile); source = '// read failed' }

    const auxFiles = []

    // store 转写时附带 getters.js，让 LLM 用 getter 名而不是 state 名
    if (m.key.startsWith('store_')) {
      const gettersPath = path.join(VUE_SRC, 'store/getters.js')
      if (fs.existsSync(gettersPath)) {
        auxFiles.push({
          file: 'src/store/getters.js',
          content: fs.readFileSync(gettersPath, 'utf-8')
        })
      }
    }

    rawDeps.forEach(function(depAbs) {
      const normDep = normPath(depAbs)
      if (absToKey[normDep]) return
      if (!normDep.includes('/src/')) return
      try {
        const content = fs.readFileSync(depAbs, 'utf-8')
        auxFiles.push({ file: normDep.replace(normPath(VUE_SRC) + '/', 'src/'), content })
      } catch (e) { /* skip */ }
    })

    const runtime = runtimeByFile[normAbsFile] || null
    console.log('[assembler]', m.key,
      '  deps:', deps.length ? deps : '(leaf)',
      auxFiles.length ? '  aux:' + auxFiles.map(function(f) { return f.file }) : '')

    return {
      key:         m.key,
      file:        absFile,
      source:      source,
      deps:        deps,
      auxFiles:    auxFiles,
      runtime:     runtime,
      outFile:     path.join(VUE3_OUT, m.out),
      outRelative: m.out,
    }
  })
}

module.exports = { assemble, VUE3_OUT, VUE_SRC }
