import {crc32, inflateRawSync} from 'node:zlib';

const expectedFiles = new Set(['manifest.json', 'background.js', 'portal.js']);
const maximumArchiveBytes = 8 * 1024 * 1024;
const maximumExpandedBytes = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const invalid = (reason) => {throw new Error(`Invalid Naruto extension ZIP: ${reason}.`);};

/** Allows standard metadata while refusing ZIP64 and encryption extras. */
const validateExtra = (bytes, start, length) => {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) invalid('incomplete extra field');
    const type = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2);
    if ([0x0001, 0x0017, 0x9901].includes(type) || start + 4 + size > end) invalid('unsupported extra field');
    start += 4 + size;
  }
};

/** Requires the packaged collector's exact privilege boundary without executing its code. */
const validateManifest = (data) => {
  if (data.length > 64 * 1024) invalid('oversized manifest');
  let value;
  try {value = JSON.parse(utf8.decode(data));} catch {invalid('invalid manifest JSON');}
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.manifest_version !== 3 || typeof value.name !== 'string' || !value.name || value.name.length > 200
    || typeof value.version !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value.version)
    || value.version.split('.').some(part => Number(part) > 65535)
    || value.background?.service_worker !== 'background.js' || value.background?.type !== 'module') invalid('incompatible manifest');
  const exactStrings = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === expected.length && actual.every(item => typeof item === 'string' && expected.includes(item));
  // Accept the legacy collector and the explicitly scoped tab-group update only.
  const allowedPermissions = exactStrings(value.permissions, ['tabs', 'scripting', 'storage'])
    || exactStrings(value.permissions, ['tabs', 'tabGroups', 'scripting', 'storage']);
  if (!allowedPermissions
    || !exactStrings(value.host_permissions, ['https://www.bilibili.com/*', 'https://search.bilibili.com/*',
      'https://t.bilibili.com/*', 'https://api.bilibili.com/*'])
    || ['optional_permissions', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources']
      .some(field => value[field] !== undefined)) invalid('unexpected extension permissions');
  const scripts = value.content_scripts;
  if (!Array.isArray(scripts) || scripts.length !== 1
    || !exactStrings(scripts[0]?.js, ['portal.js']) || scripts[0].all_frames !== false
    || scripts[0].run_at !== 'document_start'
    || !exactStrings(scripts[0].matches, ['https://kashewt.com/naruto*',
      'http://127.0.0.1/naruto*', 'http://localhost/naruto*'])) invalid('unexpected portal bridge');
  const csp = value.content_security_policy?.extension_pages;
  if (typeof csp !== 'string' || csp.split(';').map(part => part.trim()).filter(Boolean).join('; ')
    !== "script-src 'self'; object-src 'none'") invalid('unsafe extension policy');
};

/** Fully decodes the three-file collector ZIP, verifying layout, sizes, CRCs, UTF-8 and permissions. */
export const validateNarutoExtensionArchive = (input) => {
  if (!(input instanceof Uint8Array)) invalid('invalid archive input');
  if (input.byteLength < 22 || input.byteLength > maximumArchiveBytes) invalid('archive size limit');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {end = offset; break;}
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== 3 || bytes.readUInt16LE(end + 10) !== 3) invalid('incomplete or unexpected files');
  const centralOffset = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (centralOffset + centralSize !== end || centralOffset < 30) invalid('invalid central directory');
  let cursor = centralOffset, expandedBytes = 0;
  const entries = [], names = new Set();
  for (let index = 0; index < 3; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('incomplete central entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const attributes = bytes.readUInt32LE(cursor + 38), mode = attributes >>> 16 & 0xf000;
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & ~(0x0800 | 0x0008) || ![0, 8].includes(method)
      || bytes.readUInt16LE(cursor + 34) || (mode && mode !== 0x8000) || attributes & 0x10
      || !size || size > maximumArchiveBytes || local + 30 > centralOffset) invalid('unsupported or oversized entry');
    let name;
    try {name = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));} catch {invalid('invalid entry name');}
    if (!expectedFiles.has(name) || names.has(name)) invalid('unexpected files');
    names.add(name);
    expandedBytes += size;
    if (expandedBytes > maximumExpandedBytes) invalid('expanded size limit');
    validateExtra(bytes, cursor + 46 + nameLength, extraLength);
    entries.push({name, flags, method, compressed, size, local, crc: bytes.readUInt32LE(cursor + 16)});
    cursor = next;
  }
  if (cursor !== end || names.size !== expectedFiles.size) invalid('incomplete central directory');
  let previousEnd = 0;
  const data = new Map();
  for (const entry of entries.sort((left, right) => left.local - right.local)) {
    const local = entry.local;
    if (local !== previousEnd || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== entry.flags || bytes.readUInt16LE(local + 8) !== entry.method) invalid('invalid local entry');
    const nameLength = bytes.readUInt16LE(local + 26), extraLength = bytes.readUInt16LE(local + 28);
    const dataOffset = local + 30 + nameLength + extraLength, dataEnd = dataOffset + entry.compressed;
    if (dataEnd > centralOffset) invalid('truncated entry');
    let name;
    try {name = utf8.decode(bytes.subarray(local + 30, local + 30 + nameLength));} catch {invalid('invalid local name');}
    if (name !== entry.name) invalid('local name mismatch');
    validateExtra(bytes, local + 30 + nameLength, extraLength);
    const localCrc = bytes.readUInt32LE(local + 14), localCompressed = bytes.readUInt32LE(local + 18);
    const localSize = bytes.readUInt32LE(local + 22);
    let descriptorEnd = dataEnd;
    if (entry.flags & 8) {
      if (localCrc && localCrc !== entry.crc || localCompressed && localCompressed !== entry.compressed
        || localSize && localSize !== entry.size) invalid('local size or CRC mismatch');
      if (dataEnd + 12 > centralOffset) invalid('missing data descriptor');
      const descriptor = bytes.readUInt32LE(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      if (descriptor + 12 > centralOffset || bytes.readUInt32LE(descriptor) !== entry.crc
        || bytes.readUInt32LE(descriptor + 4) !== entry.compressed
        || bytes.readUInt32LE(descriptor + 8) !== entry.size) invalid('data descriptor mismatch');
      descriptorEnd = descriptor + 12;
    } else if (localCrc !== entry.crc || localCompressed !== entry.compressed || localSize !== entry.size) {
      invalid('local size or CRC mismatch');
    }
    let decoded;
    try {
      decoded = entry.method === 0 ? bytes.subarray(dataOffset, dataEnd)
        : inflateRawSync(bytes.subarray(dataOffset, dataEnd), {maxOutputLength: entry.size, info: true});
      if (entry.method === 8) {
        if (decoded.engine.bytesWritten !== entry.compressed) invalid('incomplete compression stream');
        decoded = decoded.buffer;
      }
    } catch {invalid('invalid compression stream');}
    if (decoded.length !== entry.size || crc32(decoded) !== entry.crc) invalid('entry CRC or size mismatch');
    let source;
    try {source = utf8.decode(decoded);} catch {invalid('invalid entry UTF-8');}
    if (!source.trim()) invalid('empty packaged file');
    data.set(entry.name, decoded);
    previousEnd = descriptorEnd;
  }
  if (previousEnd !== centralOffset) invalid('unexpected local data');
  validateManifest(data.get('manifest.json'));
};
