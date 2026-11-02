import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { odczytajKopie } from '../../../src/moduly/ustawienia/services/kopie.ts';

const teraz = new Date('2026-10-31T12:00:00.000Z');
const katalogi: string[] = [];
function katalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-kopie-'));
  katalogi.push(dir);
  return dir;
}
function plik(dir: string, nazwa: string, zawartosc: string, czas: string) {
  const p = path.join(dir, nazwa);
  fs.writeFileSync(p, zawartosc);
  fs.utimesSync(p, new Date(czas), new Date(czas));
}
afterEach(() => { for (const dir of katalogi.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('odczyt stanu kopii', () => {
  it('bez katalogu nie zgaduje konfiguracji ani historii', () => {
    const w = odczytajKopie();
    expect(w.stan).toBe('nie_skonfigurowano');
    expect(w.opis).toBeTruthy();
    expect(w.historia).toEqual([]);
    expect(w.retencja).toBeNull();
    expect(w.harmonogram).toBeNull();
  });

  it('odróżnia pusty katalog od nieodczytywalnego', () => {
    const dir = katalog();
    expect(odczytajKopie({ katalog: dir, teraz }).stan).toBe('brak');
    const io = { ...fs, readdirSync: (() => { throw Object.assign(new Error('EACCES tajna ścieżka'), { code: 'EACCES' }); }) as typeof fs.readdirSync };
    const w = odczytajKopie({ katalog: dir, teraz, io });
    expect(w.stan).toBe('blad');
    expect(w.historia).toEqual([]);
    expect(JSON.stringify(w)).not.toContain(dir);
    expect(JSON.stringify(w)).not.toContain('tajna ścieżka');
  });

  it('pokazuje tylko regularne pliki właściwych nazw, ich rozmiar i czas modyfikacji', () => {
    const dir = katalog();
    plik(dir, 'oms-2026-10-30.sqlite', 'baza', '2026-10-31T10:00:00Z');
    plik(dir, 'pliki-2026-10-01.tgz', 'etykiety', '2026-10-30T12:00:00Z');
    plik(dir, 'oms-2026-10-31.sqlite.tmp', 'x', '2026-10-31T12:00:00Z');
    fs.mkdirSync(path.join(dir, 'oms-2026-10-29.sqlite'));
    fs.symlinkSync(path.join(dir, 'oms-2026-10-30.sqlite'), path.join(dir, 'oms-2026-10-28.sqlite'));
    const w = odczytajKopie({ katalog: dir, teraz });
    expect(w.stan).toBe('odczytano');
    expect(w.historia).toEqual([
      { plik: 'oms-2026-10-30.sqlite', data: '2026-10-31T10:00:00.000Z', rozmiar: 4, wiekH: 2, rodzaj: 'baza' },
      { plik: 'pliki-2026-10-01.tgz', data: '2026-10-30T12:00:00.000Z', rozmiar: 8, wiekH: 24, rodzaj: 'pliki' },
    ]);
    expect(JSON.stringify(w)).not.toContain(dir);
  });

  it('ocenia brak i wiek bazy niezależnie od archiwum plików', () => {
    const dir = katalog();
    plik(dir, 'pliki-2026-10-31.tgz', 'x', '2026-10-31T11:00:00Z');
    expect(odczytajKopie({ katalog: dir, teraz }).stan).toBe('brak');
    plik(dir, 'oms-2026-10-29.sqlite', 'x', '2026-10-29T12:00:00Z');
    expect(odczytajKopie({ katalog: dir, teraz }).stan).toBe('uwaga');
  });

  it('błąd stat pojedynczego pliku nie jest pustą historią ani sukcesem', () => {
    const dir = katalog();
    plik(dir, 'oms-2026-10-31.sqlite', 'x', '2026-10-31T11:00:00Z');
    const io = { ...fs, lstatSync: (() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }) as typeof fs.lstatSync };
    expect(odczytajKopie({ katalog: dir, teraz, io }).stan).toBe('blad');
  });

  it('sam katalog zewnętrzny nie dowodzi odrębnego nośnika', () => {
    const lokalny = katalog();
    const zewnetrzny = katalog();
    plik(zewnetrzny, 'oms-2026-10-31.sqlite', 'x', '2026-10-31T11:00:00Z');
    const w = odczytajKopie({ katalog: lokalny, zewnetrzna: zewnetrzny, teraz });
    expect(w.zewnetrzna.stan).toBe('nieustalono');
    expect(w.zewnetrzna.historia).toHaveLength(1);
    expect(JSON.stringify(w)).not.toContain(zewnetrzny);
  });

  it('błąd identyfikacji urządzenia nie zamienia wyniku nadzoru ok w potwierdzenie nośnika', () => {
    const lokalny = katalog();
    const zewnetrzny = katalog();
    plik(zewnetrzny, 'oms-2026-10-31.sqlite', 'x', '2026-10-31T11:00:00Z');
    const io = { ...fs, statSync: (() => { throw new Error('EACCES'); }) as typeof fs.statSync };
    const nadzor = () => ({ alarmy: [], uwagi: [], ostatnia: null, katalogDostepny: true, zewnetrzna: true, zewnetrznaStan: 'ok' as const });
    expect(odczytajKopie({ katalog: lokalny, zewnetrzna: zewnetrzny, teraz, io, nadzor }).zewnetrzna.stan).toBe('nieustalono');
  });

  it('pokazuje ograniczenia zakresu bez obietnicy pełnej ochrony', () => {
    const w = odczytajKopie({ katalog: katalog(), teraz });
    const tekst = w.zakres.join(' ').toLowerCase();
    expect(tekst).toMatch(/baz/);
    expect(tekst).toMatch(/sekret/);
    expect(tekst).toMatch(/etykiet/);
    expect(tekst).toMatch(/proform/);
    expect(tekst).toMatch(/konfigurac/);
    expect(tekst).toMatch(/poza baz/);
    expect(JSON.stringify(w).toLowerCase()).not.toContain('pełna ochrona');
  });
});
