/**
 * Faithful TypeScript port of the subset of Python's `difflib` used by the
 * Agentera CLI: `SequenceMatcher` (with default autojunk) and `unified_diff`.
 *
 * Mirrors CPython's Lib/difflib.py closely enough to produce byte-identical
 * unified diffs for the inputs Agentera feeds it (config.toml mutation diffs).
 */

export type Opcode = [tag: string, i1: number, i2: number, j1: number, j2: number];

export class SequenceMatcher {
  private a: string[] = [];
  private b: string[] = [];
  private b2j: Map<string, number[]> = new Map();
  private bjunk: Set<string> = new Set();
  private bpopular: Set<string> = new Set();
  private matchingBlocks: Array<[number, number, number]> | null = null;
  private opcodes: Opcode[] | null = null;
  private readonly isjunk: ((s: string) => boolean) | null;
  private readonly autojunk: boolean;

  constructor(
    isjunk: ((s: string) => boolean) | null = null,
    a: string[] = [],
    b: string[] = [],
    autojunk = true,
  ) {
    this.isjunk = isjunk;
    this.autojunk = autojunk;
    this.setSeqs(a, b);
  }

  setSeqs(a: string[], b: string[]): void {
    this.setSeq1(a);
    this.setSeq2(b);
  }

  setSeq1(a: string[]): void {
    if (a === this.a) return;
    this.a = a;
    this.matchingBlocks = null;
    this.opcodes = null;
  }

  setSeq2(b: string[]): void {
    if (b === this.b) return;
    this.b = b;
    this.matchingBlocks = null;
    this.opcodes = null;
    this.chainB();
  }

  private chainB(): void {
    const b = this.b;
    this.b2j = new Map();
    for (let i = 0; i < b.length; i++) {
      const elt = b[i];
      const indices = this.b2j.get(elt);
      if (indices) indices.push(i);
      else this.b2j.set(elt, [i]);
    }

    this.bjunk = new Set();
    const junk = this.bjunk;
    const isjunk = this.isjunk;
    if (isjunk) {
      for (const elt of this.b2j.keys()) {
        if (isjunk(elt)) junk.add(elt);
      }
      for (const elt of junk) this.b2j.delete(elt);
    }

    this.bpopular = new Set();
    const popular = this.bpopular;
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of this.b2j) {
        if (idxs.length > ntest) popular.add(elt);
      }
      for (const elt of popular) this.b2j.delete(elt);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const a = this.a;
    const b = this.b;
    const b2j = this.b2j;
    const bjunk = this.bjunk;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();

    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }

    while (besti > alo && bestj > blo && !bjunk.has(b[bestj - 1]) && a[besti - 1] === this.b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !bjunk.has(this.b[bestj + bestsize]) &&
      a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize += 1;
    }

    while (besti > alo && bestj > blo && bjunk.has(this.b[bestj - 1]) && a[besti - 1] === this.b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      bjunk.has(this.b[bestj + bestsize]) &&
      a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize += 1;
    }

    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Array<[number, number, number]> {
    if (this.matchingBlocks !== null) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matchingBlocks: Array<[number, number, number]> = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k > 0) {
        matchingBlocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Array<[number, number, number]> = [];
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) nonAdjacent.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes !== null) return this.opcodes;
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size > 0) answer.push(["equal", ai, i, bj, j]);
    }
    this.opcodes = answer;
    return answer;
  }

  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes();
    if (codes.length === 0) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes[codes.length - 1][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1];
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const [tag, i1, i2, j1, j2] of codes) {
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        group.push([tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]);
        continue;
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && group[0][0] === "equal")) {
      groups.push(group);
    }
    return groups;
  }
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (length === 0) beginning -= 1;
  return `${beginning},${length}`;
}

export function unifiedDiff(
  a: string[],
  b: string[],
  fromfile = "",
  tofile = "",
  fromfiledate = "",
  tofiledate = "",
  n = 3,
  lineterm = "\n",
): string[] {
  const out: string[] = [];
  let started = false;
  const sm = new SequenceMatcher(null, a, b);
  for (const group of sm.getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      const fromdate = fromfiledate ? `\t${fromfiledate}` : "";
      const todate = tofiledate ? `\t${tofiledate}` : "";
      out.push(`--- ${fromfile}${fromdate}${lineterm}`);
      out.push(`+++ ${tofile}${todate}${lineterm}`);
    }
    const first = group[0];
    const last = group[group.length - 1];
    const file1Range = formatRangeUnified(first[1], last[2]);
    const file2Range = formatRangeUnified(first[3], last[4]);
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`);

    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push("-" + line);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push("+" + line);
      }
    }
  }
  return out;
}

/** splitlines(keepends=True) for the LF/CRLF inputs Agentera produces. */
export function splitLinesKeepEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
