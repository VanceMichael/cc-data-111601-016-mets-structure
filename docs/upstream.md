# 来源约定

## 产品交换范围

METS 交换子集包含 fileSec/fileGrp/file/FLocat，structMap/div/fptr/seq/par/area，structLink/smLink；使用 LOC METS 与 xlink 命名空间，不按固定前缀判断。fileGrp USE=master 是本次领取用途；thumbnail 仅保留描述不冒充原件。structMap 的 TYPE 与节点身份保留，ORDER 不等同于 LABEL；区域 FILEID/BEGIN/END/BETYPE 描述源区域，允许不具备像素/文本裁切能力，仅采集声明与原件来源。所有 href 以 METS URL 为基准，ID 作用域限当前交付，缺文件/区域指向不能由名称相似的资源替代。

## 产品接收语义

- LOGICAL 与 PHYSICAL 两套 structMap 平行持久化，不拼接成一棵树；structLink 单独保存。
- 仅领取选定 USE（默认 master）文件组内声明的文件，其他 USE 保留文件描述但不发起领取；区域声明与原件字节分开存储，原件以 sha256 内容寻址，区域只引用摘要。
- 单文件领取失败（HTTP 状态、校验和不符、跨来源、缺少 FLocat）只标记该文件及相关指向，同交付内其他文件继续领取；受影响篇章按 structMap 类型、divId 与从根开始的 divPath 定位。
- 未声明 FILEID 标记为 undeclared_file，指向非选定用途标记为 outside_selected_use，均不做猜测性替代。
- 重新领取同一份 METS（同来源 URL、同摘要）回到同一交付编号：已到原件保留，缺失文件补入原指针位置；来源支持 ETag 时以 If-None-Match 条件领取，304 复用已存原件。CHECKSUM/CHECKSUMTYPE（MD5、SHA-1、SHA-256、SHA-512）在领取后校验，不符则拒收且不落盘。

## 当前来源路由

- `/primary`：application/xml
- `/pages/p1.txt`：text/plain
- `/pages/p2.txt`：text/plain
- `/pages/t1.txt`：text/plain

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.loc.gov/standards/mets/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
