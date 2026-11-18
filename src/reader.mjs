import { parseXml, local, descendants } from './xml.mjs';

const attr = (node, name) => node.attrs[name];
const childElements = node => node.children.filter(child => typeof child === 'object');

function parseArea(node) {
  return {
    fileId: attr(node, 'FILEID') ?? null,
    begin: attr(node, 'BEGIN') ?? null,
    end: attr(node, 'END') ?? null,
    beType: attr(node, 'BETYPE') ?? null,
    extent: attr(node, 'EXTENT') ?? null,
    extentType: attr(node, 'EXTENTTYPE') ?? null,
  };
}

// fptr 可直接带 FILEID，也可嵌套 seq/par/area；嵌套顺序按原文档保留，不打平。
function parsePointer(node) {
  const direct = attr(node, 'FILEID') ?? null;
  const items = [];
  for (const child of childElements(node)) {
    const name = local(child);
    if (name === 'area') items.push({ kind: 'area', area: parseArea(child) });
    else if (name === 'seq' || name === 'par') items.push({ kind: name, items: parseSequence(child) });
  }
  return { fileId: direct, items };
}

function parseSequence(node) {
  return childElements(node).flatMap(child => {
    const name = local(child);
    if (name === 'area') return [{ kind: 'area', area: parseArea(child) }];
    if (name === 'seq' || name === 'par') return [{ kind: name, items: parseSequence(child) }];
    if (name === 'fptr') return [{ kind: 'fptr', pointer: parsePointer(child) }];
    return [];
  });
}

function parseDiv(node) {
  return {
    id: attr(node, 'ID') ?? null,
    type: attr(node, 'TYPE') ?? null,
    // ORDER 与 LABEL 是不同声明：ORDER 保留原始词面（可能非数字），绝不与 LABEL 互换。
    order: attr(node, 'ORDER') ?? null,
    label: attr(node, 'LABEL') ?? null,
    pointers: childElements(node).filter(child => local(child) === 'fptr').map(parsePointer),
    children: childElements(node).filter(child => local(child) === 'div').map(parseDiv),
  };
}

export function parseMets(bytes) {
  const root = parseXml(bytes);
  if (local(root) !== 'mets') throw new Error('mets_root');

  const fileGroups = descendants(root, 'fileGrp').map(group => ({
    use: attr(group, 'USE') ?? null,
    id: attr(group, 'ID') ?? null,
    files: childElements(group).filter(file => local(file) === 'file').map(file => ({
      id: attr(file, 'ID') ?? null,
      mime: attr(file, 'MIMETYPE') ?? null,
      checksum: attr(file, 'CHECKSUM') ?? null,
      checksumType: attr(file, 'CHECKSUMTYPE') ?? null,
      locations: descendants(file, 'FLocat').map(location =>
        attr(location, 'xlink:href') ?? attr(location, 'href') ?? null),
    })),
  }));

  // 两套 structMap 平行返回，保持各自 TYPE/ID 与节点身份，不合并成一棵树。
  const structMaps = descendants(root, 'structMap').map(map => ({
    id: attr(map, 'ID') ?? null,
    type: attr(map, 'TYPE') ?? null,
    divs: childElements(map).filter(child => local(child) === 'div').map(parseDiv),
  }));

  const links = descendants(root, 'structLink').flatMap(section =>
    descendants(section, 'smLink').map(link => ({
      from: attr(link, 'xlink:from') ?? attr(link, 'from') ?? null,
      to: attr(link, 'xlink:to') ?? attr(link, 'to') ?? null,
    })));

  return { kind: 'mets-structure', objectId: attr(root, 'OBJID') ?? null, fileGroups, structMaps, links };
}

// 遍历 structMap 指针，登记每个资源指向及其所在篇章路径；区域声明原样保留。
export function collectReferences(parsed) {
  const references = [];
  // 返回指针内部（seq/par/area）的指向及其相对指针的路径。
  const walkItems = (items, pointerPath) => items.flatMap((item, index) => {
    const path = [...pointerPath, index];
    if (item.kind === 'area') return [{ fileId: item.area.fileId, region: item.area, pointerPath: path }];
    if (item.kind === 'fptr') {
      const own = item.pointer.fileId
        ? [{ fileId: item.pointer.fileId, region: null, pointerPath: path }] : [];
      return [...own, ...walkItems(item.pointer.items, path)];
    }
    return walkItems(item.items, path);
  });
  const walkDiv = (div, structMap, divPath) => {
    const nextPath = [...divPath, div.id];
    div.pointers.forEach((pointer, pointerIndex) => {
      if (pointer.fileId) {
        references.push({ structMapType: structMap.type, structMapId: structMap.id,
          divId: div.id, divPath: nextPath, fileId: pointer.fileId, region: null,
          pointerPath: [pointerIndex] });
      }
      for (const ref of walkItems(pointer.items, [pointerIndex])) {
        references.push({ structMapType: structMap.type, structMapId: structMap.id,
          divId: div.id, divPath: nextPath, fileId: ref.fileId, region: ref.region,
          pointerPath: ref.pointerPath });
      }
    });
    div.children.forEach(child => walkDiv(child, structMap, nextPath));
  };
  for (const structMap of parsed.structMaps) {
    for (const div of structMap.divs) walkDiv(div, structMap, []);
  }
  return references;
}

// 兼容视图：仅 fileSec 摘要，旧调用方与 /intakes 记录形状不变。
export function inspect(bytes) {
  const parsed = parseMets(bytes);
  return {
    kind: 'mets-file-catalog',
    objectId: parsed.objectId,
    groups: parsed.fileGroups.map(group => ({
      use: group.use,
      files: group.files.map(file => ({ id: file.id, mime: file.mime,
        checksum: file.checksum, checksumType: file.checksumType,
        locations: file.locations })),
    })),
  };
}
