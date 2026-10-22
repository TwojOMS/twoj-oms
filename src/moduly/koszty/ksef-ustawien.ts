// PRZ-102.22 — klient KSeF faktur kosztowych z bieżącej konfiguracji: plik → panel → brak. Wzór: uslugaGus
// (moduly/zamowienia/gus-ustawien.ts, PRZ-102.11).
//
// Klient KSeF nie jest już budowany raz przy starcie: czuwacz kosztów (zegar i „Odśwież teraz”), PDF kosztu i paczka
// kosztów dla biura pytają przy każdym użyciu o BIEŻĄCY zestaw (klient + sesja + czuwacz + wizualizacja). Token z pliku
// (KSEF_TOKEN) — zestaw zbudowany raz przy starcie, bo plik nie zmienia się bez restartu. Zapis z Ustawień → Integracje
// → KSeF czytany z bazy; zestaw z panelu powstaje na nowo TYLKO przy zmianie tokenu, więc sesja KSeF (tokeny_ksef,
// jednorazowy redeem) i blokada „jeden przebieg naraz” przeżywają kolejne tyknięcia. Zapis albo usunięcie tokenu działa
// od następnego przebiegu — bez restartu.
// ⚠️ Token jest sekretem: nie idzie do logu ani do komunikatu (komunikaty buduje klient KSeF z odpowiedzi serwera).
// ⚠️ Wyłączony moduł „Koszty” (Ustawienia → Moduły, PRZ-102.22) jest sprawdzany przy KAŻDYM przebiegu, przed budową
// klienta: wyłączony czuwacz niczego nie woła w KSeF.
import { bladOperatora } from '../../domena/bledy.js';
import { tokenZZapisu, nipZapisuZgodny, ODMOWA_KSEF_BRAK_NIP } from '../../domena/konfiguracja-ksef-kosztow.js';
import { POWOD_TRWA } from './services/czuwacz-kosztow.js';

export type KlientKsef = Record<string, (...a: any[]) => Promise<any>>;
export type ZestawKsef = { klient: KlientKsef; sesja: { accessToken: () => Promise<string> }; czuwacz: { przebieg: (o?: { wymuszony?: boolean }) => Promise<any> }; wizualizacja: { pdf: (n: string) => Promise<any> } };
type Zapis = { ustawienia: Record<string, unknown>; sekrety: Record<string, unknown> } | null;
export type ZrodloKsef = ReturnType<typeof zrodloKsefKosztow>;

/** Powody pominięcia przebiegu czuwacza — stałe, jak POWOD_TRWA/POWOD_NIE_TA_PORA (zegar loguje tylko POWOD_TRWA). */
export const POWOD_MODUL_WYLACZONY = 'moduł Koszty wyłączony';
export const POWOD_BRAK_TOKENU = 'brak tokenu KSeF';
/** PRZ-108.10 (recenzja): token z ekranu jest, NIP-u firmy brak (Ustawienia → Firma). */
export const POWOD_BRAK_NIP = 'brak NIP-u firmy — wpisz go w Ustawienia → Firma';
const BRAK_KSEF = 'Panel nie ma podpiętego KSeF — dodaj token w Ustawienia → Integracje → KSeF.';

export function zrodloKsefKosztow({ zPliku = null, wczytaj, nipSprzedawcy, baseUrl, fabryka, zestaw, wylaczony = () => false, teraz = () => new Date() }: {
  // PRZ-108.10: NIP tekstem (stary kształt) albo funkcją — NIP z Ustawień → Firma czytany przy KAŻDYM użyciu; zmiana NIP-u
  // daje nowy zestaw (odcisk niżej), bo kontekst logowania tokenem to inna firma.
  zPliku?: ZestawKsef | null; wczytaj: () => Zapis; nipSprzedawcy: string | null | (() => string | null); baseUrl?: string;
  fabryka: (o: { token: string; nip: string; baseUrl?: string }) => KlientKsef; zestaw: (klient: KlientKsef, o: { token: string; nip: string }) => ZestawKsef;
  wylaczony?: () => boolean; teraz?: () => Date;
}) {
  const nipTeraz = (): string | null => (typeof nipSprzedawcy === 'function' ? nipSprzedawcy() : nipSprzedawcy) || null;
  let odcisk: string | null = null;
  let zPaneluZestaw: ZestawKsef | null = null;
  const zPanelu = (): ZestawKsef | null => {
    const zapis = wczytaj();
    const token = tokenZZapisu(zapis);
    const nip = nipTeraz();
    if (!token || !nip || !nipZapisuZgodny(zapis, nip)) { odcisk = null; zPaneluZestaw = null; return null; }
    const nowy = JSON.stringify([token, nip, baseUrl ?? null]);
    if (nowy !== odcisk || !zPaneluZestaw) { zPaneluZestaw = zestaw(fabryka({ token, nip, baseUrl }), { token, nip }); odcisk = nowy; }
    return zPaneluZestaw;
  };
  // Kolejność rozstrzyga regułę „plik wygrywa”: stary zapis z ekranu nie przesłoni tokenu z pliku.
  const biezacy = (): ZestawKsef | null => zPliku ?? zPanelu();
  // Token z pliku ma NIP z pliku (start bez niego odmawia) — brak NIP-u dotyczy wyłącznie tokenu z ekranu.
  const brakNipu = (): boolean => !zPliku && Boolean(tokenZZapisu(wczytaj())) && !nipTeraz();
  return {
    zEnv: Boolean(zPliku),
    biezacy,
    wylaczony,
    dostepny: () => Boolean(biezacy()),
    zapisany: () => Boolean(tokenZZapisu(wczytaj())),
    /** Zapis z ekranu jest, ale jego NIP nie zgadza się już z NIP-em firmy (plik albo Ustawienia → Firma) — token nieużywany. */
    nipNiezgodny: () => { const z = wczytaj(); return Boolean(tokenZZapisu(z)) && !nipZapisuZgodny(z, nipTeraz()); },
    /** Bieżący NIP firmy — kontekst tokenu z ekranu (null = brak, token nieużywalny). */
    nipFirmy: nipTeraz,
    /** PRZ-108.10 (recenzja): token z ekranu zapisany, NIP-u firmy brak — przyczyna, którą trzeba nazwać wprost. */
    brakNipu,
    /** Zdanie dla człowieka, czemu KSeF z panelu nie działa, albo null (wtedy obowiązują dotychczasowe komunikaty). */
    powodNiedostepnosci: () => (brakNipu() ? ODMOWA_KSEF_BRAK_NIP : null),
    // „Sprawdź połączenie” sprawdza ZAPIS Z EKRANU (w piaskownicy: atrapą z tym tokenem), nie plik. Tylko odczyt:
    // logowanie tokenem (ta sama sesja co czuwacz — nie spala drugiego redeem) i jedna strona metadanych z ostatniej
    // doby. Wynik nie trafia do kosztów, kursor pobierania stoi.
    sprawdzZapisany: async () => {
      const z = zPanelu();
      if (!z && brakNipu()) throw bladOperatora(ODMOWA_KSEF_BRAK_NIP, { status: 400 });
      if (!z) throw bladOperatora('Najpierw zapisz token, potem sprawdź połączenie.', { status: 400 });
      const accessToken = await z.sesja.accessToken();
      const koniec = teraz();
      await z.klient.pobierzMetadane({ accessToken, from: new Date(koniec.getTime() - 86400000).toISOString(), to: koniec.toISOString(), pageOffset: 0 });
      return { ok: true };
    },
  };
}

/**
 * Czuwacz kosztów dla zegara i „Odśwież teraz”: bieżący zestaw przy każdym przebiegu. Własna blokada „jeden przebieg
 * naraz” obejmuje także zmianę tokenu w trakcie długiego przebiegu (nowy zestaw ma własną blokadę, stary jeszcze pracuje).
 */
export function czuwaczZeZrodla(zrodlo: ZrodloKsef) {
  let trwa = false;
  return {
    dostepny: () => !zrodlo.wylaczony() && zrodlo.dostepny(),
    powodNiedostepnosci: () => (zrodlo.wylaczony() ? null : zrodlo.powodNiedostepnosci()),
    przebieg: async (o?: { wymuszony?: boolean }) => {
      if (zrodlo.wylaczony()) return { pominiety: true, powod: POWOD_MODUL_WYLACZONY };
      const z = zrodlo.biezacy();
      if (!z) return { pominiety: true, powod: zrodlo.brakNipu() ? POWOD_BRAK_NIP : POWOD_BRAK_TOKENU };
      if (trwa) return { pominiety: true, powod: POWOD_TRWA };
      trwa = true;
      try { return await z.czuwacz.przebieg(o); } finally { trwa = false; }
    },
  };
}

/** Wizualizacja kosztu (PDF z XML-a w KSeF) — trasa /koszty/:n/pdf i paczka kosztów dla biura. */
export function wizualizacjaZeZrodla(zrodlo: ZrodloKsef) {
  return {
    dostepny: () => !zrodlo.wylaczony() && zrodlo.dostepny(),
    powodNiedostepnosci: () => (zrodlo.wylaczony() ? null : zrodlo.powodNiedostepnosci()),
    pdf: async (ksefNumber: string) => {
      const z = zrodlo.wylaczony() ? null : zrodlo.biezacy();
      if (!z) throw bladOperatora((zrodlo.wylaczony() ? null : zrodlo.powodNiedostepnosci()) ?? BRAK_KSEF, { status: 503 });
      return z.wizualizacja.pdf(ksefNumber);
    },
  };
}

/** Piaskownica bez atrapy: token wpisany na :3005 / demo nie wychodzi do KSeF — każda metoda odmawia (4xx: nic nie poszło). */
export function odmowaKsefWProbie(): KlientKsef {
  const odmowa = async () => {
    throw bladOperatora('Piaskownica: prawdziwy KSeF jest tu wyłączony — nic nie poszło do KSeF.', { status: 400 });
  };
  return { zaloguj: odmowa, odswiez: odmowa, pobierzMetadane: odmowa, pobierzXml: odmowa };
}
