/**
 * Langage de formules du moteur de règles — évaluateur sûr, SANS eval ni new Function.
 * Grammaire :
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-' unary | primary
 *   primary := NOMBRE | IDENT | IDENT '(' expr (',' expr)* ')' | '(' expr ')'
 * Fonctions : max, min. Nombres décimaux exacts (BigInt, échelle 10^-18).
 */
import { dec, decAdd, decDiv, decMul, decSub, decToString, DecimalError } from '../../core/decimal.js';

export type FormulaNode =
  | { type: 'num'; value: string }
  | { type: 'id'; name: string }
  | { type: 'neg'; arg: FormulaNode }
  | { type: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { type: 'call'; fn: 'max' | 'min'; args: FormulaNode[] };

export class FormulaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Token = { kind: 'num' | 'id' | 'op'; text: string; pos: number };

const MAX_LENGTH = 1000;
const MAX_DEPTH = 64;
const FUNCTIONS = new Set(['max', 'min']);

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH) throw new FormulaError('FORMULA_TOO_LONG', 'Formule trop longue');
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: 'num', text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ kind: 'id', text: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      out.push({ kind: 'op', text: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError('FORMULA_SYNTAX', `Caractère inattendu « ${c} » en position ${i}`);
  }
  return out;
}

export function parseFormula(src: string): FormulaNode {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const expectOp = (op: string) => {
    const t = tokens[p];
    if (!t || t.kind !== 'op' || t.text !== op) throw new FormulaError('FORMULA_SYNTAX', `« ${op} » attendu en position ${t?.pos ?? src.length}`);
    p++;
  };

  const expr = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) throw new FormulaError('FORMULA_TOO_DEEP', 'Formule trop imbriquée');
    let left = term(depth);
    for (let t = peek(); t && t.kind === 'op' && (t.text === '+' || t.text === '-'); t = peek()) {
      p++;
      left = { type: 'bin', op: t.text as '+' | '-', left, right: term(depth) };
    }
    return left;
  };
  const term = (depth: number): FormulaNode => {
    let left = unary(depth);
    for (let t = peek(); t && t.kind === 'op' && (t.text === '*' || t.text === '/'); t = peek()) {
      p++;
      left = { type: 'bin', op: t.text as '*' | '/', left, right: unary(depth) };
    }
    return left;
  };
  const unary = (depth: number): FormulaNode => {
    const t = peek();
    if (t && t.kind === 'op' && t.text === '-') {
      p++;
      return { type: 'neg', arg: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): FormulaNode => {
    const t = peek();
    if (!t) throw new FormulaError('FORMULA_SYNTAX', 'Fin de formule inattendue');
    if (t.kind === 'num') {
      p++;
      return { type: 'num', value: t.text };
    }
    if (t.kind === 'id') {
      p++;
      const next = peek();
      if (next && next.kind === 'op' && next.text === '(') {
        if (!FUNCTIONS.has(t.text)) throw new FormulaError('FORMULA_UNKNOWN_FUNCTION', `Fonction non autorisée : ${t.text}`);
        p++;
        const args = [expr(depth + 1)];
        while (peek()?.kind === 'op' && peek()!.text === ',') {
          p++;
          args.push(expr(depth + 1));
        }
        expectOp(')');
        return { type: 'call', fn: t.text as 'max' | 'min', args };
      }
      return { type: 'id', name: t.text };
    }
    if (t.text === '(') {
      p++;
      const e = expr(depth + 1);
      expectOp(')');
      return e;
    }
    throw new FormulaError('FORMULA_SYNTAX', `Symbole inattendu « ${t.text} » en position ${t.pos}`);
  };

  const ast = expr(0);
  if (p < tokens.length) throw new FormulaError('FORMULA_SYNTAX', `Symbole inattendu « ${tokens[p]!.text} » en position ${tokens[p]!.pos}`);
  return ast;
}

export function formulaIdentifiers(node: FormulaNode, acc = new Set<string>()): Set<string> {
  switch (node.type) {
    case 'id':
      acc.add(node.name);
      break;
    case 'neg':
      formulaIdentifiers(node.arg, acc);
      break;
    case 'bin':
      formulaIdentifiers(node.left, acc);
      formulaIdentifiers(node.right, acc);
      break;
    case 'call':
      node.args.forEach((a) => formulaIdentifiers(a, acc));
      break;
    case 'num':
      break;
  }
  return acc;
}

/** Évalue l'arbre ; `resolve` fournit la valeur décimale (chaîne) de chaque identifiant. */
export function evaluateFormula(node: FormulaNode, resolve: (name: string) => string): string {
  const cache = new Map<string, bigint>();
  const ev = (n: FormulaNode): bigint => {
    switch (n.type) {
      case 'num':
        return dec(n.value);
      case 'id': {
        let v = cache.get(n.name);
        if (v === undefined) {
          v = dec(resolve(n.name));
          cache.set(n.name, v);
        }
        return v;
      }
      case 'neg':
        return -ev(n.arg);
      case 'bin': {
        const a = ev(n.left);
        const b = ev(n.right);
        if (n.op === '+') return decAdd(a, b);
        if (n.op === '-') return decSub(a, b);
        if (n.op === '*') return decMul(a, b);
        if (b === 0n) throw new FormulaError('FORMULA_DIVISION_BY_ZERO', 'Division par zéro');
        return decDiv(a, b);
      }
      case 'call': {
        const vals = n.args.map(ev);
        return vals.reduce((m, v) => (n.fn === 'max' ? (v > m ? v : m) : v < m ? v : m));
      }
    }
  };
  try {
    return decToString(ev(node));
  } catch (e) {
    if (e instanceof DecimalError) throw new FormulaError('FORMULA_INVALID_NUMBER', e.message);
    throw e;
  }
}
