'use strict'
if (typeof performance === 'undefined') {
  const { performance: p } = require('perf_hooks')
  global.performance = p
}
const fs   = require('fs')
const path = require('path')
const { execSync, execFileSync } = require('child_process')
const { useMeshFlow }        = require('@meshflow/core')
const {
  assemble,
  VUE3_OUT,
  VUE_SRC,
  loadPackageMap,
} = require('../assembler')
const { callDeepSeek }       = require('./deepseek')
const { buildSystemPrompt }  = require('../prompts')
// VS Code PowerShell terminal 有时不被 chalk 识别为 TTY，强制开启颜色
delete process.env.NO_COLOR
process.env.FORCE_COLOR = '1'
const chalk                  = require('chalk')
chalk.enabled = true
chalk.level = 3

const rawConsoleLog = console.log.bind(console)
const rawConsoleWarn = console.warn.bind(console)
const rawConsoleError = console.error.bind(console)

function colorizePrefix(line) {
  if (typeof line !== 'string') return line
  // 只匹配行首（含可选前导空白/换行）的第一个 [xxx] 前缀块
  return line.replace(/^(\s*)(\[[^\]]+\])/, function(_m, space, prefix) {
    var lower = prefix.toLowerCase()
    var colored
    if (/error|fatal|fail|✗|audit/.test(lower))    colored = chalk.red.bold(prefix)
    else if (/warn|skip|retry|truncat|cached|already exists/.test(lower)) colored = chalk.yellow(prefix)
    else if (/tsc✓|done|ok|fulfill|success/.test(lower)) colored = chalk.green(prefix)
    else if (/llm|deepseek/.test(lower))            colored = chalk.magenta(prefix)
    else if (/deps|infra|package|install/.test(lower)) colored = chalk.cyan(prefix)
    else if (/css-transform/.test(lower))           colored = chalk.blue(prefix)
    else if (/vue.*only|missing|manual/.test(lower)) colored = chalk.hex('#FF6B35').bold(prefix)
    else                                             colored = chalk.blue(prefix)
    return space + colored
  })
}

console.log = function() {
  rawConsoleLog.apply(console, Array.prototype.map.call(arguments, function(arg) {
    return colorizePrefix(arg)
  }))
}
console.warn = function() {
  rawConsoleWarn.apply(console, Array.prototype.map.call(arguments, function(arg) {
    if (typeof arg !== 'string') return arg
    return arg.replace(/^(\[[^\]]+\])/, function(p) { return chalk.yellow(p) })
  }))
}
console.error = function() {
  rawConsoleError.apply(console, Array.prototype.map.call(arguments, function(arg) {
    if (typeof arg !== 'string') return arg
    return arg.replace(/^(\[[^\]]+\])/, function(p) { return chalk.red.bold(p) })
  }))
}

const ROOT_DIR = VUE3_OUT.replace(/[\\/]src$/, '')
const CSS_CLASS_MAP_PATH = path.resolve(__dirname, '../css-class-map.json')
// 记录本次运行实际写入的输出文件，CSS 后处理只处理这些文件
var touchedOutputFiles = new Set()
// 样式同步 hash 清单，避免覆盖目标的手动修改
const STYLE_SYNC_MANIFEST = path.join(ROOT_DIR, '.style-sync-hash.json')

// --focus=layout,dashboard,login  only process keys containing these words
const focusArg = process.argv.find(function(a) { return a.startsWith('--focus=') })
const FOCUS_FILTER = focusArg
  ? focusArg.replace('--focus=', '').split(',').map(function(s) { return s.trim() }).filter(Boolean)
  : null

async function fetchElementPlusBreakingChanges() {
  try {
    console.log('[workflow] fetching Element Plus Breaking Changes...')
    const https = require('https')
    const html = await new Promise(function(resolve, reject) {
      https.get(
        'https://raw.githubusercontent.com/element-plus/element-plus/dev/docs/en-US/guide/migration.md',
        { headers: { 'User-Agent': 'node' } },
        function(res) {
          var data = ''
          res.on('data', function(c) { data += c })
          res.on('end', function() { resolve(data) })
        }
      ).on('error', reject)
    })
    console.log('[workflow] Breaking Changes fetched (' + html.length + ' bytes)')
    return '\n[Element Plus Migration Docs]\n' + html
  } catch (e) {
    console.warn('[workflow] fetch failed:', e.message)
    return ''
  }
}

var SYSTEM_PROMPT = ''

function buildPrompt(ctx, depCodeMap, tscErrors) {
  tscErrors = tscErrors || ''
  var isStore = ctx.key.startsWith('store_')

  var headerLines = ['【输出文件路径】src/' + ctx.outRelative, '【import 路径约定】']
  if (!isStore) {
    headerLines.push('  组件路径必须使用 [Webpack resolved dependency paths] 中的 targetImport；不要按组件名扁平化猜测')
  }
  headerLines.push('  store: @/stores/useAppStore  |  @/stores/useUserStore  |  @/stores/usePermissionStore  |  @/stores/useTagsViewStore  |  @/stores/useErrorLogStore')
  headerLines.push('  router: useRoute/useRouter from "vue-router"')
  headerLines.push('  Element Plus: from "element-plus"')
  headerLines.push('  图标: from "@element-plus/icons-vue"')

  if (isStore) {
    headerLines.push('【输出要求】Vuex module → Pinia store 转换，输出纯 TypeScript 文件（无 <template>）')
    headerLines.push('  - defineStore 用 setup 风格：defineStore("name", () => { ... })')
    headerLines.push('  - state 字段改为 ref() / reactive()')
    headerLines.push('  - mutations 合并进 actions，actions 改为普通 async function')
    headerLines.push('  - export const useXxxStore = defineStore(...)')
    headerLines.push('  - ⚠️ 暴露字段名必须用 getters.js 里的 getter 名（附在 auxFiles 里），不要用 state 里的原始名')
    headerLines.push('    例: getters.js 有 errorLogs: state => state.errorLog.logs → Pinia store 暴露 errorLogs 而不是 logs')
  }

  var header = headerLines.join('\n')
  var errorNote = tscErrors ? '【vue-tsc 报错（必须全部修复）】\n' + tscErrors : ''

  var deps = Array.from(depCodeMap.entries())
    .map(function(e) {
      return '// === 已升级的依赖: ' + e[0] + ' ===\n' + e[1].slice(0, 1000) + '...'
    })
    .join('\n\n')

  var src = '// === 待升级: ' + path.basename(ctx.file) + ' ===\n' + ctx.source

  // 检查源文件中的 npm import 是否有缓存的版本文档 → 提醒 LLM 去 System Prompt 查阅
  var pkgNote = ''
  var pkgDocDir = path.resolve(__dirname, '../ast/pkg-docs')
  var importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"])([^'"@.][^'"]*)['"]/g
  var matchSrc
  while ((matchSrc = importRe.exec(ctx.source))) {
    var pkgName = matchSrc[1]
    if (pkgName.startsWith('@')) pkgName = pkgName.split('/').slice(0, 2).join('/')
    else pkgName = pkgName.split('/')[0]
    if (fs.existsSync(path.join(pkgDocDir, pkgName + '.md'))) {
      pkgNote += '\n⚠️ 源文件使用了 "' + pkgName + '"，目标项目已安装新版（API 有重大变化）。详见 System Prompt 末尾的 [' + pkgName + '.md] 文档，必须按文档编写代码，禁止照抄源码 API！'
    }
  }

  var resolvedImportNote = ''
  if (ctx.resolvedImports && ctx.resolvedImports.length) {
    resolvedImportNote = [
      '[Webpack resolved dependency paths - authoritative]',
      'These paths are deterministic build outputs. Prefer targetImport exactly when present.',
      'Do not keep sourceImport only because it compiled in Vue 2; use targetOut/targetImport for Vue 3.',
      'Do not invent flattened file names or omit resolved extensions/index files.',
    ].concat(ctx.resolvedImports.map(function(dep) {
      return '  - source: ' + dep.source +
        (dep.sourceImport ? ' | sourceImport: ' + dep.sourceImport : '') +
        (dep.target ? ' | targetOut: src/' + dep.target : '') +
        (dep.targetImport ? ' | targetImport: ' + dep.targetImport : '')
    })).join('\n')
  }

  var aux = (ctx.auxFiles || []).map(function(f) {
    return '// === 原项目辅助文件（只理解，不转写）: ' + f.file + ' ===\n' + f.content
  }).join('\n\n')

  var runtimeNote = ''
  if (ctx.runtime) {
    var r = ctx.runtime
    var lines = ['【运行时数据（浏览器实际执行时收集，比静态分析更准确）】']
    if (r.props   && r.props.length)    lines.push('  props:    ' + r.props.join(', '))
    if (r.emits   && r.emits.length)    lines.push('  emits:    ' + r.emits.join(', '))
    if (r.inject  && r.inject.length)   lines.push('  inject:   ' + r.inject.join(', '))
    if (r.provide && r.provide.length)  lines.push('  provide:  ' + r.provide.join(', '))
    if (r.data    && r.data.length)     lines.push('  data:     ' + r.data.join(', '))
    if (r.computed && r.computed.length) lines.push('  computed: ' + r.computed.join(', '))
    if (r.watch   && r.watch.length)    lines.push('  watch:    ' + r.watch.join(', '))
    if (r.methods && r.methods.length)  lines.push('  methods:  ' + r.methods.join(', '))
    if (r.mixins  && r.mixins.length)   lines.push('  mixins:   ' + r.mixins.join(', '))
    if (r.refs    && r.refs.length)     lines.push('  refs:     ' + r.refs.join(', '))
    if (r.slots   && r.slots.length)    lines.push('  slots:    ' + r.slots.join(', '))
    if (r.scopedSlots && r.scopedSlots.length) lines.push('  scopedSlots: ' + r.scopedSlots.join(', '))
    if (r.attrs   && r.attrs.length)    lines.push('  attrs:    ' + r.attrs.join(', '))
    if (r.listeners && r.listeners.length) lines.push('  listeners:' + r.listeners.join(', '))
    if (r.pluginProperties && r.pluginProperties.length) lines.push('  pluginProperties: ' + r.pluginProperties.join(', '))
    lines.push('  Runtime profile is auxiliary; static dependency/source analysis remains primary.')
    lines.push('  → defineProps/defineEmits/inject 字段名以此为准；methods/computed 确保全部保留，不要遗漏')
    runtimeNote = lines.join('\n')
  }

  return [header, errorNote, pkgNote, runtimeNote, resolvedImportNote, deps, aux, src].filter(Boolean).join('\n\n')
}

function stripFence(s) {
  return s.replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim()
}

// 检测输出是否被截断
// Vue SFC (.vue) 最后一行必须是 </style>/<template>/<script>
// TypeScript 文件 (.ts) 最后一行必须是 } 或 })
function isTruncated(code, fileType) {
  if (!code || code.length < 50) return true
  var lastLine = code.trimEnd().split('\n').pop().trim()
  if (fileType === 'ts') {
    // TS 文件：以 } 或 }) 结尾即视为完整
    return !/^(\}|\}\)|}\)|export\s)/.test(lastLine)
  }
  // Vue SFC：最后一行必须是关闭标签
  return !/^<\/(style|template|script)>$/.test(lastLine)
}

// 让模型从截断处续写，把前后两段拼接成完整文件
async function continueTruncated(partialCode, fileType) {
  var isTs = fileType === 'ts'
  var continuePrompt = [
    isTs
      ? '下面是一个被截断的 TypeScript 文件，请从截断处继续补全，'
      : '下面是一个被截断的 Vue 3 <script setup> 文件，请从截断处继续补全，',
    '直接输出缺失的剩余部分（不要重复已有内容，不要加 markdown fence），',
    isTs
      ? '最后一行必须是 } 或 })。'
      : '最后一行必须是 </style>、</template> 或 </script> 之一。',
    '',
    '已输出部分（末尾被截断）：',
    '```',
    partialCode.slice(-2000),   // 只送末尾 2000 字符作上下文
    '```',
  ].join('\n')
  var suffix = await callDeepSeek(SYSTEM_PROMPT, continuePrompt)
  suffix = stripFence(suffix)
  // 拼接：去掉 suffix 开头可能重复的 partialCode 末尾内容
  return partialCode + '\n' + suffix
}

async function callWithTruncationRetry(systemPrompt, userPrompt, maxRetries, fileType) {
  maxRetries = maxRetries || 3
  fileType = fileType || 'vue'
  var code = stripFence(await callDeepSeek(systemPrompt, userPrompt))
  for (var i = 0; i < maxRetries && isTruncated(code, fileType); i++) {
    console.warn('[truncated] 检测到截断，第 ' + (i + 1) + ' 次续写...')
    code = await continueTruncated(code, fileType)
  }
  if (isTruncated(code, fileType)) {
    console.error('[truncated] 续写 ' + maxRetries + ' 次仍不完整，强制写入现有内容')
  }
  return code
}

function writeOutput(ctx, code) {
  fs.mkdirSync(path.dirname(ctx.outFile), { recursive: true })
  fs.writeFileSync(ctx.outFile, code, 'utf-8')
  touchedOutputFiles.add(ctx.outFile)
  return ctx.outFile
}

function commandName(name) {
  return process.platform === 'win32' ? name + '.cmd' : name
}

function commandOutput(e) {
  return ((e && e.stdout) ? e.stdout.toString() : '') + ((e && e.stderr) ? e.stderr.toString() : '')
}

function extractMissingPackageNames(text) {
  var missing = new Set()
  var patterns = [
    /Cannot find module ['"]([^'"]+)['"]/g,
    /Cannot find type definition file for ['"]([^'"]+)['"]/g,
    /找不到模块[“"']([^”"']+)[”"']/g,
    /找不到类型定义文件[“"']([^”"']+)[”"']/g,
  ]

  patterns.forEach(function(re) {
    var match
    while ((match = re.exec(text || ''))) {
      var pkg = packageNameFromImport(match[1])
      if (pkg) missing.add(pkg)
    }
  })

  return Array.from(missing)
}

function hasMissingPackageError(text) {
  return extractMissingPackageNames(text).length > 0
}

function runTsc(filePath) {
  var rel = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/')
  var appConfig = {}
  try {
    appConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.app.json'), 'utf-8'))
  } catch (e) {}

  var compilerOptions = Object.assign({}, appConfig.compilerOptions || {})
  delete compilerOptions.composite
  delete compilerOptions.tsBuildInfoFile
  delete compilerOptions.ignoreDeprecations
  compilerOptions.types = []
  compilerOptions.noEmit = true
  compilerOptions.skipLibCheck = true

  var files = [rel]
  if (fs.existsSync(path.join(ROOT_DIR, 'env.d.ts'))) files.unshift('env.d.ts')

  var tmpConfig = path.join(ROOT_DIR, '.refactor-tsconfig.current.json')
  var config = {
    extends: appConfig.extends || './tsconfig.json',
    files: files,
    compilerOptions: compilerOptions,
  }

  try {
    fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2), 'utf-8')
    execFileSync(commandName('npx'), [
      'vue-tsc',
      '-p',
      tmpConfig,
      '--noEmit',
      '--skipLibCheck',
      '--pretty',
      'false',
    ], { cwd: ROOT_DIR, stdio: 'pipe' })
    return ''
  } catch (e) {
    var out = commandOutput(e)
    return out.split(/\r?\n/)
      .filter(function(l) { return !l.includes('.refactor-tsconfig.current.json') })
      .join('\n').trim()
  } finally {
    try { fs.unlinkSync(tmpConfig) } catch (e) {}
  }
}

// ── 包 API 文档自动注入 ──────────────────────────────────────────────────
// 本轮运行中首次遇到 npm 包时拉 README 注入 SYSTEM_PROMPT，返回 depNote 触发 retry
var injectedPackages = new Set()

async function checkPackageApiMigrations(filePath) {
  if (!fs.existsSync(filePath)) return ''
  var source = fs.readFileSync(filePath, 'utf-8')
  var npmImports = new Set()
  var re = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"])([^'"@.][^'"]*)['"]/g
  var match
  while ((match = re.exec(source))) {
    var spec = match[1]
    var pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (pkg) npmImports.add(pkg)
  }
  if (!npmImports.size) return ''
  console.log('[deps-check]   scanning ' + path.relative(ROOT_DIR, filePath) + ': found npm imports [' + Array.from(npmImports).join(', ') + ']')

  var vue3NodeModules = path.join(ROOT_DIR, 'node_modules')
  var packageMap = loadPackageMap()
  var mappedPackages = new Set((packageMap.mappings || []).map(function(mapping) {
    return mapping.sourcePackage
  }))
  var notes = []
  for (var pi = 0; pi < Array.from(npmImports).length; pi++) { var pkg = Array.from(npmImports)[pi]
    // package-map 中的包由本地替代任务处理，不再走 npm API 文档分支
    if (mappedPackages.has(pkg)) { console.log('[deps-check]     ' + pkg + ' mapped in package-map.json, skip'); continue }
    // 已有缓存文档 → 跳过
    var pkgDocCache = path.resolve(__dirname, '../ast/pkg-docs/' + pkg + '.md')
    if (fs.existsSync(pkgDocCache)) { console.log('[deps-check]     ' + pkg + ' cached doc exists, skip'); continue }
    // 本轮已注入过 → 跳过
    if (injectedPackages.has(pkg)) { console.log('[deps-check]     ' + pkg + ' already injected, skip'); continue }
    // 没安装 → 跳过
    var pkgJsonPath = path.join(vue3NodeModules, pkg, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) { console.log('[deps-check]     ' + pkg + ' NOT INSTALLED at ' + pkgJsonPath); continue }
    // 新包，查 npm + 升级 + 拉文档
    injectedPackages.add(pkg)
    var vue3Ver = ''
    try {
      var distTags = JSON.parse(execSync('npm view ' + pkg + ' dist-tags --json', { cwd: ROOT_DIR, stdio: 'pipe', timeout: 10000 }).toString())
      for (var key in distTags) {
        try {
          var tagPeers = JSON.parse(execSync('npm view ' + pkg + '@' + distTags[key] + ' peerDependencies --json', { cwd: ROOT_DIR, stdio: 'pipe', timeout: 10000 }).toString())
          if (tagPeers.vue && /^[\^~]?(3|4)/.test(String(tagPeers.vue))) { vue3Ver = distTags[key]; break }
        } catch (e) {}
      }
    } catch (e) {}
    if (vue3Ver) {
      try {
        var localPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
        if (localPkg.version !== vue3Ver) {
          console.log('[deps-check]     upgrading ' + pkg + ' ' + localPkg.version + ' → ' + vue3Ver + ' (Vue3)')
          execSync('npm install ' + pkg + '@' + vue3Ver, { cwd: ROOT_DIR, stdio: 'pipe' })
          console.log('  ' + chalk.green('✓ ' + pkg + ' → ' + vue3Ver))
        }
      } catch (e) {}
    }
    try {
      var ver = vue3Ver || ''
      // 按优先级拉取 API 文档：release notes → CHANGELOG → README
      var doc = ''
      var docSource = ''
      var https = require('https')
      async function httpGet(url, followCount) {
        followCount = followCount || 0
        if (followCount > 3) return ''
        return new Promise(function(resolve) {
          var req = https.get(url, { headers: { 'User-Agent': 'node' } }, function(res) {
            if (res.statusCode === 301 || res.statusCode === 302) {
              var loc = res.headers.location
              res.resume()
              if (!loc) { resolve(''); return }
              if (loc.startsWith('/')) {
                var u = new URL(url)
                loc = u.protocol + '//' + u.host + loc
              }
              httpGet(loc, followCount + 1).then(resolve)
              return
            }
            if (res.statusCode !== 200) { resolve(''); return }
            var data = ''
            res.on('data', function(c) { data += c })
            res.on('end', function() { resolve(data) })
          })
          req.on('error', function() { resolve('') })
          req.setTimeout(10000, function() { req.destroy(); resolve('') })
        })
      }
      // 1. 先查 homepage，如果是 GitHub URL，抓 release notes
      var homepage = ''
      try { homepage = execSync('npm view ' + pkg + ' homepage', { cwd: ROOT_DIR, stdio: 'pipe', timeout: 10000 }).toString().trim() } catch (e) {}
      if (homepage && /github\.com/.test(homepage)) {
        var repoMatch = homepage.match(/github\.com\/([^/]+\/[^/]+)/)
        if (repoMatch && vue3Ver) {
          // 尝试多种 tag 格式：v4.1.0 / 4.1.0 / v4.1.0-next.1
          var tagFormats = ['v' + vue3Ver, vue3Ver, 'v' + vue3Ver + '-next.0', 'v' + vue3Ver + '-next.1']
          for (var tf = 0; tf < tagFormats.length && !doc; tf++) {
            var releaseUrl = 'https://api.github.com/repos/' + repoMatch[1] + '/releases/tags/' + tagFormats[tf]
            var raw = await httpGet(releaseUrl)
            if (raw) {
              try {
                var release = JSON.parse(raw)
                if (release.body) {
                  doc = release.body.slice(0, 4000)
                  docSource = 'GitHub release ' + tagFormats[tf]
                }
              } catch (e) {}
            }
          }
        }
      }
      // 2. 没拿到 → 拉 CHANGELOG.md
      if (!doc) {
        doc = await httpGet('https://unpkg.com/' + pkg + '@' + (vue3Ver || 'latest') + '/CHANGELOG.md')
        if (doc) docSource = 'CHANGELOG.md'
      }
      // 3. 还没有 → 拉 README.md
      if (!doc) {
        doc = await httpGet('https://unpkg.com/' + pkg + '@' + (vue3Ver || 'latest') + '/README.md')
        if (doc) docSource = 'README.md'
      }
      console.log('[deps-check]     ' + pkg + ' doc len=' + doc.length + (docSource ? ' from ' + docSource : '') + (vue3Ver ? ' v' + vue3Ver : ''))
      if (doc && doc.length > 100) {
        var summary = doc.slice(0, 4000).replace(/```[\s\S]*?```/g, '[code]')
        SYSTEM_PROMPT += '\n\n[Auto-fetched: ' + pkg + ' ' + docSource + ' v' + (vue3Ver || '') + ']\n' + summary
        notes.push(pkg + ' v' + (vue3Ver || '') + ' (' + docSource + ' injected)')
        console.log('  ' + chalk.cyan('✓ ' + pkg + ' ' + docSource + ' → system prompt (' + doc.length + ' bytes)'))
        // 持久化文档 + 规则：下次运行自动注入，不用再查 npm
        try {
          var cacheDir = path.resolve(__dirname, '../ast/pkg-docs')
          fs.mkdirSync(cacheDir, { recursive: true })
          fs.writeFileSync(path.join(cacheDir, pkg + '.md'), '# ' + pkg + ' v' + vue3Ver + ' ' + docSource + '\n\n' + summary, 'utf-8')
          console.log('  ' + chalk.cyan('  ↳ doc cached to ast/pkg-docs/' + pkg + '.md'))
        } catch (e) {}
      } else {
        console.log('  ' + chalk.yellow('⚠ ' + pkg + ' no API doc found'))
      }
    } catch (e) {
      console.log('  ' + chalk.yellow('⚠ ' + pkg + ' doc fetch failed: ' + (e.message || '').split('\n')[0]))
    }
  }
  return notes.length ? notes.join('; ') : ''
}

async function resolveMissingPackagesForFile(filePath, errors, contexts) {
  var missing = extractMissingPackageNames(errors)
  if (!missing.length) return errors

  var rel = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/')
  console.warn('[deps-check] tsc missing package(s) in ' + rel + ': ' + missing.join(', '))
  await checkMissingPackages(new Set([filePath]), contexts, { audit: false })
  return runTsc(filePath)
}

function ensureLine(content, line, afterLine) {
  if (content.includes(line)) return content
  if (afterLine && content.includes(afterLine)) {
    return content.replace(afterLine, afterLine + '\n' + line)
  }
  return line + '\n' + content
}

function extractImportSpecifiers(source) {
  var specs = []
  source.split(/\r?\n/).forEach(function(line) {
    var sideEffect = line.match(/^\s*import\s+['"]([^'"]+)['"]/)
    if (sideEffect) {
      specs.push(sideEffect[1])
      return
    }
    var fromImport = line.match(/\sfrom\s+['"]([^'"]+)['"]/)
    if (fromImport) specs.push(fromImport[1])
  })
  return specs
}

function syncStyleFile(srcRel, seen) {
  seen = seen || new Set()
  if (!srcRel || seen.has(srcRel)) return
  seen.add(srcRel)

  var srcAbs = path.join(VUE_SRC, srcRel.replace(/^src\//, ''))
  if (!fs.existsSync(srcAbs)) return

  var outAbs = path.join(VUE3_OUT, srcRel.replace(/^src\//, ''))
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })

  var code = fs.readFileSync(srcAbs, 'utf-8')
  var srcHash = require('crypto').createHash('md5').update(code).digest('hex')

  // 读上次同步记录，只在源文件有变动时才覆盖（避免丢目标的手动修改）
  var manifest = {}
  try { manifest = JSON.parse(fs.readFileSync(STYLE_SYNC_MANIFEST, 'utf-8')) } catch (e) {}
  var lastHash = manifest[srcRel] || ''

  if (!fs.existsSync(outAbs)) {
    // 目标不存在，首次拷贝
    fs.writeFileSync(outAbs, code, 'utf-8')
    touchedOutputFiles.add(outAbs)
    manifest[srcRel] = srcHash
    fs.writeFileSync(STYLE_SYNC_MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8')
    console.log('[infra style copy] ' + srcRel + ' (' + code.split(/\r?\n/).length + ' lines)')
  } else if (srcHash !== lastHash) {
    // 源文件有变动 → 覆盖目标
    var outCode = fs.readFileSync(outAbs, 'utf-8')
    if (code !== outCode) {
      fs.writeFileSync(outAbs, code, 'utf-8')
      touchedOutputFiles.add(outAbs)
      manifest[srcRel] = srcHash
      fs.writeFileSync(STYLE_SYNC_MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8')
      console.log('[infra style sync] source changed, overwriting ' + srcRel + ' (' + code.split(/\r?\n/).length + ' lines)')
    }
  }
  // srcHash === lastHash: 源文件没变 → 不覆盖（保护目标的手动修改）

  var re = /@import\s+['"]([^'"]+)['"]/g
  var match
  while ((match = re.exec(code))) {
    var spec = match[1].replace(/^~/, '')
    if (spec.startsWith('@/')) {
      syncStyleFile('src/' + spec.slice(2), seen)
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      var childAbs = path.resolve(path.dirname(srcAbs), spec)
      var candidates = [childAbs, childAbs + '.scss', childAbs + '.css']
      for (var i = 0; i < candidates.length; i++) {
        if (!fs.existsSync(candidates[i])) continue
        syncStyleFile('src/' + path.relative(VUE_SRC, candidates[i]).replace(/\\/g, '/'), seen)
        break
      }
    }
  }
}

function parseSassDeclarations(code) {
  var declarations = []
  var lines = String(code || '').split(/\r?\n/)
  var depth = 0
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var trimmed = line.trim()
    var currentDepth = depth
    depth += (line.match(/{/g) || []).length
    depth -= (line.match(/}/g) || []).length
    if (currentDepth !== 0 || !trimmed || trimmed.startsWith('//')) continue
    if (!trimmed.startsWith('$')) continue

    var colon = trimmed.indexOf(':')
    if (colon <= 1) continue
    var name = trimmed.slice(0, colon).trim()
    var statement = line
    while (!statement.trim().endsWith(';') && i + 1 < lines.length) {
      i += 1
      statement += '\n' + lines[i]
    }
    declarations.push({ name: name, statement: statement })
  }
  return declarations
}

function parseNestedSassDeclarationNames(code) {
  var names = new Set()
  var lines = String(code || '').split(/\r?\n/)
  var depth = 0
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var trimmed = line.trim()
    var currentDepth = depth
    depth += (line.match(/{/g) || []).length
    depth -= (line.match(/}/g) || []).length
    if (currentDepth <= 0 || !trimmed.startsWith('$')) continue
    var colon = trimmed.indexOf(':')
    if (colon > 1) names.add(trimmed.slice(0, colon).trim())
  }
  return names
}

function removeLeakedNestedSassDeclarations(targetCode, sourceCode) {
  var sourceTopNames = new Set(parseSassDeclarations(sourceCode).map(function(item) { return item.name }))
  var nestedNames = parseNestedSassDeclarationNames(sourceCode)
  if (!nestedNames.size) return { code: targetCode, changed: false }

  var changed = false
  var depth = 0
  var lines = String(targetCode || '').split(/\r?\n/)
  var kept = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var trimmed = line.trim()
    var currentDepth = depth
    depth += (line.match(/{/g) || []).length
    depth -= (line.match(/}/g) || []).length
    if (currentDepth === 0 && trimmed.startsWith('$')) {
      var colon = trimmed.indexOf(':')
      var name = colon > 1 ? trimmed.slice(0, colon).trim() : ''
      if (name && nestedNames.has(name) && !sourceTopNames.has(name)) {
        changed = true
        continue
      }
    }
    kept.push(line)
  }

  return { code: kept.join('\n'), changed: changed }
}

function ensureSassDeclarations(targetCode, sourceCode) {
  var sourceDeclarations = parseSassDeclarations(sourceCode)
  if (!sourceDeclarations.length) return { code: targetCode, changed: false }

  var targetNames = new Set(parseSassDeclarations(targetCode).map(function(item) { return item.name }))
  var missing = sourceDeclarations.filter(function(item) { return !targetNames.has(item.name) })
  if (!missing.length) return { code: targetCode, changed: false }

  var lines = String(targetCode || '').split(/\r?\n/)
  var insertAt = 0
  while (insertAt < lines.length) {
    var trimmed = lines[insertAt].trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('$')) {
      insertAt += 1
      continue
    }
    break
  }

  var statements = missing.map(function(item) { return item.statement })
  lines.splice(insertAt, 0, statements.join('\n'))
  return { code: lines.join('\n'), changed: true }
}

function parseSassMixins(code) {
  var mixins = []
  var lines = String(code || '').split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var match = line.match(/^@mixin\s+([A-Za-z0-9_-]+)\b/)
    if (!match) continue

    var depth = 0
    var block = []
    for (; i < lines.length; i++) {
      block.push(lines[i])
      depth += (lines[i].match(/{/g) || []).length
      depth -= (lines[i].match(/}/g) || []).length
      if (depth === 0 && block.length > 1) break
    }
    mixins.push({ name: match[1], block: block.join('\n') })
  }
  return mixins
}

function ensureSassMixins(targetCode, sourceCode) {
  var sourceMixins = parseSassMixins(sourceCode)
  if (!sourceMixins.length) return { code: targetCode, changed: false }

  var targetNames = new Set(parseSassMixins(targetCode).map(function(item) { return item.name }))
  var missing = sourceMixins.filter(function(item) { return !targetNames.has(item.name) })
  if (!missing.length) return { code: targetCode, changed: false }

  var code = String(targetCode || '').replace(/\s*$/, '')
  missing.forEach(function(item) {
    code += '\n\n' + item.block
  })
  return { code: code + '\n', changed: true }
}

function targetMainImportFor(spec) {
  if (spec === 'normalize.css/normalize.css') return "import 'normalize.css/normalize.css'"
  if (spec === 'element-ui' || spec === './styles/element-variables.scss') {
    return "import 'element-plus/dist/index.css'"
  }
  if (spec === '@/styles/index.scss' || spec === './styles/index.scss') {
    return "import './styles/index.scss'"
  }
  return null
}

function packageNameFromImport(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('@/')) return null
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

function targetPackageForEntryImport(spec) {
  if (spec === 'normalize.css/normalize.css') return 'normalize.css'
  if (spec === 'element-ui' || spec === './styles/element-variables.scss') return 'element-plus'
  return null
}

function ensureTargetPackageDependencies(specs) {
  var vue2PkgPath = path.resolve(VUE_SRC, '../package.json')
  var vue3PkgPath = path.join(ROOT_DIR, 'package.json')
  if (!fs.existsSync(vue2PkgPath) || !fs.existsSync(vue3PkgPath)) return

  var vue2Pkg = JSON.parse(fs.readFileSync(vue2PkgPath, 'utf-8'))
  var vue3Pkg = JSON.parse(fs.readFileSync(vue3PkgPath, 'utf-8'))
  vue3Pkg.dependencies = vue3Pkg.dependencies || {}

  var changed = false
  specs.forEach(function(spec) {
    var targetPkg = targetPackageForEntryImport(spec)
    if (!targetPkg || vue3Pkg.dependencies[targetPkg] || (vue3Pkg.devDependencies || {})[targetPkg]) return

    var sourcePkg = packageNameFromImport(spec)
    var sourceVersion = sourcePkg && vue2Pkg.dependencies && vue2Pkg.dependencies[sourcePkg]
    var fallbackVersions = {
      'normalize.css': sourceVersion || '^8.0.1',
      'element-plus': '^2.14.2',
    }
    vue3Pkg.dependencies[targetPkg] = fallbackVersions[targetPkg] || sourceVersion || 'latest'
    changed = true
    console.log('[infra package] added dependency:', targetPkg + '@' + vue3Pkg.dependencies[targetPkg])
  })

  if (changed) {
    fs.writeFileSync(vue3PkgPath, JSON.stringify(vue3Pkg, null, 2) + '\n', 'utf-8')
    console.log('[infra package] package.json changed; run npm install in ' + ROOT_DIR)
  }
}

function syncEntryDependencies() {
  var vue2Main = path.join(VUE_SRC, 'main.js')
  var vue3Main = path.join(VUE3_OUT, 'main.ts')
  if (!fs.existsSync(vue2Main) || !fs.existsSync(vue3Main)) return

  var depGraphPath = path.resolve(VUE_SRC, '../autorefactor/ast/dep-graph.json')
  var webpackEntryDeps = []
  if (fs.existsSync(depGraphPath)) {
    try {
      var depData = JSON.parse(fs.readFileSync(depGraphPath, 'utf-8'))
      var appEntry = depData.infra && depData.infra.entrypoints && depData.infra.entrypoints.app
      if (appEntry && appEntry.dependencies) webpackEntryDeps = appEntry.dependencies
      if (!webpackEntryDeps.length && depData.files) {
        Object.keys(depData.files).forEach(function(file) {
          var meta = depData.files[file]
          if (/^src\/main\.(js|ts)( \+ \d+ modules)?$/.test(meta.sourceRelative || '')) {
            webpackEntryDeps = webpackEntryDeps.concat(meta.dependencies || [])
          }
        })
      }
    } catch (e) {
      console.warn('[infra main] dep-graph read failed:', e.message)
    }
  }

  var source = fs.readFileSync(vue2Main, 'utf-8')
  var specs = extractImportSpecifiers(source)
  console.log('[infra main] scanned imports:', specs.join(', '))
  if (webpackEntryDeps.length) console.log('[infra main] webpack entry deps:', webpackEntryDeps.join(', '))
  ensureTargetPackageDependencies(specs)
  var mainImports = []

  specs.forEach(function(spec) {
    if (spec === '@/styles/index.scss' || spec === './styles/index.scss') {
      syncStyleFile('src/styles/index.scss')
    }
    var mapped = targetMainImportFor(spec)
    if (mapped && !mainImports.includes(mapped)) mainImports.push(mapped)
  })
  webpackEntryDeps.forEach(function(dep) {
    if (/^src\/styles\/index\.scss/.test(dep)) syncStyleFile('src/styles/index.scss')
    if (/^src\/styles\/element-variables\.scss/.test(dep)) {
      var mapped = "import 'element-plus/dist/index.css'"
      if (!mainImports.includes(mapped)) mainImports.push(mapped)
    }
  })

  var main = fs.readFileSync(vue3Main, 'utf-8')
  main = main.replace(/import\s+['"]\.\/assets\/main\.css['"]\r?\n?/g, '')
  mainImports.forEach(function(line) {
    main = main.replace(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n?', 'g'), '')
  })
  if (mainImports.length) {
    main = mainImports.concat([main.trimStart()]).join('\n')
    fs.writeFileSync(vue3Main, main, 'utf-8')
    console.log('[infra main] ensured entry imports:', mainImports.join(', '))
  }
}

function copyTargetAuxFiles(contexts) {
  var seen = new Set()
  for (var i = 0; i < contexts.length; i++) {
    var auxFiles = contexts[i].auxFiles || []
    for (var j = 0; j < auxFiles.length; j++) {
      var af = auxFiles[j]
      if (!af.target || seen.has(af.target)) continue
      seen.add(af.target)

      var srcAbs = path.join(VUE_SRC, af.file.replace(/^src\//, ''))
      var outAbs = af.target.startsWith('src/')
        ? path.join(VUE3_OUT.replace(/[\\/]src$/, ''), af.target)
        : path.join(VUE3_OUT, af.target)
      if (fs.existsSync(outAbs)) {
        console.log('[aux pre-skip] already exists: ' + af.target)
        continue
      }

      fs.mkdirSync(path.dirname(outAbs), { recursive: true })
      fs.copyFileSync(srcAbs, outAbs)
      console.log('[aux pre-copy] ' + af.file + ' -> ' + af.target)
    }
  }
}

// ── 基建：全局 CSS class 名迁移（Element UI → Element Plus）─────────────────
// 在所有文件生成完毕后运行一次，非组件级，属于拓扑顶层后处理
// files: 可选 Set，若传入则只处理这些路径；否则全量扫描 targetDir
function transformElCssClasses(targetDir, files) {
  if (!fs.existsSync(CSS_CLASS_MAP_PATH)) {
    console.warn('[css-transform] css-class-map.json not found, skipping')
    return
  }
  var mapData = JSON.parse(fs.readFileSync(CSS_CLASS_MAP_PATH, 'utf-8'))
  var rules = (mapData.rules || []).filter(function(r) { return r.pattern && r.replacement })
  if (!rules.length) {
    console.warn('[css-transform] no rules in map, skipping')
    return
  }

  var allFiles
  if (files && files.size) {
    // 增量模式：只处理本次运行实际写入的文件
    allFiles = Array.from(files).filter(function(f) {
      return /\.(vue|scss|css|ts|tsx|js)$/.test(f) && fs.existsSync(f)
    })
    console.log('[css-transform] incremental mode: ' + allFiles.length + ' touched file(s)')
  } else {
    // 全量模式：扫描整个输出目录
    allFiles = []
    function walk(dir) {
      var entries = fs.readdirSync(dir, { withFileTypes: true })
      for (var i = 0; i < entries.length; i++) {
        var full = path.join(dir, entries[i].name)
        if (entries[i].isDirectory()) {
          if (entries[i].name === 'node_modules' || entries[i].name === '.git' || entries[i].name === 'dist') continue
          walk(full)
        } else if (/\.(vue|scss|css|ts|tsx|js)$/.test(entries[i].name)) {
          allFiles.push(full)
        }
      }
    }
    walk(targetDir)
    console.log('[css-transform] full mode: ' + allFiles.length + ' file(s) scanned')
  }

  if (!allFiles.length) {
    console.log('[css-transform] no files to process')
    return
  }

  var changedCount = 0
  var totalReplacements = 0

  allFiles.forEach(function(filePath) {
    var content = fs.readFileSync(filePath, 'utf-8')
    var newContent = content
    var fileChanges = 0

    rules.forEach(function(rule) {
      var parts = newContent.split(rule.pattern)
      fileChanges += parts.length - 1
      newContent = parts.join(rule.replacement)
    })

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent, 'utf-8')
      totalReplacements += fileChanges
      changedCount++
      var relPath = path.relative(targetDir, filePath)
      console.log('[css-transform] ' + relPath + ' (' + fileChanges + ' replacements)')
    }
  })

  console.log('[css-transform] done: ' + changedCount + ' files changed, ' + totalReplacements + ' total replacements')
}

// ── 审计：源码 Vue 2 only 包是否在目标项目中正确替换 ──────────────────────────
function auditVue2OnlyPackages(contexts, installed, vue2Pkg) {
  var srcNames = contexts.map(function(c) { return c.outRelative || path.basename(c.file) }).join(', ')
  console.log('[audit] checking ' + contexts.length + ' source file(s): ' + srcNames)

  // ── 第一步：列出 package-map.json 中命中的映射及其替换状态 ──────────────────
  var pkgMap = loadPackageMap()
  if (pkgMap.mappings && pkgMap.mappings.length) {
    var mapByPackage = {}
    pkgMap.mappings.forEach(function(m) { mapByPackage[m.sourcePackage] = m })
    var seenPackages = {}
    contexts.forEach(function(ctx) {
      if (!ctx.source) return
      var re = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"])([^'"@.][^'"]*)['"]/g
      var match
      while ((match = re.exec(ctx.source))) {
        var spec = match[1]
        var pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!mapByPackage[pkgName] || seenPackages[pkgName]) continue
        seenPackages[pkgName] = true
        var targetFile = mapByPackage[pkgName].targetFile
        var targetAbs = path.join(VUE3_OUT, targetFile)
        var exists = fs.existsSync(targetAbs)
        var outContent = ''
        try { outContent = fs.readFileSync(ctx.outFile, 'utf-8') } catch (e) {}
        var stillImports = outContent.includes("'" + pkgName + "'") || outContent.includes('"' + pkgName + '"')
        if (stillImports) {
          console.log('[audit]   ' + pkgName + ' ' + chalk.red('STILL IMPORTS ' + pkgName))
        } else if (exists) {
          console.log('[audit]   ' + pkgName + ' ' + chalk.green('→ ' + targetFile + ' (exists)'))
        } else {
          console.log('[audit]   ' + pkgName + ' ' + chalk.yellow('→ ' + targetFile + ' (NOT FOUND)'))
        }
      }
    })
  }

  // ── 第二步：npm registry 检测 Vue 2 only 包 ────────────────────────────────
  var VUE2_CACHE = {}
  function isVue2Only(pkgName) {
    if (VUE2_CACHE.hasOwnProperty(pkgName)) return VUE2_CACHE[pkgName]
    try {
      var raw = execSync(
        'npm view ' + pkgName + ' peerDependencies --json',
        { cwd: ROOT_DIR, stdio: 'pipe', timeout: 10000 }
      ).toString().trim()
      if (!raw) { VUE2_CACHE[pkgName] = false; return false }
      var info = JSON.parse(raw)
      var peers = (info && info.peerDependencies) || {}
      var isV2 = peers.vue && /^[\^~]?2/.test(String(peers.vue))
      console.log('[audit]   ' + pkgName + ' peerDeps: ' + JSON.stringify(peers) + ' → Vue2Only=' + !!isV2)
      VUE2_CACHE[pkgName] = !!isV2
    } catch (e) {
      console.log('[audit]   ' + pkgName + ' npm view FAILED: ' + (e.message || '').split('\n')[0])
      VUE2_CACHE[pkgName] = false
    }
    return VUE2_CACHE[pkgName]
  }

  var auditWarnings = []
  contexts.forEach(function(ctx) {
    if (!ctx.source) return
    var re = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"])([^'"@.][^'"]*)['"]/g
    var match
    while ((match = re.exec(ctx.source))) {
      var spec = match[1]
      var pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (installed.has(pkgName)) continue
      if (!isVue2Only(pkgName)) continue
      var outFile = ctx.outFile
      var outContent = ''
      try { outContent = fs.readFileSync(outFile, 'utf-8') } catch (e) {}
      var stillImports = outContent.includes("'" + pkgName + "'") || outContent.includes('"' + pkgName + '"')
      var status = stillImports
        ? 'STILL IMPORTED — install failed?'
        : 'removed — manually implemented'
      auditWarnings.push({ file: ctx.outRelative, pkg: pkgName, status: status, ok: !stillImports })
    }
  })

  if (auditWarnings.length) {
    console.log('')
    console.log(chalk.bgRed.white(' ╔══════════════════════════════════════════════════════════╗ '))
    console.log(chalk.bgRed.white(' ║  !! VUE 2 ONLY PACKAGES — HANDLED MANUALLY             ║ '))
    console.log(chalk.bgRed.white(' ╚══════════════════════════════════════════════════════════╝ '))
    auditWarnings.forEach(function(w) {
      var colorFn = w.ok ? chalk.green : chalk.red
      console.log('  ' + w.file)
      console.log('    ' + chalk.bold(colorFn(w.pkg + ' → ' + w.status)))
    })
    console.log('')
  } else {
    console.log('[audit] no Vue 2 only packages detected in source files')
  }
}

// ── 基建：缺包检测 ──────────────────────────────────────────────────────────────
// 扫描输出文件的外部 import，对照 admin-vue2 版本自动安装，Vue 2 only 标红警告
async function checkMissingPackages(touchedFiles, contexts, opts) {
  opts = opts || {}
  var vue3Root = ROOT_DIR
  var vue3NodeModules = path.join(vue3Root, 'node_modules')
  var vue3PkgPath = path.join(vue3Root, 'package.json')
  if (!fs.existsSync(vue3PkgPath)) return { missing: [], autoInstall: [], manualWarn: [] }

  var vue3Pkg = JSON.parse(fs.readFileSync(vue3PkgPath, 'utf-8'))
  var installed = new Set(Object.keys(vue3Pkg.dependencies || {}).concat(Object.keys(vue3Pkg.devDependencies || {})))

  // 读 admin-vue2 的 package.json 获取版本参考
  var vue2Pkg = {}
  var vue2PkgPath = path.join(VUE_SRC, '../package.json')
  try { vue2Pkg = JSON.parse(fs.readFileSync(vue2PkgPath, 'utf-8')) } catch (e) {}

  // 收集所有输出文件的外部 import
  var externalImports = new Set()
  var files = Array.from(touchedFiles || []).filter(function(f) {
    return /\.(vue|ts|tsx|js)$/.test(f) && fs.existsSync(f)
  })

  if (files.length) {
    files.forEach(function(fp) {
      var source = fs.readFileSync(fp, 'utf-8')
      var re = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]|require\s*\(\s*['"])([^'"@.][^'"]*)['"]/g
      var match
      while ((match = re.exec(source))) {
        var spec = match[1]
        var pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (pkgName && !installed.has(pkgName)) {
          externalImports.add(pkgName)
        }
      }
    })
  }

  // ── 审计：检查源码用到的 Vue 2 only 包在目标项目中是否已处理 ────────────
  // 不管 touchedFiles 有没有内容，contexts 存在就要审计
  if (opts.audit !== false && contexts && contexts.length) {
    auditVue2OnlyPackages(contexts, installed, vue2Pkg)
  }

  if (!externalImports.size) {
    console.log('[deps-check] all packages installed')
    return { missing: [], autoInstall: [], manualWarn: [] }
  }

  var missing = Array.from(externalImports)
  var autoInstall = []
  var manualWarn = []

  // 运行时检测：查每个缺包的 npm registry metadata
  for (var i = 0; i < missing.length; i++) {
    var pkg = missing[i]
    var isVue2Only = false
    var latestVue3Version = null
    var latestVersion = null
    try {
      // 查本地已装版本 和 最新版本
      var localVer = ''
      try { localVer = JSON.parse(fs.readFileSync(path.join(vue3NodeModules, pkg, 'package.json'), 'utf-8')).version } catch (e) {}
      var info = JSON.parse(execSync('npm view ' + pkg + ' peerDependencies version --json', { cwd: vue3Root, stdio: 'pipe', timeout: 10000 }).toString())

      // npm view 单个版本 vs 多个版本
      if (Array.isArray(info)) {
        // 多个版本，逐个检查
        for (var vi = info.length - 1; vi >= 0; vi--) {
          var peers = (info[vi] && info[vi].peerDependencies) || {}
          if (peers.vue && /^[\^~]?(3|4)/.test(String(peers.vue))) {
            latestVue3Version = info[vi].version
            break
          }
          if (!latestVersion) latestVersion = info[vi].version
        }
      } else {
        var peers = (info && info.peerDependencies) || {}
        if (peers.vue && /^[\^~]?(3|4)/.test(String(peers.vue))) latestVue3Version = info.version
        latestVersion = info.version || latestVersion
      }

      if (peers && peers.vue && /^[\^~]?2/.test(String(peers.vue)) && !latestVue3Version) {
        isVue2Only = true
      }
      var keywords = ((info && !Array.isArray(info) && info.keywords) || []).join(' ').toLowerCase()
      if (keywords.includes('vue2') && !keywords.includes('vue3') && !latestVue3Version) isVue2Only = true
    } catch (e) { /* npm view 失败 */ }

    // 有 Vue 3 版本 → 自动安装最新版
    if (latestVue3Version) {
      var oldMajor = localVer ? parseInt(String(localVer).split('.')[0], 10) : 0
      var newMajor = parseInt(String(latestVue3Version).split('.')[0], 10)
      var isMajorBump = oldMajor > 0 && newMajor > oldMajor
      console.log('[deps-check]   ' + pkg + ' has Vue 3 version ' + latestVue3Version +
        (isMajorBump ? ' (major bump from ' + (localVer || 'none') + ')' : '') + ', auto-upgrading...')
      try {
        execSync('npm install ' + pkg + '@' + latestVue3Version, { cwd: vue3Root, stdio: 'pipe' })
        console.log('  ' + chalk.green('✓ upgraded ' + pkg + ' → ' + latestVue3Version))
        // Major 版本跳跃 → 拉取包 README 注入 system prompt，让 LLM 知道 API 变化
        if (isMajorBump) {
          try {
            var readme = execSync('npm view ' + pkg + '@' + latestVue3Version + ' readme', { cwd: vue3Root, stdio: 'pipe', timeout: 10000 }).toString()
            if (readme && readme.length > 100) {
              var summary = readme.slice(0, 3000).replace(/```[\s\S]*?```/g, '[code block]')
              SYSTEM_PROMPT += '\n\n[Auto-fetched: ' + pkg + ' v' + latestVue3Version + ' README — API reference for LLM]\n' + summary
              console.log('  ' + chalk.cyan('✓ fetched README (' + readme.length + ' bytes) → injected into system prompt'))
            }
          } catch (e) {
            console.log('  ' + chalk.yellow('⚠ README fetch failed: ' + (e.message || '').split('\n')[0]))
          }
        }
        continue
      } catch (e) {
        console.log('  ' + chalk.red('✗ upgrade failed: ' + (e.stderr || e.message || '').toString().split('\n')[0]))
      }
    }

    if (isVue2Only) {
      var vue2OnlyReason = 'no compatible Vue 3 package; write a local compatibility package'
      manualWarn.push('[manual package] ' + pkg + ' (' + vue2OnlyReason + ')')
      SYSTEM_PROMPT += '\n\n[Manual package rewrite] ' + pkg +
        ' has no compatible Vue 3 package. Implement the required behavior locally in the current file or a local helper; do not import ' +
        pkg + ' and do not add the original package to target package.json.'
      continue
    }

    // 找不到 Vue 3 兼容版本时，不再把旧项目版本伪装成可用依赖安装。
    // 旧版本可能仍然依赖 Vue 2；正确动作是进入本地手写替代流程。
    var manualReason = 'no compatible Vue 3 version; write a local compatibility package'
    manualWarn.push('[manual package] ' + pkg + ' (' + manualReason + ')')
    SYSTEM_PROMPT += '\n\n[Manual package rewrite] ' + pkg +
      ' has no compatible Vue 3 version. Implement the required behavior locally in the current file or a local helper; do not import ' +
      pkg + ' and do not add the original package to target package.json.'
  }

  // ── 自动安装（有 admin-vue2 版本参照） ────────────────────────────
  if (autoInstall.length) {
    console.log('\n[deps-check] auto-installing ' + autoInstall.length + ' package(s)...')
    for (var i = 0; i < autoInstall.length; i++) {
      var p = autoInstall[i]
      try {
        console.log('  npm install ' + p.name + '@' + p.version)
        execSync('npm install ' + p.name + '@' + p.version, { cwd: vue3Root, stdio: 'pipe' })
        console.log('  ' + chalk.green('✓ ' + p.name + '@' + p.version))
      } catch (e) {
        console.log('  ' + chalk.red('✗ ' + p.name + ': ' + (e.stderr || e.message || '').toString().split('\n')[0]))
      }
    }
  }

  // ── 需手动处理（Vue 2 only 或无版本参照） ─────────────────────────
  if (manualWarn.length) {
    console.log('')
    console.log(chalk.bgRed.white(' ╔══════════════════════════════════════════════════════════╗ '))
    console.log(chalk.bgRed.white(' ║  ⚠ MISSING PACKAGES — manual action required          ║ '))
    console.log(chalk.bgRed.white(' ╚══════════════════════════════════════════════════════════╝ '))
    manualWarn.forEach(function(msg) {
      console.log('  ' + chalk.yellow('⚠ ' + msg))
    })
    console.log('')
  }

  return { missing: missing, autoInstall: autoInstall, manualWarn: manualWarn }
}

async function run() {
  var packageMap = loadPackageMap()
  var breakingChanges = await fetchElementPlusBreakingChanges()
  SYSTEM_PROMPT = buildSystemPrompt(packageMap) + breakingChanges
  // 注入缓存的包文档（之前拉取过的 npm 包 API 文档）
  var pkgDocDir = path.resolve(__dirname, '../ast/pkg-docs')
  try {
    if (fs.existsSync(pkgDocDir)) {
      var docFiles = fs.readdirSync(pkgDocDir).filter(function(f) { return f.endsWith('.md') })
      docFiles.sort().forEach(function(f) {
        var content = fs.readFileSync(path.join(pkgDocDir, f), 'utf-8')
        SYSTEM_PROMPT += '\n\n[Cached doc: ' + f + ']\n' + content.slice(0, 3000)
      })
      console.log('[workflow] injected ' + docFiles.length + ' cached package doc(s) into system prompt: ' + docFiles.join(', '))
    }
  } catch (e) { console.warn('[workflow] cached doc injection failed: ' + e.message) }

  var allContexts = assemble()

  var contextByKey = new Map(allContexts.map(function(c) { return [c.key, c] }))
  var contexts = allContexts

  if (FOCUS_FILTER) {
    var focusNeedles = FOCUS_FILTER.map(function(f) { return f.toLowerCase() })
    var selected = new Map()
    var addWithDeps = function(ctx) {
      if (!ctx || selected.has(ctx.key)) return
      selected.set(ctx.key, ctx)
      ;(ctx.deps || []).forEach(function(depKey) {
        addWithDeps(contextByKey.get(depKey))
      })
    }

    allContexts.forEach(function(c) {
      var key = c.key.toLowerCase()
      var out = String(c.outRelative || '').toLowerCase()
      var file = String(c.file || '').toLowerCase()
      if (focusNeedles.some(function(f) {
        return key.includes(f) || out.includes(f) || file.includes(f)
      })) {
        addWithDeps(c)
      }
    })

    contexts = Array.from(selected.values())
  }

  if (FOCUS_FILTER) {
    console.log('[focus] filter:', FOCUS_FILTER.join(', '))
    console.log('[focus] matched:', contexts.map(function(c) { return c.key }).join(', '))
    contexts.forEach(function(c) {
      console.log('[focus] output:', c.key + ' -> src/' + c.outRelative)
    })
  }

  syncEntryDependencies()
  copyTargetAuxFiles(contexts)

  var focusKeys = new Set(contexts.map(function(c) { return c.key }))
  var inScope   = function(ctx) { return ctx.deps.filter(function(d) { return focusKeys.has(d) }) }
  var leaves    = contexts.filter(function(c) { return !inScope(c).length })
  var nonLeaves = contexts.filter(function(c) { return inScope(c).length > 0 })

  console.log('leaves:    [' + leaves.map(function(c) { return c.key }).join(', ') + ']')
  console.log('nonLeaves: [' + nonLeaves.map(function(c) { return c.key }).join(', ') + ']')

  var KICKOFF  = '__kickoff__'
  var allPaths = [{ path: KICKOFF, vue3Code: '', tscErrors: '', status: 'idle' }]
    .concat(contexts.map(function(c) { return { path: c.key, vue3Code: '', tscErrors: '', status: 'idle' } }))

  var engine = useMeshFlow(
    'vue-element-admin-upgrade',
    allPaths,
    {
      config: { useEntangleStep: 3, MAX_CONCURRENT_TASKS: 1, BACKPRESSURE_LIMIT: 1 },
      UITrigger: { signalCreator: function() { return null }, signalTrigger: function() {} },
      modules: {
        useInternalForm: function(scheduler, schemaArg) {
          schemaArg.forEach(function(node) {
            scheduler.registerNode({
              path: node.path,
              type: 'string',
              state: { vue3Code: '', tscErrors: '', status: 'idle' },
              meta: {},
              notifyKeys: new Set(),
            }).createView()
          })
          return { uiSchema: schemaArg, GetFormData: function() { return {} } }
        },
      },
    }
  )

  var SetRules    = engine.config.SetRules
  var useEntangle = engine.config.useEntangle
  var SetValue    = engine.data.SetValue
  var GetValue    = engine.data.GetValue
  var onSuccess   = engine.hooks.onSuccess
  var onError     = engine.hooks.onError

  for (var i = 0; i < leaves.length; i++) {
    ;(function(ctx) {
      SetRules([KICKOFF], ctx.key, 'vue3Code', {
        triggerKeys: ['status'],
        logic: async function(slot) {
          if (slot.slot.triggerTargets[0].status !== 'go') return ''
          var existing = GetValue(ctx.key, 'vue3Code')
          if (existing) return existing
          console.log('[LLM leaf] ' + ctx.key + '...')
          var ft = ctx.key.startsWith('store_') ? 'ts' : 'vue'
          return await callWithTruncationRetry(SYSTEM_PROMPT, buildPrompt(ctx, new Map()), 3, ft)
        },
      })
    })(leaves[i])
  }

  for (var j = 0; j < nonLeaves.length; j++) {
    ;(function(ctx) {
      var deps = inScope(ctx)
      SetRules(deps, ctx.key, 'vue3Code', {
        triggerKeys: ['vue3Code'],
        logic: async function(slot) {
          var existing = GetValue(ctx.key, 'vue3Code')
          if (existing) return existing
          var dm = new Map()
          for (var i = 0; i < deps.length; i++) {
            var c = slot.slot.triggerTargets[i].vue3Code
            if (!c) return ''
            dm.set(deps[i], c)
          }
          console.log('[LLM non-leaf] ' + ctx.key + '...')
          var ft = ctx.key.startsWith('store_') ? 'ts' : 'vue'
          return await callWithTruncationRetry(SYSTEM_PROMPT, buildPrompt(ctx, dm), 3, ft)
        },
      })
    })(nonLeaves[j])
  }

  for (var k = 0; k < contexts.length; k++) {
    ;(function(ctx) {
      useEntangle({
        cause: ctx.key, impact: ctx.key, via: ['vue3Code'],
        emit: async function(causeNode, _impact, propose) {
          var code = causeNode.state.vue3Code
          if (!code) return
          var outFile = writeOutput(ctx, code)
          var errors  = runTsc(outFile)
          if (errors && hasMissingPackageError(errors)) {
            errors = await resolveMissingPackagesForFile(outFile, errors, contexts)
          }
          // 检查生成的代码是否用了需要 API 迁移的包（major 版本跳跃）
          var depNote = await checkPackageApiMigrations(outFile)
          console.log(errors ? '[tsc✗] ' + ctx.key : '[tsc✓] ' + ctx.key)
          if (errors) console.log(errors)
          propose.set('tscErrors', errors)
          propose.set('depNote', depNote)
          if (!errors && !depNote) propose.set('status', 'fulfilled')
        },
      })
    })(contexts[k])
  }

  for (var m = 0; m < contexts.length; m++) {
    ;(function(ctx) {
      var deps = inScope(ctx)
      useEntangle({
        cause: ctx.key, impact: ctx.key, via: ['tscErrors'],
        emit: async function(causeNode, _impact, propose) {
          var errors   = causeNode.state.tscErrors
          if (!errors) return
          var existing = causeNode.state.vue3Code || ''
          var dm = new Map()
          for (var d = 0; d < deps.length; d++) dm.set(deps[d], GetValue(deps[d], 'vue3Code'))
          console.log('[LLM retry] ' + ctx.key + '...')
          var ft = ctx.key.startsWith('store_') ? 'ts' : 'vue'
          var code = await callWithTruncationRetry(SYSTEM_PROMPT, buildPrompt(ctx, dm, errors), 3, ft)
          if (code.length < 200 || code.length < existing.length * 0.5) {
            console.warn('[retry SKIP] ' + ctx.key + ' too short (' + code.length + ')')
            return
          }
          propose.set('vue3Code', code)
        },
      })
    })(contexts[m])
  }

  // ── depNote 触发重试：包 API 迁移文档注入后重新生成 ────────────────────
  for (var n = 0; n < contexts.length; n++) {
    ;(function(ctx) {
      var deps = inScope(ctx)
      useEntangle({
        cause: ctx.key, impact: ctx.key, via: ['depNote'],
        emit: async function(causeNode, _impact, propose) {
          var note = causeNode.state.depNote
          if (!note) return
          var existing = causeNode.state.vue3Code || ''
          var dm = new Map()
          for (var d = 0; d < deps.length; d++) dm.set(deps[d], GetValue(deps[d], 'vue3Code'))
          console.log('[LLM retry] ' + ctx.key + ' (depNote: ' + note + ') ...')
          var ft = ctx.key.startsWith('store_') ? 'ts' : 'vue'
          var fixPrompt = buildPrompt(ctx, dm)
          fixPrompt += '\n\n⚠️ 以下 npm 包的版本/API 已变更，System Prompt 末尾已注入对应版本文档：\n' + note + '\n请对照文档修正 API 用法（如 v-for→#item slot 等 breaking changes），重新生成此文件。'
          var code = await callWithTruncationRetry(SYSTEM_PROMPT, fixPrompt, 3, ft)
          if (code.length < 200 || code.length < existing.length * 0.5) {
            console.warn('[retry SKIP] ' + ctx.key + ' too short (' + code.length + ')')
            return
          }
          propose.set('vue3Code', code)
          propose.set('depNote', '')
        },
      })
    })(contexts[n])
  }

  var done = new Promise(function(resolve, reject) {
    onSuccess(function() {
      if (contexts.some(function(c) { return GetValue(c.key, 'status') !== 'fulfilled' })) return
      console.log('\n all done:')
      for (var i = 0; i < contexts.length; i++) {
        var errors = GetValue(contexts[i].key, 'tscErrors')
        console.log('  ' + contexts[i].outRelative + (errors ? ' has errors' : ' OK'))
      }
      console.log('\noutput: ' + VUE3_OUT)
      resolve()
    })
    onError(function(err) { console.error('error:', err); reject(err) })
  })

  await Promise.resolve()
  SetValue(KICKOFF, 'status', 'go')
  await done

  // ── 迁移 aux 文件 (api/*.js / utils/*.js → *.ts) ──────────────────────────
  await migrateAuxFiles(contexts)

  // ── 基建：检查缺包 ──────────────────────────────────────────────────────────────
  // 扫描输出文件的 import，发现目标项目未安装的包就自动 npm install
  console.log('\n[deps-check] scanning for missing packages...')
  await checkMissingPackages(touchedOutputFiles, contexts)

  // ── 基建：全局 CSS class 名迁移 (Element UI → Element Plus) ──────────────────
  console.log('\n[css-transform] starting global CSS class migration...')
  transformElCssClasses(VUE3_OUT, touchedOutputFiles)
  touchedOutputFiles.clear()
}

// 收集当前 focus 范围内所有 aux 文件，跳过目标已存在的，其余 LLM 迁移
async function migrateAuxFiles(contexts) {
  // key: 相对路径 'src/api/role.js', value: 原始内容
  var seen = new Map()
  for (var i = 0; i < contexts.length; i++) {
    var auxFiles = contexts[i].auxFiles || []
    for (var j = 0; j < auxFiles.length; j++) {
      var af = auxFiles[j]
      if (af.target) {
        if (!seen.has(af.target)) {
          // .vue 文件需要走 LLM 转换，不能只拷贝（Vue 2 源码在 Vue 3 跑不了）
          var isVue = /\.vue$/.test(af.file)
          seen.set(af.target, {
            srcRel: af.file,
            outRel: af.target,
            content: af.content,
            mode: isVue ? 'llm-vue' : 'copy',
          })
        }
        continue
      }
      // 只处理 src/api/ 和 src/utils/ 下的 js 文件（store/getters.js 等是参考用，跳过）
      if (!/^src\/(api|utils|vendor)\//.test(af.file)) continue
      var sharedOutRel = af.file.replace(/\.js$/, '.ts')
      if (!seen.has(sharedOutRel)) {
        seen.set(sharedOutRel, {
          srcRel: af.file,
          outRel: sharedOutRel,
          content: af.content,
          mode: /^src\/vendor\//.test(af.file) ? 'copy' : 'llm',
        })
      }
    }
  }

  if (!seen.size) return
  console.log('\n[aux] 需要迁移的 aux 文件:', Array.from(seen.keys()).join(', '))

  for (var entry of seen.values()) {
    var srcRel  = entry.srcRel
    var srcCode = entry.content
    // 目标路径：把 .js 换成 .ts
    var outRel  = entry.outRel
    var outAbs  = outRel.startsWith('src/')
      ? path.join(VUE3_OUT.replace(/[\\/]src$/, ''), outRel)
      : path.join(VUE3_OUT, outRel)

    if (fs.existsSync(outAbs)) {
      console.log('[aux skip] already exists: ' + outRel)
      continue
    }

    fs.mkdirSync(path.dirname(outAbs), { recursive: true })

    // vendor 文件直接复制，不走 LLM
    if (entry.mode === 'copy') {
      var srcAbs = path.join(VUE_SRC, srcRel.replace(/^src\//, ''))
      fs.copyFileSync(srcAbs, outAbs)
      touchedOutputFiles.add(outAbs)
      console.log('[aux copy] ' + srcRel + ' -> ' + outRel)
      continue
    }

    // .vue aux 文件用完整 Vue 2→3 转换 prompt
    if (entry.mode === 'llm-vue') {
      console.log('[aux LLM vue] ' + srcRel + ' ...')
      var vuePrompt = [
        '【输出文件路径】src/' + outRel,
        '【import 路径约定】store: @/stores/xxx | router: useRoute/useRouter from vue-router | Element Plus: from element-plus | 图标: from @element-plus/icons-vue',
        '',
        '将下面的 Vue 2 组件迁移为 Vue 3 + <script setup lang="ts">：',
        '',
        '源文件 (' + srcRel + '):',
        '```vue',
        srcCode,
        '```',
      ].join('\n')
      var code = await callWithTruncationRetry(SYSTEM_PROMPT, vuePrompt, 3, 'vue')
      fs.writeFileSync(outAbs, code, 'utf-8')
      touchedOutputFiles.add(outAbs)
      console.log('[aux LLM vue] done: ' + outRel)
      continue
    }

    console.log('[aux LLM] ' + srcRel + ' ...')
    var prompt = [
      '将下面的 Vue 2 JavaScript 工具/API 文件迁移为 Vue 3 + TypeScript：',
      '- 保持函数名和导出不变',
      '- import request from \'@/utils/request\' 保留不变',
      '- 如有 store.getters.xxx，改成从对应 Pinia store 取值（useUserStore / useAppStore / usePermissionStore 等）',
      '- 添加合适的 TypeScript 类型注解',
      '- 输出纯 TypeScript 文件，不要 <template>',
      '',
      '源文件 (' + srcRel + '):',
      '```js',
      srcCode,
      '```',
    ].join('\n')

    var code = await callWithTruncationRetry(SYSTEM_PROMPT, prompt, 3, 'ts')
    fs.writeFileSync(outAbs, code, 'utf-8')
    touchedOutputFiles.add(outAbs)
    console.log('[aux done] ' + outRel)
  }
}

run().catch(function(err) { console.error('fatal:', err && err.message || err); process.exit(1) })
