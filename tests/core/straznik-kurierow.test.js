import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tymczasowe = [];
afterEach(() => tymczasowe.splice(0).forEach(k => fs.rmSync(k, { recursive: true, force: true })));

function uruchom(...argumenty) {
  return spawnSync(process.execPath, ['scripts/straznik-kurierow.mjs', ...argumenty], { encoding: 'utf8' });
}

describe('strażnik nazw kurierów', () => {
  it('przechodzi na bieżącym drzewie', () => {
    const wynik = uruchom();
    expect(wynik.status, wynik.stderr).toBe(0);
  });

  it('wykrywa nowy literał w kopii drzewa i podaje plik oraz liczbę', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurierzy-'));
    tymczasowe.push(root);
    fs.cpSync('src', path.join(root, 'src'), { recursive: true });
    fs.appendFileSync(path.join(root, 'src/domena/telefon.js'), "\nif (k === 'dpd') {}\n");
    const wynik = uruchom(root);
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toContain('src/domena/telefon.js');
    expect(wynik.stderr).toMatch(/1\/0/);
  });
});
