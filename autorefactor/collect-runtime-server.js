'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const connect = require('connect')
const serveStatic = require('serve-static')

const ROOT_DIR = path.resolve(__dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')
const AST_DIR = path.join(__dirname, 'ast')
const DUMP_PATH = path.join(AST_DIR, 'runtime-dump.json')
const PORT = Number(process.env.REFACTOR_COLLECT_PORT || process.env.PORT || 9526)
const PUBLIC_PATH = '/'
const EXIT_DELAY = Number(process.env.REFACTOR_COLLECT_EXIT_DELAY || 5000)
const KEEP_OPEN = process.argv.includes('--keep-open') || process.env.REFACTOR_COLLECT_KEEP_OPEN === '1'
const REFACTOR_FOCUS = process.env.REFACTOR_FOCUS || process.env.VUE_APP_REFACTOR_FOCUS || ''

var shutdownTimer = null
var server = null

function ensureRuntimeDump(reset) {
  fs.mkdirSync(AST_DIR, { recursive: true })
  if (reset || !fs.existsSync(DUMP_PATH)) {
    fs.writeFileSync(DUMP_PATH, '[]\n', 'utf-8')
  }
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = []
    req.on('data', function(chunk) { chunks.push(chunk) })
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf-8')) })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function handleRuntimeDump(req, res) {
  try {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '[]')
    if (!Array.isArray(data)) throw new Error('runtime dump body must be an array')

    fs.mkdirSync(AST_DIR, { recursive: true })
    fs.writeFileSync(DUMP_PATH, JSON.stringify(data, null, 2), 'utf-8')
    console.log('[runtime-dump] wrote ' + data.length + ' components -> ' + DUMP_PATH)
    sendJson(res, 200, { ok: true, count: data.length, file: DUMP_PATH })
    scheduleShutdown()
  } catch (e) {
    console.error('[runtime-dump] write failed:', e.message)
    sendJson(res, 500, { ok: false, error: e.message })
  }
}

function scheduleShutdown() {
  if (KEEP_OPEN) return
  if (shutdownTimer) clearTimeout(shutdownTimer)
  shutdownTimer = setTimeout(function() {
    console.log('[collect-runtime] no new runtime dump for ' + EXIT_DELAY + 'ms, shutting down.')
    server.close(function() {
      process.exit(0)
    })
  }, EXIT_DELAY)
}

function createApp() {
  const app = connect()

  app.use(function(req, res, next) {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/runtime-dump') {
      handleRuntimeDump(req, res)
      return
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/runtime-dump') {
      sendJson(res, 200, {
        ok: true,
        file: DUMP_PATH,
        exists: fs.existsSync(DUMP_PATH),
        size: fs.existsSync(DUMP_PATH) ? fs.statSync(DUMP_PATH).size : 0
      })
      return
    }
    next()
  })

  app.use(PUBLIC_PATH, serveStatic(DIST_DIR, {
    index: ['index.html', '/']
  }))

  app.use(function(req, res) {
    const indexPath = path.join(DIST_DIR, 'index.html')
    if (!fs.existsSync(indexPath)) {
      res.statusCode = 404
      res.end('dist/index.html not found. Run npm run build first.')
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    fs.createReadStream(indexPath).pipe(res)
  })

  return app
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('[collect-runtime] dist does not exist. Run npm run build first.')
  process.exit(1)
}

ensureRuntimeDump(!process.argv.includes('--keep-runtime'))

server = http.createServer(createApp())
server.listen(PORT, function() {
  console.log('[collect-runtime] static dist: ' + DIST_DIR)
  console.log('[collect-runtime] runtime dump: ' + DUMP_PATH)
  console.log('[collect-runtime] focus: ' + (REFACTOR_FOCUS || '(all src)'))
  console.log('[collect-runtime] listening: http://localhost:' + PORT + '/')
  console.log('[collect-runtime] health:    http://localhost:' + PORT + '/api/runtime-dump')
  console.log('[collect-runtime] browse the focused pages, then check autorefactor/ast/runtime-dump.json')
  if (!KEEP_OPEN) {
    console.log('[collect-runtime] will auto-exit ' + EXIT_DELAY + 'ms after the last runtime dump.')
  }
})
