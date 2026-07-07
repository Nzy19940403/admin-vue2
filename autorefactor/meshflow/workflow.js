'use strict'
if (typeof performance === 'undefined') {
  const { performance: p } = require('perf_hooks')
  global.performance = p
}
const fs   = require('fs')
const path = require('path')
const { execSync }           = require('child_process')
const { useMeshFlow }        = require('../../../react-app-webpack/node_modules/@meshflow/core')
const { assemble, VUE3_OUT, VUE_SRC } = require('../assembler')
const { callDeepSeek }       = require('./deepseek')
const { buildSystemPrompt }  = require('../prompts')

const ROOT_DIR = VUE3_OUT.replace(/[\\/]src$/, '')

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
    headerLines.push('  组件: @/components/admin/XxxComponent')
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
    if (r.computed && r.computed.length) lines.push('  computed: ' + r.computed.join(', '))
    if (r.watch   && r.watch.length)    lines.push('  watch:    ' + r.watch.join(', '))
    if (r.methods && r.methods.length)  lines.push('  methods:  ' + r.methods.join(', '))
    if (r.mixins  && r.mixins.length)   lines.push('  mixins:   ' + r.mixins.join(', '))
    lines.push('  → defineProps/defineEmits/inject 字段名以此为准；methods/computed 确保全部保留，不要遗漏')
    runtimeNote = lines.join('\n')
  }

  return [header, errorNote, runtimeNote, deps, aux, src].filter(Boolean).join('\n\n')
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
  return ctx.outFile
}

function runTsc(filePath) {
  try {
    execSync('npx vue-tsc --noEmit --skipLibCheck', { cwd: ROOT_DIR, stdio: 'pipe' })
    return ''
  } catch (e) {
    var out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')
    var rel = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/')
    return out.split('\n')
      .filter(function(l) { return l.includes(rel) || l.startsWith('  ') })
      .join('\n').trim()
  }
}

async function run() {
  var breakingChanges = await fetchElementPlusBreakingChanges()
  SYSTEM_PROMPT = buildSystemPrompt() + breakingChanges

  var allContexts = assemble()

  var contexts = FOCUS_FILTER
    ? allContexts.filter(function(c) {
        return FOCUS_FILTER.some(function(f) { return c.key.includes(f) })
      })
    : allContexts

  if (FOCUS_FILTER) {
    console.log('[focus] filter:', FOCUS_FILTER.join(', '))
    console.log('[focus] matched:', contexts.map(function(c) { return c.key }).join(', '))
  }

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
          console.log(errors ? '[tsc✗] ' + ctx.key : '[tsc✓] ' + ctx.key)
          if (errors) console.log(errors)
          propose.set('tscErrors', errors)
          if (!errors) propose.set('status', 'fulfilled')
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
}

// 收集当前 focus 范围内所有 aux 文件，跳过目标已存在的，其余 LLM 迁移
async function migrateAuxFiles(contexts) {
  // key: 相对路径 'src/api/role.js', value: 原始内容
  var seen = new Map()
  for (var i = 0; i < contexts.length; i++) {
    var auxFiles = contexts[i].auxFiles || []
    for (var j = 0; j < auxFiles.length; j++) {
      var af = auxFiles[j]
      // 只处理 src/api/ 和 src/utils/ 下的 js 文件（store/getters.js 等是参考用，跳过）
      if (!/^src\/(api|utils|vendor)\//.test(af.file)) continue
      if (!seen.has(af.file)) seen.set(af.file, af.content)
    }
  }

  if (!seen.size) return
  console.log('\n[aux] 需要迁移的 aux 文件:', Array.from(seen.keys()).join(', '))

  for (var entry of seen.entries()) {
    var srcRel  = entry[0]          // 'src/api/role.js'
    var srcCode = entry[1]
    // 目标路径：把 .js 换成 .ts
    var outRel  = srcRel.replace(/\.js$/, '.ts')
    var outAbs  = path.join(ROOT_DIR, outRel.replace(/^src\//, 'src/'))
    outAbs      = path.join(VUE3_OUT.replace(/[\\/]src$/, ''), outRel)

    if (fs.existsSync(outAbs)) {
      console.log('[aux skip] already exists: ' + outRel)
      continue
    }

    fs.mkdirSync(path.dirname(outAbs), { recursive: true })

    // vendor 文件直接复制，不走 LLM
    if (/^src\/vendor\//.test(srcRel)) {
      var srcAbs = path.join(VUE_SRC, srcRel.replace(/^src\//, ''))
      fs.copyFileSync(srcAbs, outAbs.replace(/\.ts$/, '.js'))
      console.log('[aux copy] ' + srcRel)
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
    console.log('[aux done] ' + outRel)
  }
}

run().catch(function(err) { console.error('fatal:', err && err.message || err); process.exit(1) })
