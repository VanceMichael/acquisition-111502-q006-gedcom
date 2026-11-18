// GEDCOM 7 层级行解析：保留原始行号、续行内容和未识别的行。
const LINE = /^(\d+)(?:[ \t]+(@[^@\s]+@))?[ \t]+([A-Za-z0-9_]+)(?:[ \t](.*))?$/;

export function isPointer(value) {
  return typeof value === 'string' && /^@[^@\s]+@$/.test(value.trim());
}

export function locationOf(node) {
  if (!node) return 'line:0';
  return node.lineEnd && node.lineEnd !== node.line
    ? `line:${node.line}-${node.lineEnd}`
    : `line:${node.line}`;
}

/**
 * 把 GEDCOM 文本解析成带行号的结构树。
 * CONT/CONC 会合并到被续接的节点值中，同时保留各自行号范围。
 * 解析问题只报告，不终止其余行的读取。
 */
export function parseGedcom(text) {
  const roots = [];
  const issues = [];
  const stack = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let lastContentLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    if (raw.trim() === '') continue;
    lastContentLine = lineNumber;
    const match = raw.match(LINE);
    if (!match) {
      issues.push({ reason: 'malformed_line', location: `line:${lineNumber}` });
      continue;
    }

    const level = Number(match[1]);
    const xref = match[2] || null;
    const tag = match[3];
    const value = match[4] ?? '';

    if (tag === 'CONT' || tag === 'CONC') {
      const target = stack[level - 1];
      if (!target || level !== target.level + 1) {
        issues.push({ reason: 'orphan_continuation', location: `line:${lineNumber}` });
        continue;
      }
      target.value += (tag === 'CONT' ? '\n' : '') + value;
      target.lineEnd = lineNumber;
      target.continuations.push({ tag, value, line: lineNumber });
      continue;
    }

    let parent = null;
    if (level > 0) {
      for (let candidate = Math.min(level - 1, stack.length - 1); candidate >= 0; candidate -= 1) {
        if (stack[candidate]) { parent = stack[candidate]; break; }
      }
      if (!parent || level > stack.length) {
        issues.push({ reason: 'unexpected_level', location: `line:${lineNumber}` });
      }
    }

    const node = {
      level, xref, tag, value, line: lineNumber, lineEnd: lineNumber,
      children: [], continuations: [], parent
    };
    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.length = level;
    stack[level] = node;
  }

  if (lastContentLine > 0 && !roots.some(node => node.tag === 'TRLR')) {
    issues.push({ reason: 'missing_trailer', location: `line:${lastContentLine}` });
  }

  return { roots, issues, lines };
}

