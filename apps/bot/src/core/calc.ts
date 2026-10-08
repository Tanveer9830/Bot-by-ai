/**
 * Tiny, dependency-free arithmetic evaluator.
 *
 * Security note: this never calls eval/Function, never touches the filesystem
 * and never accepts identifiers other than a fixed allow-list of constants and
 * functions. Input length, nesting and token count are bounded.
 */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'op'; value: string };

const MAX_INPUT_LENGTH = 200;
const MAX_TOKENS = 200;

/** Parses "15% of 200" into "0.15 * 200" before tokenising. */
function preprocess(input: string): string {
  return input
    .toLowerCase()
    .replace(/\bof\b/g, '*')
    .replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '');
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/[0-9.]/.test(char)) {
      let literal = '';
      while (index < source.length && /[0-9._]/.test(source[index] as string)) {
        const current = source[index] as string;
        if (current !== '_') literal += current;
        index += 1;
      }
      if (!/^\d*\.?\d+$/.test(literal)) throw new Error(`invalid number "${literal}"`);
      tokens.push({ type: 'number', value: Number(literal) });
      continue;
    }
    if (/[a-z]/.test(char)) {
      let name = '';
      while (index < source.length && /[a-z0-9]/.test(source[index] as string)) {
        name += source[index];
        index += 1;
      }
      tokens.push({ type: 'name', value: name });
      continue;
    }
    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character "${char}"`);
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

/** Shunting-yard conversion to RPN. */
function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operators: Token[] = [];
  let previous: Token | null = null;

  for (const token of tokens) {
    if (token.type === 'number' || (token.type === 'name' && !(token.value in FUNCTIONS))) {
      output.push(token);
    } else if (token.type === 'name') {
      operators.push(token);
    } else if (token.value === ',') {
      while (operators.length > 0 && (operators[operators.length - 1] as Token).value !== '(') {
        output.push(operators.pop() as Token);
      }
      if (operators.length === 0) throw new Error('misplaced comma');
    } else if (token.value === '(') {
      operators.push(token);
    } else if (token.value === ')') {
      while (operators.length > 0 && (operators[operators.length - 1] as Token).value !== '(') {
        output.push(operators.pop() as Token);
      }
      if (operators.length === 0) throw new Error('unbalanced parentheses');
      operators.pop();
      if (operators.length > 0 && (operators[operators.length - 1] as Token).type === 'name') {
        output.push(operators.pop() as Token);
      }
    } else {
      // Unary minus: convert to (0 - x)
      const isUnary =
        (token.value === '-' || token.value === '+') &&
        (previous === null || (previous.type === 'op' && previous.value !== ')'));
      if (isUnary) {
        if (token.value === '-') {
          output.push({ type: 'number', value: 0 });
          const next = operators[operators.length - 1];
          void next;
          operators.push({ type: 'op', value: '-' });
        }
        previous = token;
        continue;
      }
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined) throw new Error(`unsupported operator "${token.value}"`);
      while (operators.length > 0) {
        const top = operators[operators.length - 1] as Token;
        if (top.type !== 'op' || top.value === '(' || top.value === ',') break;
        const topPrecedence = PRECEDENCE[top.value] ?? 0;
        const rightAssociative = token.value === '^';
        if (topPrecedence > precedence || (topPrecedence === precedence && !rightAssociative)) {
          output.push(operators.pop() as Token);
        } else break;
      }
      operators.push(token);
    }
    previous = token;
  }
  while (operators.length > 0) {
    const token = operators.pop() as Token;
    if (token.type === 'op' && (token.value === '(' || token.value === ')'))
      throw new Error('unbalanced parentheses');
    output.push(token);
  }
  return output;
}

function evaluateRpn(rpn: Token[]): number {
  const stack: number[] = [];
  for (const token of rpn) {
    if (token.type === 'number') {
      stack.push(token.value);
      continue;
    }
    if (token.type === 'name') {
      const constant = CONSTANTS[token.value];
      const fn = FUNCTIONS[token.value];
      if (constant !== undefined) {
        stack.push(constant);
        continue;
      }
      if (!fn) throw new Error(`unknown identifier "${token.value}"`);
      const arity = token.value === 'min' || token.value === 'max' ? 2 : 1;
      if (stack.length < arity) throw new Error(`"${token.value}" needs ${arity} argument(s)`);
      const args = stack.splice(stack.length - arity, arity);
      stack.push(fn(...args));
      continue;
    }
    if (token.value === '(' || token.value === ')') throw new Error('unbalanced parentheses');
    const right = stack.pop();
    const left = stack.pop();
    if (right === undefined || left === undefined) throw new Error('incomplete expression');
    switch (token.value) {
      case '+':
        stack.push(left + right);
        break;
      case '-':
        stack.push(left - right);
        break;
      case '*':
        stack.push(left * right);
        break;
      case '/':
        if (right === 0) throw new Error('division by zero');
        stack.push(left / right);
        break;
      case '%':
        if (right === 0) throw new Error('division by zero');
        stack.push(left % right);
        break;
      case '^':
        stack.push(left ** right);
        break;
      default:
        throw new Error(`unsupported operator "${token.value}"`);
    }
  }
  if (stack.length !== 1) throw new Error('incomplete expression');
  return stack[0] as number;
}

/** Throws a descriptive Error when the expression is invalid. */
export function evaluateMath(expression: string): number {
  if (expression.length === 0) throw new Error('the expression is empty');
  if (expression.length > MAX_INPUT_LENGTH) throw new Error('the expression is too long');
  const cleaned = preprocess(expression);
  const tokens = tokenize(cleaned);
  if (tokens.length === 0) throw new Error('the expression is empty');
  if (tokens.length > MAX_TOKENS) throw new Error('the expression is too complex');
  return evaluateRpn(toRpn(tokens));
}

/** Convenience wrapper for commands: returns NaN when the input is invalid. */
export function safeEvaluateMath(expression: string): number {
  try {
    const value = evaluateMath(expression);
    return Number.isFinite(value) ? value : Number.NaN;
  } catch {
    return Number.NaN;
  }
}
