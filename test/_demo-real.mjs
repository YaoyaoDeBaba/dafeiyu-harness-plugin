
import { createServer } from 'node:http'
import { routeHandlers, ROUTES } from '../lib/routes.js'
const RUN = process.argv[2]
const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir: RUN }).map((h) => [h.path, h.handler]))
const server = createServer((req, res) => {
  const h = map.get((req.url || '').split('?')[0])
  if (!h) { res.writeHead(404); res.end('{}'); return }
  h(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const s = await (await fetch('http://127.0.0.1:' + port + ROUTES.state)).json()
const w = await (await fetch('http://127.0.0.1:' + port + ROUTES.window)).json()
console.log('run =', s.run.name, '| nodes =', s.nodes.length, '| 当前站 =', s.currentNode && s.currentNode.id)
const done = s.nodes.filter((n) => n.status === 'done').length
console.log('已完成', done, '/', s.nodes.length, '| 预算', JSON.stringify(s.budget))
console.log('intent:', s.intent ? (s.intent.numeric + ' 数值 / ' + s.intent.human + ' 人判 · ' + String(s.intent.restate).slice(0, 40) + '…') : '无')
console.log('research:', s.research ? (s.research.total + ' 条 · 带URL ' + s.research.withUrl + ' · used ' + s.research.used + ' · 分类 ' + JSON.stringify(s.research.byKind)) : '无')
console.log('research.top[0]:', s.research && s.research.top[0])
console.log('verify:', s.verify ? ('pass ' + s.verify.pass.length + ' / fail ' + s.verify.fail.length + ' · measuredBy=' + s.verify.measuredBy) : '无')
console.log('review:', s.review ? (s.review.verdict + ' · ' + s.review.failCount + '/' + s.review.total + ' 未过') : '无', '| decide:', s.decide && s.decide.action)
console.log('window:', JSON.stringify(w))
server.close()
