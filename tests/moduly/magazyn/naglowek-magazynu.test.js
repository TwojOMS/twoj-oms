import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// Nagłówek Magazynu niesie „Dodaj produkt" i „Importuj"; przyciski odczytu
// katalogów, treści ofert i tworzenia kart zniknęły z listy (są na ekranie importu). Pasek „Odczyt katalogów"
// zostaje na liście WYŁĄCZNIE przy trwającym przebiegu albo błędzie — błąd odczytu nadal musi być widoczny.

const config = { auth: { user: 'operator', pass: 'atrapa' } };
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const SPOKOJ = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };
const TRESC_SPOKOJ = {
  trwa: false,
  zaczety_at: null,
  skonczony_at: null,
  postep: null,
  razem: 0,
  pobrane: 0,
  bledy: [],
  blad: null,
};

// Konto, któremu mapa praw odmawia adresów importu i nowej karty. `mozeAdres` w widokach to
// `maDostepDoAdresu` (pipeline.js); strażnik tras pyta osobno (`maDostepDoEkranu`), więc lista nadal się otwiera.
const odmowa = vi.hoisted(() => ({ adresy: new Set() }));
vi.mock('../../../src/domena/ekrany.js', async (oryginal) => {
  const m = await oryginal();
  return {
    ...m,
    maDostepDoAdresu: (konto, url) => !odmowa.adresy.has(String(url).split('?')[0]) && m.maDostepDoAdresu(konto, url),
  };
});

let db;
let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
});
afterEach(async () => {
  await app?.close();
  db.close();
});

const serwer = ({ stan = SPOKOJ, tresc = null, bezPrawa = false } = {}) => {
  app = buildOmsServer({
    db,
    config,
    magazyn: { start: vi.fn(() => ({ wystartowal: true })), stan: () => stan },
    nadpisania: tresc
      ? { 'magazyn.trescAllegro': { start: vi.fn(), stan: () => ({ ...TRESC_SPOKOJ, ...tresc }), gotowy: () => true } }
      : {},
  });
  odmowa.adresy = new Set(bezPrawa ? ['/magazyn/import', '/magazyn/nowa-karta'] : []);
  return app;
};
const lista = async (opcje) => {
  const r = await serwer(opcje).inject({ method: 'GET', url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};
const naglowek = (html) => /<header class="naglowek-ekranu[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
const pasek = (html) => /<div class="pasek-odczytu"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';

describe('nagłówek Magazynu — Dodaj produkt i Importuj', () => {
  it('edytujący widzi oba odnośniki w nagłówku, w stylu przycisków OMS', async () => {
    const h = naglowek(await lista());
    expect(h).toContain('<div class="naglowek-ekranu__akcje">');
    expect(h).toMatch(/<a class="btn btn--maly btn--glowny" href="\/magazyn\/nowa-karta">Dodaj produkt<\/a>/);
    expect(h).toMatch(/<a class="btn btn--maly" href="\/magazyn\/import">Importuj<\/a>/);
  });

  it('bez prawa do tych adresów nagłówek nie ma żadnego z odnośników', async () => {
    const html = await lista({ bezPrawa: true });
    expect(naglowek(html)).not.toBe('');
    expect(naglowek(html)).not.toContain('naglowek-ekranu__akcje');
    expect(html).not.toContain('Dodaj produkt');
    expect(html).not.toContain('href="/magazyn/import"');
  });

  it('ekran nowej karty nazywa się „Nowy produkt"', async () => {
    const r = await serwer().inject({ method: 'GET', url: '/magazyn/nowa-karta', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h1>Nowy produkt</h1>');
    expect(r.body).toMatch(/<title>[^<]*Nowy produkt/);
  });
});

describe('lista Magazynu — przyciski odczytu przeniesione na ekran importu', () => {
  it('nie ma starych przycisków ani odnośników (także przy połączonym Allegro i po błędzie)', async () => {
    for (const opcje of [
      { tresc: {} },
      { tresc: { blad: 'Allegro odmówiło (HTTP 403).' }, stan: { ...SPOKOJ, blad: 'brak konfiguracji' } },
    ]) {
      const html = await lista(opcje);
      for (const stary of [
        'action="/magazyn/odswiez"',
        'action="/magazyn/tresc-allegro"',
        'action="/magazyn/utworz-karty"',
        'Nowa karta',
        'Odczytaj katalogi ze sklepów',
        'Pobierz treść i zdjęcia ofert',
        'Utwórz karty z niepowiązanych',
        'Co panel pomija i dlaczego',
        'Powiąż oferty Allegro z kartami',
      ]) {
        expect(html, stary).not.toContain(stary);
      }
    }
  });
});

describe('lista Magazynu — pasek „Odczyt katalogów" tylko przy trwaniu albo błędzie', () => {
  it('spokój po udanym odczycie = brak paska', async () => {
    const html = await lista({
      tresc: { skonczony_at: '2026-11-13T08:10:00.000Z', razem: 2, pobrane: 2 },
      stan: {
        ...SPOKOJ,
        skonczony_at: '2026-11-13T08:00:00.000Z',
        kanaly: [{ kanal: 'swietlik', zapisane: 12, znikniete: 0, blad: null }],
      },
    });
    expect(pasek(html)).toBe('');
    expect(html).not.toContain('Odczyt katalogów');
    expect(html).not.toContain('odczyt-szczegoly');
  });

  it('trwający odczyt = jedna linia z postępem i odnośnikiem „Importuj →"', async () => {
    const p = pasek(
      await lista({ stan: { ...SPOKOJ, trwa: true, postep: { kanal: 'swietlik', zrobione: 3, zTego: 40 } } }),
    );
    expect(p).toContain('Odczyt katalogów');
    expect(p).toContain('3 z 40');
    expect(p).toMatch(/<a href="\/magazyn\/import">Importuj →<\/a>/);
    expect(p).not.toContain('błąd');
  });

  it('błąd kanału = pasek z PEŁNYM komunikatem i odnośnikiem do importu', async () => {
    const p = pasek(
      await lista({
        stan: {
          ...SPOKOJ,
          skonczony_at: '2026-11-13T08:00:00.000Z',
          kanaly: [
            {
              kanal: 'swietlik',
              zapisane: 0,
              znikniete: 0,
              blad: 'Sklep oddał pustą listę — oznacz jego wiersze ręcznie.',
            },
          ],
        },
      }),
    );
    expect(p).toContain('błąd odczytu');
    expect(p).toContain('Sklep oddał pustą listę — oznacz jego wiersze ręcznie.');
    expect(p).toMatch(/<a href="\/magazyn\/import">Importuj →<\/a>/);
  });

  it('błąd całego przebiegu też pokazuje pasek', async () => {
    const p = pasek(await lista({ stan: { ...SPOKOJ, blad: 'brak konfiguracji kanałów' } }));
    expect(p).toContain('brak konfiguracji kanałów');
    expect(p).toContain('href="/magazyn/import"');
  });

  it('pobieranie treści ofert: trwanie i błąd pokazują pasek, spokój nie', async () => {
    const trwa = pasek(await lista({ tresc: { trwa: true, postep: { zrobione: 2, zTego: 5 } } }));
    expect(trwa).toContain('2 z 5');
    expect(trwa).toContain('role="status"');
    await app.close();
    const blad = pasek(
      await lista({
        tresc: {
          skonczony_at: '2026-11-13T08:10:00.000Z',
          razem: 3,
          pobrane: 1,
          blad: 'Allegro odmówiło dostępu (HTTP 403).',
          bledy: [{ kanal: 'allegro_polcien2', oferta_id: '7700000001', blad: 'Oferta w EUR — pominięta.' }],
        },
      }),
    );
    expect(blad).toContain('Allegro odmówiło dostępu (HTTP 403).');
    expect(blad).not.toContain('role="status"');
    expect(blad).toContain('7700000001: Oferta w EUR — pominięta.');
    expect(blad).toContain('href="/magazyn/import"');
  });

  it('ponad 50 ofert z błędem: pasek wypisuje 50 i dopisuje „…i jeszcze N”', async () => {
    const bledy = Array.from({ length: 53 }, (_, i) => ({
      kanal: 'allegro_polcien2',
      oferta_id: String(7700000100 + i),
      blad: 'Brak opisu.',
    }));
    const p = pasek(await lista({ tresc: { skonczony_at: '2026-11-13T08:10:00.000Z', razem: 60, pobrane: 7, bledy } }));
    expect(p).toContain('ofert z błędem: 53');
    expect(p).toContain('7700000149: Brak opisu.');
    expect(p).not.toContain('7700000150');
    expect(p).toContain('…i jeszcze 3');
  });

  it('bez prawa do importu pasek przebiegu nie ma odnośnika „Importuj →”', async () => {
    const p = pasek(await lista({ bezPrawa: true, stan: { ...SPOKOJ, blad: 'brak konfiguracji kanałów' } }));
    expect(p).toContain('brak konfiguracji kanałów');
    expect(p).not.toContain('href="/magazyn/import"');
  });
});
