'use strict'

const fs   = require('fs')
const path = require('path')

const VUE_SRC  = path.resolve(__dirname, '../src')
const VUE3_OUT = process.env.REFACTOR_VUE3_OUT ||
  path.resolve(__dirname, '../../admin-vue3/src')
const AST_DIR  = path.resolve(__dirname, 'ast')
const PACKAGE_MAP_PATH = path.resolve(__dirname, 'package-map.json')

/**
 * package-map.json is the single source of truth for local replacements.
 * Keep loading and validation here so assembler, workflow and prompts do not
 * each implement a slightly different interpretation of the map.
 */
function loadPackageMap() {
  if (!fs.existsSync(PACKAGE_MAP_PATH)) {
    return { version: 1, mappings: [] }
  }

  var raw = JSON.parse(fs.readFileSync(PACKAGE_MAP_PATH, 'utf-8'))
  var mappings = Array.isArray(raw.mappings) ? raw.mappings : []
  var seen = {}
  var validMappings = []

  mappings.forEach(function(mapping) {
    if (!mapping || !mapping.sourcePackage || !mapping.targetFile) {
      console.warn('[package-map] ignored mapping without sourcePackage/targetFile')
      return
    }
    if (seen[mapping.sourcePackage]) {
      throw new Error('[package-map] duplicate sourcePackage: ' + mapping.sourcePackage)
    }
    seen[mapping.sourcePackage] = true
    validMappings.push(mapping)
  })

  return Object.assign({}, raw, {
    version: raw.version || 1,
    mappings: validMappings,
  })
}

function normPath(p) { return p.replace(/\\/g, '/') }

function runtimeFileKey(file) {
  const norm = normPath(file || '')
  if (!norm) return ''
  if (norm.startsWith('src/')) {
    return normPath(path.join(VUE_SRC, norm.replace(/^src\//, '')))
  }
  return norm
}

function uniq(arr) {
  const seen = {}
  return (arr || []).filter(function(item) {
    if (!item || seen[item]) return false
    seen[item] = true
    return true
  }).sort()
}

function mergeRuntime(prev, entry) {
  const next = {
    names:       entry.name ? [entry.name] : [],
    props:       entry.props || [],
    emits:       entry.emits || [],
    inject:      entry.inject || [],
    provide:     entry.provide || [],
    data:        entry.data || [],
    computed:    entry.computed || [],
    watch:       entry.watch || [],
    methods:     entry.methods || [],
    mixins:      entry.mixins || [],
    refs:        entry.refs || [],
    slots:       entry.slots || [],
    scopedSlots: entry.scopedSlots || [],
    attrs:       entry.attrs || [],
    listeners:   entry.listeners || [],
    pluginProperties: entry.pluginProperties || [],
  }

  if (!prev) return next
  Object.keys(next).forEach(function(k) {
    prev[k] = uniq((prev[k] || []).concat(next[k] || []))
  })
  return prev
}

function sourceRelFromAbs(absFile) {
  const norm = normPath(absFile)
  const srcRoot = normPath(VUE_SRC) + '/'
  return norm.startsWith(srcRoot) ? norm.replace(srcRoot, 'src/') : norm
}

function targetRelForSourceRel(sourceRel) {
  const rel = sourceRel.replace(/^src\//, '')
  // 直接使用 webpack 解析出的源路径，不做变换（不添加 admin/ 等前缀）
  if (rel.startsWith('views/') || rel.startsWith('layout/') || rel.startsWith('components/')) {
    return rel
  }
  if (rel.startsWith('store/modules/') && rel.endsWith('.js')) {
    const name = path.basename(rel, '.js')
    const pascal = name.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase() })
      .replace(/^./, function(c) { return c.toUpperCase() })
    return 'stores/use' + pascal + 'Store.ts'
  }
  return null
}

function localAuxTargetRel(importerOutRel, sourceRel, sourceImport) {
  if (!importerOutRel || !sourceImport) return null
  if (!sourceImport.startsWith('./') && !sourceImport.startsWith('../')) return null
  if (!/\.(js|ts|scss|css)$/.test(sourceRel)) return null
  return normPath(path.join(path.dirname(importerOutRel), path.basename(sourceRel)))
}

function targetImportFor(currentOutRel, targetRel, sourceImport) {
  if (!currentOutRel || !targetRel) return null
  if (sourceImport && (sourceImport.startsWith('./') || sourceImport.startsWith('../'))) {
    var rel = normPath(path.relative(path.dirname(currentOutRel), targetRel))
    if (!rel.startsWith('./') && !rel.startsWith('../')) rel = './' + rel
    return rel
  }
  return '@/' + targetRel
}

function extractImportSpecifiers(source) {
  const specs = []
  const seen = {}
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  patterns.forEach(function(re) {
    var match
    while ((match = re.exec(source))) {
      const spec = match[1]
      if (!spec || seen[spec]) continue
      seen[spec] = true
      specs.push(spec)
    }
  })
  return specs
}

function packageNameFromSpecifier(spec) {
  if (!spec || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/')) return ''
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

function resolveImportFile(currentAbsFile, spec) {
  if (!spec) return null
  var base
  if (spec.startsWith('@/')) {
    base = path.join(VUE_SRC, spec.slice(2))
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.resolve(path.dirname(currentAbsFile), spec)
  } else {
    return null
  }

  const candidates = [
    base,
    base + '.vue',
    base + '.js',
    base + '.ts',
    base + '.scss',
    base + '.css',
    path.join(base, 'index.vue'),
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.scss'),
    path.join(base, 'index.css'),
  ]

  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isFile()) {
      return candidates[i]
    }
  }
  return null
}

function buildResolvedImports(currentAbsFile, currentOutRel, rawDeps, source, graphImports) {
  const currentDir = path.dirname(currentAbsFile)
  const currentNorm = normPath(currentAbsFile)
  const graphImportList = graphImports || []
  const imports = rawDeps
    .filter(function(depAbs) {
      return /\.(vue|js|ts|scss|css)$/.test(depAbs) && normPath(depAbs) !== currentNorm
    })
    .map(function(depAbs) {
      const sourceRel = sourceRelFromAbs(depAbs)
      const targetRel = targetRelForSourceRel(sourceRel)
      var sourceImport = './' + normPath(path.relative(currentDir, depAbs))
      if (!sourceImport.startsWith('./') && !sourceImport.startsWith('../')) sourceImport = './' + sourceImport
      return {
        source: sourceRel,
        sourceImport: sourceImport,
        target: targetRel,
        targetImport: targetImportFor(currentOutRel, targetRel, sourceImport),
      }
    })

  graphImportList.forEach(function(item) {
    if (!item || !item.resolved) return
    const sourceRel = item.resolved
    const targetRel = targetRelForSourceRel(sourceRel) ||
      localAuxTargetRel(currentOutRel, sourceRel, item.specifier)
    imports.push({
      source: sourceRel,
      sourceImport: item.specifier || null,
      target: targetRel,
      targetImport: targetImportFor(currentOutRel, targetRel, item.specifier),
    })
  })

  extractImportSpecifiers(source || '').forEach(function(spec) {
    const depAbs = resolveImportFile(currentAbsFile, spec)
    if (!depAbs) return
    if (normPath(depAbs) === currentNorm) return
    const sourceRel = sourceRelFromAbs(depAbs)
    const alreadyResolved = imports.some(function(item) {
      return item.source === sourceRel && item.sourceImport === spec
    })
    if (alreadyResolved) return
    const targetRel = targetRelForSourceRel(sourceRel)
    imports.push({
      source: sourceRel,
      sourceImport: spec,
      target: targetRel,
      targetImport: targetImportFor(currentOutRel, targetRel, spec),
    })
  })

  const seen = {}
  return imports.filter(function(item) {
    const key = item.source + '|' + item.sourceImport
    if (seen[key]) return false
    seen[key] = true
    return true
  })
}

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
    // 直接使用 webpack 解析出的源路径作为输出路径，不做变换
    if (rel.startsWith('views/') || rel.startsWith('layout/') || rel.startsWith('components/')) {
      out = rel
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
  const depData = JSON.parse(fs.readFileSync(depGraphPath, 'utf-8'))
  const graph = depData.graph || {}
  const fileMeta = depData.files || {}

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
      const file = runtimeFileKey(entry.file)
      runtimeByFile[file] = mergeRuntime(runtimeByFile[file], entry)
    })
  }

  var contexts = MANIFEST.map(function(m) {
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

    function addAuxFile(sourceRel, targetRel) {
      if (!sourceRel) return
      if (auxFiles.some(function(f) { return f.file === sourceRel && f.target === targetRel })) return
      const abs = path.join(VUE_SRC, sourceRel.replace(/^src\//, ''))
      try {
        const content = fs.readFileSync(abs, 'utf-8')
        auxFiles.push({ file: sourceRel, target: targetRel || null, content: content })
      } catch (e) { /* skip */ }
    }

    rawDeps.forEach(function(depAbs) {
      const normDep = normPath(depAbs)
      if (absToKey[normDep]) return
      if (!normDep.includes('/src/')) return
      addAuxFile(normDep.replace(normPath(VUE_SRC) + '/', 'src/'), null)
    })

    const graphImports = fileMeta[absFile] && fileMeta[absFile].imports
    const resolvedImports = buildResolvedImports(absFile, m.out, rawDeps, source, graphImports)
    resolvedImports.forEach(function(item) {
      const depKey = absToKey[normPath(path.join(VUE_SRC, item.source.replace(/^src\//, '')))]
      if (depKey && depKey !== m.key && !deps.includes(depKey)) deps.push(depKey)
      if (!depKey) {
        addAuxFile(item.source, item.target)
      }
    })

    // 递归解析 auxFile 自身的相对 import，补齐间接依赖（如 default-options.js）
    var auxQueue = auxFiles.slice()
    while (auxQueue.length) {
      var af = auxQueue.shift()
      if (!af.content || af._scanned) continue
      af._scanned = true
      var afSpecs = extractImportSpecifiers(af.content)
      for (var s = 0; s < afSpecs.length; s++) {
        var spec = afSpecs[s]
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue
        var afAbs = path.join(VUE_SRC, af.file.replace(/^src\//, ''))
        var depAbs = resolveImportFile(afAbs, spec)
        if (!depAbs) continue
        var sourceRel = sourceRelFromAbs(depAbs)
        var targetRel = af.target
          ? localAuxTargetRel(af.target, sourceRel, spec)
          : null
        if (auxFiles.some(function(f) { return f.file === sourceRel })) continue
        var content
        try { content = fs.readFileSync(depAbs, 'utf-8') } catch (e) { continue }
        auxFiles.push({ file: sourceRel, target: targetRel, content: content, _scanned: false })
        auxQueue.push(auxFiles[auxFiles.length - 1])
      }
    }
    // 清理 _scanned 标记
    auxFiles.forEach(function(f) { delete f._scanned })

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
      resolvedImports: resolvedImports,
      runtime:     runtime,
      outFile:     path.join(VUE3_OUT, m.out),
      outRelative: m.out,
    }
  })

  // ── npm→本地替代任务 ────────────────────────────────────────────────
  // 扫描每个 context 的 source，发现 npm import 匹配 package-map.json →
  // 创建本地替代 context 并添加到依赖关系中
  var pkgMap = loadPackageMap()
  var mapByPackage = {}
  pkgMap.mappings.forEach(function(mapping) {
    mapByPackage[mapping.sourcePackage] = mapping
  })
  var replacementByTarget = {}

  contexts.forEach(function(ctx) {
    if (!ctx.source) return
    var specs = extractImportSpecifiers(ctx.source)
    specs.forEach(function(spec) {
      // 只处理 npm 包名（无 ./ ../ @/ 前缀）
      var mapping = mapByPackage[packageNameFromSpecifier(spec)]
      if (!mapping) return
      // 已有真实条目在 deps 中了 → 跳过
      if (ctx.deps.some(function(d) {
        return d === mapping.targetFile.replace(/[/\\]/g, '_').replace('.vue', '')
      })) return

      var replacementKey = mapping.targetFile.replace(/[/\\]/g, '_').replace('.vue', '')
      if (!replacementByTarget[mapping.targetFile]) {
        replacementByTarget[mapping.targetFile] = {
          key: replacementKey,
          file: path.join(VUE_SRC, mapping.targetFile),
          source: [
            '创建一个 Vue 3 <script setup lang="ts"> 组件替换 npm 包 ' + mapping.sourcePackage + '：',
            'Props: ' + (mapping.props || ['none']).join(', '),
            mapping.note || '',
            '输出路径: src/' + mapping.targetFile,
          ].join('\n'),
          deps: [],
          auxFiles: [],
          resolvedImports: [],
          runtime: null,
          outFile: path.join(VUE3_OUT, mapping.targetFile),
          outRelative: mapping.targetFile,
          _localReplacement: true,
        }
        console.log('[assembler] local replacement task: ' + replacementKey + ' → src/' + mapping.targetFile)
      }
      // 把本地替代任务加入当前 context 的依赖
      if (!ctx.deps.includes(replacementKey)) {
        ctx.deps.push(replacementKey)
      }
    })
  })

  // 追加本地替代任务到 context 列表
  Object.keys(replacementByTarget).forEach(function(target) {
    contexts.push(replacementByTarget[target])
  })

  return contexts
}

module.exports = {
  assemble,
  VUE3_OUT,
  VUE_SRC,
  loadPackageMap,
  PACKAGE_MAP_PATH,
}
