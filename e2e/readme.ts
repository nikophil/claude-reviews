import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, write } from '../server/fixture.ts';

// The sample projects of the README's images: e2e/readme.spec.ts for the page, e2e/vscode.spec.ts for VS Code.
export const IMAGES = join(import.meta.dirname, '..', 'docs', 'images');
// A fixed path, as it shows in the pages.
export const ROOT = join(tmpdir(), 'claude-reviews-readme');

const CART = `export type Line = { label: string; price: number; quantity: number };

export function total(lines: Line[]): number {
    return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

export function format(amount: number): string {
    return \`\${amount.toFixed(2)} €\`;
}
`;

const CART_CHANGED = `export type Line = { label: string; price: number; quantity: number; vatRate: number };

const round = (amount: number) => Math.round(amount * 100) / 100;

export function total(lines: Line[]): number {
    return round(lines.reduce((sum, line) => sum + line.price * line.quantity, 0));
}

export function totalWithVat(lines: Line[]): number {
    return round(lines.reduce((sum, line) => sum + line.price * line.quantity * (1 + line.vatRate), 0));
}

export function format(amount: number): string {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount);
}
`;

const CART_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalWithVat } from './cart.ts';

test('the VAT of each line adds up', () => {
    assert.equal(totalWithVat([{ label: 'Book', price: 10, quantity: 2, vatRate: 0.055 }]), 21.1);
});
`;

/** A repository on `branch`, as Claude left it: changes not committed, and a new file. */
export function project(name: string, branch: string): string {
    const dir = join(ROOT, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, { 'src/cart.ts': CART, 'README.md': `# ${name}\n` });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'Cart');
    git(dir, 'checkout', '-qb', branch);
    write(dir, { 'src/cart.ts': CART_CHANGED, 'src/cart.test.ts': CART_TEST });
    return dir;
}
