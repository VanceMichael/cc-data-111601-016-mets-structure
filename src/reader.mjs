import { parseXml, local, descendants } from './xml.mjs';
export function inspect(bytes) {
  const root = parseXml(bytes);
  if (local(root) !== 'mets') throw new Error('mets_root');
  return { kind: 'mets-file-catalog', objectId: root.attrs.OBJID,
    groups: descendants(root, 'fileGrp').map(group => ({ use: group.attrs.USE,
      files: group.children.filter(file => local(file) === 'file').map(file => ({ id: file.attrs.ID,
        mime: file.attrs.MIMETYPE, checksum: file.attrs.CHECKSUM, checksumType: file.attrs.CHECKSUMTYPE,
        locations: descendants(file, 'FLocat').map(location => location.attrs['xlink:href'] ?? location.attrs.href) })) })) };
}
