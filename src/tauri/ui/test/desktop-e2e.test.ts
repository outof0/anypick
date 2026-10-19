import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('compiles the actual JavaScript sent to native WebDriver', () => {
  const path = resolve(__dirname, '../scripts/desktop-e2e.mjs');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let scripts = 0;
  function visit(node: ts.Node) {
    let value: ts.Node | undefined;
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'execute') value = node.arguments[0];
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'script') value = node.initializer;
    if (value) {
      expect(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value), 'WebDriver script must be a static literal').toBe(true);
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        scripts++;
        const line = source.getLineAndCharacterOfPosition(value.getStart(source)).line + 1;
        expect(() => new Function(value.text), `invalid injected script at desktop-e2e.mjs:${line}`).not.toThrow();
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(scripts).toBeGreaterThan(0);
});
