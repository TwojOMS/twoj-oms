import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { naruszenia } from '../../../scripts/straznik-sekretow.mjs';

const korzen = path.resolve(import.meta.dirname, '../../..');

describe('strażnik poświadczeń w bazie', () => {
  it('repozytorium: zero naruszeń', () => {
    expect(naruszenia(korzen)).toEqual([]);
  });
  it('łapie SQL na kolumnie z sekretem, surowy SELECT * i sejf domyślny poza testami', () => {
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'straznik-sekretow-'));
    try {
      fs.mkdirSync(path.join(k, 'src/moduly/x'), { recursive: true });
      fs.mkdirSync(path.join(k, 'deploy'), { recursive: true });
      fs.writeFileSync(
        path.join(k, 'src/moduly/x/a.js'),
        "db.prepare('SELECT access_token FROM tokeny_kanalu').get();\n",
      );
      fs.writeFileSync(
        path.join(k, 'src/moduly/x/b.ts'),
        "db.prepare('SELECT * FROM konfiguracja_integracji').all();\n",
      );
      fs.writeFileSync(path.join(k, 'deploy/c.mjs'), 'ustawSejfDomyslny(s);\n');
      fs.writeFileSync(path.join(k, 'src/moduly/x/d.js'), 'const t = d.access_token; // odpowiedź OAuth, nie SQL\n');
      fs.writeFileSync(
        path.join(k, 'src/moduly/x/e.js'),
        'db.prepare(`UPDATE tokeny_kanalu\n  SET\n    access_token = ?`).run(t);\n',
      );
      fs.writeFileSync(path.join(k, 'src/moduly/x/f.js'), "db.prepare('SELECT t.* FROM tokeny_ksef t').get();\n");
      const n = naruszenia(k);
      expect(n.join('\n')).toMatch(/e\.js:1: .*wieloliniowe/);
      expect(n.join('\n')).toMatch(/f\.js:1/);
      expect(n.filter((x) => !/[ef]\.js/.test(x))).toHaveLength(3);
      expect(n.join('\n')).toMatch(/a\.js:1/);
      expect(n.join('\n')).toMatch(/b\.ts:1/);
      expect(n.join('\n')).toMatch(/c\.mjs:1/);
    } finally {
      fs.rmSync(k, { recursive: true, force: true });
    }
  });
});
