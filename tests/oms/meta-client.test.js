import { describe, it, expect } from 'vitest';
import { createMetaClient } from '../../src/oms/meta/client.js';

// Klient Meta Graph API (Etap 1 kampanii). Atrapa `fetch` — suita nie rozmawia z Meta.
// Ksztalt odpowiedzi odwzorowany z ZYWEGO konta (odczyt 2026-08-25, act_10200536090637189):
// `data: [{ spend, impressions, reach, clicks, inline_link_clicks, date_start, date_stop }]`.

const KONTO = 'act_10200536090637189';
const DRUGIE = 'act_1513037475565017';

const odpowiedz = (data, { ok = true, status = 200, blad = null } = {}) => ({
  ok, status,
  json: async () => (blad ? { error: blad } : { data }),
});

// Atrapa zapisuje, o co zapytano — to na tych zapisach stoja asercje o naglowku i adresie.
function atrapa(mapa) {
  const wywolania = [];
  const fetchImpl = async (url, opcje) => {
    wywolania.push({ url: new URL(url), opcje });
    const klucz = [...Object.keys(mapa)].find((k) => String(url).includes(k));
    return mapa[klucz] ?? odpowiedz([]);
  };
  return { fetchImpl, wywolania };
}

const dzien = (data, nad = {}) => ({
  date_start: data, date_stop: data,
  spend: '30.00', impressions: '1000', reach: '800', clicks: '40', inline_link_clicks: '12', ...nad,
});

describe('createMetaClient — bariery', () => {
  it('bez tokenu w ogóle nie powstaje', () => {
    expect(() => createMetaClient({ token: '', konta: [KONTO] })).toThrow(/bez tokenu/);
  });

  // ⚠️⚠️ TOKEN W NAGLOWKU, NIGDY W ADRESIE: adresy z parametrami laduja w logach
  // posrednikow, a ten token jest BEZTERMINOWY (System User).
  it('token idzie nagłówkiem Authorization, a nie w query stringu', async () => {
    const { fetchImpl, wywolania } = atrapa({ insights: odpowiedz([dzien('2026-08-24')]) });
    const klient = createMetaClient({ token: 'SEKRET-XYZ', konta: [KONTO], fetchImpl });
    await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' });

    expect(wywolania[0].opcje.headers.Authorization).toBe('Bearer SEKRET-XYZ');
    expect(wywolania[0].url.search).not.toContain('SEKRET-XYZ');
    expect(String(wywolania[0].url)).not.toContain('SEKRET-XYZ');
  });

  it('komunikat odmowy NIE niesie tokenu', async () => {
    const { fetchImpl } = atrapa({
      insights: odpowiedz(null, { ok: false, status: 400, blad: { message: 'Invalid OAuth token', type: 'OAuthException' } }),
    });
    const klient = createMetaClient({ token: 'SEKRET-XYZ', konta: [KONTO], fetchImpl });
    await expect(klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/OAuthException.*Invalid OAuth token/);
    await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' }).catch((e) => {
      expect(e.message).not.toContain('SEKRET-XYZ');
      expect(e.status).toBe(400);
    });
  });

  // 200 z cialem bez `data` wygladaloby jak „zero wydatkow" — czyli dokladnie jak
  // „reklama nie chodzi". To ma byc GLOSNY blad, nie cicha zerowa doba.
  it('odpowiedź 200 bez listy „data" jest błędem, nie zerem', async () => {
    const { fetchImpl } = atrapa({ insights: { ok: true, status: 200, json: async () => ({ cokolwiek: 1 }) } });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    await expect(klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' }))
      .rejects.toThrow(/bez listy/);
  });
});

describe('createMetaClient — dzienne statystyki', () => {
  it('przenosi dzień, kwotę i liczby z odpowiedzi', async () => {
    const { fetchImpl } = atrapa({ insights: odpowiedz([dzien('2026-08-24', { spend: '88.19' })]) });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    const wynik = await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' });

    expect(wynik).toEqual([{
      dzien: '2026-08-24', wydatek: '88.19', wyswietlenia: 1000, zasieg: 800,
      klikniecia: 40, kliknieciaLinku: 12,
    }]);
  });

  // ⚠️ SUMOWANIE W GROSZACH: 0.1 + 0.2 na liczbach zmiennoprzecinkowych daje 0.30000000000000004,
  // a dwa konta w jednym dniu to najzwyklejszy przypadek tej kampanii (remarketing + ruchowa).
  it('sumuje dwa konta w jednym dniu bez gubienia grosza', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes(KONTO)) return odpowiedz([dzien('2026-08-24', { spend: '0.10', impressions: '3' })]);
      return odpowiedz([dzien('2026-08-24', { spend: '0.20', impressions: '4' })]);
    };
    const klient = createMetaClient({ token: 'x', konta: [KONTO, DRUGIE], fetchImpl });
    const wynik = await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-24' });

    expect(wynik).toHaveLength(1);
    expect(wynik[0].wydatek).toBe('0.30');
    expect(wynik[0].wyswietlenia).toBe(7);
  });

  // ⚠️⚠️ MIKROWYDATKI PONIZEJ GROSZA — zlapane weryfikacja mutacyjna. Meta oddaje takie
  // kwoty przy sladowej emisji na Instagramie (w baseline 0,92 zl na CALE 30 dni).
  // Zaokraglenie KAZDEGO konta osobno robi z dwoch takich wierszy 0,00 zl zamiast 0,01 zl —
  // czyli gubi wydatek, ktory naprawde byl. Zaokraglamy RAZ, po zsumowaniu.
  it('dwa mikrowydatki poniżej grosza sumują się do grosza, nie do zera', async () => {
    const fetchImpl = async (url) => (String(url).includes(KONTO)
      ? odpowiedz([dzien('2026-08-24', { spend: '0.004' })])
      : odpowiedz([dzien('2026-08-24', { spend: '0.004' })]));
    const klient = createMetaClient({ token: 'x', konta: [KONTO, DRUGIE], fetchImpl });
    expect((await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-24' }))[0].wydatek).toBe('0.01');
  });

  // Kwota zapisana do bazy MUSI byc w pelnych groszach — panel liczy pieniadze wylacznie
  // groszami calkowitymi, wiec ulamek grosza nie ma jak przez ten model przejsc.
  it('kwota wychodzi zawsze w pełnych groszach', async () => {
    const { fetchImpl } = atrapa({ insights: odpowiedz([dzien('2026-08-24', { spend: '1.2345' })]) });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    const wydatek = (await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-24' }))[0].wydatek;
    expect(wydatek).toBe('1.23');
    expect(Number(wydatek) * 100).toBeCloseTo(Math.round(Number(wydatek) * 100), 9);
  });

  it('układa dni rosnąco, każdy dzień osobno', async () => {
    const { fetchImpl } = atrapa({
      insights: odpowiedz([dzien('2026-08-25', { spend: '5.00' }), dzien('2026-08-24', { spend: '3.00' })]),
    });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    const wynik = await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' });
    expect(wynik.map((w) => w.dzien)).toEqual(['2026-08-24', '2026-08-25']);
    expect(wynik.map((w) => w.wydatek)).toEqual(['3.00', '5.00']);
  });

  it('pusta odpowiedź (brak wydatków w oknie) to pusta lista, nie błąd', async () => {
    const { fetchImpl } = atrapa({ insights: odpowiedz([]) });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    expect(await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-25' })).toEqual([]);
  });

  it('okno dat jedzie jako time_range, a rozbicie dzienne jako time_increment', async () => {
    const { fetchImpl, wywolania } = atrapa({ insights: odpowiedz([]) });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-09-07' });

    const p = wywolania[0].url.searchParams;
    expect(JSON.parse(p.get('time_range'))).toEqual({ since: '2026-08-24', until: '2026-09-07' });
    expect(p.get('time_increment')).toBe('1');
    expect(p.get('level')).toBe('account');
  });

  // Zawezenie do wskazanych kampanii reklamowych (kolumna `kampanie.meta_kampanie`).
  it('wskazane kampanie: pyta na poziomie kampanii i odsiewa cudze wiersze', async () => {
    const { fetchImpl, wywolania } = atrapa({
      insights: odpowiedz([
        { ...dzien('2026-08-24', { spend: '10.00' }), campaign_id: '111' },
        { ...dzien('2026-08-24', { spend: '99.00' }), campaign_id: '222' },
      ]),
    });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    const wynik = await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-24', kampanie: ['111'] });

    expect(wywolania[0].url.searchParams.get('level')).toBe('campaign');
    expect(wynik).toHaveLength(1);
    expect(wynik[0].wydatek).toBe('10.00');
  });

  it('kwota w nieznanym formacie liczy się jako zero, a nie jako NaN na ekranie', async () => {
    const { fetchImpl } = atrapa({ insights: odpowiedz([dzien('2026-08-24', { spend: 'brak danych' })]) });
    const klient = createMetaClient({ token: 'x', konta: [KONTO], fetchImpl });
    expect((await klient.dzienneStatystyki({ od: '2026-08-24', do: '2026-08-24' }))[0].wydatek).toBe('0.00');
  });
});

describe('createMetaClient — raport reklam', () => {
  it('czyta dwie strony insights, status kampanii i budżet zestawu bez uznania ACTIVE za emisję', async () => {
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      const u = new URL(url);
      wywolania.push({ url: u, opcje });
      if (u.pathname.endsWith('/campaigns')) return {
        ok: true, status: 200, json: async () => ({ data: [
          { id: 'c1', name: 'Ruch', status: 'ACTIVE', effective_status: 'ACTIVE' },
          { id: 'c2', name: 'Dawna', status: 'ACTIVE', effective_status: 'ACTIVE' },
        ] }),
      };
      if (u.pathname.endsWith('/adsets')) return {
        ok: true, status: 200, json: async () => ({ data: [
          { id: 's1', campaign_id: 'c1', daily_budget: '1200' },
          { id: 's2', campaign_id: 'c1', daily_budget: '800' },
          { id: 's3', campaign_id: 'c2', lifetime_budget: '10000', start_time: '2026-09-01', end_time: '2026-09-10' },
          { id: 's4', campaign_id: 'c2', lifetime_budget: '20000', start_time: '2026-09-11', end_time: '2026-09-20' },
        ] }),
      };
      if (u.pathname.endsWith('/insights') && !u.searchParams.has('after')) return {
        ok: true, status: 200, json: async () => ({
          data: [{ campaign_id: 'c1', date_start: '2026-09-22', spend: '1.25', impressions: '100', clicks: '8', inline_link_clicks: '3' }],
          paging: { next: `https://evil.example/steal?access_token=SEKRET-XYZ&after=CURSOR1` },
        }),
      };
      if (u.pathname.endsWith('/insights') && u.searchParams.get('after') === 'CURSOR1') return {
        ok: true, status: 200, json: async () => ({
          data: [{ campaign_id: 'c1', date_start: '2026-09-23', spend: '0.004', impressions: '2', clicks: '1', inline_link_clicks: '1' }],
        }),
      };
      return { ok: true, status: 200, json: async () => ({ currency: 'PLN', timezone_name: 'Europe/Warsaw' }) };
    };
    const raport = await createMetaClient({ token: 'SEKRET-XYZ', konta: [KONTO], fetchImpl })
      .raportReklam({ konto: KONTO, od: '2026-09-22', do: '2026-09-23' });

    expect(raport.waluta).toBe('PLN');
    expect(raport.strefa).toBe('Europe/Warsaw');
    expect(raport.dni).toEqual([
      { kontoId: KONTO, kampaniaId: 'c1', dzien: '2026-09-22', wydatek: '1.25', wyswietlenia: 100, klikniecia: 8, kliknieciaLinku: 3 },
      { kontoId: KONTO, kampaniaId: 'c1', dzien: '2026-09-23', wydatek: '0.004', wyswietlenia: 2, klikniecia: 1, kliknieciaLinku: 1 },
    ]);
    expect(raport.kampanie.find((k) => k.id === 'c2')).toMatchObject({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    expect(raport.kampanie.find((k) => k.id === 'c2').emituje).toBe(false);
    expect(raport.kampanie.find((k) => k.id === 'c1').budzety).toEqual([
      { poziom: 'zestawy', typ: 'dzienny', kwotaMinor: '2000' },
    ]);
    expect(raport.kampanie.find((k) => k.id === 'c2').budzety).toEqual([
      { poziom: 'zestawy', typ: 'calkowity', okresOd: '2026-09-01', okresDo: '2026-09-10', kwotaMinor: '10000' },
      { poziom: 'zestawy', typ: 'calkowity', okresOd: '2026-09-11', okresDo: '2026-09-20', kwotaMinor: '20000' },
    ]);
    expect(wywolania.filter((w) => w.url.pathname.endsWith('/insights'))).toHaveLength(2);
    expect(wywolania.every((w) => w.url.origin === 'https://graph.facebook.com')).toBe(true);
    expect(wywolania.every((w) => !String(w.url).includes('SEKRET-XYZ'))).toBe(true);
    expect(wywolania.every((w) => w.opcje.headers.Authorization === 'Bearer SEKRET-XYZ')).toBe(true);
  });

  it('nie ujawnia tokenu z błędu Graph ani z błędu sieci', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({
      error: { type: 'OAuthException', message: 'Token SEKRET-XYZ invalid' },
    }) });
    const klient = createMetaClient({ token: 'SEKRET-XYZ', konta: [KONTO], fetchImpl });
    await expect(klient.raportReklam({ konto: KONTO, od: '2026-09-22', do: '2026-09-23' }))
      .rejects.toThrow(/OAuthException/);
    await klient.raportReklam({ konto: KONTO, od: '2026-09-22', do: '2026-09-23' }).catch((e) => {
      expect(e.message).not.toContain('SEKRET-XYZ');
    });
    const siec = createMetaClient({ token: 'SEKRET-XYZ', konta: [KONTO], fetchImpl: async () => {
      throw new Error('Request SEKRET-XYZ failed');
    } });
    await siec.raportReklam({ konto: KONTO, od: '2026-09-22', do: '2026-09-23' }).catch((e) => {
      expect(e.message).not.toContain('SEKRET-XYZ');
    });
  });
});
