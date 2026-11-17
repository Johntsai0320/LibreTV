/**
 * 搜尋布林邏輯解析與求值器（純函式）：
 * 支援：
 * - OR：`|`、`||`、`｜`、大寫獨立關鍵字 `OR`
 * - AND：`&`、`&&`、`＆`、大寫獨立關鍵字 `AND`、以及空白字元（隱含 AND）
 * - NOT：字首 `-`、`!`、`！`、或大寫獨立關鍵字 `NOT`（詞中標點如 `CCTV-1`、`摔跤吧！爸爸` 視為一般字詞）
 * - 括號群組：`(...)`、`（...）`
 * - 雙引號字面詞組：`"..."`（保留空白與運算符號作為單一詞彙）
 */

export type SearchQueryNode =
  | { type: 'term'; value: string; quoted?: boolean }
  | { type: 'not'; operand: SearchQueryNode }
  | { type: 'and'; left: SearchQueryNode; right: SearchQueryNode; explicit: boolean }
  | { type: 'or'; left: SearchQueryNode; right: SearchQueryNode };

type Token =
  | { kind: 'or' }
  | { kind: 'and' }
  | { kind: 'not' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'term'; value: string; quoted?: boolean };

const WHITESPACE_RE = /\s/u;

/** 判斷字元是否可作為獨立布林運算字元（含全形符號） */
function isOperatorBoundaryStart(ch: string): boolean {
  return ch === '(' || ch === '（' || ch === ')' || ch === '）' || ch === '&' || ch === '＆' || ch === '|' || ch === '｜';
}

export function tokenizeSearchQuery(raw: string): { tokens: Token[]; hasBooleanSyntax: boolean } {
  const input = raw.trim();
  const tokens: Token[] = [];
  let hasBooleanSyntax = false;
  let i = 0;

  while (i < input.length) {
    if (WHITESPACE_RE.test(input[i])) {
      while (i < input.length && WHITESPACE_RE.test(input[i])) i++;
      continue;
    }

    const ch = input[i];

    // 1. 括號
    if (ch === '(' || ch === '（') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')' || ch === '）') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }

    // 2. OR（| / || / ｜）
    if (ch === '|' || ch === '｜') {
      hasBooleanSyntax = true;
      tokens.push({ kind: 'or' });
      i += ch === '|' && input[i + 1] === '|' ? 2 : 1;
      continue;
    }

    // 3. AND（& / && / ＆）
    if (ch === '&' || ch === '＆') {
      hasBooleanSyntax = true;
      tokens.push({ kind: 'and' });
      i += ch === '&' && input[i + 1] === '&' ? 2 : 1;
      continue;
    }

    // 4. 成對雙引號詞組 "..."
    if (ch === '"') {
      const closeIdx = input.indexOf('"', i + 1);
      if (closeIdx > i + 1) {
        const phrase = input.slice(i + 1, closeIdx).trim();
        if (phrase) {
          tokens.push({ kind: 'term', value: phrase, quoted: true });
        }
        i = closeIdx + 1;
        continue;
      }
    }

    // 5. 前置 NOT（- / ! / ！ 位於詞首，且後方有緊接詞彙或左括號）
    if ((ch === '-' || ch === '!' || ch === '！') && i + 1 < input.length && !WHITESPACE_RE.test(input[i + 1])) {
      const next = input[i + 1];
      if (next !== ')' && next !== '）' && next !== '&' && next !== '＆' && next !== '|' && next !== '｜') {
        hasBooleanSyntax = true;
        tokens.push({ kind: 'not' });
        i++;
        continue;
      }
    }

    // 6. 一般字詞：讀到空白或結構運算子為止（詞內的 - ! 如 CCTV-1、摔跤吧！爸爸 保留原字）
    const start = i;
    while (i < input.length && !WHITESPACE_RE.test(input[i]) && !isOperatorBoundaryStart(input[i])) {
      if (input[i] === '"' && input.indexOf('"', i + 1) > i) break;
      i++;
    }
    const word = input.slice(start, i);
    if (!word) {
      i++;
      continue;
    }

    if (word === 'OR') {
      hasBooleanSyntax = true;
      tokens.push({ kind: 'or' });
    } else if (word === 'AND') {
      hasBooleanSyntax = true;
      tokens.push({ kind: 'and' });
    } else if (word === 'NOT') {
      hasBooleanSyntax = true;
      tokens.push({ kind: 'not' });
    } else {
      tokens.push({ kind: 'term', value: word });
    }
  }

  return { tokens, hasBooleanSyntax };
}

export function parseSearchQuery(raw: string): { ast: SearchQueryNode | undefined; hasBooleanSyntax: boolean } {
  const { tokens, hasBooleanSyntax } = tokenizeSearchQuery(raw);
  if (tokens.length === 0) return { ast: undefined, hasBooleanSyntax: false };

  let pos = 0;
  let grouped = false;

  const peek = (): Token | undefined => tokens[pos];
  const canStartUnary = (t: Token | undefined): boolean =>
    Boolean(t && (t.kind === 'term' || t.kind === 'not' || t.kind === 'lparen'));

  const parseOr = (): SearchQueryNode | undefined => {
    let left = parseAnd();
    while (pos < tokens.length) {
      const t = peek();
      if (t?.kind !== 'or') break;
      pos++;
      const right = parseAnd();
      if (!left) left = right;
      else if (right) left = { type: 'or', left, right };
    }
    return left;
  };

  const parseAnd = (): SearchQueryNode | undefined => {
    let left = parseUnary();
    while (pos < tokens.length) {
      const t = peek();
      if (t?.kind === 'and') {
        pos++;
        const right = parseUnary();
        if (!left) left = right;
        else if (right) left = { type: 'and', left, right, explicit: true };
        continue;
      }
      if (canStartUnary(t)) {
        const right = parseUnary();
        if (!left) left = right;
        else if (right) left = { type: 'and', left, right, explicit: false };
        continue;
      }
      break;
    }
    return left;
  };

  const parseUnary = (): SearchQueryNode | undefined => {
    const t = peek();
    if (t?.kind === 'not') {
      pos++;
      const operand = parseUnary();
      return operand ? { type: 'not', operand } : undefined;
    }
    return parsePrimary();
  };

  const parsePrimary = (): SearchQueryNode | undefined => {
    const t = peek();
    if (!t) return undefined;
    if (t.kind === 'lparen') {
      pos++;
      const inner = parseOr();
      if (peek()?.kind === 'rparen') {
        pos++;
        grouped = true;
      }
      return inner;
    }
    if (t.kind === 'term') {
      pos++;
      return { type: 'term', value: t.value, quoted: t.quoted };
    }
    // 容錯：遇到孤立的運算子（例如尾端多打一個 & 或未配對的 )）直接跳過
    pos++;
    return parsePrimary();
  };

  const ast = parseOr();
  // 容錯：若前面提早遇到多餘右括號而中止，把後續剩餘 token 以空白 AND 補接上
  let root = ast;
  while (pos < tokens.length) {
    const rest = parseOr();
    if (!rest) break;
    root = root ? { type: 'and', left: root, right: rest, explicit: false } : rest;
  }

  return { ast: root, hasBooleanSyntax: hasBooleanSyntax || grouped };
}

/** 對 AST 遞迴求值 */
export function evaluateSearchAst(
  node: SearchQueryNode,
  matchTerm: (value: string, quoted?: boolean) => boolean
): boolean {
  switch (node.type) {
    case 'term':
      return matchTerm(node.value, node.quoted);
    case 'not':
      return !evaluateSearchAst(node.operand, matchTerm);
    case 'and':
      return evaluateSearchAst(node.left, matchTerm) && evaluateSearchAst(node.right, matchTerm);
    case 'or':
      return evaluateSearchAst(node.left, matchTerm) || evaluateSearchAst(node.right, matchTerm);
  }
}

/**
 * 若節點純粹由空白（隱含 AND）連接多個詞彙組成（不含 &、|、NOT、引號），
 * 回傳依序詞彙陣列，供季數別名解析（「慶餘年 2」→「慶餘年第二季」）。
 */
export function collectImplicitTerms(node: SearchQueryNode): string[] | undefined {
  if (node.type === 'term') {
    return node.quoted ? undefined : [node.value];
  }
  if (node.type === 'and' && !node.explicit) {
    const left = collectImplicitTerms(node.left);
    const right = collectImplicitTerms(node.right);
    if (left && right) return [...left, ...right];
  }
  return undefined;
}

export interface UpstreamBranchPlan {
  /** 首選向上游請求的關鍵字 */
  primary: string;
  /** 主查詢回傳 0 筆時的備援關鍵字（例如空白 AND 詞組在蘋果 CMS 查無結果時退回核心片名） */
  fallback?: string;
}

interface DnfBranch {
  positiveTerms: string[];
  hasExplicitOps: boolean;
}

function expandBranches(node: SearchQueryNode, maxBranches: number): DnfBranch[] {
  switch (node.type) {
    case 'term':
      return [{ positiveTerms: [node.value], hasExplicitOps: Boolean(node.quoted) }];
    case 'not':
      return [{ positiveTerms: [], hasExplicitOps: true }];
    case 'or': {
      const combined = [...expandBranches(node.left, maxBranches), ...expandBranches(node.right, maxBranches)];
      return combined.slice(0, maxBranches);
    }
    case 'and': {
      const leftBranches = expandBranches(node.left, maxBranches);
      const rightBranches = expandBranches(node.right, maxBranches);
      const out: DnfBranch[] = [];
      for (const l of leftBranches) {
        for (const r of rightBranches) {
          out.push({
            positiveTerms: [...l.positiveTerms, ...r.positiveTerms],
            hasExplicitOps: node.explicit || l.hasExplicitOps || r.hasExplicitOps,
          });
          if (out.length >= maxBranches) return out;
        }
      }
      return out;
    }
  }
}

function pickAnchorTerm(terms: string[]): string {
  // 優先挑較長的非純數字詞彙，減少向上游抓回過多無關條目
  const nonNumeric = terms.filter((t) => !/^\d+$/u.test(t));
  const pool = nonNumeric.length > 0 ? nonNumeric : terms;
  return pool.reduce((best, cur) => (cur.length > best.length ? cur : best), pool[0]);
}

/**
 * 依搜尋語法產生向上游蘋果 CMS 發起查詢的分支計畫：
 * - 無布林運算子（如「周處除三害」）：只發送原始詞組
 * - 純空白 AND（如「周處 2024」）：先試原始詞組，若上游無命中再退回核心片名（如「周處」）
 * - 含明確 `&` / `|` / `-` / `!` / `NOT` / `()`：展開各 OR 分支並取各分支的核心正向關鍵字
 */
export function extractUpstreamPlans(raw: string, maxBranches = 4): UpstreamBranchPlan[] {
  const { ast } = parseSearchQuery(raw);
  if (!ast) return [];

  const branches = expandBranches(ast, maxBranches);
  const plans: UpstreamBranchPlan[] = [];
  const seenPrimary = new Set<string>();

  for (const branch of branches) {
    if (branch.positiveTerms.length === 0) continue;
    const anchor = pickAnchorTerm(branch.positiveTerms);
    const primary = branch.hasExplicitOps ? anchor : branch.positiveTerms.join(' ');
    const fallback = !branch.hasExplicitOps && branch.positiveTerms.length > 1 && anchor !== primary ? anchor : undefined;

    if (!seenPrimary.has(primary)) {
      seenPrimary.add(primary);
      plans.push({ primary, fallback });
    }
  }

  return plans;
}
