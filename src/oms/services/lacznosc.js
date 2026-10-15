import { transport } from '../../integracje/transport.js';
import { lookup as lookupDns } from 'node:dns/promises';

// Sprawdzenie osiagalnosci uslug — DWIE WARSTWY OSOBNO: najpierw nazwa (DNS), potem
// polaczenie (HTTP). Rozdzielenie ich jest cala wartoscia tego modulu.
//
// ⚠️ „fetch failed" NIE ODROZNIA „nie znam nazwy" od „usluga nie odpowiada". 17.08.2026
// panel pokazywal ten komunikat przy sklepach, Allegro i inFakcie naraz — a padl DNS na
// NAS-ie. Ekran, ktory mowi „nie rozwiazuje sie nazwa sklep-b.example", wysyla czlowieka
// od razu do sieci; „fetch failed" wysylal go w kod panelu.
//
// ⚠️⚠️ ANI JEDEN TOKEN, ANI JEDEN KLUCZ. Sprawdzamy WYLACZNIE, czy da sie dojsc pod adres —
// bez naglowka autoryzacji, bez odswiezania tokenow. Powod jest zmierzony: refresh token
// Allegro jest JEDNORAZOWY i 14.08.2026 dwa procesy, ktore wyslaly ten sam, polozyly kanal
// na siedem godzin. Ekran diagnostyczny bywa odswiezany co chwile przy awarii — nie ma
// prawa niczego zuzyc.

const LIMIT_MS = 5000;

/** 401/403 to DZIALAJACA usluga, ktora nie chce rozmawiac bez klucza — a my pytamy bez klucza. */
const osiagalna = (status) => status < 500;

export async function sprawdzLacznosc({
  cele = [],
  limitMs = LIMIT_MS,
  lookup = lookupDns,
  fetchImpl, http = transport({ fetchImpl }),
  teraz = () => Date.now(),
} = {}) {
  // ⚠️⚠️ PO KOLEI, NIE RÓWNOLEGLE — i to jest decyzja o PRAWDZIWOSCI LICZB, nie o wydajnosci.
  //
  // Pierwsza wersja sprawdzala wszystko naraz (`Promise.all`) i na produkcji pokazala
  // **4059 ms przy siedmiu roznych hostach, co do milisekundy** — podczas gdy pojedyncze
  // wywolanie z tego samego kontenera trwa ~300 ms (zmierzone). Powod: kazde sprawdzenie
  // robi DWA rozwiazania nazwy (nasze + wewnetrzne `fetch`), a `dns.lookup` chodzi przez
  // czterowatkowa pule libuv; dziewiec celow naraz ustawia sie w kolejce, ktora dodatkowo
  // czeka na ~1-sekundowe ogony resolwera. Ekran raportowal wiec WLASNE zatkanie jako czas
  // odpowiedzi cudzej uslugi — czyli wysylalby szukac awarii wydajnosci, ktorej nie ma.
  //
  // Sekwencyjnie kazdy pomiar jest prawdziwy, a caly ekran i tak konczy sie w kilka sekund
  // (dziewiec uslug × ~0,3 s). Diagnostyka ma nie klamac; szybkosc jest tu drugorzedna.
  const wyniki = [];
  for (const cel of cele) {
    // eslint-disable-next-line no-await-in-loop -- patrz komentarz wyzej: to jest cel, nie przeoczenie
    wyniki.push(await (async () => {
    const wynik = {
      klucz: cel.klucz, nazwa: cel.nazwa, url: cel.url, host: cel.host,
      ok: false, warstwa: null, adresIp: null, status: null, msDns: null, msHttp: null, komunikat: '',
    };

    if (!cel.host) {
      wynik.warstwa = 'konfiguracja';
      wynik.komunikat = `Adres „${cel.url}" nie jest poprawnym adresem — popraw konfigurację panelu.`;
      return wynik;
    }

    // ——— WARSTWA 1: NAZWA ———————————————————————————————————————————————————————
    const t0 = teraz();
    try {
      const { address } = await lookup(cel.host);
      wynik.adresIp = address;
      wynik.msDns = teraz() - t0;
    } catch (e) {
      wynik.msDns = teraz() - t0;
      wynik.warstwa = 'dns';
      // ⚠️ Zdanie ma nazwac WINOWAJCE, nie kod bledu: przy tej awarii operator ma pojsc
      // sprawdzic DNS, a nie sklep.
      wynik.komunikat = `Nie rozwiązuje się nazwa ${cel.host} — to awaria DNS, nie tej usługi.`
        + ` (${e?.code || e?.message || 'nieznany błąd'})`;
      return wynik;
    }

    // ——— WARSTWA 2: POLACZENIE ——————————————————————————————————————————————————
    const t1 = teraz();
    const przerwij = new AbortController();
    const stoper = setTimeout(() => przerwij.abort(), limitMs);
    try {
      // HEAD, bo pytamy o osiagalnosc, a nie o tresc — i bez ani jednego naglowka
      // autoryzacji (patrz naglowek pliku).
      const odp = await http(cel.url, { method: 'HEAD', redirect: 'manual', signal: przerwij.signal });
      wynik.msHttp = teraz() - t1;
      wynik.status = odp.status;
      wynik.ok = osiagalna(odp.status);
      wynik.warstwa = wynik.ok ? null : 'usluga';
      wynik.komunikat = wynik.ok
        ? `Odpowiada (HTTP ${odp.status}).`
        : `Usługa odpowiada błędem HTTP ${odp.status} — nazwa i połączenie są w porządku.`;
    } catch (e) {
      wynik.msHttp = teraz() - t1;
      wynik.warstwa = 'siec';
      // ⚠️ Limit pokazujemy w sekundach dopiero od sekundy w gore — „limit czasu (0 s)"
      // przy progu 5 ms w tescie czytaloby sie jak usterka ekranu.
      const próg = limitMs >= 1000 ? `${Math.round(limitMs / 1000)} s` : `${limitMs} ms`;
      wynik.komunikat = e?.name === 'AbortError'
        ? `Przekroczony limit czasu (${próg}) — nazwa rozwiązuje się poprawnie, usługa nie odpowiedziała.`
        : `Nazwa rozwiązuje się (${wynik.adresIp}), ale połączenie nie doszło: ${e?.message || 'nieznany błąd'}.`;
    } finally {
      clearTimeout(stoper);
    }
    return wynik;
    })());
  }
  return wyniki;
}
