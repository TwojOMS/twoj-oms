// właściciel 06.11: NIP sprzedawcy w demo i w próbnej instalacji nie może należeć do żadnej firmy. Wcześniejszy
// 1234563218 ma poprawną sumę kontrolną i krąży w sieci jako numer przykładowy. Fikcyjne NIP-y demo mają przedrostek 999 —
// pierwsze trzy cyfry NIP-u to kod urzędu skarbowego, a urzędu 999 nie ma (ta sama zasada co FIRMY_B2B).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { FIRMY_B2B } from '../../scripts/demo-dane-firma.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WAGI = [6, 5, 7, 2, 3, 4, 5, 6, 7];
const poprawny = (nip) => /^\d{10}$/.test(nip)
  && WAGI.reduce((s, w, i) => s + w * Number(nip[i]), 0) % 11 === Number(nip[9]);

describe('NIP-y demo bez prawdziwej firmy', () => {
  it('sprzedawca demo ma fikcyjny NIP 999… z poprawną sumą kontrolną', () => {
    expect(ENV_DEMO.OMS_SPRZEDAWCA_NIP).toMatch(/^999\d{7}$/);
    expect(poprawny(ENV_DEMO.OMS_SPRZEDAWCA_NIP)).toBe(true);
  });

  it('firmy B2B demo mają fikcyjne NIP-y 999…', () => {
    for (const f of FIRMY_B2B) expect(f.nip).toMatch(/^999\d{7}$/);
  });

  it('próbna instalacja (szybki start) wpisuje fikcyjny NIP 999…', () => {
    const skrypt = fs.readFileSync(path.join(ROOT, 'scripts/instalacja-przygotuj.mjs'), 'utf8');
    const nip = /OMS_SPRZEDAWCA_NIP=(\d{10})/.exec(skrypt)?.[1];
    expect(nip).toMatch(/^999\d{7}$/);
    expect(poprawny(nip)).toBe(true);
  });

  it('demo i próba nie podają już NIP-u 1234563218', () => {
    for (const plik of ['scripts/demo-dane.mjs', 'scripts/instalacja-przygotuj.mjs']) {
      expect(fs.readFileSync(path.join(ROOT, plik), 'utf8')).not.toContain('1234563218');
    }
  });
});
