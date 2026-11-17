# mets-structure

数字馆藏交付中逻辑篇章与页面资源采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

除单件读取契约外，可从 METS 入口领取整套交付：按 fileGrp USE 索取所需版本的文件，把逻辑目录、物理页序与它们指向的资源区域分别保存，保留 structMap TYPE、节点身份、ORDER 与 LABEL 的区别。LOGICAL 与 PHYSICAL 两套 structMap 保持平行，不拼成一棵树；structLink 单独保存，用于在物理页与逻辑篇章之间定位。thumbnail 等非领取用途的文件只保留声明，不当作正文原件。

领取失败或指向缺失不会回滚整次交付：其它可领取的文件照常入库，受影响的篇章列在 affected 中并带原因（unknown_file_id、missing_file_id、non_master_file、source_unavailable 等）。后续补件通过重领同一入口或 `POST /deliveries/{id}/recheck` 回到原结构位置，不产生重复投递。

`src/mets.mjs` 解析 fileSec 与两套 structMap；`src/intake.mjs` 负责按用途领取、绑定区域与定位受影响篇章；`src/reader.mjs` 保持原有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、单件记录和投递记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一次交付、读取已保存结果，再模拟来源缺页、查看受影响篇章，然后补件重查，最后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

这四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录只包含单件 raw 对象，不代表关联资料已完整。

结构交付接口：

- POST /deliveries，JSON 为 {"path":"/primary","fileUse":"master"}：从 METS 入口领取整套交付。`path` 缺省为 `/primary`，`fileUse` 缺省为 `master`。首次为 201，同入口同摘要重领为 200 并返回原 id。
- GET /deliveries：投递摘要列表（不含区域明细），带 counts、complete 和结构漂移提示。
- GET /deliveries/{id}：完整投递，含 `logical`、`physical`、`regions`、`files`、`issues`、`affected`、`structure`。
- GET /deliveries/{id}/affected：仅受影响篇章；`kind=chapter|page` 过滤，`chapterId` 按 div ID 或标签定位。
- POST /deliveries/{id}/recheck：对未领取的文件重新领取，补齐后回到原结构位置。

`regions` 每项记录所属 structMap、div、区域路径、FILEID 及 BEGIN/END/BETYPE 等声明；`fileIdSource` 区分指向是显式还是从上级 fptr 继承。`spansFiles` 表示该区域声明跨越多个文件。产品只采集声明与原件来源，不做像素或文本裁切。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；结构交付行为在 test/structure.test.mjs 与 test/delivery.test.mjs，包括两套 structMap 平行保存、ORDER/LABEL 分离、文件组用途、跨文件区域、缺失指向定位、部分领取与补件重查。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t mets-structure:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
