// Selfloop · 插件自带静态服（领域无关，只认"给一个目录"）
//
// 用法与项目根的 _tmp_static.js 完全一致（iter.ps1 就是在 Start-Process 里按这个签名起它的）：
//   node server.mjs <root> <port> [host]
//
// 为什么要自带：iter.ps1 的 server.staticScript 指哪打哪，但干净机器上没有项目根那份
// _tmp_static.js（它被 8 个进程引用，按纪律不能挪进包里）。所以包里放一份同签名实现，
// adapter 里把 server.staticScript 写成相对 harness\ 的 ../static/server.mjs 即可，iter.ps1 零改动。
//
// 行为对齐项（逐条与 _tmp_static.js 相同）：
//   - 只做 GET/HEAD 静态文件，全部 no-store（验收台每次刷新都要拿到最新 js）
//   - 带 Access-Control-Allow-Origin: *
//   - '/' 当 '/index.html'
//   - 404 回 '404 <path>'
// 不同项（更严，不是更松）：
//   - 目录穿越用 path.relative 判定（_tmp_static.js 用 startsWith，兄弟目录同前缀时能穿）
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

export const contentType = (file) => MIME[path.extname(String(file)).toLowerCase()] ?? 'application/octet-stream'

// 纯函数：URL 路径 → 绝对文件路径（不碰磁盘，测试里直接断言）。
// 返回 { file } 或 { denied: 原因 }；越界一律 denied，不做"就近回退"。
export function resolveRequest(root, urlPath) {
  const raw = String(urlPath ?? '/').split('?')[0].split('#')[0]
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return { denied: 'URL 不是合法 UTF-8 编码' }
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const absRoot = path.resolve(root)
  const file = path.resolve(absRoot, rel)
  const relFromRoot = path.relative(absRoot, file)
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return { denied: `越界路径：${decoded}` }
  }
  if (relFromRoot === '') return { denied: `指向目录本身：${decoded}` }
  return { file }
}

// 只读处理器：测试里用假 req/res 直接调，不开端口。
export function createStaticHandler(root) {
  const absRoot = path.resolve(root)
  return async function handle(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Cache-Control': 'no-store', Allow: 'GET, HEAD' })
      res.end('405')
      return
    }
    const { file, denied } = resolveRequest(absRoot, req.url)
    if (denied) {
      res.writeHead(403, { 'Cache-Control': 'no-store' })
      res.end('no')
      return
    }
    let info
    try {
      info = await stat(file)
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end(`404 ${String(req.url ?? '').split('?')[0]}`)
      return
    }
    if (!info.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end(`404 ${String(req.url ?? '').split('?')[0]}`)
      return
    }
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    await new Promise((resolve) => {
      const stream = createReadStream(file)
      stream.on('error', () => {
        res.destroy()
        resolve()
      })
      stream.on('end', resolve)
      res.on('close', () => {
        stream.destroy()
        resolve()
      })
      stream.pipe(res)
    })
  }
}

export function startServer(root, port, host = '0.0.0.0') {
  const server = http.createServer(createStaticHandler(root))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const root = process.argv[2] || '.'
  const port = Number.parseInt(process.argv[3] || '8123', 10)
  const host = process.argv[4] || '0.0.0.0'
  startServer(root, port, host).then(
    () => console.log(`static root=${path.resolve(root)} url=http://${host}:${port}/`),
    (err) => {
      console.error(`静态服起不来（port=${port} host=${host}）：${err?.message ?? err}`)
      process.exit(1)
    },
  )
}
