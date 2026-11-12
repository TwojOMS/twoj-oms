// PRZ-157.04 — kanał sprzedaży ERLI dla wspólnego pollera (`createPoller`).
//
// Tor importu (D1):
//  - główny: `POST /orders/changes/_search` (500 najstarszych nieprzeczytanych zmian) + `mark-read`;
//  - gdy ERLI odpowie 404 na tor główny: `POST /inbox/_search` + `/inbox/mark-read`; wybór toru zostaje
//    zapisany przy kanale (stan w `konfiguracja_integracji`, bez migracji) i jest widoczny w diagnostyce;
//  - uzgodnienie zapasowe: `POST /orders/_search` po `updated` ASC z kursorem `cursor` ERLI (nie po dacie —
//    remis dat nie gubi zamówienia) przy pierwszym podłączeniu i raz na dobę; filtr `updated >= od` (data
//    startu kanału), kilka stron na przebieg, kursor zapisywany po każdym przebiegu, błąd nie blokuje /changes.
//
// ⚠️ MARK-READ DOPIERO PO ZAPISIE: `pobierzStrone` tylko zapamiętuje id ostatniej wiadomości; oznacza je
// `potwierdz()`, które poller woła po udanym przebiegu (wszystkie zamówienia zapisane w bazie). Awaria zapisu
// przerywa przebieg przed `potwierdz()`, więc wiadomości wrócą; zapis jest idempotentny po id zamówienia.

import { mapujZamowienieErli, terminWysylkiErli, sprawyErli } from '../../domena/erli-mapowanie.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../db/konfiguracja-integracji.js';

const DOBA_MS = 24 * 60 * 60 * 1000;
const TYPY_ZMIAN = ['orderCreated', 'orderStatusChanged', 'orderSellerStatusChanged'];
const TYPY_INBOX = ['orderCreated', 'orderStatusChanged'];

/** Stan toru ERLI w pamięci (testy, kanał bez bazy). */
export function stanErliWPamieci(poczatek = {}) {
  let biezacy = { ...poczatek };
  return {
    wczytaj: () => ({ ...biezacy }),
    zapisz: (zmiany) => { biezacy = { ...biezacy, ...zmiany }; },
  };
}

/**
 * Stan toru ERLI przy kanale: wiersz `erli_stan:<klucz>` w `konfiguracja_integracji` (bez nowej kolumny ani
 * migracji). Same ustawienia jawne — tor, kursor i chwila uzgodnienia; żadnych sekretów.
 */
export function stanErliWBazie(db, klucz) {
  const integracja = `erli_stan:${klucz}`;
  return {
    wczytaj: () => ({ ...(wczytajKonfiguracjeIntegracji(db, integracja)?.ustawienia ?? {}) }),
    zapisz: (zmiany) => {
      const ustawienia = { ...(wczytajKonfiguracjeIntegracji(db, integracja)?.ustawienia ?? {}), ...zmiany };
      zapiszKonfiguracjeIntegracji(db, integracja, { ustawienia, sekrety: {} });
    },
  };
}

const toZamowienie = (p) => p && typeof p === 'object' && p.id != null && Array.isArray(p.items);
const nowsze = (a, b) => String(b?.updated ?? '') >= String(a?.updated ?? '');

/**
 * @param {{ klient: any, stan: { wczytaj: () => Record<string, any>, zapisz: (zmiany: Record<string, any>) => void },
 *   domyslnyCzasWysylki?: any, teraz?: () => Date, limitUzgodnienia?: number, stronUzgodnieniaNaPrzebieg?: number }} opcje
 */
export function createErliAdapter({
  klient, stan, domyslnyCzasWysylki = null, teraz = () => new Date(), limitUzgodnienia = 200, stronUzgodnieniaNaPrzebieg = 5,
}) {
  // Wiadomości do potwierdzenia po udanym przebiegu: { tor, lastMessageId } i kursor uzgodnienia.
  let oczekujace = null;
  // Limit dotyczy wszystkich żądań tego kanału, także produktów i mark-read.
  // Potwierdzenie odłożone przez 429 obejmuje wyłącznie paczkę już zapisaną przez poller.
  let zapisanePotwierdzenie = null;
  let przerwaDo = 0;
  let przerwaMs = 0;
  let bladLimitu = null;
  const limitZadan = (e) => e?.kod === 'ERLI_429';
  const trwaPrzerwa = () => teraz().getTime() < przerwaDo;

  async function zapytaj(wykonaj) {
    if (trwaPrzerwa()) throw bladLimitu;
    try {
      const wynik = await wykonaj();
      przerwaMs = 0;
      przerwaDo = 0;
      return wynik;
    } catch (e) {
      if (limitZadan(e)) {
        przerwaMs = Math.min(przerwaMs ? przerwaMs * 2 : 60_000, 15 * 60_000);
        const ms = Number.isSafeInteger(e.retryAfterS) && e.retryAfterS >= 0 ? Math.min(e.retryAfterS * 1000, 15 * 60_000) : przerwaMs;
        przerwaDo = teraz().getTime() + ms;
        bladLimitu = e;
      }
      throw e;
    }
  }

  async function potwierdzZapisane() {
    const o = zapisanePotwierdzenie;
    if (!o || trwaPrzerwa()) return;
    try {
      await zapytaj(() => o.tor === 'inbox'
        ? klient.inboxOznacz({ lastMessageId: o.lastMessageId })
        : klient.oznaczPrzeczytane({ lastMessageId: o.lastMessageId }));
      zapisanePotwierdzenie = null;
    } catch (e) {
      // Inny błąd niż 429 nie może blokować importu: wiadomości wrócą w kolejnym odczycie (zapis idempotentny).
      if (!limitZadan(e)) { zapisanePotwierdzenie = null; throw e; }
    }
  }

  const torZapisany = () => (stan.wczytaj().tor === 'inbox' ? 'inbox' : 'zmiany');

  async function wiadomosci() {
    if (torZapisany() === 'zmiany') {
      try {
        return { tor: 'zmiany', lista: (await zapytaj(() => klient.zmianyZamowien({ types: TYPY_ZMIAN }))) ?? [] };
      } catch (e) {
        if (e?.status !== 404) throw e;
        stan.zapisz({ tor: 'inbox', torUstalonyAt: teraz().toISOString() });
      }
    }
    return { tor: 'inbox', lista: (await zapytaj(() => klient.inboxSzukaj({ types: TYPY_INBOX }))) ?? [] };
  }

  function uzgodnienieNalezne() {
    const s = stan.wczytaj();
    // Niedokończone uzgodnienie (`uzgodnienieWToku`) nie odświeża `uzgodnienieAt`, więc zostaje należne.
    if (!s.uzgodnienieAt) return true;
    return teraz().getTime() - new Date(s.uzgodnienieAt).getTime() >= DOBA_MS;
  }

  // Uzgodnienie czyta najwyżej `stronUzgodnieniaNaPrzebieg` stron; resztę dokończy następny przebieg od
  // zapisanego kursora. Błąd na stronie N nie cofa postępu: zamówienia ze stron 1..N-1 idą do zapisu, kursor
  // zostaje na ostatniej dobrej stronie, a błąd trafia do stanu (diagnostyka) — tor /changes idzie dalej.
  async function uzgodnienie(od) {
    let after = stan.wczytaj().uzgodnienieKursor ?? null;
    const zamowienia = [];
    // Bez kursora (pierwsze podłączenie) i tak tylko od daty startu kanału (D1), nie cała historia konta.
    const filtr = od ? { filter: { field: 'updated', operator: '>=', value: od } } : {};
    let koniec = false;
    let blad = null;
    for (let i = 0; i < stronUzgodnieniaNaPrzebieg; i++) {
      const pagination = { sortField: 'updated', order: 'ASC', limit: limitUzgodnienia, ...(after ? { after } : {}) };
      let strona;
      try {
        strona = (await zapytaj(() => klient.szukajZamowien({ pagination, ...filtr }))) ?? [];
      } catch (e) {
        if (e?.name === 'KanalZatrzymany') throw e;
        blad = e;
        break;
      }
      zamowienia.push(...strona);
      const ostatni = strona.at(-1)?.cursor ?? null;
      if (ostatni) after = ostatni;
      if (strona.length < limitUzgodnienia || !ostatni) { koniec = true; break; }
    }
    return { zamowienia, kursor: after, koniec, blad };
  }

  async function czasyProduktow(zamowienia, pamiec) {
    for (const z of zamowienia) {
      for (const p of z.items ?? []) {
        if (p?.dispatchTime || p?.externalId == null || pamiec.has(p.externalId)) continue;
        if (trwaPrzerwa()) return;
        try {
          const produkt = await zapytaj(() => klient.pobierzProdukt(p.externalId));
          pamiec.set(p.externalId, produkt?.dispatchTime ?? null);
        } catch (e) {
          if (e?.name === 'KanalZatrzymany') throw e;
          if (limitZadan(e)) return;
          // Brak karty produktu nie zatrzymuje importu — zostaje czas domyślny albo pusty termin.
          pamiec.set(p.externalId, null);
        }
      }
    }
  }

  /** @param {{ od?: string|null }} [arg] */
  async function pobierzStrone({ od = null } = {}) {
    oczekujace = null;
    const pusta = { zamowienia: [], stron: 1 };
    if (trwaPrzerwa()) return pusta;
    await potwierdzZapisane();
    if (trwaPrzerwa()) return pusta;
    let wiad;
    try {
      wiad = await wiadomosci();
    } catch (e) {
      if (limitZadan(e)) return pusta;
      throw e;
    }
    const { tor, lista } = wiad;
    const wgId = new Map();
    const dolicz = (z) => {
      if (!toZamowienie(z)) return;
      const klucz = String(z.id);
      const byl = wgId.get(klucz);
      if (!byl || nowsze(byl, z)) wgId.set(klucz, z);
    };
    for (const w of lista) dolicz(w?.payload);
    const lastMessageId = lista.length ? lista.at(-1).id : null;

    let uzg = null;
    if (uzgodnienieNalezne()) {
      const u = await uzgodnienie(od);
      for (const z of u.zamowienia) dolicz(z);
      uzg = { kursor: u.kursor, koniec: u.koniec };
      if (u.blad) {
        // Komunikat klienta ERLI nie niesie klucza API (klucz jest tylko w nagłówku); przycięty dla diagnostyki.
        stan.zapisz({ uzgodnienieBlad: `${teraz().toISOString()} ${String(u.blad?.message ?? u.blad).slice(0, 200)}` });
      }
    }
    oczekujace = { tor, lastMessageId, uzg };

    const zamowienia = [...wgId.values()];
    const pamiec = new Map();
    await czasyProduktow(zamowienia, pamiec);
    for (const z of zamowienia) {
      // Tylko czasy produktów tego zamówienia (potrzebne do terminu), nie cała paczka z przebiegu.
      const czasy = {};
      for (const p of z.items ?? []) if (p?.externalId != null && pamiec.has(p.externalId)) czasy[p.externalId] = pamiec.get(p.externalId);
      const oms = { czasyProduktow: czasy, domyslnyCzasWysylki };
      const zOms = { ...z, _oms: oms };
      z._oms = { ...oms, termin: terminWysylkiErli(zOms), sprawy: sprawyErli(zOms) };
    }
    return { zamowienia, stron: 1 };
  }

  /** Woła poller po udanym przebiegu: dopiero teraz wiadomości są przeczytane, a uzgodnienie zaliczone. */
  async function potwierdz() {
    const o = oczekujace;
    if (!o) return;
    if (o.lastMessageId != null) {
      zapisanePotwierdzenie = { tor: o.tor, lastMessageId: o.lastMessageId };
    }
    if (o.uzg) {
      // Postęp uzgodnienia zapisany po zapisie zamówień w bazie; zaliczone dopiero po przejściu do końca.
      stan.zapisz(o.uzg.koniec
        ? { uzgodnienieAt: teraz().toISOString(), uzgodnienieKursor: o.uzg.kursor ?? undefined, uzgodnienieWToku: false, uzgodnienieBlad: null }
        : { uzgodnienieKursor: o.uzg.kursor ?? undefined, uzgodnienieWToku: true });
    }
    oczekujace = null;
    await potwierdzZapisane();
  }

  return {
    pobierzStrone,
    potwierdz,
    kursorZ: (s) => s?.updated ?? null,
    zlozoneZ: (s) => s?.purchasedAt ?? s?.created ?? null,
    mapuj: (s) => mapujZamowienieErli(s),
    tor: torZapisany,
    /** Ostatni błąd uzgodnienia (chwila + komunikat, bez klucza API) albo null — dla diagnostyki kanału. */
    bladUzgodnienia: () => stan.wczytaj().uzgodnienieBlad ?? null,
  };
}
