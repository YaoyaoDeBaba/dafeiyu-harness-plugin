# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。


## 0.26.1（未发布）· 真机两处修正：指针被测试污染、面板分栏点不动

> 装着 0.26.0 第一次真机验收就撞到这两条，都是「看起来能用、其实不能用」的形状。

- **修：临时目录里的 run 不许写成「当前 run」**。`npm test` 里 `pipeline.test.mjs` 用 Temp 下的
  fixture 跑 CLI，把 `active-run.json` 写成了那个 fixture，界面于是显示一个不存在的实验
  （真实是 `runs/雷暴-r6`）。现在 `runDir` 落在系统临时目录内就跳过写指针，另留
  `DSH_SELFLOOP_NO_POINTER=1` 环境变量做显式关闭。判据：`test/ui-routes.test.mjs` 那条
  「临时目录里的 run 不许写成当前 run」。
- **修：面板分栏点击丢失**。面板每 3s 轮询重绘 `innerHTML`，元素在 mousedown→mouseup 之间被
  换掉时 `click` 永远不触发 —— 表现是「流转状态点不动」。改成 `pointerdown` 委托，
  且**内容没变就不重建 DOM**（顺带不再把滚动位置顶回顶部），z-index 提到最上。
- **修：面板压住宿主窗口按钮**。面板原本 `top:0`，右上角正好盖住窗口的最小化/关闭区，
  收起按钮和关闭按钮重合（真机差点误关窗口）。现在面板从 `top:40px` 起（标题栏下沿），
  收起按钮挪到左侧（`«`），右上角留给宿主。
- 版本 0.26.1；其余接口与 0.26.0 相同。

## 0.26.0（未发布）· 会话内 UI 的宿主侧底座：四条同源路由 + 浏览器半边

> 用户在右侧栏里要能看见流程走到哪、能填意向、能在窗口期内吐槽。这一版只做**代码与判据**，
> 装机仍需改 profile pin + 重启宿主（另开一次发版）。

- **新增四条同源路由**（`lib/routes.js`，前缀 `/plugins/dsh-selfloop`）：
  `GET /state`（流程态 + 需求/调研/验收摘要）、`GET /window`（乱入窗口开合）、
  `POST /intent-answers`（`intent.confirm.answers.json`）、`POST /interrupt`（`user-interrupt.jsonl`，
  过期标 `expired` 并回 409）。
- **窗口语义**（按用户 2026-11-17 拍板）：调查员/观察员在跑 → 开；主 Agent 正在做本环节
  （存在 `active.json`）→ 也开；`done` 一写就关。过期不丢，只顺延。
- **安全姿态**照抄大肥鱼的七条路由：只读判 Host 环回；写要自定义头 `x-selfloop: 1`。
- **新增 `lib/active-run.js`**：pipeline 每次 `status/step/done` 写一个「当前在跑哪个 run」的指针
  （`~/.dsh/dsh-selfloop/active-run.json`），插件路由只读它，不在插件里猜路径。
- **新增浏览器半边** `lib/client.js` 与 `tools/build-client.mjs`（产出 `dist/client.cjs`，外壳逐字节校验）：
  挂 `conversation.composer.dock`（状态胶囊）与 `conversation.session.header.actions`（肥鱼自治按钮），
  面板由插件 docked 到右侧渲染，两分栏「肥鱼自治 / 流转状态」。
- **修 `harness/pipeline.mjs` 不能 import 的老毛病**：加了 `isMainModule()` 守卫，
  否则插件路由一 import 它，整个进程按「用法」退出。
- **修 `expired` 布尔化 bug**：`false || (undefined && x)` 得到 `undefined`，JSON 里整条字段消失。