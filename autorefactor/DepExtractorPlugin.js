'use strict'

/**
 * DepExtractorPlugin — vue-admin-template 版
 *
 * 适配 Vue CLI 4 (webpack 4 + webpack-dev-server v3)
 *
 * 核心改动：hook finishModules 而非 compiler.done
 * finishModules 阶段所有模块已构建、scope hoisting 尚未发生，
 * compilation.modules 里每个文件都是独立 NormalModule，
 * 不会出现 "file.vue + N modules" 的合并。
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

const OUTPUT_DIR = path.resolve(__dirname, 'ast')

function normPath(p) { return p.replace(/\\/g, '/') }

class DepExtractorPlugin {
  constructor(options) {
    options = options || {}
    this.srcFilter  = options.srcFilter || options.srcDir || path.resolve(__dirname, '../src')
    this.outputDir  = options.outputDir || options.outDir || OUTPUT_DIR
  }

  apply(compiler) {
    const self = this

    compiler.hooks.compilation.tap('DepExtractorPlugin', (compilation) => {
      // finishModules: 所有模块构建完毕，scope hoisting / tree shaking 尚未发生
      // 只在生产构建（npm run build）时写入，dev server 懒加载会导致每次编译模块列表不同
      compilation.hooks.finishModules.tap('DepExtractorPlugin', () => {
        const isProd = compiler.options.mode === 'production' || !compiler.watchMode
        if (!isProd) return

        const isSrcFile = (absPath) => {
          if (!absPath) return false
          return absPath.startsWith(self.srcFilter) && !absPath.includes('node_modules')
        }

        const toSrcRelative = (absPath) => {
          return 'src/' + normPath(path.relative(self.srcFilter, absPath))
        }

        console.log('\n[DepExtractor] 开始提取依赖图 (finishModules, ' + compilation.modules.length + ' total modules)...')

        const depGraph   = {}

        compilation.modules.forEach((mod) => {
          // webpack 4: NormalModule 有 resource 属性；ConcatenatedModule / ExternalModule 等忽略
          if (!mod.resource) return
          const absFile = mod.resource
          if (!isSrcFile(absFile)) return

          if (!depGraph[absFile]) depGraph[absFile] = []

          // 方法1：从 webpack 内部 dependency graph 提取
          // HarmonyImportSideEffectDependency / HarmonyImportSpecifierDependency
          ;(mod.dependencies || []).forEach((dep) => {
            if (!dep.module || !dep.module.resource) return
            const depFile = dep.module.resource
            if (!isSrcFile(depFile) || depFile === absFile) return
            if (!depGraph[absFile].includes(depFile)) {
              depGraph[absFile].push(depFile)
            }
            // 确保依赖文件也在 graph 中（即使没有 import 别人）
            if (!depGraph[depFile]) depGraph[depFile] = []
          })

          // 方法2：静态分析补漏
          // require() / 动态 import / webpack 无法静态追踪的依赖靠源码正则
          let source = ''
          try { source = fs.readFileSync(absFile, 'utf-8') } catch (e) {}
          if (!source) return

          const importRe = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
          const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
          let match
          while ((match = importRe.exec(source)) || (match = requireRe.exec(source))) {
            const spec = match[1]
            // 只看项目内引用
            if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('@/')) continue

            let base
            if (spec.startsWith('@/')) {
              base = path.join(self.srcFilter, spec.slice(2))
            } else {
              base = path.resolve(path.dirname(absFile), spec)
            }

            const candidates = [
              base,
              base + '.vue', base + '.js', base + '.ts',
              base + '.scss', base + '.css',
              path.join(base, 'index.vue'), path.join(base, 'index.js'),
              path.join(base, 'index.ts'), path.join(base, 'index.scss'),
            ]

            for (let c = 0; c < candidates.length; c++) {
              let exists = false
              try { exists = fs.existsSync(candidates[c]) && fs.statSync(candidates[c]).isFile() } catch(e) {}
              if (!exists) continue
              const depFile = candidates[c]
              if (!isSrcFile(depFile) || depFile === absFile) break
              if (!depGraph[absFile].includes(depFile)) {
                depGraph[absFile].push(depFile)
              }
              if (!depGraph[depFile]) depGraph[depFile] = []
              break
            }
          }
        })

        // 构建 fileMeta
        const fileMeta = {}
        Object.keys(depGraph).forEach(file => {
          fileMeta[file] = {
            sourceRelative: toSrcRelative(file),
            dependencies: (depGraph[file] || []).map(toSrcRelative),
          }
        })

        // entrypoint
        const infra = { entrypoints: {} }
        Object.keys(fileMeta).forEach(file => {
          const meta = fileMeta[file]
          if (/^src\/main\.(js|ts)$/.test(meta.sourceRelative)) {
            infra.entrypoints.app = {
              source: meta.sourceRelative,
              dependencies: meta.dependencies,
            }
          }
        })

        fs.mkdirSync(self.outputDir, { recursive: true })

        const outPath = path.join(self.outputDir, 'dep-graph.json')
        fs.writeFileSync(outPath, JSON.stringify({
          meta: {
            generatedAt: new Date().toISOString(),
            srcRoot: self.srcFilter,
          },
          infra: infra,
          files: fileMeta,
          graph: depGraph,
        }, null, 2))

        console.log('[DepExtractor] 依赖图  →', outPath)
        console.log('[DepExtractor] 节点数:  ', Object.keys(depGraph).length)
      })
    })
  }

  // devServer.before — runtime-dump 接收端点
  static before(app) {
    app.post('/api/runtime-dump', (req, res) => {
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
