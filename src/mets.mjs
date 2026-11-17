import { parseXml, local } from './xml.mjs';

export const METS_NAMESPACE = 'http://www.loc.gov/METS/';
export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

const POINTER_NAMES = new Set(['fptr', 'area', 'seq', 'par']);

const prefixOf = name => {
  const index = name.indexOf(':');
  return index === -1 ? '' : name.slice(0, index);
};

const localName = name => name.slice(name.indexOf(':') + 1);

function scopeOf(node, parent) {
  let scope = parent;
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    if (scope === parent) scope = { ...parent };
    scope[name === 'xmlns' ? '' : name.slice(6)] = value;
  }
  return scope;
}

const namespaceOf = (node, scope) => scope[prefixOf(node.name)];

function isMetsNode(node, scope) {
  const namespace = namespaceOf(node, scope);
  return namespace === undefined || namespace === METS_NAMESPACE;
}

function metsChild(node, child, parentScope) {
  const scope = scopeOf(child, parentScope);
  return isMetsNode(child, scope) ? { node: child, scope } : null;
}

function xlinkAttribute(node, name, scope) {
  let plain = null;
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localName(key) !== name) continue;
    const prefix = prefixOf(key);
    if (prefix && scope[prefix] === XLINK_NAMESPACE) return value;
    if (!prefix) plain = value;
  }
  return plain;
}

function rootScope(root) {
  const scope = scopeOf(root, {});
  const namespace = namespaceOf(root, scope);
  if (local(root) !== 'mets') throw new Error('mets_root');
  if (namespace !== undefined && namespace !== METS_NAMESPACE) throw new Error('mets_namespace');
  return scope;
}

function fileEntry(node, scope, groupUse) {
  const locations = [];
  const visit = (current, currentScope) => {
    for (const child of current.children) {
      const resolved = metsChild(current, child, currentScope);
      if (!resolved) continue;
      if (local(child) === 'FLocat') {
        const href = xlinkAttribute(child, 'href', resolved.scope) ?? child.attrs.href ?? null;
        locations.push(href);
      } else {
        visit(child, resolved.scope);
      }
    }
  };
  visit(node, scope);
  return {
    id: node.attrs.ID ?? null,
    use: groupUse,
    mime: node.attrs.MIMETYPE ?? null,
    checksum: node.attrs.CHECKSUM ?? null,
    checksumType: node.attrs.CHECKSUMTYPE ?? null,
    groupId: node.attrs.GROUPID ?? null,
    locations,
    location: locations[0] ?? null
  };
}

function fileGroups(fileSec, scope) {
  const groups = [];
  const visit = (node, currentScope) => {
    for (const child of node.children) {
      const resolved = metsChild(node, child, currentScope);
      if (!resolved) continue;
      if (local(child) === 'fileGrp') {
        const use = child.attrs.USE ?? null;
        groups.push({
          id: child.attrs.ID ?? null,
          use,
          files: child.children
            .map(item => metsChild(child, item, resolved.scope))
            .filter(Boolean)
            .filter(item => local(item.node) === 'file')
            .map(item => fileEntry(item.node, item.scope, use))
        });
        visit(child, resolved.scope);
      } else {
        visit(child, resolved.scope);
      }
    }
  };
  visit(fileSec, scope);
  return groups;
}

function pointerNode(node, scope, owner, path, inheritedFileId, references, group) {
  const kind = local(node);
  const context = group ?? { fileIds: new Set() };
  const fileId = node.attrs.FILEID ?? null;
  const effective = fileId ?? inheritedFileId;
  if (effective) context.fileIds.add(effective);
  if (kind === 'area') {
    references.push({
      kind: 'area',
      owner,
      path,
      group: context,
      fileId,
      inheritedFileId,
      begin: node.attrs.BEGIN ?? null,
      end: node.attrs.END ?? null,
      betype: node.attrs.BETYPE ?? null,
      extent: node.attrs.EXTENT ?? null,
      shape: node.attrs.SHAPE ?? null,
      coords: node.attrs.COORDS ?? null
    });
    return {
      kind: 'area',
      fileId,
      inheritedFileId,
      begin: node.attrs.BEGIN ?? null,
      end: node.attrs.END ?? null,
      betype: node.attrs.BETYPE ?? null,
      extent: node.attrs.EXTENT ?? null,
      shape: node.attrs.SHAPE ?? null,
      coords: node.attrs.COORDS ?? null,
      fileIds: effective ? [effective] : [],
      children: []
    };
  }
  const pointer = {
    kind,
    owner,
    path,
    id: node.attrs.ID ?? null,
    fileId,
    inheritedFileId,
    children: []
  };
  const descendantsInherit = fileId ?? inheritedFileId;
  let index = 0;
  for (const child of node.children) {
    const resolved = metsChild(node, child, scope);
    if (!resolved || !POINTER_NAMES.has(local(child))) continue;
    pointer.children.push(pointerNode(child, resolved.scope, owner,
      [...path, index++], descendantsInherit, references, context));
  }
  if (kind === 'fptr') {
    references.push({ kind: 'fptr', owner, path, group: context, fileId,
      inheritedFileId, hasChildren: pointer.children.length > 0,
      begin: null, end: null, betype: null, children: [] });
  }
  const descendants = pointer.children.flatMap(child => child.fileIds ?? []);
  pointer.fileIds = [...new Set([...(fileId ? [fileId] : []), ...descendants])];
  pointer.spansFiles = pointer.fileIds.length > 1;
  return pointer;
}

function divNode(node, scope, map, path, ancestors, references) {
  const div = {
    id: node.attrs.ID ?? null,
    label: node.attrs.LABEL ?? null,
    order: node.attrs.ORDER ?? null,
    type: node.attrs.TYPE ?? null,
    dmdId: node.attrs.DMDID ?? null,
    amdId: node.attrs.AMDID ?? null,
    structMap: map.index,
    structMapType: map.type,
    path,
    blockId: `${map.index}|${path.join('.')}`,
    labelPath: node.attrs.LABEL ? [...ancestors, node.attrs.LABEL] : [...ancestors],
    children: [],
    pointers: []
  };
  const owner = { structMap: map.index, structMapType: map.type,
    divId: div.id, divPath: path, blockId: div.blockId };
  let childIndex = 0;
  let pointerIndex = 0;
  for (const child of node.children) {
    const resolved = metsChild(node, child, scope);
    if (!resolved) continue;
    if (local(child) === 'div') {
      div.children.push(divNode(child, resolved.scope, map, [...path, childIndex++],
        div.labelPath, references));
    } else if (POINTER_NAMES.has(local(child))) {
      div.pointers.push(pointerNode(child, resolved.scope, owner,
        [...path, pointerIndex++], null, references));
    }
  }
  const direct = div.pointers.flatMap(pointer => pointer.fileIds);
  div.ownFileIds = [...new Set(direct)];
  const nested = div.children.flatMap(child => child.fileIds);
  div.fileIds = [...new Set([...div.ownFileIds, ...nested])];
  div.crossFile = div.pointers.some(pointer => pointer.spansFiles);
  return div;
}

function structMaps(root, scope, references) {
  const maps = [];
  for (const child of root.children) {
    const resolved = metsChild(root, child, scope);
    if (!resolved || local(child) !== 'structMap') continue;
    const map = {
      index: maps.length,
      id: child.attrs.ID ?? null,
      type: child.attrs.TYPE ?? null,
      label: child.attrs.LABEL ?? null,
      order: child.attrs.ORDER ?? null,
      roots: []
    };
    let rootIndex = 0;
    for (const item of child.children) {
      const div = metsChild(child, item, resolved.scope);
      if (!div || local(item) !== 'div') continue;
      map.roots.push(divNode(item, div.scope, map, [rootIndex++], [], references));
    }
    maps.push(map);
  }
  return maps;
}

function structLinks(root, scope) {
  const links = [];
  const visit = (node, currentScope) => {
    for (const child of node.children) {
      const resolved = metsChild(node, child, currentScope);
      if (!resolved) continue;
      if (local(child) === 'smLink') {
        links.push({
          from: xlinkAttribute(child, 'from', resolved.scope),
          to: xlinkAttribute(child, 'to', resolved.scope)
        });
      } else {
        visit(child, resolved.scope);
      }
    }
  };
  for (const child of root.children) {
    const resolved = metsChild(root, child, scope);
    if (!resolved) continue;
    if (local(child) === 'structLink') visit(child, resolved.scope);
  }
  return links;
}

export function analyzeMets(bytes) {
  const root = parseXml(bytes);
  const scope = rootScope(root);
  const fileSec = root.children
    .map(child => metsChild(root, child, scope))
    .find(item => item && local(item.node) === 'fileSec');
  const groups = fileSec ? fileGroups(fileSec.node, fileSec.scope) : [];
  const references = [];
  const maps = structMaps(root, scope, references);
  return {
    objectId: root.attrs.OBJID ?? null,
    groups,
    files: groups.flatMap(group => group.files),
    structMaps: maps,
    links: structLinks(root, scope),
    references
  };
}
