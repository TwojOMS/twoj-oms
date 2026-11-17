// Paczka klienta niesie w wydanie.json format poświadczeń w bazie, który zna PAKOWANY commit
// (plik src/core/bezpieczenstwo/format-sekretow.json z tego commita, bez wykonywania jego kodu; brak pliku = 0).
// Aktualizator decyduje po nim przy powrocie do starszego wydania — format z bieżącego drzewa oznaczyłby
// stare wydanie jako znające szyfrowanie i powrót pominąłby odszyfrowanie bazy.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSekretowZCommita, plikiPaczki, PLIK_FORMATU_SEKRETOW } from '../../scripts/paczka-klienta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });

const gitW = dir => (args, encoding = 'utf8', input) => execFileSync('git', args, { cwd: dir, encoding, input, maxBuffer: 64 * 1024 * 1024 });

/** Repozytorium z trzema commitami: bez pliku formatu, z formatem 1, z zepsutym plikiem formatu. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-paczka-format-'));
  katalogi.push(dir);
  const git = gitW(dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'test']); git(['config', 'core.autocrlf', 'false']);
  const commit = (opis) => { git(['add', '-A']); git(['commit', '-q', '-m', opis]); return git(['rev-parse', 'HEAD']).trim(); };
  fs.mkdirSync(path.join(dir, 'src/core/bezpieczenstwo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/oms.js'), '// kod\n');
  const stary = commit('wydanie sprzed szyfrowania');
  fs.writeFileSync(path.join(dir, PLIK_FORMATU_SEKRETOW), '{"format": 1}\n');
  const nowy = commit('wydanie z szyfrowaniem');
  fs.writeFileSync(path.join(dir, PLIK_FORMATU_SEKRETOW), '{"format": "jeden"}\n');
  const zly = commit('zepsuty plik formatu');
  // Drzewo robocze ma jeszcze inny format — generator nie może go czytać.
  fs.writeFileSync(path.join(dir, PLIK_FORMATU_SEKRETOW), '{"format": 7}\n');
  return { git, stary, nowy, zly };
}

describe('paczka klienta: formatSekretow z pakowanego commita', () => {
  it('nowy generator pakuje stary commit → 0; nowy commit → 1 (z commita, nie z drzewa roboczego)', () => {
    const { git, stary, nowy } = repo();
    expect(formatSekretowZCommita(stary, git)).toBe(0);
    expect(formatSekretowZCommita(nowy, git)).toBe(1);
  });

  it('nieczytelny plik formatu w commicie = odmowa pakowania', () => {
    const { git, zly } = repo();
    expect(() => formatSekretowZCommita(zly, git)).toThrow('PACZKA_ZLY_FORMAT_SEKRETOW');
  });

  it('narzędzie poświadczeń jedzie w paczce', () => {
    expect(plikiPaczki(['scripts/sekrety.mjs', 'scripts/straznik-sekretow.mjs'])).toEqual(['scripts/sekrety.mjs']);
  });

  it('wydanie.json paczki z tego repo ma formatSekretow z HEAD', () => {
    const git = gitW(ROOT);
    const commit = git(['rev-parse', 'HEAD']).trim();
    const wHead = spawnSync('git', ['cat-file', '-e', `${commit}:${PLIK_FORMATU_SEKRETOW}`], { cwd: ROOT }).status === 0;
    const oczekiwany = wHead ? JSON.parse(git(['show', `${commit}:${PLIK_FORMATU_SEKRETOW}`])).format : 0;
    const wyjscie = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oms-paczka-')), 'wynik');
    katalogi.push(path.dirname(wyjscie));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/paczka-klienta.mjs'), '--commit', commit, '--wyjscie', wyjscie], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(wyjscie, `oms-${commit.slice(0, 12)}.manifest.json`), 'utf8'));
    expect(manifest.formatSekretow).toBe(oczekiwany);
  }, 120_000);
});
