import { createHash } from "node:crypto";

const TOP_LEVEL_KEYS = new Set([
  "lockfileVersion",
  "settings",
  "importers",
  "packages",
  "snapshots"
]);
const IMPORTER_GROUPS = new Set(["dependencies", "devDependencies"]);
const IMPORTER_FIELDS = new Set(["specifier", "version"]);
const SNAPSHOT_FIELDS = new Set([
  "dependencies",
  "optionalDependencies",
  "optional",
  "transitivePeerDependencies"
]);
const SNAPSHOT_EDGE_GROUPS = new Set([
  "dependencies",
  "optionalDependencies"
]);

function fail(label, lineNumber, message) {
  const location = lineNumber === undefined ? label : `${label}:${lineNumber}`;
  throw new Error(`${location} ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function indentation(line) {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

function splitMappingLine(content, label, lineNumber) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let flowDepth = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      if (singleQuoted && content[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) {
      continue;
    }
    if (character === "{" || character === "[") {
      flowDepth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      flowDepth -= 1;
      if (flowDepth < 0) {
        fail(label, lineNumber, "has an unmatched flow delimiter");
      }
      continue;
    }
    if (character === ":" && flowDepth === 0) {
      return [content.slice(0, index).trim(), content.slice(index + 1).trim()];
    }
  }

  fail(label, lineNumber, "is not an unambiguous YAML mapping entry");
}

function decodeScalar(rawValue, label, lineNumber) {
  const value = rawValue.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    let decoded = "";
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] !== "'") {
        decoded += inner[index];
        continue;
      }
      if (inner[index + 1] !== "'") {
        fail(label, lineNumber, "has an invalid single-quoted scalar");
      }
      decoded += "'";
      index += 1;
    }
    return decoded;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") {
        fail(label, lineNumber, "must decode to a string");
      }
      return decoded;
    } catch {
      fail(label, lineNumber, "has an invalid double-quoted scalar");
    }
  }
  if (value.startsWith("'") || value.endsWith("'") || value.startsWith('"') || value.endsWith('"')) {
    fail(label, lineNumber, "has an unterminated quoted scalar");
  }
  return value;
}

function decodeMappingKey(rawKey, label, lineNumber) {
  const trimmed = rawKey.trim();
  const quoted =
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  if (
    !quoted &&
    /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:(?:[0-9]+(?:\.[0-9]+)?(?:e[-+]?[0-9]+)?)|(?:0[xob][0-9a-f]+)|\.(?:inf|nan))|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ].*)?)$/iu.test(
      trimmed
    )
  ) {
    fail(label, lineNumber, `uses implicit-type mapping key ${trimmed}`);
  }
  return decodeScalar(trimmed, label, lineNumber);
}

function mappingEntry(line, expectedIndent, label, lineNumber) {
  if (indentation(line) !== expectedIndent) {
    fail(label, lineNumber, `must use ${String(expectedIndent)} spaces of indentation`);
  }
  const [rawKey, rawValue] = splitMappingLine(
    line.slice(expectedIndent),
    label,
    lineNumber
  );
  const key = decodeMappingKey(rawKey, label, lineNumber);
  if (key === "") {
    fail(label, lineNumber, "has an empty mapping key");
  }
  return {
    key,
    value: decodeScalar(rawValue, label, lineNumber)
  };
}

function scanYamlSafety(line, label, lineNumber) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let unquoted = "";
  const flowDelimiters = [];
  let mappingSeparators = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      if (singleQuoted && line[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted) {
      unquoted += character;
      if (character === "{" || character === "[") {
        flowDelimiters.push(character);
      } else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (flowDelimiters.pop() !== expected) {
          fail(label, lineNumber, "has an unmatched flow delimiter");
        }
        if (
          flowDelimiters.length === 0 &&
          line.slice(index + 1).trim() !== ""
        ) {
          fail(label, lineNumber, "has content after a flow collection");
        }
      } else if (
        character === ":" &&
        flowDelimiters.length === 0 &&
        (line[index + 1] === undefined || /\s/u.test(line[index + 1]))
      ) {
        mappingSeparators += 1;
        if (mappingSeparators > 1) {
          fail(label, lineNumber, "has an ambiguous plain-scalar mapping separator");
        }
      }
      if (character === "#") {
        fail(label, lineNumber, "contains a YAML comment");
      }
      if (
        (character === "&" || character === "*" || character === "!") &&
        /[\s:[{,]/u.test(line[index - 1] ?? " ")
      ) {
        fail(label, lineNumber, "contains an unsupported YAML anchor, alias, or tag");
      }
    }
  }
  if (singleQuoted || doubleQuoted) {
    fail(label, lineNumber, "has an unterminated quote");
  }
  if (flowDelimiters.length > 0) {
    fail(label, lineNumber, "has an unterminated flow delimiter");
  }
  if (/^\s*(?:---|\.\.\.|%YAML)\s*$/u.test(unquoted)) {
    fail(label, lineNumber, "contains an unsupported YAML directive");
  }
  if (/^\s*<<\s*:/u.test(unquoted)) {
    fail(label, lineNumber, "contains an unsupported YAML merge key");
  }
  const mapping = /:\s*([>|][+-]?[0-9]*)\s*$/u.exec(unquoted);
  if (mapping !== null) {
    fail(label, lineNumber, "contains an unsupported block scalar");
  }
}

function assertNoDuplicateFlowMappingKeys(line, label, lineNumber) {
  function inspect(startIndex) {
    const keys = new Set();
    let singleQuoted = false;
    let doubleQuoted = false;
    let escaped = false;
    let sequenceDepth = 0;
    let entryStart = startIndex + 1;
    let sawComma = false;

    function inspectEntry(endIndex, allowWholeMappingEmpty = false) {
      const entry = line.slice(entryStart, endIndex).trim();
      if (entry === "") {
        if (allowWholeMappingEmpty && keys.size === 0 && !sawComma) return;
        fail(label, lineNumber, "contains an empty flow mapping entry");
      }
      const [rawKey, rawValue] = splitMappingLine(entry, label, lineNumber);
      const key = decodeMappingKey(rawKey, label, lineNumber);
      if (keys.has(key)) {
        fail(label, lineNumber, `repeats flow mapping key ${key}`);
      }
      if (rawValue === "") {
        fail(label, lineNumber, `flow mapping key ${key} has no value`);
      }
      if (!rawValue.startsWith("[") && !rawValue.startsWith("{")) {
        decodeScalar(rawValue, label, lineNumber);
      }
      keys.add(key);
    }

    for (let index = startIndex + 1; index < line.length; index += 1) {
      const character = line[index];
      if (doubleQuoted && escaped) {
        escaped = false;
        continue;
      }
      if (doubleQuoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (!doubleQuoted && character === "'") {
        if (singleQuoted && line[index + 1] === "'") {
          index += 1;
        } else {
          singleQuoted = !singleQuoted;
        }
        continue;
      }
      if (!singleQuoted && character === '"') {
        doubleQuoted = !doubleQuoted;
        continue;
      }
      if (singleQuoted || doubleQuoted) continue;
      if (character === "{") {
        fail(label, lineNumber, "contains an unsupported nested flow mapping");
        continue;
      }
      if (character === "[") {
        sequenceDepth += 1;
        continue;
      }
      if (character === "]") {
        sequenceDepth -= 1;
        if (sequenceDepth < 0) {
          fail(label, lineNumber, "has an unmatched flow sequence delimiter");
        }
        continue;
      }
      if (character === "}") {
        if (sequenceDepth !== 0) {
          fail(label, lineNumber, "has an unterminated flow sequence");
        }
        inspectEntry(index, true);
        return index;
      }
      if (character === "," && sequenceDepth === 0) {
        inspectEntry(index);
        sawComma = true;
        entryStart = index + 1;
      }
    }
    fail(label, lineNumber, "has an unterminated flow mapping");
  }

  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      if (singleQuoted && line[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && character === "{") {
      index = inspect(index);
    }
  }
}

function assertValidFlowSequences(line, label, lineNumber) {
  function inspect(startIndex) {
    const items = [];
    let singleQuoted = false;
    let doubleQuoted = false;
    let escaped = false;
    let itemStart = startIndex + 1;
    let sawComma = false;

    function inspectItem(endIndex, allowWholeSequenceEmpty = false) {
      const rawItem = line.slice(itemStart, endIndex).trim();
      if (rawItem === "") {
        if (allowWholeSequenceEmpty && items.length === 0 && !sawComma) return;
        fail(label, lineNumber, "contains an empty flow sequence entry");
      }
      if (rawItem.includes("{") || rawItem.includes("["))
        fail(label, lineNumber, "contains an unsupported nested flow collection");
      items.push(decodeMappingKey(rawItem, label, lineNumber));
    }

    for (let index = startIndex + 1; index < line.length; index += 1) {
      const character = line[index];
      if (doubleQuoted && escaped) {
        escaped = false;
        continue;
      }
      if (doubleQuoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (!doubleQuoted && character === "'") {
        if (singleQuoted && line[index + 1] === "'") {
          index += 1;
        } else {
          singleQuoted = !singleQuoted;
        }
        continue;
      }
      if (!singleQuoted && character === '"') {
        doubleQuoted = !doubleQuoted;
        continue;
      }
      if (singleQuoted || doubleQuoted) continue;
      if (character === "[" || character === "{") {
        fail(label, lineNumber, "contains an unsupported nested flow collection");
      }
      if (character === "]") {
        inspectItem(index, true);
        return index;
      }
      if (character === ",") {
        inspectItem(index);
        sawComma = true;
        itemStart = index + 1;
      }
    }
    fail(label, lineNumber, "has an unterminated flow sequence");
  }

  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      if (singleQuoted && line[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && character === "[") {
      index = inspect(index);
    }
  }
}

function normalizeLockfile(contents, label) {
  const source = String(contents);
  if (/\r(?!\n)/u.test(source)) {
    fail(label, undefined, "contains a bare carriage return");
  }
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("\t")) {
      fail(label, index + 1, "contains a tab");
    }
    scanYamlSafety(line, label, index + 1);
    assertNoDuplicateFlowMappingKeys(line, label, index + 1);
    assertValidFlowSequences(line, label, index + 1);
  }
  return { normalized, lines };
}

function assertNoDuplicateBlockKeys(lines, label, lineOffset = 0) {
  const frames = [{ indent: -1, keys: new Set() }];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const rawItem = trimmed.slice(2).trim();
      if (
        rawItem === "" ||
        rawItem.startsWith("[") ||
        rawItem.startsWith("{") ||
        (!rawItem.startsWith("'") &&
          !rawItem.startsWith('"') &&
          /:\s/u.test(rawItem))
      ) {
        fail(label, lineOffset + index + 1, "has an unsupported block sequence item");
      }
      decodeMappingKey(rawItem, label, lineOffset + index + 1);
      continue;
    }
    const indent = indentation(line);
    while (frames.length > 1 && frames.at(-1).indent >= indent) {
      frames.pop();
    }
    const entry = mappingEntry(line, indent, label, lineOffset + index + 1);
    const parent = frames.at(-1);
    if (parent.keys.has(entry.key)) {
      fail(label, lineOffset + index + 1, `repeats mapping key ${entry.key}`);
    }
    parent.keys.add(entry.key);
    if (entry.value === "") {
      frames.push({ indent, keys: new Set() });
    }
  }
}

function normalizedBlock(lines) {
  const copy = lines.map((line) => line.replace(/[ ]+$/u, ""));
  while (copy.length > 0 && copy[0].trim() === "") copy.shift();
  while (copy.length > 0 && copy.at(-1).trim() === "") copy.pop();
  return copy.join("\n");
}

function splitTopLevel(lines, label) {
  const values = new Map();
  let activeKey;
  let activeLines = [];

  function finishSection() {
    if (activeKey !== undefined && activeKey !== "lockfileVersion") {
      values.set(activeKey, activeLines);
    }
    activeKey = undefined;
    activeLines = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      if (activeKey !== undefined && activeKey !== "lockfileVersion") {
        activeLines.push(line);
      }
      continue;
    }
    if (indentation(line) === 0) {
      finishSection();
      const entry = mappingEntry(line, 0, label, index + 1);
      if (!TOP_LEVEL_KEYS.has(entry.key)) {
        fail(label, index + 1, `has unknown top-level key ${entry.key}`);
      }
      if (values.has(entry.key)) {
        fail(label, index + 1, `repeats top-level key ${entry.key}`);
      }
      if (entry.key === "lockfileVersion") {
        if (entry.value !== "9.0") {
          fail(label, index + 1, `lockfileVersion must be 9.0, got ${entry.value}`);
        }
        values.set(entry.key, entry.value);
      } else {
        if (entry.value !== "") {
          fail(label, index + 1, `${entry.key} must be a block mapping`);
        }
        activeKey = entry.key;
      }
      continue;
    }
    if (activeKey === undefined) {
      fail(label, index + 1, "has content outside a top-level section");
    }
    activeLines.push(line);
  }
  finishSection();

  for (const key of TOP_LEVEL_KEYS) {
    if (!values.has(key)) {
      fail(label, undefined, `is missing top-level key ${key}`);
    }
  }
  return values;
}

function parseSettings(lines, label) {
  const settings = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const entry = mappingEntry(line, 2, label, index + 1);
    if (settings.has(entry.key)) {
      fail(label, index + 1, `repeats setting ${entry.key}`);
    }
    if (entry.value === "") {
      fail(label, index + 1, `setting ${entry.key} must be scalar`);
    }
    settings.set(entry.key, entry.value);
  }
  if (
    settings.size !== 2 ||
    settings.get("autoInstallPeers") !== "true" ||
    settings.get("excludeLinksFromLockfile") !== "false"
  ) {
    fail(label, undefined, "has unsupported pnpm lock settings");
  }
  return {
    values: settings,
    digest: sha256(normalizedBlock(lines))
  };
}

function validatePackageName(name, label, lineNumber) {
  if (
    Buffer.byteLength(name, "utf8") > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)
  ) {
    fail(label, lineNumber, `has unsupported package name ${name}`);
  }
}

function validateRegistryReference(reference, label, lineNumber) {
  function reject() {
    fail(label, lineNumber, `has unsupported dependency reference ${reference}`);
  }

  function validateVersion(value) {
    const base = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u.exec(
      value
    )?.[0];
    if (base === undefined) reject();
    let index = base.length;
    while (index < value.length) {
      if (value[index] !== "(") reject();
      let depth = 1;
      let closingIndex = index + 1;
      for (; closingIndex < value.length; closingIndex += 1) {
        if (value[closingIndex] === "(") depth += 1;
        if (value[closingIndex] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) reject();
      const peer = value.slice(index + 1, closingIndex);
      const separator =
        peer.startsWith("@")
          ? peer.indexOf("@", peer.indexOf("/") + 1)
          : peer.indexOf("@");
      if (separator <= 0) reject();
      const dependencyName = peer.slice(0, separator);
      const peerReference = peer.slice(separator + 1);
      if (
        !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(dependencyName)
      ) {
        reject();
      }
      validateVersion(peerReference);
      index = closingIndex + 1;
    }
  }

  if (reference === "" || /\s/u.test(reference)) reject();
  validateVersion(reference);
}

function parseDepPath(depPath, label, lineNumber) {
  const separator = depPath.startsWith("@")
    ? depPath.indexOf("@", depPath.indexOf("/") + 1)
    : depPath.indexOf("@");
  if (separator <= 0) {
    fail(label, lineNumber, `has unsupported dependency path ${depPath}`);
  }
  const name = depPath.slice(0, separator);
  const reference = depPath.slice(separator + 1);
  validatePackageName(name, label, lineNumber);
  validateRegistryReference(reference, label, lineNumber);
  return {
    name,
    reference,
    packageKey: `${name}@${reference.split("(")[0]}`
  };
}

function parseImporter(lines, label) {
  const roots = new Map();
  let importerSeen = false;
  let group;
  let dependency;
  const importerGroups = new Set();
  const dependencyFields = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indent = indentation(line);
    if (indent === 2) {
      const entry = mappingEntry(line, 2, label, index + 1);
      if (importerSeen || entry.key !== "." || entry.value !== "") {
        fail(label, index + 1, "must contain exactly the '.' importer");
      }
      importerSeen = true;
      group = undefined;
      dependency = undefined;
      continue;
    }
    if (!importerSeen) {
      fail(label, index + 1, "defines importer content before '.'");
    }
    if (indent === 4) {
      const entry = mappingEntry(line, 4, label, index + 1);
      if (!IMPORTER_GROUPS.has(entry.key) || entry.value !== "") {
        fail(label, index + 1, `has unsupported importer group ${entry.key}`);
      }
      if (importerGroups.has(entry.key)) {
        fail(label, index + 1, `repeats importer group ${entry.key}`);
      }
      importerGroups.add(entry.key);
      group = entry.key;
      dependency = undefined;
      continue;
    }
    if (indent === 6 && group !== undefined) {
      const entry = mappingEntry(line, 6, label, index + 1);
      if (entry.value !== "" || roots.has(entry.key)) {
        fail(label, index + 1, `repeats or inlines root dependency ${entry.key}`);
      }
      validatePackageName(entry.key, label, index + 1);
      dependency = entry.key;
      dependencyFields.set(dependency, new Map());
      roots.set(dependency, { group });
      continue;
    }
    if (indent === 8 && dependency !== undefined) {
      const entry = mappingEntry(line, 8, label, index + 1);
      if (!IMPORTER_FIELDS.has(entry.key) || entry.value === "") {
        fail(label, index + 1, `has unsupported importer field ${entry.key}`);
      }
      const fields = dependencyFields.get(dependency);
      if (fields.has(entry.key)) {
        fail(label, index + 1, `repeats ${dependency}.${entry.key}`);
      }
      fields.set(entry.key, entry.value);
      continue;
    }
    fail(label, index + 1, "has unsupported importer structure");
  }

  if (!importerSeen || roots.size === 0) {
    fail(label, undefined, "has no root dependencies");
  }
  for (const [name, root] of roots) {
    const fields = dependencyFields.get(name);
    if (fields.size !== 2) {
      fail(label, undefined, `root ${name} must have specifier and version`);
    }
    root.specifier = fields.get("specifier");
    root.version = fields.get("version");
    validateRegistryReference(root.version, label);
  }
  return roots;
}

function splitRecords(lines, label) {
  const records = new Map();
  let key;
  let block = [];
  let startLine = 0;
  let inlineEmpty = false;

  function finish() {
    if (key === undefined) return;
    const raw = normalizedBlock(block);
    records.set(key, {
      key,
      raw,
      digest: sha256(raw),
      lines: [...block],
      startLine,
      inlineEmpty
    });
    key = undefined;
    block = [];
    inlineEmpty = false;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      if (key !== undefined) block.push(line);
      continue;
    }
    const indent = indentation(line);
    if (indent === 2) {
      finish();
      const entry = mappingEntry(line, 2, label, index + 1);
      if (records.has(entry.key)) {
        fail(label, index + 1, `repeats record ${entry.key}`);
      }
      if (entry.value !== "" && entry.value !== "{}") {
        fail(label, index + 1, `record ${entry.key} must be a mapping`);
      }
      key = entry.key;
      block = [line];
      startLine = index + 1;
      inlineEmpty = entry.value === "{}";
      continue;
    }
    if (key === undefined || indent < 4) {
      fail(label, index + 1, "has content outside a record");
    }
    if (inlineEmpty) {
      fail(label, index + 1, `inline empty record ${key} cannot have children`);
    }
    block.push(line);
  }
  finish();
  if (records.size === 0) {
    fail(label, undefined, "has no records");
  }
  return records;
}

function parseSnapshotRecord(record, label) {
  const dependencies = new Map();
  const optionalDependencies = new Map();
  const transitivePeerDependencies = new Set();
  let group;
  const groups = new Set();

  for (let index = 1; index < record.lines.length; index += 1) {
    const line = record.lines[index];
    if (line.trim() === "") continue;
    const indent = indentation(line);
    if (indent === 4) {
      const entry = mappingEntry(
        line,
        4,
        label,
        record.startLine + index
      );
      if (!SNAPSHOT_FIELDS.has(entry.key)) {
        fail(label, record.startLine + index, `has unsupported snapshot field ${entry.key}`);
      }
      if (groups.has(entry.key)) {
        fail(label, record.startLine + index, `repeats snapshot field ${entry.key}`);
      }
      groups.add(entry.key);
      if (SNAPSHOT_EDGE_GROUPS.has(entry.key)) {
        if (entry.value !== "") {
          fail(label, record.startLine + index, `${entry.key} must be a mapping`);
        }
        group = entry.key;
      } else if (entry.key === "transitivePeerDependencies") {
        if (entry.value !== "") {
          fail(label, record.startLine + index, `${entry.key} must be a sequence`);
        }
        group = entry.key;
      } else {
        if (entry.value !== "true") {
          fail(label, record.startLine + index, "optional must be true");
        }
        group = undefined;
      }
      continue;
    }
    if (indent === 6 && SNAPSHOT_EDGE_GROUPS.has(group)) {
      const entry = mappingEntry(
        line,
        6,
        label,
        record.startLine + index
      );
      if (entry.value === "") {
        fail(label, record.startLine + index, "dependency reference must be scalar");
      }
      validatePackageName(entry.key, label, record.startLine + index);
      validateRegistryReference(entry.value, label, record.startLine + index);
      const target =
        group === "dependencies" ? dependencies : optionalDependencies;
      if (target.has(entry.key)) {
        fail(label, record.startLine + index, `repeats dependency ${entry.key}`);
      }
      target.set(entry.key, entry.value);
      continue;
    }
    if (
      indent === 6 &&
      group === "transitivePeerDependencies" &&
      line.trim().startsWith("- ") &&
      line.trim().length > 2
    ) {
      const dependencyName = decodeScalar(
        line.trim().slice(2),
        label,
        record.startLine + index
      );
      validatePackageName(dependencyName, label, record.startLine + index);
      if (transitivePeerDependencies.has(dependencyName)) {
        fail(
          label,
          record.startLine + index,
          `repeats transitive peer dependency ${dependencyName}`
        );
      }
      transitivePeerDependencies.add(dependencyName);
      continue;
    }
    fail(label, record.startLine + index, "has unsupported snapshot structure");
  }
  return { dependencies, optionalDependencies };
}

function packageKeyForSnapshot(packages, snapshotKey, label) {
  const expectedKey = parseDepPath(snapshotKey, label).packageKey;
  if (!packages.has(expectedKey)) {
    fail(label, undefined, `snapshot ${snapshotKey} has no package metadata`);
  }
  return expectedKey;
}

function resolveReference(graph, dependencyName, reference) {
  const key = `${dependencyName}@${reference}`;
  if (!graph.snapshots.has(key)) {
    fail(
      graph.label,
      undefined,
      `cannot resolve ${dependencyName} reference ${reference}`
    );
  }
  return key;
}

export function rootClosure(graph, dependencyNames) {
  const nodes = new Set();
  const edges = new Set();

  function visit(snapshotKey) {
    if (nodes.has(snapshotKey)) return;
    nodes.add(snapshotKey);
    const snapshot = graph.snapshots.get(snapshotKey);
    for (const [kind, dependencies] of [
      ["dependency", snapshot.dependencies],
      ["optionalDependency", snapshot.optionalDependencies]
    ]) {
      for (const [dependencyName, reference] of dependencies) {
        const childKey = resolveReference(graph, dependencyName, reference);
        edges.add(`${snapshotKey} -> ${kind}:${dependencyName}:${childKey}`);
        visit(childKey);
      }
    }
  }

  for (const dependencyName of dependencyNames) {
    const root = graph.roots.get(dependencyName);
    if (root === undefined) {
      fail(graph.label, undefined, `is missing root dependency ${dependencyName}`);
    }
    visit(resolveReference(graph, dependencyName, root.version));
  }
  return { nodes, edges };
}

export function resolvedRootVersion(graph, dependencyName) {
  const root = graph.roots.get(dependencyName);
  if (root === undefined) return undefined;
  const snapshotKey = resolveReference(graph, dependencyName, root.version);
  const packageKey = graph.snapshots.get(snapshotKey).packageKey;
  const prefix = `${dependencyName}@`;
  if (!packageKey.startsWith(prefix)) {
    fail(graph.label, undefined, `root ${dependencyName} resolves to ${packageKey}`);
  }
  return packageKey.slice(prefix.length);
}

export function parsePnpmLockV9(contents, label = "pnpm-lock.yaml") {
  const { lines } = normalizeLockfile(contents, label);
  assertNoDuplicateBlockKeys(lines, label);
  const topLevel = splitTopLevel(lines, label);
  const settings = parseSettings(topLevel.get("settings"), `${label}:settings`);
  const roots = parseImporter(topLevel.get("importers"), `${label}:importers`);
  const packages = splitRecords(topLevel.get("packages"), `${label}:packages`);
  const snapshots = splitRecords(topLevel.get("snapshots"), `${label}:snapshots`);
  for (const packageKey of packages.keys()) {
    const parsed = parseDepPath(packageKey, `${label}:packages`);
    if (parsed.packageKey !== packageKey) {
      fail(
        label,
        undefined,
        `package metadata key ${packageKey} must not contain a peer suffix`
      );
    }
  }
  for (const snapshotKey of snapshots.keys()) {
    parseDepPath(snapshotKey, `${label}:snapshots`);
  }
  const ownership = new Map(
    [...packages.keys()].map((key) => [key, new Set()])
  );

  for (const record of snapshots.values()) {
    const parsed = parseSnapshotRecord(record, `${label}:snapshots:${record.key}`);
    record.dependencies = parsed.dependencies;
    record.optionalDependencies = parsed.optionalDependencies;
    record.packageKey = packageKeyForSnapshot(packages, record.key, label);
    ownership.get(record.packageKey).add(record.key);
  }

  const graph = {
    label,
    roots,
    settings,
    packages,
    snapshots,
    ownership
  };

  for (const [name, root] of roots) {
    resolveReference(graph, name, root.version);
  }
  for (const snapshot of snapshots.values()) {
    for (const dependencies of [
      snapshot.dependencies,
      snapshot.optionalDependencies
    ]) {
      for (const [name, reference] of dependencies) {
        resolveReference(graph, name, reference);
      }
    }
  }

  const reachable = rootClosure(graph, [...roots.keys()]).nodes;
  if (reachable.size !== snapshots.size) {
    const orphan = [...snapshots.keys()].find((key) => !reachable.has(key));
    fail(label, undefined, `contains orphan snapshot ${orphan}`);
  }
  for (const [packageKey, owners] of ownership) {
    if (owners.size === 0) {
      fail(label, undefined, `contains orphan package metadata ${packageKey}`);
    }
  }
  return graph;
}

function setDifference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function sameRoot(left, right) {
  return (
    left?.group === right?.group &&
    left?.specifier === right?.specifier &&
    left?.version === right?.version
  );
}

function packageIsExclusive(graph, packageKey, exclusiveSnapshots) {
  const owners = graph.ownership.get(packageKey);
  return (
    owners !== undefined &&
    owners.size > 0 &&
    [...owners].every((snapshotKey) => exclusiveSnapshots.has(snapshotKey))
  );
}

export function compareLockMigration({
  legacyGraph,
  targetGraph,
  legacyAllowedRoots,
  targetAllowedRoots,
  frozenRoots,
  expectedTargetVersions,
  expectedTargetRoots = {}
}) {
  const errors = [];
  const legacyAllowed = new Set(legacyAllowedRoots);
  const targetAllowed = new Set(targetAllowedRoots);
  const frozen = new Set(frozenRoots);
  const expectedLegacyRoots = new Set([...frozen, ...legacyAllowed]);
  const expectedTargetRootSet = new Set([...frozen, ...targetAllowed]);

  function compareRootSet(graph, expected, side) {
    const actual = new Set(graph.roots.keys());
    for (const name of expected) {
      if (!actual.has(name)) errors.push(`${side} lock is missing direct dependency ${name}`);
    }
    for (const name of actual) {
      if (!expected.has(name)) errors.push(`${side} lock has unexpected direct dependency ${name}`);
    }
  }

  compareRootSet(legacyGraph, expectedLegacyRoots, "legacy");
  compareRootSet(targetGraph, expectedTargetRootSet, "target");
  if (legacyGraph.settings.digest !== targetGraph.settings.digest) {
    errors.push("pnpm lock settings changed");
  }
  for (const name of frozen) {
    if (!sameRoot(legacyGraph.roots.get(name), targetGraph.roots.get(name))) {
      errors.push(`frozen direct dependency ${name} changed`);
    }
  }
  for (const [name, expectedVersion] of Object.entries(expectedTargetVersions)) {
    let actual;
    try {
      actual = resolvedRootVersion(targetGraph, name);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (actual !== expectedVersion) {
      errors.push(
        `resolved ${name} version must be ${expectedVersion}, got ${actual ?? "<missing>"}`
      );
    }
  }
  for (const [name, expected] of Object.entries(expectedTargetRoots)) {
    const actual = targetGraph.roots.get(name);
    if (
      actual?.group !== expected.group ||
      actual?.specifier !== expected.specifier
    ) {
      errors.push(
        `target direct dependency ${name} must be ${expected.group} ` +
          `${expected.specifier}`
      );
    }
  }

  let legacyAllowedClosure;
  let targetAllowedClosure;
  let legacyFrozenClosure;
  let targetFrozenClosure;
  try {
    legacyAllowedClosure = rootClosure(legacyGraph, [...legacyAllowed]);
    targetAllowedClosure = rootClosure(targetGraph, [...targetAllowed]);
    legacyFrozenClosure = rootClosure(legacyGraph, [...frozen]);
    targetFrozenClosure = rootClosure(targetGraph, [...frozen]);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { errors, stats: {} };
  }
  const legacyExclusive = setDifference(
    legacyAllowedClosure.nodes,
    legacyFrozenClosure.nodes
  );
  const targetExclusive = setDifference(
    targetAllowedClosure.nodes,
    targetFrozenClosure.nodes
  );

  const snapshotKeys = new Set([
    ...legacyGraph.snapshots.keys(),
    ...targetGraph.snapshots.keys()
  ]);
  for (const key of snapshotKeys) {
    const legacyRecord = legacyGraph.snapshots.get(key);
    const targetRecord = targetGraph.snapshots.get(key);
    if (legacyRecord === undefined) {
      if (!targetExclusive.has(key)) {
        errors.push(`lockfile added protected snapshot ${key}`);
      }
    } else if (targetRecord === undefined) {
      if (!legacyExclusive.has(key)) {
        errors.push(`lockfile removed protected snapshot ${key}`);
      }
    } else if (
      legacyRecord.digest !== targetRecord.digest &&
      !(legacyExclusive.has(key) && targetExclusive.has(key))
    ) {
      errors.push(`lockfile changed protected snapshot ${key}`);
    }
  }

  const packageKeys = new Set([
    ...legacyGraph.packages.keys(),
    ...targetGraph.packages.keys()
  ]);
  for (const key of packageKeys) {
    const legacyRecord = legacyGraph.packages.get(key);
    const targetRecord = targetGraph.packages.get(key);
    if (legacyRecord === undefined) {
      if (!packageIsExclusive(targetGraph, key, targetExclusive)) {
        errors.push(`lockfile added protected package metadata ${key}`);
      }
    } else if (targetRecord === undefined) {
      if (!packageIsExclusive(legacyGraph, key, legacyExclusive)) {
        errors.push(`lockfile removed protected package metadata ${key}`);
      }
    } else if (
      legacyRecord.digest !== targetRecord.digest &&
      !(
        packageIsExclusive(legacyGraph, key, legacyExclusive) &&
        packageIsExclusive(targetGraph, key, targetExclusive)
      )
    ) {
      errors.push(`lockfile changed protected package metadata ${key}`);
    }
  }

  return {
    errors,
    stats: {
      legacySnapshots: legacyGraph.snapshots.size,
      targetSnapshots: targetGraph.snapshots.size,
      legacyEdges: rootClosure(legacyGraph, [...legacyGraph.roots.keys()]).edges.size,
      targetEdges: rootClosure(targetGraph, [...targetGraph.roots.keys()]).edges.size,
      legacyAllowedExclusive: legacyExclusive.size,
      targetAllowedExclusive: targetExclusive.size,
      frozenRoots: frozen.size
    }
  };
}
