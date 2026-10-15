// tests/core/narzedzia.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('narzędzia repo', () => {
  it('Node uruchamia punkt wejścia z plikiem .ts bez kroku budowania', () => {
    const wynik = execFileSync(process.execPath, ['-e', "import('./src/moduly/lista.ts').then(m => console.log('twoj-oms', m.MODULY.length))"], { encoding: 'utf8' });
    expect(wynik).toContain('twoj-oms 1');
  });

  it('kompilator typów przechodzi bez błędów', () => {
    expect(() => execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { encoding: 'utf8' })).not.toThrow();
  });
});
