type Token = number | "+" | "-" | "*" | "/" | "%" | "(" | ")";

function tokenize(expression: string): Token[] {
  if (expression.length > 200) throw new Error("Expression is too long");
  const tokens: Token[] = [];
  let rest = expression;
  while (rest.length > 0) {
    const whitespace = rest.match(/^\s+/)?.[0];
    if (whitespace) {
      rest = rest.slice(whitespace.length);
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
    if (number) {
      tokens.push(Number(number));
      rest = rest.slice(number.length);
      continue;
    }
    const operator = rest[0];
    if (operator && "+-*/%()".includes(operator)) {
      tokens.push(operator as Exclude<Token, number>);
      rest = rest.slice(1);
      continue;
    }
    throw new Error(`Unsupported token near "${rest.slice(0, 12)}"`);
  }
  return tokens;
}

export function evaluateArithmetic(expression: string): number {
  const tokens = tokenize(expression);
  let cursor = 0;

  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];

  const primary = (): number => {
    const token = take();
    if (typeof token === "number") return token;
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") {
      const value = sum();
      if (take() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    throw new Error("Expected a number or parenthesized expression");
  };

  const product = (): number => {
    let value = primary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = take();
      const right = primary();
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  };

  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = product();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };

  if (tokens.length === 0) throw new Error("Expression is empty");
  const result = sum();
  if (cursor !== tokens.length) throw new Error("Unexpected trailing input");
  if (!Number.isFinite(result)) throw new Error("Expression did not produce a finite number");
  return result;
}
