// PRZ-099: funkcje ekranu Ustawienia → Aktualizacje — odczyt wydania, porównanie wersji, zapytanie do GitHuba.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { odczytajWydanie, porownajWersje, sprawdzNajnowsze, REPO_AKTUALIZACJI } from '../../../src/moduly/ustawienia/aktualizacje.ts';

const COMMIT = 'abc123def4560000000000000000000000000000';

function plikWydania(tresc: unknown): URL {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'prz099-'));
  const plik = path.join(katalog, 'wydanie.json');
  fs.writeFileSync(plik, typeof tresc === 'string' ? tresc : JSON.stringify(tresc));
  return pathToFileURL(plik);
}

type Wywolanie = { adres: string; init?: RequestInit };
function atrapaHttp(odpowiedz: () => Response | Promise<Response>) {
  const wywolania: Wywolanie[] = [];
  const http = async (adres: string, init?: RequestInit) => { wywolania.push({ adres, init }); return odpowiedz(); };
  return { http, wywolania };
}
const json = (cialo: unknown, status = 200) => new Response(JSON.stringify(cialo), { status, headers: { 'content-type': 'application/json' } });
const WYDANIE_GH = { tag_name: 'v0.3.0', published_at: '2026-10-25T09:00:00Z', body: 'Nowy ekran.', html_url: 'https://github.com/TwojOMS/twoj-oms/releases/tag/v0.3.0' };

describe('PRZ-099 odczytajWydanie', () => {
  it('pełny plik → commit, wersja i data paczki', () => {
    expect(odczytajWydanie(plikWydania({ commit: COMMIT, wersja: 'v0.2.0', utworzono: '2026-10-18T12:02:00Z' })))
      .toEqual({ commit: COMMIT, wersja: 'v0.2.0', utworzono: '2026-10-18T12:02:00Z' });
  });
  it('paczka bez pola wersja (sprzed PRZ-095) → wersja null, commit zostaje', () => {
    expect(odczytajWydanie(plikWydania({ commit: COMMIT, utworzono: '2026-10-18T12:02:00Z' })))
      .toEqual({ commit: COMMIT, wersja: null, utworzono: '2026-10-18T12:02:00Z' });
  });
  it('wersja spoza wzorca vX.Y.Z → null w polu', () => {
    expect(odczytajWydanie(plikWydania({ commit: COMMIT, wersja: '0.2' }))?.wersja).toBeNull();
  });
  it('brak pliku, zły JSON, zły commit → null', () => {
    expect(odczytajWydanie(new URL('file:///nie/ma/takiego/wydanie.json'))).toBeNull();
    expect(odczytajWydanie(plikWydania('{nie json'))).toBeNull();
    expect(odczytajWydanie(plikWydania({ commit: 'abc', wersja: 'v0.2.0' }))).toBeNull();
  });
});

describe('PRZ-099 porownajWersje', () => {
  it('porównuje liczbowo, nie jako napisy', () => {
    expect(porownajWersje('v0.10.0', 'v0.9.0')).toBe(1);
    expect(porownajWersje('v0.2.0', 'v0.2.0')).toBe(0);
    expect(porownajWersje('v0.2.0', 'v0.2.1')).toBe(-1);
    expect(porownajWersje('v1.0.0', 'v0.99.99')).toBe(1);
  });
});

describe('PRZ-099 sprawdzNajnowsze', () => {
  it('200 → jest; pyta o releases/latest repo produktu z User-Agent i Accept GitHuba', async () => {
    const { http, wywolania } = atrapaHttp(() => json(WYDANIE_GH));
    expect(await sprawdzNajnowsze({ http })).toEqual({
      stan: 'jest', wersja: 'v0.3.0', opublikowano: '2026-10-25T09:00:00Z', opis: 'Nowy ekran.', adres: WYDANIE_GH.html_url,
    });
    expect(REPO_AKTUALIZACJI).toBe('TwojOMS/twoj-oms');
    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].adres).toBe('https://api.github.com/repos/TwojOMS/twoj-oms/releases/latest');
    const naglowki = new Headers(wywolania[0].init?.headers);
    expect(naglowki.get('user-agent')).toBe('TwojOMS-aktualizacje');
    expect(naglowki.get('accept')).toBe('application/vnd.github+json');
  });
  it('opis dłuższy niż 4000 znaków jest ucinany', async () => {
    const { http } = atrapaHttp(() => json({ ...WYDANIE_GH, body: 'x'.repeat(10_000) }));
    const w = await sprawdzNajnowsze({ http });
    expect(w.stan === 'jest' && w.opis.length).toBe(4000);
  });
  it('brak opisu → pusty napis', async () => {
    const { http } = atrapaHttp(() => json({ ...WYDANIE_GH, body: null }));
    const w = await sprawdzNajnowsze({ http });
    expect(w.stan === 'jest' && w.opis).toBe('');
  });
  it('tag spoza wzorca wersji → blad', async () => {
    const { http } = atrapaHttp(() => json({ ...WYDANIE_GH, tag_name: 'najnowsza' }));
    expect(await sprawdzNajnowsze({ http })).toEqual({ stan: 'blad' });
  });
  it('404 → brak-wydan; 403 i 429 → limit; 500 → blad; wyjątek transportu → blad', async () => {
    expect(await sprawdzNajnowsze(atrapaHttp(() => json({ message: 'Not Found' }, 404)))).toEqual({ stan: 'brak-wydan' });
    expect(await sprawdzNajnowsze(atrapaHttp(() => json({ message: 'rate limit' }, 403)))).toEqual({ stan: 'limit' });
    expect(await sprawdzNajnowsze(atrapaHttp(() => json({}, 429)))).toEqual({ stan: 'limit' });
    expect(await sprawdzNajnowsze(atrapaHttp(() => json({}, 500)))).toEqual({ stan: 'blad' });
    expect(await sprawdzNajnowsze({ http: async () => { throw new Error('api.github.com: limit czasu'); } })).toEqual({ stan: 'blad' });
    expect(await sprawdzNajnowsze(atrapaHttp(() => new Response('<html>', { status: 200 })))).toEqual({ stan: 'blad' });
  });
});
