# mets-structure

数字馆藏交付中逻辑篇章与页面资源采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

从 METS 入口领取所选版本的文件与结构映射：fileSec 文件组（含 USE 用途）、LOGICAL 与 PHYSICAL 两套 structMap 平行保存，不合并成一棵树；ORDER 与 LABEL 原样区分；fptr/seq/par/area 的资源区域声明与已存原件分开持久化，structLink 单独保留。仅领取选定 USE（默认 master）的文件，thumbnail 只保留描述、不会冒充正文原件。单文件 404、校验不符、跨来源或未声明指向被隔离标记并定位到受影响篇章，其余资料继续接收；来源补件后重新领取，资料按原 structMap 位置归位并保持同一交付编号。

`src/reader.mjs` 的 `inspect` 保留单件 fileSec 兼容契约，`parseMets`/`collectReferences` 提供完整结构与区域指向；`src/ingest.mjs` 编排按用途领取、校验、失败隔离与补件；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 以内容寻址保存原件，分别持久化接收索引与交付记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /deliveries，JSON 为 {"path":"/primary","use":"master"}（use 可省略，默认 master）：从 METS 入口领取结构映射与该用途文件，返回交付记录；结构解释失败不登记，单文件失败不阻塞其余资料。
- GET /deliveries：交付记录索引（编号、METS 摘要、来源、用途、状态）。
- GET /deliveries/{id}：读取单条交付，含平行 structMap、区域指向、文件领取结果与受影响篇章。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整；交付记录的 `status` 为 complete/incomplete，`events` 保留每次领取与补件过程，`affectedChapters` 给出缺失指向的 structMap 身份与篇章路径。

## 交付记录形状

- `fileGroups`：METS fileSec 原样分组，USE 区别保留；thumbnail 等非选定用途只在此描述，不进入 `resources`。
- `structMaps`：LOGICAL、PHYSICAL 各自独立，div 的 ID/TYPE/ORDER/LABEL 与 fptr/seq/par/area 嵌套原样保留，两套图不拼接。
- `links`：structLink/smLink 单独保存。
- `resources`：选定用途每个文件的领取结果（href、ETag、原件摘要、字节数、received/failed、原因）。
- `regions`：每个资源指向的平面视图，含 structMap 类型、divId/divPath、pointerPath、区域 BEGIN/END/BETYPE 声明与对应原件摘要；未解析指向带原因（source_status_404、checksum_mismatch、outside_source、undeclared_file、outside_selected_use 等）。
- 所有原件字节只存于内容寻址对象仓，结构与区域记录通过 sha256 摘要引用，不用相似名称资源顶替缺失指向。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖结构解析、ORDER/LABEL 与区域保留、平行 structMap、真实 HTTP 领取、校验和拒收、缺件隔离与补件归位、缩略图不领取、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，领取编排在 test/ingest.test.mjs，HTTP 流程在 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t mets-structure:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
