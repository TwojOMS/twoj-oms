import { transport } from '../../integracje/transport.js';
// Jedyne miejsce w OMS, ktore rozmawia z Google Analytics Data API (Etap 2 kampanii,
// 2026-08-25). Konto USLUGOWE (JWT-bearer), nie OAuth: dziala w kontenerze bez czlowieka
// przy przegladarce i nie wygasa — ta sama droga, co skrypt arkuszy (gsheets.mjs).
//
// ⚠️ SAME ODCZYTY (`runReport`). Zakres `analytics.readonly` — klucz nie ma prawa niczego
// w GA4 zmienic, nawet gdyby ktos pomylil sie w kodzie.
//
// ⚠️ KLUCZ CZYTANY LENIWIE, PRZY PIERWSZYM UZYCIU, A NIE PRZY STARCIE PANELU. Brak pliku
// (nie wgrany na NAS, zly wolumen) ma zgasic SEKCJE i zostawic slad w `kampania_zrodla`,
// a nie polozyc calego OMS-a przy starcie kontenera — zamowienia i paczki nie moga zalezec
// od tego, czy dziala pomiar marketingu.
//
// ⚠️ ANI KLUCZ PRYWATNY, ANI TOKEN NIE TRAFIAJA DO ZADNEGO KOMUNIKATU (niezmiennik 4.10).

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const OAUTH = 'https://oauth2.googleapis.com/token';
const API = 'https://analyticsdata.googleapis.com/v1beta';
const ZAKRES = 'https://www.googleapis.com/auth/analytics.readonly';
// Token Google zyje godzine; odswiezamy pieć minut wczesniej, zeby przebieg zaczety tuz
// przed koncem waznosci nie dostal 401 w polowie.
const ZAPAS_MS = 5 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ⚠️ ŹRÓDLA META WZORCEM, NIE LISTA: GA4 zapisuje je na kilka sposobow naraz
// (`facebook.com`, `m.facebook.com`, `l.instagram.com`, samo `fb`, `ig`), a lista dokladnych
// wartosci gubi te, ktorych akurat nie przewidzielismy — czyli zanizza ruch z reklamy
// po cichu. Wzorzec czastkowy lapie cala rodzine.
const WZORZEC_META = 'facebook|instagram|^fb$|^ig$';

export function createGa4Client({ sciezkaKlucza, fetchImpl, http = transport({ fetchImpl }), teraz = () => Date.now(), authUrl = OAUTH, baseUrl = API }) {
  if (!sciezkaKlucza) throw new Error('Klient GA4 bez ścieżki klucza — sekcja konfiguracji miała nie wstać.');

  let klucz = null;
  let token = null;
  let tokenDo = 0;

  function wczytajKlucz() {
    if (klucz) return klucz;
    let surowy;
    try {
      surowy = readFileSync(sciezkaKlucza, 'utf8');
    } catch (e) {
      // ⚠️ Komunikat mowi SCIEZKE, bo to jedyna rzecz, ktora czlowiek musi poprawic —
      // i NIE mowi nic o zawartosci pliku.
      throw new Error(`Nie mogę odczytać klucza konta usługowego (${sciezkaKlucza}): ${e.code ?? e.message}`);
    }
    let dane;
    try { dane = JSON.parse(surowy); } catch { throw new Error(`Klucz ${sciezkaKlucza} nie jest poprawnym JSON-em.`); }
    if (!dane?.client_email || !dane?.private_key) {
      throw new Error(`Plik ${sciezkaKlucza} to nie jest klucz konta usługowego (brak client_email / private_key).`);
    }
    klucz = dane;
    return klucz;
  }

  async function dostep() {
    const chwila = teraz();
    if (token && chwila < tokenDo) return token;
    const k = wczytajKlucz();
    const sekundy = Math.floor(chwila / 1000);
    const naglowek = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const tresc = b64url(JSON.stringify({
      iss: k.client_email, scope: ZAKRES, aud: authUrl, iat: sekundy, exp: sekundy + 3600,
    }));
    const podpis = b64url(createSign('RSA-SHA256').update(`${naglowek}.${tresc}`).sign(k.private_key));

    let res;
    try {
      res = await http(authUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${naglowek}.${tresc}.${podpis}`,
        }),
      });
    } catch (e) {
      throw new Error(`Google nieosiągalny: ${e.message}`);
    }
    const dane = await res.json().catch(() => null);
    if (!res.ok || !dane?.access_token) {
      // `error_description` Google bywa konkretne („Invalid JWT Signature"), ale nigdy nie
      // zawiera klucza — a samego `assertion` nie przepisujemy do komunikatu.
      throw new Error(`Google odmówił tokenu: ${dane?.error ?? res.status} ${dane?.error_description ?? ''}`.trim());
    }
    token = dane.access_token;
    tokenDo = chwila + Math.max(0, (Number(dane.expires_in) || 3600) * 1000 - ZAPAS_MS);
    return token;
  }

  async function raport(wlasciwosc, cialo) {
    const dostepny = await dostep();
    let res;
    try {
      res = await http(`${baseUrl}/properties/${wlasciwosc}:runReport`, {
        method: 'POST',
        headers: { authorization: `Bearer ${dostepny}`, 'content-type': 'application/json' },
        body: JSON.stringify(cialo),
      });
    } catch (e) {
      throw new Error(`GA4 nieosiągalne: ${e.message}`);
    }
    const dane = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GA4 odmówiło (${res.status}): ${dane?.error?.message ?? 'brak powodu'}`);
    // Raport BEZ wierszy jest poprawny (dzien bez ruchu), ale odpowiedz, ktora nie ma nawet
    // pola `rows` ani `metadata`, znaczy „nie rozumiem tej odpowiedzi" — a to nie to samo
    // co zero sesji i nie wolno tego zapisac jako zero.
    if (dane === null || typeof dane !== 'object' || (!('rows' in dane) && !('metadata' in dane) && !('rowCount' in dane))) {
      throw new Error(`GA4 oddało odpowiedź, której nie rozpoznaję: ${JSON.stringify(dane).slice(0, 200)}`);
    }
    return dane.rows ?? [];
  }

  const liczba = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  // GA4 oddaje date jako `20260824` — panel wszedzie indziej uzywa `RRRR-MM-DD`.
  const dzienZGa4 = (v) => {
    const s = String(v ?? '');
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
  };

  const zakres = (od, doDnia) => [{ startDate: od, endDate: doDnia }];

  /**
   * Dzienne liczby dla okna kampanii: sesje i uzytkownicy sklepu, sesje ze zrodel Meta
   * oraz odslony strony warunkow promocji.
   *
   * ⚠️⚠️ TRZY OSOBNE RAPORTY, NIE JEDEN Z DWOMA WYMIARAMI — i to nie jest rozrzutnosc.
   * `totalUsers` to liczba UNIKALNYCH ludzi: rozbita po zrodle i zsumowana w panelu liczy
   * dwa razy kazdego, kto wszedl raz z Facebooka i raz z Google. Jedyna droga do prawdziwej
   * liczby dziennej jest zapytac o nia BEZ drugiego wymiaru.
   */
  async function dzienneStatystyki({ wlasciwosc, od, do: doDnia, sciezkaPromo = null }) {
    const wgDni = new Map();
    const wiersz = (dzien) => {
      const dotad = wgDni.get(dzien) ?? { dzien, sesje: 0, uzytkownicy: 0, sesjeMeta: 0, odslonyPromo: 0 };
      wgDni.set(dzien, dotad);
      return dotad;
    };

    for (const w of await raport(wlasciwosc, {
      dateRanges: zakres(od, doDnia),
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    })) {
      const dzien = dzienZGa4(w.dimensionValues?.[0]?.value);
      if (!dzien) continue;
      const r = wiersz(dzien);
      r.sesje = liczba(w.metricValues?.[0]?.value);
      r.uzytkownicy = liczba(w.metricValues?.[1]?.value);
    }

    for (const w of await raport(wlasciwosc, {
      dateRanges: zakres(od, doDnia),
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: WZORZEC_META } },
      },
    })) {
      const dzien = dzienZGa4(w.dimensionValues?.[0]?.value);
      if (dzien) wiersz(dzien).sesjeMeta = liczba(w.metricValues?.[0]?.value);
    }

    if (sciezkaPromo) {
      for (const w of await raport(wlasciwosc, {
        dateRanges: zakres(od, doDnia),
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensionFilter: {
          filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: sciezkaPromo } },
        },
      })) {
        const dzien = dzienZGa4(w.dimensionValues?.[0]?.value);
        if (dzien) wiersz(dzien).odslonyPromo = liczba(w.metricValues?.[0]?.value);
      }
    }

    return [...wgDni.values()].sort((a, b) => a.dzien.localeCompare(b.dzien));
  }

  // Raport bieżących reklam jest odrębny od historycznego pomiaru promocji.
  // Nie przepuszczamy odpowiedzi API ani wyjątków fetch do wyższej warstwy: mogą
  // zawierać token lub inne dane połączenia. Kod HTTP zostaje do klasyfikacji stanu.
  async function raportReklam({ wlasciwosc, od, do: doDnia }) {
    const LIMIT = 10000;
    const dateRanges = zakres(od, doDnia);
    let statusBledu = null;

    async function strony(dimensions, metrics) {
      const zebrane = [];
      let waluta = null;
      for (let offset = 0; ; offset += LIMIT) {
        const dostepny = await dostep();
        const res = await http(`${baseUrl}/properties/${encodeURIComponent(wlasciwosc)}:runReport`, {
          method: 'POST',
          headers: { authorization: `Bearer ${dostepny}`, 'content-type': 'application/json' },
          body: JSON.stringify({ dateRanges, dimensions: dimensions.map((name) => ({ name })),
            metrics: metrics.map((name) => ({ name })), limit: LIMIT, offset }),
        });
        if (!res.ok) {
          statusBledu = res.status;
          throw new Error('GA4 odmówiło odczytu');
        }
        const dane = await res.json();
        if (!dane || typeof dane !== 'object' || !Number.isInteger(dane.rowCount) || dane.rowCount < 0
          || (dane.rows !== undefined && !Array.isArray(dane.rows))) {
          throw new Error('Niepoprawna odpowiedź GA4');
        }
        const kod = dane.metadata?.currencyCode ?? null;
        if (kod && waluta && kod !== waluta) throw new Error('Niezgodna waluta GA4');
        waluta = kod ?? waluta;
        zebrane.push(...(dane.rows ?? []));
        if (offset + LIMIT >= dane.rowCount) break;
      }
      return { rows: zebrane, waluta };
    }

    const kampaniaId = (value) => {
      const id = String(value ?? '').trim();
      return id && id.toLowerCase() !== '(not set)' ? id : null;
    };
    const wartosc = (row, index) => row.metricValues?.[index]?.value;
    const calkowita = (value) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Niepoprawna miara GA4');
      return n;
    };
    const kwota = (value) => {
      const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? ''));
      if (!match) throw new Error('Niepoprawna kwota GA4');
      const [, znak, cale, ulamek = ''] = match;
      const grosze = BigInt(cale) * 100n + BigInt((ulamek + '00').slice(0, 2))
        + (Number(ulamek[2] ?? 0) >= 5 ? 1n : 0n);
      const wynik = znak === '-' ? -grosze : grosze;
      return `${wynik < 0n ? '-' : ''}${String((wynik < 0n ? -wynik : wynik) / 100n)}.${String((wynik < 0n ? -wynik : wynik) % 100n).padStart(2, '0')}`;
    };

    try {
      const dniRaport = await strony(
        ['date', 'googleAdsCampaignId', 'googleAdsCampaignName'],
        ['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions'],
      );
      const transakcjeRaport = await strony(
        ['date', 'transactionId', 'sessionGoogleAdsCampaignId'],
        ['purchaseRevenue'],
      );
      if (dniRaport.waluta && transakcjeRaport.waluta && dniRaport.waluta !== transakcjeRaport.waluta) {
        throw new Error('Niezgodna waluta GA4');
      }
      const dni = dniRaport.rows.flatMap((row) => {
        const dzien = dzienZGa4(row.dimensionValues?.[0]?.value);
        const id = kampaniaId(row.dimensionValues?.[1]?.value);
        if (!dzien || !id) return [];
        return [{ dzien, kampaniaId: id, nazwa: row.dimensionValues?.[2]?.value ?? '',
          koszt: kwota(wartosc(row, 0)), klikniecia: calkowita(wartosc(row, 1)),
          wyswietlenia: calkowita(wartosc(row, 2)) }];
      });
      const transakcje = transakcjeRaport.rows.flatMap((row) => {
        const dzien = dzienZGa4(row.dimensionValues?.[0]?.value);
        const transactionId = String(row.dimensionValues?.[1]?.value ?? '').trim();
        const id = kampaniaId(row.dimensionValues?.[2]?.value);
        if (!dzien || !id || !transactionId || transactionId.toLowerCase() === '(not set)') return [];
        return [{ dzien, kampaniaId: id, transactionId, przychod: kwota(wartosc(row, 0)) }];
      });
      return { dni, transakcje, waluta: dniRaport.waluta ?? transakcjeRaport.waluta };
    } catch {
      const blad = new Error(`GA4: nie udało się pobrać raportu reklam${statusBledu ? ` (HTTP ${statusBledu})` : ''}`);
      if (statusBledu) blad.status = statusBledu;
      throw blad;
    }
  }

  return { dzienneStatystyki, raportReklam };
}
