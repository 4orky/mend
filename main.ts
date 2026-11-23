// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
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

type Edit = (tree: Tree) => void;

// ---------- shared line helpers (SPEC.md sections 3 and 5) ----------

interface FileText { lines: string[]; br: '\r\n' | '\n'; ends: boolean; }

function splitText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  const ok = O.map((o) => tierKey(o, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) { good = false; break; }
    }
    if (good) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findTierFrom(lines: string[], O: string[], from: number, strict: boolean, eof: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, O, t).filter((i) => i >= from);
    if (eof) occ = occ.filter((i) => i + O.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

interface NLine { text: string; ctx: boolean; oIdx: number; }

function buildReplacement(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadingWs(fileLines[pos] ?? '');
  const P = leadingWs(O[0] ?? '');
  return N.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return e.text;
  });
}

interface BodyLine { kind: 'ctx' | 'old' | 'new'; text: string; bs: boolean; }

function bodyON(body: BodyLine[]): { O: string[]; N: NLine[]; lastCtxNewBs: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  let oIdx = 0;
  let lastCtxNewBs = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') { lastCtxNewBs = b.bs; break; }
  }
  for (const b of body) {
    if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, ctx: true, oIdx }); oIdx++; }
    else if (b.kind === 'old') { O.push(b.text); oIdx++; }
    else { N.push({ text: b.text, ctx: false, oIdx: -1 }); }
  }
  return { O, N, lastCtxNewBs };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface Hunk { a: number; body: BodyLine[]; }
interface UniSection { oldPath: string | null; newPath: string | null; oldLevel: number; newLevel: number; isNew: boolean; isDel: boolean; hunks: Hunk[]; }

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function readHunk(lines: string[], hdrIdx: number, a: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = hdrIdx + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      if (l[0] === '\\') {
        if (body.length > 0) body[body.length - 1]!.bs = true;
        j++;
        continue;
      }
      let kind: 'ctx' | 'old' | 'new';
      let text: string;
      if (l === '') { kind = 'ctx'; text = ''; }
      else if (l[0] === ' ') { kind = 'ctx'; text = l.slice(1); }
      else if (l[0] === '-') { kind = 'old'; text = l.slice(1); }
      else { kind = 'new'; text = l.slice(1); }
      body.push({ kind, text, bs: false });
      j++;
    } else break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '' && !last.bs) body.pop();
    else break;
  }
  return { hunk: { a, body }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const diffGitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let cur: UniSection | null = null;
  let state: 'between' | 'header' | 'afterHunk' = 'between';
  const newSection = (oldP: string | null, newP: string | null, oldL: number, newL: number): UniSection => {
    const s: UniSection = { oldPath: oldP, newPath: newP, oldLevel: oldL, newLevel: newL, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffGitRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!, 1, 1);
      state = 'header';
      i++;
      continue;
    }
    if (state === 'between') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection(headerPath(line), headerPath(lines[i + 1]!), 3, 3);
        state = 'header';
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else i++;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur!.oldLevel < 3) { cur!.oldPath = headerPath(line); cur!.oldLevel = 3; }
          if (cur!.newLevel < 3) { cur!.newPath = headerPath(lines[i + 1]!); cur!.newLevel = 3; }
          i += 2;
        } else throw new Exit2(`error: parse ${i + 2}`);
      } else if (line.startsWith('rename from ')) {
        if (cur!.oldLevel < 2) { cur!.oldPath = line.slice('rename from '.length).trim(); cur!.oldLevel = 2; }
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur!.newLevel < 2) { cur!.newPath = line.slice('rename to '.length).trim(); cur!.newLevel = 2; }
        i++;
      } else if (line.startsWith('new file mode')) { cur!.isNew = true; i++; }
      else if (line.startsWith('deleted file mode')) { cur!.isDel = true; i++; }
      else if (line.startsWith('@@')) {
        const hm = hunkRe.exec(line);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const r = readHunk(lines, i, parseInt(hm[1]!, 10));
        cur!.hunks.push(r.hunk);
        i = r.next;
        state = 'afterHunk';
      } else i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection(headerPath(line), headerPath(lines[i + 1]!), 3, 3);
      state = 'header';
      i += 2;
    } else if (line.startsWith('@@')) {
      const hm = hunkRe.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const r = readHunk(lines, i, parseInt(hm[1]!, 10));
      cur!.hunks.push(r.hunk);
      i = r.next;
    } else i++;
  }
  return sections.map((sec) => (tree: Tree) => applyUniSection(tree, sec, strict));
}

function applyHunksToFile(f: FileText, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N, lastCtxNewBs } = bodyON(h.body);
    if (O.length > 0) {
      const found = findTier(f.lines, O, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const repl = buildReplacement(f.lines, best, O, N, found.tier);
      const runsToEnd = best + O.length === f.lines.length;
      f.lines.splice(best, O.length, ...repl);
      if (runsToEnd) f.ends = !lastCtxNewBs;
      d += N.length - O.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = idx === f.lines.length;
      f.lines.splice(idx, 0, ...N.map((e) => e.text));
      if (atEnd) f.ends = !lastCtxNewBs;
      d += N.length;
    }
  }
}

function applyUniSection(tree: Tree, sec: UniSection, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = oldP === null || sec.isNew;
  const isDelete = newP === null || sec.isDel;
  if (isCreate) {
    const p = newP;
    if (p === null) throw new Fail('unsafe', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    let plus: BodyLine[] = [];
    for (const h of sec.hunks) plus = plus.concat(h.body.filter((b) => b.kind === 'new'));
    const lastPlus = plus[plus.length - 1];
    const text = plus.length === 0 ? '' : plus.map((b) => b.text).join('\n') + (lastPlus!.bs ? '' : '\n');
    tree.now.set(p, text);
    return;
  }
  if (isDelete) {
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  if (oldP !== newP) {
    if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
    if (!safe(newP!)) throw new Fail('unsafe', newP!);
    const cur = tree.get(oldP!);
    if (cur === null) throw new Fail('missing', oldP!);
    if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const f = splitText(cur);
    applyHunksToFile(f, sec.hunks, strict, oldP!);
    const text = joinText(f);
    tree.now.set(newP!, text);
    tree.now.set(oldP!, null);
    tree.moves.push({ old: oldP!, new: newP! });
    return;
  }
  const p = oldP!;
  if (!safe(p)) throw new Fail('unsafe', p);
  const cur = tree.get(p);
  if (cur === null) throw new Fail('missing', p);
  const f = splitText(cur);
  applyHunksToFile(f, sec.hunks, strict, p);
  tree.now.set(p, joinText(f));
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (true) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitText(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const repl = buildReplacement(f.lines, pos, oldLines, N, found.tier);
      f.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinText(f));
    });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface V4aChunk { anchor: string | null; body: BodyLine[]; eof: boolean; startedByAt: boolean; }

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) { last = j; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      i++;
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith('+')) { secLines.push(l.slice(1)); i++; }
        else if (l === '') { secLines.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      const p = path;
      const ls = secLines;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let firstChunk = true;
      let cur: V4aChunk | null = null;
      const finish = (): void => { if (cur) { chunks.push(cur); cur = null; } };
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          finish();
          firstChunk = false;
          i++;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith('@@')) {
          finish();
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [], eof: false, startedByAt: true };
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!cur) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, body: [], eof: false, startedByAt: false };
          }
          let kind: 'ctx' | 'old' | 'new';
          let text: string;
          if (l === '') { kind = 'ctx'; text = ''; }
          else if (l[0] === ' ') { kind = 'ctx'; text = l.slice(1); }
          else if (l[0] === '-') { kind = 'old'; text = l.slice(1); }
          else { kind = 'new'; text = l.slice(1); }
          cur.body.push({ kind, text, bs: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finish();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === 'ctx' && b.text.trim() === '') lastChunk.body.pop();
          else break;
        }
      }
      const hasChunk = chunks.some((c) => c.body.length > 0 || c.startedByAt);
      if (!hasChunk && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitText(curText);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const idx = findAnchor(f.lines, ch.anchor, cursor, strict);
            if (idx < 0) throw new Fail('no-match', p);
            cursor = idx + 1;
          }
          const O: string[] = [];
          const N: NLine[] = [];
          let oIdx = 0;
          for (const b of ch.body) {
            if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, ctx: true, oIdx }); oIdx++; }
            else if (b.kind === 'old') { O.push(b.text); oIdx++; }
            else { N.push({ text: b.text, ctx: false, oIdx: -1 }); }
          }
          if (O.length === 0) {
            const ins = ch.eof ? f.lines.length : cursor;
            f.lines.splice(ins, 0, ...N.map((e) => e.text));
            cursor = ins + N.length;
          } else {
            const found = findTierFrom(f.lines, O, cursor, strict, ch.eof);
            if (!found) throw new Fail('no-match', p);
            const pos = found.occ[0]!;
            const repl = buildReplacement(f.lines, pos, O, N, found.tier);
            f.lines.splice(pos, O.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const text = joinText(f);
        if (mt !== null) {
          tree.now.set(mt, text);
          tree.now.set(p, null);
          tree.moves.push({ old: p, new: mt });
        } else {
          tree.now.set(p, text);
        }
      });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

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
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    const origOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const origNew = tree.original(mv.new);
    const nowNew = tree.get(mv.new);
    if (origOld !== null && nowOld === null && origNew === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
