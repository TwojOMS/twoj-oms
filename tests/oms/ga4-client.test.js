import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGa4Client } from '../../src/oms/ga4/client.js';

// Klient GA4 Data API (Etap 2 kampanii). Atrapa `fetch` — suita nie rozmawia z Google.
// Ksztalt odpowiedzi odwzorowany z ZYWEGO odczytu (25.08.2026, właściwość 398443619):
// `rows: [{ dimensionValues: [{value:'20260824'}], metricValues: [{value:'28'}] }]`.
//
// Klucz jest PRAWDZIWYM kluczem RSA generowanym na potrzeby testu — atrapa napisu nie
// przeszlaby przez `createSign`, wiec podpisywanie JWT nie byloby w ogole sprawdzone.

const kluczTestowy = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const katalog = mkdtempSync(join(tmpdir(), 'oms-ga4-'));
  const sciezka = join(katalog, 'sa.json');
  writeFileSync(sciezka, JSON.stringify({
    client_email: 'konto-uslugowe@projekt.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }));
  return sciezka;
};

const wiersz = (dzien, ...wartosci) => ({
  dimensionValues: [{ value: dzien }],
  metricValues: wartosci.map((v) => ({ value: String(v) })),
});

// Atrapa: pierwszy strzal to zawsze token, kolejne to raporty — w kolejnosci, w jakiej
// klient je wysyła (sesje, sesje Meta, odsłony promocji).
function atrapa({ raporty = [], token = { access_token: 'TOKEN-ABC', expires_in: 3600 }, tokenOk = true } = {}) {
  const wywolania = [];
  let i = 0;
  const fetchImpl = async (url, opcje) => {
    wywolania.push({ url: String(url), opcje });
    if (String(url).includes('oauth2')) {
      return { ok: tokenOk, status: tokenOk ? 200 : 401, json: async () => token };
    }
    const rows = raporty[i] ?? [];
    i += 1;
    return { ok: true, status: 200, json: async () => ({ rows }) };
  };
  return { fetchImpl, wywolania };
}

describe('createGa4Client — bariery i sekrety', () => {
  it('bez ścieżki klucza w ogóle nie powstaje', () => {
    expect(() => createGa4Client({ sciezkaKlucza: '' })).toThrow(/bez ścieżki klucza/);
  });

  // ⚠️ KLUCZ CZYTANY DOPIERO PRZY UZYCIU: brak pliku ma zgasic SEKCJE, nie polozyc panelu.
  it('brak pliku klucza NIE wywala konstruktora — dopiero odczyt mówi, czego brakuje', async () => {
    const klient = createGa4Client({ sciezkaKlucza: 'C:/nie/ma/takiego/pliku.json', fetchImpl: atrapa().fetchImpl });
    await expect(klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/Nie mogę odczytać klucza konta usługowego/);
  });

  it('plik, który nie jest kluczem konta usługowego, mówi to wprost', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-ga4-zly-'));
    const sciezka = join(katalog, 'zly.json');
    writeFileSync(sciezka, JSON.stringify({ cokolwiek: 1 }));
    const klient = createGa4Client({ sciezkaKlucza: sciezka, fetchImpl: atrapa().fetchImpl });
    await expect(klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/nie jest klucz konta usługowego/);
  });

  it('token idzie nagłówkiem, a klucz prywatny nie pojawia się w żadnym żądaniu', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '398443619', od: '2026-08-24', do: '2026-08-25' });

    const raport = wywolania.find((w) => w.url.includes('runReport'));
    expect(raport.opcje.headers.authorization).toBe('Bearer TOKEN-ABC');
    expect(wywolania.every((w) => !String(w.opcje?.body ?? '').includes('PRIVATE KEY'))).toBe(true);
  });

  it('odmowa tokenu jest błędem z powodem, bez treści klucza', async () => {
    const { fetchImpl } = atrapa({ tokenOk: false, token: { error: 'invalid_grant', error_description: 'Invalid JWT Signature' } });
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await expect(klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/invalid_grant.*Invalid JWT Signature/);
  });

  // ⚠️ Trzy raporty na przebieg — token ma byc podpisany RAZ, nie trzy razy.
  it('token bierze się raz na przebieg (pamięć podręczna)', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25', sciezkaPromo: '/wrzesien' });
    expect(wywolania.filter((w) => w.url.includes('oauth2'))).toHaveLength(1);
  });

  // ⚠️ GODZINA I MINUTA, nie „token na 60 sekund": Google przy JWT-bearer zawsze oddaje
  // ~3600 s, a zapas 5 minut sprawia, ze token krotszy niz zapas jest z definicji
  // przeterminowany — taki test mierzylby wiec brak buforowania, a nie jego wygasanie.
  it('po wygaśnięciu tokenu bierze nowy', async () => {
    const { fetchImpl, wywolania } = atrapa({ token: { access_token: 'T', expires_in: 3600 } });
    let chwila = 1_000_000;
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl, teraz: () => chwila });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' });
    expect(wywolania.filter((w) => w.url.includes('oauth2'))).toHaveLength(1);

    chwila += 61 * 60 * 1000;
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' });
    expect(wywolania.filter((w) => w.url.includes('oauth2'))).toHaveLength(2);
  });
});

describe('createGa4Client — dzienne statystyki', () => {
  it('składa sesje, użytkowników, sesje z Mety i odsłony promocji w jeden wiersz dnia', async () => {
    const { fetchImpl } = atrapa({
      raporty: [
        [wiersz('20260824', 28, 24), wiersz('20260825', 12, 11)],
        [wiersz('20260824', 5)],
        [wiersz('20260824', 3), wiersz('20260825', 1)],
      ],
    });
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    const wynik = await klient.dzienneStatystyki({
      wlasciwosc: '398443619', od: '2026-08-24', do: '2026-08-25', sciezkaPromo: '/wrzesien',
    });

    expect(wynik).toEqual([
      { dzien: '2026-08-24', sesje: 28, uzytkownicy: 24, sesjeMeta: 5, odslonyPromo: 3 },
      { dzien: '2026-08-25', sesje: 12, uzytkownicy: 11, sesjeMeta: 0, odslonyPromo: 1 },
    ]);
  });

  it('data GA4 (20260824) wychodzi jako RRRR-MM-DD', async () => {
    const { fetchImpl } = atrapa({ raporty: [[wiersz('20260907', 1, 1)]] });
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    const wynik = await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-09-07', do: '2026-09-07' });
    expect(wynik[0].dzien).toBe('2026-09-07');
  });

  // ⚠️ TRZY OSOBNE RAPORTY, bo `totalUsers` rozbite po zrodle i zsumowane liczyloby dwa
  // razy kazdego, kto wszedl i z Facebooka, i z Google.
  it('pyta o użytkowników BEZ drugiego wymiaru', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' });

    const pierwszy = JSON.parse(wywolania.find((w) => w.url.includes('runReport')).opcje.body);
    expect(pierwszy.dimensions).toEqual([{ name: 'date' }]);
    expect(pierwszy.metrics.map((m) => m.name)).toEqual(['sessions', 'totalUsers']);
    expect(pierwszy.dimensionFilter).toBeUndefined();
  });

  it('sesje z Mety filtruje wzorcem źródeł, nie listą dokładnych wartości', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' });

    const drugi = JSON.parse(wywolania.filter((w) => w.url.includes('runReport'))[1].opcje.body);
    expect(drugi.dimensionFilter.filter.fieldName).toBe('sessionSource');
    expect(drugi.dimensionFilter.filter.stringFilter.matchType).toBe('PARTIAL_REGEXP');
    expect(drugi.dimensionFilter.filter.stringFilter.value).toMatch(/facebook/);
    expect(drugi.dimensionFilter.filter.stringFilter.value).toMatch(/instagram/);
  });

  // ⚠️⚠️ ZLAPANE WERYFIKACJA MUTACYJNA: bez filtra `pagePath` trzeci raport oddaje odslony
  // CALEGO SKLEPU, a ekran podpisuje je „odsłony warunków promocji". Liczba bylaby
  // dwa rzedy wielkosci za duza i wygladalaby jak sukces kampanii.
  it('odsłony promocji filtruje po ścieżce strony — nie liczy całego sklepu', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25', sciezkaPromo: '/wrzesien' });

    const trzeci = JSON.parse(wywolania.filter((w) => w.url.includes('runReport'))[2].opcje.body);
    expect(trzeci.metrics.map((m) => m.name)).toEqual(['screenPageViews']);
    expect(trzeci.dimensionFilter.filter.fieldName).toBe('pagePath');
    expect(trzeci.dimensionFilter.filter.stringFilter.value).toBe('/wrzesien');
  });

  it('bez ścieżki promocji NIE pyta o odsłony (trzeci raport nie leci)', async () => {
    const { fetchImpl, wywolania } = atrapa();
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' });
    expect(wywolania.filter((w) => w.url.includes('runReport'))).toHaveLength(2);
  });

  it('dzień bez ruchu to brak wiersza, a nie błąd', async () => {
    const { fetchImpl } = atrapa({ raporty: [[], [], []] });
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    expect(await klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' })).toEqual([]);
  });

  // 200 z cialem, ktorego nie rozumiemy (strona logowania, blad proxy), wygladalby jak
  // „zero sesji" — czyli jak prawdziwy, spokojny dzien bez ruchu.
  it('odpowiedź 200, której nie rozpoznajemy, jest błędem — nie zerem sesji', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'T', expires_in: 3600 }) };
      return { ok: true, status: 200, json: async () => ({ cokolwiek: 'HTML logowania' }) };
    };
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    await expect(klient.dzienneStatystyki({ wlasciwosc: '1', od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/nie rozpoznaję/);
  });
});

describe('createGa4Client — raport reklam', () => {
  const wierszReklamy = (wymiary, metryki) => ({
    dimensionValues: wymiary.map((value) => ({ value })),
    metricValues: metryki.map((value) => ({ value: String(value) })),
  });

  it('pobiera wszystkie strony dni i transakcji, rozdziela kwoty i pomija nieprzypisane kampanie', async () => {
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'SEKRET-TOKEN', expires_in: 3600 }) };
      const body = JSON.parse(opcje.body);
      wywolania.push({ url: String(url), body, headers: opcje.headers });
      const transakcje = body.dimensions.some((d) => d.name === 'transactionId');
      const offset = Number(body.offset ?? 0);
      const rows = transakcje
        ? (offset === 0
          ? [wierszReklamy(['20260916', '1451', '42'], ['97.40']), wierszReklamy(['20260916', '1452', '(not set)'], ['50'])]
          : [wierszReklamy(['20260917', '1453', '43'], ['12.30'])])
        : (offset === 0
          ? [wierszReklamy(['20260916', '42', 'Search'], ['104.06', 253, 6936]), wierszReklamy(['20260916', '', 'Bez ID'], ['9', 2, 3])]
          : [wierszReklamy(['20260917', '43', 'Brand'], ['10.20', 8, 100])]);
      return { ok: true, status: 200, json: async () => ({ rows, rowCount: 10001, metadata: { currencyCode: 'PLN' } }) };
    };
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });

    const wynik = await klient.raportReklam({ wlasciwosc: 'property-a', od: '2026-09-16', do: '2026-09-22' });

    expect(wynik).toEqual({
      dni: [
        { dzien: '2026-09-16', kampaniaId: '42', nazwa: 'Search', koszt: '104.06', klikniecia: 253, wyswietlenia: 6936 },
        { dzien: '2026-09-17', kampaniaId: '43', nazwa: 'Brand', koszt: '10.20', klikniecia: 8, wyswietlenia: 100 },
      ],
      transakcje: [
        { dzien: '2026-09-16', kampaniaId: '42', transactionId: '1451', przychod: '97.40' },
        { dzien: '2026-09-17', kampaniaId: '43', transactionId: '1453', przychod: '12.30' },
      ],
      waluta: 'PLN',
    });
    expect(wywolania).toHaveLength(4);
    expect(wywolania.map((w) => Number(w.body.offset ?? 0))).toEqual([0, 10000, 0, 10000]);
    expect(wywolania.map((w) => w.body.limit)).toEqual([10000, 10000, 10000, 10000]);
    expect(wywolania[0].body.dimensions.map((d) => d.name)).toEqual(['date', 'googleAdsCampaignId', 'googleAdsCampaignName']);
    expect(wywolania[0].body.metrics.map((m) => m.name)).toEqual(['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions']);
    expect(wywolania[2].body.dimensions.map((d) => d.name)).toEqual(['date', 'transactionId', 'sessionGoogleAdsCampaignId']);
    expect(wywolania[2].body.metrics.map((m) => m.name)).toEqual(['purchaseRevenue']);
    expect(wywolania.every((w) => w.headers.authorization === 'Bearer SEKRET-TOKEN')).toBe(true);
    expect(wywolania.every((w) => !w.url.includes('SEKRET-TOKEN'))).toBe(true);
  });

  it('pusty raport zachowuje brak waluty zamiast udawać zero', async () => {
    const fetchImpl = async (url) => String(url).includes('oauth2')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'T', expires_in: 3600 }) }
      : { ok: true, status: 200, json: async () => ({ rowCount: 0, metadata: {} }) };
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    expect(await klient.raportReklam({ wlasciwosc: '1', od: '2026-09-16', do: '2026-09-22' }))
      .toEqual({ dni: [], transakcje: [], waluta: null });
  });

  it('błąd GA4 nie ujawnia tokenu ani treści odpowiedzi', async () => {
    const fetchImpl = async (url) => String(url).includes('oauth2')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'TAJNY-TOKEN', expires_in: 3600 }) }
      : { ok: false, status: 403, json: async () => ({ error: { message: 'Odmowa TAJNY-TOKEN' } }) };
    const klient = createGa4Client({ sciezkaKlucza: kluczTestowy(), fetchImpl });
    const blad = await klient.raportReklam({ wlasciwosc: '1', od: '2026-09-16', do: '2026-09-22' })
      .catch((e) => e);
    expect(blad.message).toContain('GA4: nie udało się pobrać raportu reklam');
    expect(blad.status).toBe(403);
    expect(blad.message).not.toContain('TAJNY-TOKEN');
    expect(blad.message).not.toContain('Odmowa');
  });
});
