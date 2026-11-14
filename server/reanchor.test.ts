import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reanchor } from './reanchor.ts';

// The 16 cases of the prototype of #8, with the result it expects under its default options.
const CART = `import { Cart } from './cart';

export function total(cart: Cart): number {
  let sum = 0;
  for (const item of cart.items) {
    sum += item.price * item.quantity;
  }
  return sum;
}

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}`;

const CART_WITH_DISCOUNT = `import { Cart } from './cart';
import { Discount } from './discount';

export function discounted(cart: Cart, discount: Discount): number {
  return total(cart) * (1 - discount.rate);
}

export function total(cart: Cart): number {
  let sum = 0;
  for (const item of cart.items) {
    sum += item.price * item.quantity;
  }
  return sum;
}

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}`;

const CART_UNIT_PRICE = CART.replace('item.price', 'item.unitPrice');

const TESTS = `it('returns 0 for an empty cart', () => {
  const cart = makeCart([]);
  expect(total(cart)).toBe(0);
});

it('ignores free items', () => {
  const cart = makeCart([freeItem]);
  expect(total(cart)).toBe(0);
});`;

const BASE_WITH_LOG = `import { Cart } from './cart';

export function total(cart: Cart): number {
  let sum = 0;
  for (const item of cart.items) {
    sum += item.price * item.quantity;
  }
  console.log('total', sum);
  return sum;
}`;

const CASES: { title: string; original: string; range: [number, number]; current: string | null; expected: [number, number] | null }[] = [
    { title: 'nothing moved', original: CART, range: [6, 6], current: CART, expected: [6, 6] },
    { title: 'lines added above', original: CART, range: [6, 6], current: CART_WITH_DISCOUNT, expected: [11, 11] },
    { title: 'the commented line changes', original: CART, range: [6, 6], current: CART_UNIT_PRICE, expected: null },
    { title: 'a range of which one line changes', original: CART, range: [4, 8], current: CART_UNIT_PRICE, expected: null },
    {
        title: 'a line inserted in the range', original: CART, range: [5, 7],
        current: CART.replace('cart.items) {\n', 'cart.items) {\n    if (item.free) continue;\n'), expected: null,
    },
    { title: 'neighbours changed, line intact', original: CART, range: [6, 6], current: CART.replace('let sum = 0;', 'let sum = 0; // in cents'), expected: [6, 6] },
    {
        title: 'a line alone in the file, moved far', original: CART, range: [12, 12], expected: [4, 4],
        current: `import { Cart } from './cart';

export const isEmpty = (cart: Cart): boolean => {
  return cart.items.length === 0;
};

export function total(cart: Cart): number {
  let sum = 0;
  for (const item of cart.items) {
    sum += item.price * item.quantity;
  }
  return sum;
}`,
    },
    { title: 'a closing brace, neighbours intact', original: CART, range: [9, 9], current: CART_WITH_DISCOUNT, expected: [14, 14] },
    {
        title: 'a closing brace, everything around changed', original: CART, range: [9, 9], expected: null,
        current: `import { Cart } from './cart';

export const total = (cart: Cart): number =>
  cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}

export function count(cart: Cart): number {
  return cart.items.length;
}`,
    },
    { title: 'an empty line', original: CART, range: [10, 10], current: CART_WITH_DISCOUNT, expected: [15, 15] },
    {
        title: 'near without neighbours or far with neighbours', original: CART, range: [8, 8], expected: [14, 14],
        current: `import { Cart } from './cart';

export function subtotal(cart: Cart): number {
  let sum = 0;
  for (const line of cart.lines) sum += line.amount;
  return sum;
}

export function total(cart: Cart): number {
  let sum = 0;
  for (const item of cart.items) {
    sum += item.price * item.quantity;
  }
  return sum;
}

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}`,
    },
    {
        title: 'a test copied by Claude', original: TESTS, range: [3, 3], expected: [8, 8],
        current: `it('returns 0 for an empty cart', () => {
  const cart = makeCart([]);
  expect(total(cart)).toBe(0);
});

it('returns 0 for an empty cart', () => {
  const cart = makeCart([]);
  expect(total(cart)).toBe(0);
});

it('ignores free items', () => {
  const cart = makeCart([freeItem]);
  expect(total(cart)).toBe(0);
});`,
    },
    {
        title: 'a block indented again', original: CART, range: [6, 6], expected: null,
        current: `import { Cart } from './cart';

export function total(cart: Cart): number {
  let sum = 0;
  if (cart.items.length > 0) {
    for (const item of cart.items) {
      sum += item.price * item.quantity;
    }
  }
  return sum;
}

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}`,
    },
    { title: 'a file renamed or deleted', original: CART, range: [6, 6], current: null, expected: null },
    {
        title: 'old side: I change the base', original: BASE_WITH_LOG, range: [8, 8], expected: [9, 9],
        current: BASE_WITH_LOG.replace("from './cart';", "from './cart';\nimport { logger } from './logger';"),
    },
    {
        title: 'old side: the deletion enters the base', original: BASE_WITH_LOG, range: [8, 8], expected: null,
        current: BASE_WITH_LOG.replace("  console.log('total', sum);\n", ''),
    },
];

for (const { title, original, range: [start, end], current, expected } of CASES) {
    test(`reanchor: ${title}`, () => {
        // Captured as the server captures an Anchor: the range, and up to 3 neighbours on each side.
        const lines = original.split('\n');
        const anchor = { start, lines: lines.slice(start - 1, end), before: lines.slice(Math.max(0, start - 4), start - 1), after: lines.slice(end, end + 3) };

        const found = reanchor(anchor, current === null ? null : current.split('\n'));

        assert.deepEqual(found, expected && { start: expected[0], end: expected[1] });
    });
}
