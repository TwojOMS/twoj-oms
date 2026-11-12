import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sprawdz } from '../../scripts/straznik-kanalow.mjs';

const katalogi = [];
afterEach(() => katalogi.splice(0).forEach(k => fs.rmSync(k, { recursive: true, force: true })));

function probka(a, b) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaly-test-'));
  katalogi.push(root);
  fs.mkdirSync(path.join(root, 'src', 'domena'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'domena', 'a.js'), a);
  fs.writeFileSync(path.join(root, 'src', 'domena', 'b.ts'), b);
  return root;
}

describe('strażnik nazw kanałów', () => {
  it('pilnuje także nowych rozgałęzień ERLI w obu kolejnościach', () => {
    const root = probka("z.typ === 'erli';", "'erli' !== z?.typ;");
    expect(sprawdz(root, {}).kod).toBe(1);
    expect(sprawdz(root, {
      'src/domena/a.js': { liczba: 1, powod: 'adapter ERLI' },
      'src/domena/b.ts': { liczba: 1, powod: 'komunikat ERLI' },
    }).kod).toBe(0);
  });
  it('liczy wszystkie operatory i kolejności, także wiele trafień w wierszu', () => {
    const root = probka("czyKanalAllegro(z); x.typ === 'allegro'; 'woo' !== x.typ;\n", 'typ !== "woo"; "allegro" === typ; const czyKanalAllegro = (z) => z;');
    const wynik = sprawdz(root, { 'src/domena/a.js': { liczba: 3, powod: 'próba' }, 'src/domena/b.ts': { liczba: 3, powod: 'próba' } });
    expect(wynik.kod).toBe(0);
    expect(wynik.trafienia['src/domena/a.js']).toEqual([1, 1, 1]);
    expect(wynik.trafienia['src/domena/b.ts']).toEqual([1, 1, 1]);
  });

  it('skanuje szablony EJS i porównania przez ?.', () => {
    const root = probka('', '');
    fs.writeFileSync(path.join(root, 'src', 'domena', 'c.ejs'), "<% if ('woo' === k?.typ) { %>x<% } %>");
    const wynik = sprawdz(root, {});
    expect(wynik.kod).toBe(1);
    expect(wynik.bledy).toEqual(['src/domena/c.ejs:1']);
  });

  it('odrzuca nadmiar i nowy plik, a przy ubytku podpowiada zmniejszenie liczby', () => {
    const root = probka('czyKanalAllegro(z);\nczyKanalAllegro(z);', "x.typ === 'woo';");
    const wynik = sprawdz(root, { 'src/domena/a.js': { liczba: 1, powod: 'próba' }, 'src/domena/brak.js': { liczba: 1, powod: 'próba' } });
    expect(wynik.kod).toBe(1);
    expect(wynik.bledy.join('\n')).toContain('src/domena/a.js:2');
    expect(wynik.bledy.join('\n')).toContain('src/domena/b.ts:1');
    expect(wynik.podpowiedzi.join('\n')).toContain('zmniejsz liczbę na liście');
    expect(sprawdz(root, { 'src/domena/a.js': { liczba: 3, powod: 'próba' }, 'src/domena/b.ts': { liczba: 1, powod: 'próba' } }).kod).toBe(0);
  });

  it('uruchamia strażnika CLI na repozytorium', () => {
    const wynik = spawnSync(process.execPath, ['scripts/straznik-kanalow.mjs'], { encoding: 'utf8' });
    expect(wynik.status, wynik.stderr).toBe(0);
  });
});
