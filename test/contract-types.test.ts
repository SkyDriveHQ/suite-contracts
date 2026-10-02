/**
 * Runs the TypeScript compiler over `test/types/*.check.ts` and fails on any
 * error.
 *
 * The package's `typecheck` script covers `src/` only, and vitest does not
 * type-check, so a contract rule that exists only in the types (a required
 * field, a closed union) had no test that could fail. These files hold such
 * rules as `@ts-expect-error` lines; this test is what makes them count.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const typesDir = join(here, 'types');

/** The repo's own compiler options, minus emitting and the src-only root. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const { rootDir: _rootDir, outDir: _outDir, ...rest } = parsed.options;
  return { ...rest, noEmit: true, declaration: false };
}

describe('contract type rules', () => {
  const files = readdirSync(typesDir).filter((f) => f.endsWith('.check.ts'));

  it('has type-rule files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} compiles, and every @ts-expect-error in it is earned`, () => {
      const program = ts.createProgram([join(typesDir, file)], compilerOptions());
      const errors = ts.getPreEmitDiagnostics(program).map((d) => {
        const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const at = where ? `${d.file!.fileName}:${where.line + 1}` : '';
        return `${at} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
      });
      expect(errors).toEqual([]);
    }, 60_000);
  }
});
