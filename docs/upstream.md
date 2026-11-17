# 来源约定

## 产品交换范围

METS 交换子集包含 fileSec/fileGrp/file/FLocat，structMap/div/fptr/seq/par/area，structLink/smLink；使用 LOC METS 与 xlink 命名空间，不按固定前缀判断。fileGrp USE=master 是本次领取用途；thumbnail 仅保留描述不冒充原件。structMap 的 TYPE 与节点身份保留，ORDER 不等同于 LABEL；区域 FILEID/BEGIN/END/BETYPE 描述源区域，允许不具备像素/文本裁切能力，仅采集声明与原件来源。所有 href 以 METS URL 为基准，ID 作用域限当前交付，缺文件/区域指向不能由名称相似的资源替代。

## 当前来源路由

- `/primary`：application/xml
- `/pages/p1.txt`：text/plain
- `/pages/p2.txt`：text/plain
- `/pages/t1.txt`：text/plain

`/catalog` 提供入口及业务选择（`entry`、`fileUse`），来自来源而非产品硬编码。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 产品接收语义

- 入口：以 `/catalog.entry` 的 METS 为基准解释所有相对 href。领取用途取 `fileUse`（默认 `master`）；同 USE 的多个 fileGrp 均可作为该用途来源。
- 文件：仅领取所选用途的文件组。thumbnail 等其它用途只登记 USE、ID、MIMETYPE 与声明的 href，不请求字节、不冒充正文。提供 CHECKSUM/CHECKSUMTYPE 时按声明校验，不匹配视为不可用。
- 结构：LOGICAL 与 PHYSICAL 两套 structMap 独立保存为平行列表，不合并为一棵树；每个投稿节点保留 ID、TYPE、LABEL 与 ORDER。物理页序按同级 ORDER 数值排序，LABEL 不作为顺序依据。
- 区域：fptr 与 area（含 seq/par 内的）各成一条区域记录，保存 FILEID、BEGIN、END、BETYPE、EXTENT、SHAPE、COORDS 及其在 structMap 内的路径。区域只保存声明，不做裁切。
- 关联：structLink/smLink 单独保存；物理页故障经 smLink 回指其逻辑篇章。跨文件区域由同一指针组内的多个 FILEID 判定，标记 spansFiles。
- 缺失与部分接收：缺 FILEID、未知 FILEID、指向非领取用途、源状态失败或校验不匹配，都记为该区域的问题并定位到所属 div；同一文件下其它区域照常入库。补件后重领同一入口或 recheck 回到原 div 与原区域路径。
- 范围：ID 作用域限当前交付；缺指向不得用名称相似资源替代；不跨来源重定向，跨来源 href 直接判为不可用。

## 依据和范围说明

- https://www.loc.gov/standards/mets/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；通用收件接口成功只表示该单件已保存，结构交付的 `counts.issues` 为 0 才表示本次声明的区域全部可用。
