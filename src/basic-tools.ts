import type { Plugin } from 'cordis';
import { Failure } from './errors.js';

export function calculate(expression: string): number {
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/%^-]/g) ?? [];
  if (expression.replace(/\s+/g, '') !== tokens.join('') || tokens.length > 256 || !tokens.length) throw new Failure('calculation_invalid');
  let index = 0;
  function part(minimum = 0, depth = 0): number {
    if (depth > 32) throw new Failure('calculation_invalid');
    const token = tokens[index++]; let value: number;
    if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * part(3, depth + 1);
    else if (token === '(') { value = part(0, depth + 1); if (tokens[index++] !== ')') throw new Failure('calculation_invalid'); }
    else { value = Number(token); if (!Number.isFinite(value)) throw new Failure('calculation_invalid'); }
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
    while (index < tokens.length) {
      const op = tokens[index!]!, level = precedence[op];
      if (level === undefined || level < minimum) break;
      index++; const right = part(level + (op === '^' ? 0 : 1), depth + 1);
      value = op === '+' ? value + right : op === '-' ? value - right : op === '*' ? value * right
        : op === '/' ? value / right : op === '%' ? value % right : value ** right;
      if (!Number.isFinite(value)) throw new Failure('calculation_invalid');
    }
    return value;
  }
  const result = part(); if (index !== tokens.length) throw new Failure('calculation_invalid'); return result;
}
export const basicToolsPlugin: Plugin.Object<void> = { name: 'xiaolang-basic-tools', inject: ['tools'], apply(ctx) {
  ctx.effect(() => ctx.tools.register({ name: 'calculate', title: '计算', summary: '数值表达式计算', source: 'xiaolang-basic-tools', effect: 'read',
    description: '计算数值表达式，支持加减乘除、取余、乘方和括号，不执行程序代码。',
    parameters: { type: 'object', additionalProperties: false, required: ['expression'], properties: { expression: { type: 'string', minLength: 1, maxLength: 1000 } } },
    execute: async args => ({ result: calculate(String(args.expression)) }) }));
} };
