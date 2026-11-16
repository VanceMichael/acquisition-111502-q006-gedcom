// GEDCOM 7 行级解析器：保留每个物理行（含 CONT/CONC 续行）、行列与字节区间。
// 解析限制以 issues 显式报告，不静默丢弃任何输入。

const LINE_PATTERN = /^(\d+)(?: (@[^@]*@))? ([A-Za-z0-9_]+)(?: (.*))?$/;
const POINTER_PATTERN = /^@[^@]*@$/;

export function unescapeText(value) {
  return value.replaceAll('@@', '@');
}

function splitPhysicalLines(bytes) {
  const text = bytes.toString('utf8');
  const lines = [];
  let lineStart = 0;
  let lineNumber = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      let end = index;
      if (end > lineStart && text[end - 1] === '\r') end -= 1;
      lines.push({ lineNumber, lineStart, lineEnd: end, text: text.slice(lineStart, end) });
      lineStart = index + 1;
      lineNumber += 1;
    }
  }
  if (lineStart < text.length) {
    lines.push({ lineNumber, lineStart, lineEnd: text.length, text: text.slice(lineStart) });
  }
  return { text, lines };
}

export function parseGedcom(bytes, resourceName) {
  const issues = [];
  const { text, lines } = splitPhysicalLines(bytes);
  const nodes = [];
  const stack = [];
  let unterminated = false;

  const locationOf = (line) => `${resourceName}:line:${line.lineNumber}`;
  const addIssue = (reason, line, detail) => issues.push({ reason, location: locationOf(line), detail });

  for (const line of lines) {
    const match = line.text.match(LINE_PATTERN);
    if (!match) {
      addIssue('malformed_line', line, '行不符合 GEDCOM 层级语法，物理行已保留在原文收件中');
      continue;
    }
    const level = Number(match[1]);
    const pointer = match[2] || null;
    const tag = match[3];
    const payload = match[4] ?? '';
    const node = {
      level,
      pointer,
      tag,
      payload,
      text: unescapeText(payload),
      isPointer: POINTER_PATTERN.test(payload),
      lineNumber: line.lineNumber,
      lineStart: line.lineStart,
      lineEnd: line.lineEnd,
      location: locationOf(line),
      children: []
    };
    if (level === 0) {
      nodes.push(node);
      stack.length = 0;
      stack.push(node);
      continue;
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) {
      addIssue('orphan_line', line, `层级 ${level} 找不到上级记录，该行未挂接但原文保留`);
      continue;
    }
    if (level > parent.level + 1) addIssue('level_gap', line, '层级跳跃，已按最近上级挂接');
    parent.children.push(node);
    stack.push(node);
  }

  if (lines.length && !nodes.some(node => node.tag === 'TRLR')) {
    unterminated = true;
    const last = lines[lines.length - 1];
    issues.push({
      reason: 'unterminated_dataset',
      location: locationOf(last),
      detail: '缺少 0 TRLR，资料可能被截断；已解释的部分均标注出处'
    });
  }

  // 忠实还原续行：CONT 追加换行文本，CONC 直接拼接，物理行位置仍可逐行回查。
  const materialize = (node) => {
    const parts = [{ text: node.text, location: node.location }];
    for (const child of node.children) {
      if (child.tag === 'CONT') {
        parts.push({ text: '\n' + child.text, location: child.location });
        materialize(child);
      } else if (child.tag === 'CONC') {
        parts.push({ text: child.text, location: child.location });
        materialize(child);
      } else {
        materialize(child);
      }
    }
    node.joinedText = parts.map(part => part.text).join('');
    node.textParts = parts;
  };
  nodes.forEach(materialize);

  return { text, lines, nodes, issues, unterminated, locationOf };
}
