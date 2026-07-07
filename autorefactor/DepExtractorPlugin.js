'use strict'

/**
 * DepExtractorPlugin — vue-admin-template 版
 *
 * 适配 Vue CLI 4 (webpack 4 + webpack-dev-server v3)
 *
 * vue.config.js 用法：
 *   const DepExtractorPlugin = require('./autorefactor/DepExtractorPlugin')
 *
 *   configureWebpack: {
 *     plugins: [ new DepExtractorPlugin() ]
 *   },
 *   devServer: {
 *     before: DepExtractorPlugin.before,
 *   }
 */

const fs   = require('fs')
const path = require('path')

// 输出到 react-app-webpack 那边的 vue-admin/ast 目录
const OUTPUT_DIR = path.resolve(__dirname, 'ast')

class DepExtractorPlugin {
  constructor(options) {
    options = options || {}
    this.srcFilter  = options.srcFilter  || path.resolve(__dirname, '../src')
    this.outputDir  = options.outputDir  || OUTPUT_DIR
    // 只抓我们关心的组件范围（节省噪音）
    // focusPaths 已移除：统一只收录 src/ 下所有文件，无需手动维护列表
  }

  apply(compiler) {
    // entry 注入已改为 vue.config.js chainWebpack.entry('app').prepend(...)
    // ── 编译完成：提取依赖图 + sourcemap 索引 ────────────────────────────────
    compiler.hooks.done.tap('DepExtractorPlugin', (stats) => {
      // 只在生产构建时收集：dev server 懒加载会导致动态 import 的 chunk 不完整
      const isProduction = compiler.options.mode === 'production' || !compiler.watchMode
      if (!isProduction) {
        console.log('\n[DepExtractor] dev 模式跳过，请用 npm run build 收集完整依赖图')
        return
      }
      console.log('\n[DepExtractor] 开始提取依赖图...')

      const json = stats.toJson({
        modules: true,
        reasons: true,
        source:  false,
        chunks:  false,
        assets:  false,
      })

      const depGraph   = {}
      const reverseMap = {}

      // webpack 4: mod.name = './src/layout/index.vue?vue&type=script...'（相对路径，带query）
      // webpack 5: mod.nameForCondition = 绝对路径
      const modToAbsFile = (mod) => {
        // webpack 5
        if (mod.nameForCondition) return mod.nameForCondition
        // webpack 4: name 可能是 './src/xxx.vue' 或带 loader 前缀的 identifier
        let name = mod.name || mod.identifier || ''
        // 去掉 loader 链前缀（最后一个 ! 之后才是文件路径）
        if (name.includes('!')) name = name.split('!').pop()
        // 去掉 vue-loader query（?vue&type=script&lang=js 等）
        name = name.split('?')[0]
        if (!name) return null
        const abs = path.isAbsolute(name) ? name : path.resolve(compiler.context, name)
        return abs
      }

      const isSrcFile = (absPath) => {
        if (!absPath) return false
        return absPath.startsWith(this.srcFilter) && !absPath.includes('node_modules')
      }

      // focusPaths 已废弃：src/ 下全部文件都纳入，node_modules 由 isSrcFile 排除
      const isInFocus = (absPath) => isSrcFile(absPath)

      // identifier → absFile 反查表（含 webpack 4 的带query identifier）
      const identToFile = {}
      ;(json.modules || []).forEach(mod => {
        const abs = modToAbsFile(mod)
        if (!abs || !isSrcFile(abs)) return
        // 把 mod.identifier（带 loader/query）映射到干净的 absFile
        if (mod.identifier) identToFile[mod.identifier] = abs
        if (mod.id != null)  identToFile[String(mod.id)] = abs
      })

      const resolveIdent = (ident) => {
        if (!ident) return null
        if (identToFile[ident]) return identToFile[ident]
        // 降级：剥 loader + query
        let name = ident
        if (name.includes('!')) name = name.split('!').pop()
        name = name.split('?')[0]
        const abs = path.isAbsolute(name) ? name : path.resolve(compiler.context, name)
        return isSrcFile(abs) ? abs : null
      }

      ;(json.modules || []).forEach((mod) => {
        const file = modToAbsFile(mod)
        if (!isSrcFile(file)) return

        if (!depGraph[file])   depGraph[file]   = []
        if (!reverseMap[file]) reverseMap[file] = []

        const importers = (mod.reasons || [])
          // webpack 4: r.moduleIdentifier; webpack 5: r.resolvedModuleIdentifier
          .map(r => resolveIdent(r.resolvedModuleIdentifier || r.moduleIdentifier))
          .filter(f => f && isSrcFile(f) && f !== file)

        importers.forEach(parent => {
          if (!reverseMap[file].includes(parent)) reverseMap[file].push(parent)
          if (!depGraph[parent]) depGraph[parent] = []
          if (!depGraph[parent].includes(file))   depGraph[parent].push(file)
        })
      })

      // 只保留 focusPaths 范围内的节点
      const focusGraph = {}
      Object.keys(depGraph).forEach(file => {
        if (isInFocus(file)) {
          focusGraph[file] = depGraph[file].filter(isInFocus)
        }
      })

      // sourcemap 收集
      const outputPath = stats.compilation.outputOptions.path
      const sourceMaps = {}
      const smDestDir  = path.join(this.outputDir, 'sourcemaps')
      fs.mkdirSync(smDestDir, { recursive: true })

      try {
        fs.readdirSync(outputPath)
          .filter(f => f.endsWith('.map'))
          .forEach(mapFile => {
            const srcPath    = path.join(outputPath, mapFile)
            const mapContent = JSON.parse(fs.readFileSync(srcPath, 'utf-8'))
            const relSources = (mapContent.sources || []).filter(isInFocus)
            if (relSources.length === 0) return

            const destPath = path.join(smDestDir, mapFile)
            fs.copyFileSync(srcPath, destPath)
            sourceMaps[mapFile] = { copiedTo: destPath, sources: relSources }
          })
      } catch (e) {
        console.warn('[DepExtractor] 读取 sourcemap 失败:', e.message)
      }

      fs.mkdirSync(this.outputDir, { recursive: true })

      const depGraphPath = path.join(this.outputDir, 'dep-graph.json')
      fs.writeFileSync(depGraphPath, JSON.stringify({
        meta: {
          generatedAt: new Date().toISOString(),
          srcRoot:     this.srcFilter,
          focusPaths:  this.focusPaths,
        },
        graph:   focusGraph,
        reverse: reverseMap,
      }, null, 2))

      const smIndexPath = path.join(this.outputDir, 'sourcemap-index.json')
      fs.writeFileSync(smIndexPath, JSON.stringify(sourceMaps, null, 2))

      console.log('[DepExtractor] 依赖图  →', depGraphPath)
      console.log('[DepExtractor] SM 索引 →', smIndexPath)
      console.log('[DepExtractor] 节点数:  ', Object.keys(focusGraph).length)
    })
  }

  // ── 3. devServer.before — webpack-dev-server v3 API ───────────────────────
  // vue.config.js: devServer: { before: DepExtractorPlugin.before }
  static before(app) {
    app.post('/api/runtime-dump', (req, res) => {
      // mock-server.js 注册了全局 bodyParser.json()，body 已被自动解析到 req.body
      try {
        const data = req.body
        if (!Array.isArray(data)) throw new Error('body 不是数组')
        fs.mkdirSync(OUTPUT_DIR, { recursive: true })
        const dumpPath = path.join(OUTPUT_DIR, 'runtime-dump.json')
        fs.writeFileSync(dumpPath, JSON.stringify(data, null, 2))
        console.log('[DepExtractor] runtime-dump.json 已写入 (' + data.length + ' 个组件)')
        res.json({ ok: true, count: data.length })
      } catch (e) {
        console.error('[DepExtractor] runtime-dump 写入失败:', e.message)
        res.status(400).json({ error: e.message })
      }
    })
  }
}

module.exports = DepExtractorPlugin
