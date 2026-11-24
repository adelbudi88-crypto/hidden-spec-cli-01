// mend — one patch tool for every AI edit format.
//
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` reads a patch in one of four
// formats (a unified diff, SEARCH/REPLACE blocks, a V4A patch, JSON tool calls) and applies
// its edits to the tree in the working directory: every file changes, or nothing does.
// SPEC.md is the whole contract; this file is a fresh implementation of it, written from the
// spec alone. Node 22, standard library only, deterministic, no installs.
//
// How the work is laid out:
//   1. the command line, the output and the exit codes (SPEC 1-2)
//   2. the tree, safe paths, and a file's lines and line break (SPEC 3)
//   3. matching old lines at three tiers (SPEC 5)
//   4. the four readers (SPEC 6-9), each producing a list of edits
//   5. applying the edits in order, all or nothing (SPEC 10)
// A trial hands over to runner.ts at the bottom, exactly as the kit asks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the one line the CLI prints. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no `\`, and no segment is empty, `.` or `..`. */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: it reads the tree as earlier edits left it and records its change in `tree.now`. */
type Edit = (tree: Tree) => void;

/** A file as lines: its break (CRLF when its first line feed follows a carriage return, else LF), its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** A line as a tier reads it: tier 0 exact, tier 1 trailing spaces and tabs off, tier 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O matches the file's lines at this tier; overlaps count. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  if (o.length === 0) return hits;
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which O occurs at least once. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk or chunk: ' ' a context line, '-' an old line, '+' a new line. */
type Op = { t: ' ' | '-' | '+'; text: string };

/**
 * The lines that replace the matched lines. A context line is written as the file's own matched
 * line, never the patch's. At tier 2 every other line of N is re-indented: with F the leading
 * spaces and tabs of the file's first matched line and P those of O's first line, a line of N
 * that is not empty and not only whitespace, and starts with P, has that P replaced by F.
 */
function applyOps(ops: Op[], fileLines: string[], pos: number, tier: number, oFirst: string): string[] {
  const fLead = leadWs(fileLines[pos] ?? '');
  const pLead = leadWs(oFirst);
  const out: string[] = [];
  let fi = pos;
  for (const op of ops) {
    if (op.t === ' ') {
      out.push(fileLines[fi]!);
      fi += 1;
    } else if (op.t === '-') {
      fi += 1;
    } else if (tier === 2 && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(pLead)) {
      out.push(fLead + op.text.slice(pLead.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

/** Detect the format (SPEC 4): the first of v4a, json, search-replace, unified that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(f));
    };
  }
  return null;
}

/** A JSON patch: one array of edit objects, or JSON Lines with one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The old start line A from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  /** The body in order: context, old, new, and `\` lines (the `\` line's text is ignored). */
  body: { t: ' ' | '-' | '+' | '\\'; text: string }[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: the text after the four characters, up to the first tab, trimmed. */
function headerPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function parseUnified(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let cur: Section | null = null;
  let state: 'none' | 'header' | 'between' = 'none';

  const noPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const asPath = (raw: string): string | null => (raw === '/dev/null' ? null : noPrefix(raw));
  const openSection = (oldP: string | null, newP: string | null): Section => {
    const s: Section = {
      oldPath: oldP,
      newPath: newP,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      create: false,
      remove: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = openSection(m[1]!, m[2]!);
      state = 'header';
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = asPath(headerPath(l));
      const newP = asPath(headerPath(lines[i + 1]!));
      if (state === 'header' && !cur!.hasPair) {
        // The section's own pair: it names this section's paths.
        cur!.oldPath = oldP;
        cur!.newPath = newP;
        cur!.hasPair = true;
      } else {
        // A section already holding a pair, or no section at all: a new section starts.
        cur = openSection(oldP, newP);
        cur.hasPair = true;
        state = 'header';
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && state === 'header') throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b === '') {
          hunk.body.push({ t: ' ', text: '' });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          if (c === '-' && b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          hunk.body.push({ t: c, text: b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.t === ' ' && lastB.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      state = 'between';
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    if (!s.hasPair) {
      if (s.renameFrom !== null) s.oldPath = s.renameFrom === '/dev/null' ? null : s.renameFrom;
      if (s.renameTo !== null) s.newPath = s.renameTo === '/dev/null' ? null : s.renameTo;
    }
    edits.push(unifiedEdit(s, strict, moves));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    if (hunk.body[k]!.t === ' ' || hunk.body[k]!.t === '+') return hunk.body[k + 1]?.t === '\\';
  }
  return false;
}

function unifiedEdit(s: Section, strict: boolean, moves: [string, string][]): Edit {
  const opsOf = (h: Hunk): Op[] =>
    h.body.filter((b) => b.t !== '\\').map((b) => ({ t: b.t as ' ' | '-' | '+', text: b.text }));

  /** Apply the section's hunks in order, each to the result of the ones before it. */
  const applyHunks = (f: FileState, path: string): void => {
    let d = 0;
    for (const h of s.hunks) {
      const ops = opsOf(h);
      const o = ops.filter((x) => x.t === ' ' || x.t === '-').map((x) => x.text);
      const nn = ops.filter((x) => x.t === ' ' || x.t === '+').map((x) => x.text);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines = f.lines.slice(0, at).concat(nn, f.lines.slice(at));
        if (atEnd) f.final = !backslashAfterLast(h);
      } else {
        const found = findTier(f.lines, o, strict);
        if (found === null) throw new Fail('no-match', path);
        const target = h.a - 1 + d;
        let pos = found.occ[0]!;
        let best = Math.abs(pos - target);
        for (const p of found.occ) {
          const dist = Math.abs(p - target);
          if (dist < best) {
            best = dist;
            pos = p;
          }
        }
        const out = applyOps(ops, f.lines, pos, found.tier, o[0]!);
        const toEnd = pos + o.length === f.lines.length;
        f.lines = f.lines.slice(0, pos).concat(out, f.lines.slice(pos + o.length));
        if (toEnd) f.final = !backslashAfterLast(h);
      }
      d += nn.length - o.length;
    }
  };

  return (tree: Tree): void => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (s.create || oldP === null) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.t === '+') plus.push(b.text);
      let finalBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const b = s.hunks[hi]!.body;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]!.t === '+') {
            finalBreak = b[k + 1]?.t !== '\\';
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (s.remove || newP === null) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(text);
      applyHunks(f, oldP);
      tree.now.set(newP, serializeFile(f));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const f = parseFile(text);
    applyHunks(f, oldP);
    tree.now.set(oldP, serializeFile(f));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = parseFile(text);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const ops: Op[] = [
      ...oldLines.map((t) => ({ t: '-' as const, text: t })),
      ...newLines.map((t) => ({ t: '+' as const, text: t })),
    ];
    const out = applyOps(ops, f.lines, pos, found.tier, oldLines[0]!);
    f.lines = f.lines.slice(0, pos).concat(out, f.lines.slice(pos + oldLines.length));
    tree.now.set(path, serializeFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

function parseV4a(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') ||
    l.startsWith('*** Delete File: ') ||
    l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const raw = lines.slice(i + 1, j).map((text, k) => ({ text, num: i + 2 + k }));
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aEdit(kind, path, raw, i + 1, strict, moves));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  raw: { text: string; num: number }[],
  sectionLine: number,
  strict: boolean,
  moves: [string, string][],
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, num } of raw) {
      if (text === '') fileLines.push('');
      else if (text.startsWith('+')) fileLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }

  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let afterEof = false;
  for (; idx < raw.length; idx++) {
    const { text, num } = raw[idx]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
      chunks.push(cur);
      afterEof = false;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      afterEof = true;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (afterEof) throw new Exit2(`error: parse ${num}`);
      if (cur === null) {
        cur = { anchor: null, eof: false, ops: [] };
        chunks.push(cur);
      }
      if (text === '') cur.ops.push({ t: ' ', text: '' });
      else cur.ops.push({ t: text[0] as ' ' | '-' | '+', text: text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);

  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(f.lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o = chunk.ops.filter((x) => x.t === ' ' || x.t === '-').map((x) => x.text);
      const nn = chunk.ops.filter((x) => x.t === ' ' || x.t === '+').map((x) => x.text);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines = f.lines.slice(0, at).concat(nn, f.lines.slice(at));
        cursor = at + nn.length;
      } else {
        const found = findTier(f.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (chunk.eof) {
          const end = found.occ.find((p) => p + o.length === f.lines.length);
          if (end === undefined) throw new Fail('no-match', path);
          pos = end;
        } else {
          pos = found.occ[0]!;
        }
        const out = applyOps(chunk.ops, f.lines, pos, found.tier, o[0]!);
        f.lines = f.lines.slice(0, pos).concat(out, f.lines.slice(pos + o.length));
        cursor = pos + out.length;
      }
    }
    const result = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  // One line per changed path, in byte order of the paths; a move that succeeded prints
  // `R <old> -> <new>` instead of that pair's `D` and `A` lines, and sorts by `<new>`.
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  const seenR = new Set<string>();
  for (const [oldP, newP] of moves) {
    const pairKey = `${oldP}\0${newP}`;
    if (seenR.has(pairKey)) continue;
    seenR.add(pairKey);
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressedD.add(oldP);
      suppressedA.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && suppressedA.has(p)) continue;
    if (now === null && suppressedD.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
