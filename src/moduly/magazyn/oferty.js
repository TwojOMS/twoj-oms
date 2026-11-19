import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ofertyKarty,
  ofertaPoId,
  ofertaPoIdZewnetrznym,
  wstawOferte,
  zmienOferte,
  usunOferte,
  ustawieniaOfertKonta,
  zapiszUstawieniaOfertKonta,
} from '../../oms/db/oferty-kanalow.ts';
import { STAWKI_Z_ZW } from '../../domena/vat.js';
import { wyjatekCennika } from '../../oms/db/cenniki-kart.ts';
import {
  cennikiOms,
  cennikOmsKarty,
  maCennikiOms,
  ustawCennikKarty,
  wyjatekKartyOms,
} from '../../oms/db/cenniki-oms.ts';
import { liniaDanychKartyErli } from '../../domena/erli-linia-karty.js';
import { brakiUstawienOfert } from '../../domena/erli-oferty-ustawienia.js';
import { dobierzCennik, opisRozmiaruCennika, regulyKonta } from '../../domena/cennik-dostaw.js';
import { trescOferty } from './services/tresc-oferty.js';
import { idProduktuErli } from './services/petla-ofert.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
import { zdanieCzekaniaOferty } from '../../domena/czekanie-oferty.js';
import { pobierzOfertyReczne, propozycjePrzejecia, transakcjaOfert } from './services/przejecie-ofert-erli.js';
import { ofertaAllegroKarty } from './services/tresc-oferty-allegro.js';
import { bramkaZapisu, znakInstalacji } from './services/oferty-wspolne.js';
import { cenaDlaKanalu, kwotaDziesietna } from '../../domena/cena-kanalu.js';
import { groszeZKwoty } from '../../domena/kwota.js';
import { cenyReczneKarty, zapiszZmianeWKanale } from '../../oms/db/ceny-kanalow.js';
import { createOplatyAllegro } from './services/oplaty-allegro.js';
import { BRAK_ZGODY_OFERT, gotowoscOfertAllegro } from '../kanaly/services/oferty-allegro-ustawienia.ts';
import { migawkaStanow, przelacznikStanow } from '../../oms/db/stany-magazynowe.js';

const LIMIT_KART_PODGLADU = 200;

/**
 * Kto wystawia oferty hurtem z listy Magazynu (pasek, podgląd, zatwierdzenie, aktywacja szkiców): administrator
 * oraz gość demo publicznego. Znacznik `podgladDemo` powstaje tylko na instancji z kontem gościa (tryb próby,
 * wszystkie kanały to atrapy) i tylko dla loginu gościa — na zwykłej instancji zostaje sam admin.
 * Pozostałe operacje na ofertach (objęcie, wznowienia, sterowanie ceną) dalej wyłącznie dla admina.
 */
export function mozeWystawiacHurtem(konto) {
  return konto?.admin === true || konto?.podgladDemo === true;
}

// Brak tekstu i załączniki z innego konta naprawia też tekst domyślny konta; tekst za długi albo uszkodzony —
// tylko karta. Domena nie rozróżnia tych przypadków kodem, więc rozpoznajemy je po początku zdania.
const NAPRAWI_TEKST_KONTA = /^(?:Wpisz informację o bezpieczeństwie|Załączniki bezpieczeństwa należą)/u;

/**
 * Odnośniki przy odmowie podglądu Allegro: gdzie uzupełnić informację o bezpieczeństwie. Ustawienia konta widzi
 * tylko admin — gość demo i inni dostają zdanie, kto to ustawia, zamiast odnośnika, który i tak by ich odbił.
 * @param {{kod: string, tekst: string}} blad
 * @param {number} kartaId
 * @param {{klucz: string, nazwa?: string}} konto
 * @param {boolean} admin
 * @returns {Array<{adres?: string, napis: string}>}
 */
export function odnosnikiBledu(blad, kartaId, konto, admin) {
  if (blad.kod !== 'bezpieczenstwo') return [];
  const odnosniki = [{ adres: `/magazyn/${kartaId}#gpsr-informacja-tytul`, napis: 'Uzupełnij na karcie' }];
  if (!NAPRAWI_TEKST_KONTA.test(blad.tekst)) return odnosniki;
  const nazwa = konto.nazwa || konto.klucz;
  odnosniki.push(
    admin
      ? {
          adres: `/ustawienia/integracje/allegro/${encodeURIComponent(konto.klucz)}/oferty#allegro-oferty-bezpieczenstwo`,
          napis: `Ustaw tekst domyślny konta ${nazwa}`,
        }
      : {
          napis: `(tekst domyślny konta ustawia administrator: Ustawienia → Integracje → Allegro → konto ${nazwa} → krok Oferty)`,
        },
  );
  return odnosniki;
}

/** E4.06 (D47): napis nagłówka podglądu o ilości; null = stany nigdy niewłączone (dzisiejszy tekst, D14). */
export function zrodloIlosci(migawka, ustawienia) {
  if (!migawka.historia?.length) return null;
  if (!migawka.wlaczone) return `stała ${ustawienia.stalaIlosc ?? '—'} szt.`;
  if (migawka.zatwierdzenie?.przelaczenieId !== migawka.przelaczenieId) {
    return 'zatwierdź podgląd stanów — do tego czasu oferty dostają cenę i treść bez ilości.';
  }
  return `stan magazynu − bufor ${ustawienia.buforSzt ?? 0} szt.`;
}
/** Ilość w wierszu podglądu: liczba albo powód, dla którego czeka. */
export function napisIlosci(ilosc, wyslana) {
  if (wyslana != null) return String(wyslana);
  if (ilosc?.powod === 'brak-stanu') return 'czeka na stan magazynu';
  if (ilosc?.powod === 'stany-niezatwierdzone') return 'zatwierdź podgląd stanów';
  return '—';
}

export const STANY_PO_POLSKU = Object.freeze({
  szkic: 'szkic',
  do_wyslania: 'do wysłania',
  wyslana: 'wysłana',
  sprawdzana: 'sprawdzana',
  aktywna: 'aktywna',
  nieaktywna: 'nieaktywna',
  problem: 'problem',
  blad: 'błąd',
});
// Pętla pomija oferty z konfliktem, więc „zdejmij” nigdy by nie wyszło.
const maKonflikt = (o) => (o.problemy ?? []).some((p) => p?.kod === 'konflikt');
/** D30: „Aktywuj” wyłącznie na szkicu — nieaktywna oferta bez `szkic` jest zdjęta i tu nie wraca. */
function mozeAktywowac(o) {
  if (o.odczytStatus === 'ENDED') return false;
  if (o.tryb !== 'zarzadzana' || o.stan !== 'nieaktywna') return false;
  if (o.wyslanePola?.szkic !== true) return false;
  return !o.wyslanePola?.zdejmij && !o.wyslanePola?.aktywuj && !maKonflikt(o);
}
/**
 * E3.27: zmiany wiersza po „Ponów”. Oferta Allegro z numerem z Allegro (nie `ext:`, nie pusty) wraca do synchronizacji
 * (stan wg ostatniego odczytu, bez zaległej komendy) — NIGDY do `do_wyslania`, bo pętla wysłałaby drugi POST.
 * Bez numeru albo poza Allegro → `do_wyslania`, jak dotąd. Numer bez żadnego odczytu (problem z pierwszego
 * sprawdzenia: walidacja, aktywacja, brak potwierdzenia) → `sprawdzana` od nowa, bo `nieaktywna` bez szkicu jest martwa.
 */
export function zmianyPonowienia(o, allegro) {
  const zero = { liczbaProb: 0, blad: null, nastepnaProbaAt: null, problemy: [] };
  const numer = String(o.idZewnetrzne ?? '');
  if (!allegro || !numer || numer.startsWith('ext:')) return { stan: 'do_wyslania', ...zero };
  const {
    komendaIlosci: _i,
    komendaCeny: _c,
    probyZdjecia: _z,
    bledyZdjecia: _b,
    probyOdczytu: _po,
    odczytPo: _op,
    ...wyslanePola
  } = o.wyslanePola ?? {};
  // Odrzucona treść (problem `odczyt`): Ponów wysyła ją od nowa z pełnym limitem prób, zamiast tylko zdjąć problem.
  const tresc = (o.problemy ?? []).some((p) => p?.kod === 'odczyt') ? { wyslanySkrot: null } : {};
  if (!o.odczytStatus)
    return { stan: 'sprawdzana', ...zero, ...tresc, wyslanePola: { ...wyslanePola, etap: null, operacja: null } };
  return {
    stan: ['ACTIVATING', 'ACTIVE'].includes(o.odczytStatus) ? 'aktywna' : 'nieaktywna',
    ...zero,
    ...tresc,
    wyslanePola,
  };
}
/**
 * E3.28 (D-28.3): „Ponów” dla karty i ekranu „Problemy ofert” — warunki E3.27 w jednym miejscu. Zakończona oferta
 * nie dostaje Ponów (byłaby druga oferta i opłata) — zamiast tego jest „Wznów”.
 */
export function mozePonowic(o) {
  return (
    o.tryb === 'zarzadzana' &&
    ['blad', 'problem'].includes(o.stan) &&
    !o.wyslanePola?.zdejmij &&
    !(o.problemy ?? []).some((p) => p?.kod === 'zakonczona' || p?.kod === 'duplikat' || p?.kod === 'brak-w-allegro')
  );
}
/**
 * E4.22: Allegro nie zwraca oferty (`brak-w-allegro`) — Ponów jej nie odtwarza (nowa oferta = opłata i ryzyko
 * duplikatu). Zamiast przycisku ekran pokazuje odmowę, a trasy Ponów zwracają 409 z tym samym tekstem.
 */
export const ODMOWA_BRAK_W_ALLEGRO =
  'Oferty nie ma już w Allegro — Ponów jej nie odtworzy (nowa oferta to opłata i ryzyko ' +
  'duplikatu). Sprawdź ją w panelu Allegro. Jeśli usunąłeś ją celowo, użyj „Usuń z OMS” — karta zostaje, ' +
  'a ofertę możesz wystawić od nowa.';
// Dziennik zmian w kanałach ma w bazie CHECK na `pole` (cena, status, steruj_cena), więc usunięcie zapisu oferty
// trafia tam jako zmiana statusu na ten napis — czytelny wprost w historii karty.
export const STATUS_USUNIETEJ_Z_OMS = 'usunięta z OMS';
export function brakWAllegro(o) {
  return (
    o.tryb === 'zarzadzana' &&
    ['blad', 'problem'].includes(o.stan) &&
    (o.problemy ?? []).some((p) => p?.kod === 'brak-w-allegro')
  );
}
/**
 * E3c (N5): Allegro ma kilka ofert tej karty — Ponów założyłby następną, więc zamiast przycisku ekran mówi,
 * że trzeba wybrać jedną z nich (w Allegro albo w „Przeglądzie zapisów”).
 */
export function duplikatDoWyboru(o) {
  return (
    o.tryb === 'zarzadzana' &&
    ['blad', 'problem'].includes(o.stan) &&
    (o.problemy ?? []).some((p) => p?.kod === 'duplikat')
  );
}
/** Wznów na karcie i ekranie problemów: te same warunki oceny zakończonej oferty. */
export function zakonczonaDoWznowienia(o) {
  const z = (o.problemy ?? []).find((p) => p?.kod === 'zakonczona');
  return o.stan === 'problem' && z ? z : null;
}
export function mozeWznowic(o) {
  const z = zakonczonaDoWznowienia(o);
  return (
    Boolean(z) &&
    o.tryb === 'zarzadzana' &&
    !o.wyslanePola?.zdejmij &&
    !o.wyslanePola?.wznow &&
    ((typeof z.tekst === 'string' && z.tekst.trim() !== '') || Number(z.sztuk) > 0)
  );
}
/**
 * E3.28 (D-28.3): skutek „Ponów” (logika E3.27, `zmianyPonowienia`). E4.13: przy włączonych stanach Ponów nie
 * wysyła zapamiętanej ilości — znika komenda ilości (Allegro) i cel w toku (ERLI/Woo); następny przebieg liczy cel
 * z migawki. Komenda ceny zostaje jak w E3.
 */
export function ponowOferte(db, o, allegro) {
  const zmiany = zmianyPonowienia(o, allegro);
  if (!przelacznikStanow(db).wlaczone) return zmienOferte(db, o.id, zmiany);
  const { komendaIlosci: _i, ...wyslanePola } = zmiany.wyslanePola ?? o.wyslanePola ?? {};
  return zmienOferte(db, o.id, { ...zmiany, wyslanePola, iloscWToku: null, liczbaProb: 0 });
}
/** E3.26a: zmiany wiersza po „Zdejmij ofertę” — flaga dla pętli, zero prób komend i zdejmowania, bez przerwy. */
export function zmianyZdjecia(o) {
  const { probyZdjecia: _z, bledyZdjecia: _b, ...wyslanePola } = o.wyslanePola ?? {};
  return { wyslanePola: { ...wyslanePola, zdejmij: true }, liczbaProb: 0, nastepnaProbaAt: null };
}
export function ofertyDoWidoku(db, kartaId) {
  return ofertyKarty(db, kartaId).map((o) => ({
    ...o,
    stanTekst: STANY_PO_POLSKU[o.stan],
    trybTekst: o.tryb === 'zarzadzana' ? 'zarządzana' : 'obserwowana',
    odczytTekst: o.odczytanoAt
      ? fmtDataCzas(o.odczytanoAt).replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1')
      : 'jeszcze nie odczytano',
    zdejmij:
      o.tryb === 'zarzadzana' &&
      ['aktywna', 'sprawdzana', 'problem'].includes(o.stan) &&
      !o.wyslanePola?.zdejmij &&
      !maKonflikt(o),
    ponow: mozePonowic(o),
    duplikat: duplikatDoWyboru(o),
    brakWAllegro: brakWAllegro(o) ? ODMOWA_BRAK_W_ALLEGRO : null,
    aktywuj: mozeAktywowac(o),
    aktywacjaZlecona: o.stan === 'nieaktywna' && o.wyslanePola?.aktywuj === true,
  }));
}

/** Lista cenników konta Allegro z „Pobierz z Allegro” (krok 6) — `[{ id, nazwa }]`, bez listy pusta. */
export function cennikiAllegro(ustawienia) {
  const lista = ustawienia?.slowniki?.cenniki;
  return Array.isArray(lista) ? lista.filter((p) => p && typeof p.id === 'string' && p.id.trim()) : [];
}
/**
 * Cenniki OMS do pola wyboru na karcie i w podglądzie ERLI — `[{ id, etykieta }]`. Etykieta mówi, czym cennik jest
 * (rozmiar, domyślny, tylko na karcie), chyba że mówi to już sama nazwa.
 */
export function opcjeCennikowOms(db) {
  if (!maCennikiOms(db)) return [];
  return cennikiOms(db).map((c) => {
    const opis =
      c.rodzaj === 'rozmiar'
        ? opisRozmiaruCennika({ doMm: c.doMm, doG: c.doG })
        : c.rodzaj === 'domyslny'
          ? 'domyślny'
          : 'tylko na karcie';
    const samaNazwa = c.nazwa.trim().toLowerCase() === opis.toLowerCase();
    return { id: String(c.id), etykieta: samaNazwa ? c.nazwa : `${c.nazwa} (${opis})` };
  });
}

/** Nazwa cennika OMS karty, gdy ma on powiązanie z kontem (to on daje wtedy wyjątek) — do powodu doboru. */
export function nazwaCennikaKarty(db, kartaId, konto) {
  return maCennikiOms(db) ? (wyjatekKartyOms(db, { kartaId, konto })?.nazwaOms ?? null) : null;
}

/**
 * Wybrany cennik do podglądu i karty — nazwa ze słownika konta Allegro albo identyfikator (ERLI: nazwa z panelu
 * ERLI) i powód doboru. `nazwaWyjatku` — nazwa cennika OMS karty do powodu wyjątku. Odmowa doboru → null (odmowę
 * pokazują błędy karty).
 */
export function opisDostawy(ustawienia, rodzaj, dostawa, karta = null, nazwaWyjatku = null) {
  if (!dostawa?.cennik) return null;
  const nazwa = rodzaj === 'allegro' ? cennikiAllegro(ustawienia).find((p) => p.id === dostawa.cennik)?.nazwa : null;
  const wyjatek = dostawa.powod?.rodzaj === 'wyjatek';
  const odmowa =
    rodzaj === 'allegro' && wyjatek && !cennikiAllegro(ustawienia).some((p) => p.id === dostawa.cennik)
      ? 'Cennik z karty nie istnieje już na koncie Allegro — wybierz inny'
      : null;
  const reguly = regulyKonta(ustawienia);
  const bezWyjatku = wyjatek && reguly.length ? dobierzCennik({ karta, reguly }) : null;
  let dopisek = '';
  if (bezWyjatku && bezWyjatku.cennik !== dostawa.cennik) {
    const nazwaZRegul =
      rodzaj === 'allegro' ? cennikiAllegro(ustawienia).find((p) => p.id === bezWyjatku.cennik)?.nazwa : null;
    const opis = bezWyjatku.odmowa?.tekst ?? `${nazwaZRegul || bezWyjatku.cennik} — ${bezWyjatku.powod.tekst}`;
    dopisek = ` (reguły dałyby: ${opis})`;
  }
  // Budowniczowie oferty nie znają nazwy cennika OMS karty — powód wyjątku dostaje ją tutaj.
  const powod =
    wyjatek && nazwaWyjatku
      ? dobierzCennik({ wyjatek: dostawa.cennik, nazwaWyjatku }).powod.tekst
      : dostawa.powod?.tekst;
  return {
    cennik: dostawa.cennik,
    nazwa: typeof nazwa === 'string' && nazwa.trim() ? nazwa : dostawa.cennik,
    rodzaj: dostawa.powod?.rodzaj ?? null,
    powod: (powod ?? '') + dopisek,
    odmowa,
  };
}

/** Napis drogi produktu (D16) dla podglądu Allegro. */
const DROGI = Object.freeze({
  'katalog-id': 'produkt z katalogu Allegro',
  ean: 'produkt po EAN',
  nowy: 'nowy produkt',
});

export function registerOfertyMagazynu(
  app,
  {
    db,
    pomoc,
    kontaErli,
    kontaAllegro = /** @returns {{ klucz: string, srodowisko: string, zgoda?: boolean, klient?: any }[]} */ () => [],
    adresPublicznyZdjec = '',
  },
) {
  const oplaty = createOplatyAllegro();
  // Podpis procesu: restart wymaga ponownego podglądu. Bez magazynowania list kart w pamięci.
  const sekret = randomBytes(32);
  const podpis = (req, konto, ids, czas, odcisk = '') =>
    createHmac('sha256', sekret)
      .update(JSON.stringify([req.konto?.login, konto, ids, czas, odcisk]))
      .digest('hex');
  // Ślad podglądu ERLI obejmuje ustawienia ofert konta: po ich zmianie (uzupełnienie braków w podglądzie albo
  // konfigurator) stary ślad nie zatwierdzi ofert policzonych przy innych ustawieniach — potrzebny nowy podgląd.
  const odciskUstawien = (konto) =>
    JSON.stringify(ustawieniaOfertKonta(db, konto), (k, v) =>
      k === 'zmienionoAt' || k === 'aktorLogin' ? undefined : v,
    );
  const maVat = (karta) => String(karta?.stawka_vat ?? '').trim() !== '';
  const odmowa = (reply, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, { tytul: 'Oferty', wroc: '/magazyn', napisWroc: 'Wróć do magazynu' });
  const uprawniony = (req) => req.konto?.admin === true;
  const waznyPodpis = (req, konto, ids, token) => {
    const [czas, mac] = (token ?? '').split('.');
    return (
      /^\d+$/.test(czas ?? '') &&
      Date.now() - Number(czas) <= 30 * 60_000 &&
      Number(czas) <= Date.now() &&
      /^[a-f0-9]{64}$/.test(mac ?? '') &&
      timingSafeEqual(Buffer.from(mac), Buffer.from(podpis(req, konto, ids, czas)))
    );
  };
  // Formularz przekazuje wyłącznie wybór. Odczyt pozostaje po stronie serwera, osobno dla konta i operatora.
  const odczyty = new Map();
  const kluczOdczytu = (req, konto) => JSON.stringify([req.konto?.login, konto]);
  for (const akcja of ['pobierz', 'zatwierdz'])
    app.post(`/magazyn/powiazania/erli/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const kanal = pomoc.pole(req.body, 'konto');
      const konto = kontaErli().find((k) => k.klucz === kanal);
      if (!konto) return odmowa(reply, 400, 'Wybierz bieżące konto ERLI.');
      for (const [k, v] of odczyty) if (Date.now() - v.czas > 30 * 60_000) odczyty.delete(k);
      const klucz = kluczOdczytu(req, kanal);
      if (akcja === 'pobierz') {
        let dane;
        try {
          dane = await pobierzOfertyReczne(konto);
        } catch {
          return odmowa(reply, 502, 'Nie udało się pobrać ofert ERLI. Spróbuj ponownie.');
        }
        if (odczyty.size >= 100) odczyty.delete(odczyty.keys().next().value);
        odczyty.set(klucz, { ...dane, czas: Date.now() });
      }
      const odczyt = odczyty.get(klucz);
      if (!odczyt) return odmowa(reply, 409, 'Pobierz oferty ponownie przed przejęciem.');
      let wynik = null;
      if (akcja === 'zatwierdz') {
        const surowe = req.body?.zaznaczone;
        const ids = new Set(Array.isArray(surowe) ? surowe : [surowe]);
        wynik = transakcjaOfert(db, () => {
          // Ponowne dopasowanie i sprawdzenie istnienia oferty odbywa się już w transakcji.
          const wiersze = propozycjePrzejecia(db, kanal, odczyt.produkty);
          let przejeto = 0;
          for (const { produkt: p, karta } of wiersze) {
            if (!ids.has(p.externalId) || !karta) continue;
            if (!['active', 'inactive'].includes(p.status)) continue;
            const o = wstawOferte(db, {
              kartaId: Number(karta.id),
              kanal,
              idZewnetrzne: p.externalId,
              pochodzenie: 'przejeta',
              tryb: 'obserwowana',
              stan: p.status === 'active' ? 'aktywna' : 'nieaktywna',
            });
            zmienOferte(db, o.id, {
              odczytCenaGr: Number.isInteger(p.price) && p.price >= 0 ? p.price : null,
              odczytIlosc: Number.isInteger(p.stock) && p.stock >= 0 ? p.stock : null,
              odczytStatus: p.status,
              odczytZamrozone: p.frozen ?? null,
              odczytZarchiwizowana: p.archived === true,
              odczytanoAt: new Date(odczyt.czas).toISOString(),
            });
            przejeto++;
          }
          return { przejeto, pominieto: ids.size - przejeto };
        });
      }
      return reply.view('magazyn-przejecie-erli.ejs', {
        title: 'Przejęcie ofert ERLI',
        konto: kanal,
        wiersze: propozycjePrzejecia(db, kanal, odczyt.produkty),
        limit: odczyt.limit,
        wynik,
      });
    });
  for (const akcja of ['podglad', 'zatwierdz'])
    app.post(`/magazyn/:id/oferty/:ofertaId/objecie/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const o = ofertaPoId(db, Number(req.params.ofertaId));
      if (!o || o.kartaId !== Number(req.params.id)) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
      if (o.tryb !== 'obserwowana' || !kontaErli().some((k) => k.klucz === o.kanal))
        return odmowa(reply, 409, 'Ta oferta nie pozwala na tę akcję.');
      if (
        ofertyKarty(db, o.kartaId).some(
          (inna) => inna.id !== o.id && inna.kanal === o.kanal && inna.tryb === 'zarzadzana',
        )
      ) {
        return odmowa(reply, 409, 'Karta ma już ofertę zarządzaną na tym koncie.');
      }
      const zakres = ['objecie', o.id, o.kartaId];
      if (akcja === 'zatwierdz' && !waznyPodpis(req, o.kanal, zakres, pomoc.pole(req.body, 'podglad'))) {
        return odmowa(reply, 409, 'Otwórz podgląd ponownie przed objęciem zarządzaniem.');
      }
      const ustawienia = ustawieniaOfertKonta(db, o.kanal);
      const dane = trescOferty(db, o.kartaId, ustawienia, adresPublicznyZdjec, { migawka: migawkaStanow(db) });
      dane.bledy.push(
        ...brakiUstawienOfert(ustawienia)
          .filter((b) => !(b === 'cennik dostaw' && dane.dostawa?.cennik))
          .filter((b) => !(b === 'stawka VAT' && maVat(dane.karta)))
          .map((b) => `Uzupełnij ustawienia: ${b}`),
      );
      if (dane.karta?.wycofana) dane.bledy.push('Karta jest wycofana.');
      if (o.odczytCenaGr === null || o.odczytIlosc === null) dane.bledy.push('Brak odczytu ceny lub ilości z ERLI.');
      if (
        o.odczytZarchiwizowana ||
        (Array.isArray(o.odczytZamrozone) ? o.odczytZamrozone.length : Object.keys(o.odczytZamrozone ?? {}).length)
      )
        dane.bledy.push('Oferta jest zarchiwizowana lub ma zamrożone pola.');
      if (akcja === 'zatwierdz') {
        if (dane.bledy.length) return odmowa(reply, 409, `Nie można objąć zarządzaniem: ${dane.bledy.join(' ')}`);
        zmienOferte(db, o.id, { tryb: 'zarzadzana' });
        return reply.code(303).redirect(`/magazyn/${o.kartaId}#produkty-karty`);
      }
      const czas = String(Date.now());
      return reply.view('magazyn-objecie-erli.ejs', {
        title: 'Objęcie zarządzaniem',
        oferta: o,
        ...dane,
        iloscNapis: napisIlosci(dane.ilosc, dane.cialo?.stock),
        token: `${czas}.${podpis(req, o.kanal, zakres, czas)}`,
      });
    });
  const idsZadania = (req) => {
    if (pomoc.zakresHurtu(pomoc.pole(req.body, 'zakres')) === 'pasujace') {
      const filtry = pomoc.filtryZawezenia(pomoc.pole(req.body, 'zawezenie') ?? '');
      return pomoc.kartyZKanalami(db, { fraza: filtry.fraza, filtry }).map((k) => k.id);
    }
    const surowe = req.body?.zaznaczone;
    return pomoc.numeryZaznaczone(
      (Array.isArray(surowe) ? surowe : [surowe]).map((v) => (Number.isSafeInteger(v) && v > 0 ? String(v) : v)),
    );
  };
  // Wyjątek cennika z karty wystarcza — konto bez reguł nie blokuje podglądu, gdy choć jedna wybrana karta ma cennik
  // OMS powiązany z tym kontem; karty bez wyjątku dostają wtedy odmowę osobno (błąd budowniczego).
  const bezBrakuCennika = (braki, konto, ids) =>
    braki.includes('cennik dostaw') && ids.some((id) => wyjatekCennika(db, { kartaId: id, konto }))
      ? braki.filter((b) => b !== 'cennik dostaw')
      : braki;
  // Stawka VAT konta jest tylko zapasem dla kart bez własnej — brak na koncie blokuje podgląd jedynie wtedy,
  // gdy choć jedna wybrana karta nie ma stawki.
  const vatNaKazdejKarcie = (ids) => {
    if (!ids.length) return false;
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM karty_produktow
      WHERE id IN (${ids.map(() => '?').join(',')}) AND length(trim(coalesce(stawka_vat, ''))) > 0`,
      )
      .get(...ids);
    return Number(n) === ids.length;
  };
  function zestaw(konto, ids) {
    const ustawienia = ustawieniaOfertKonta(db, konto);
    const reguly = regulyKonta(ustawienia);
    // Jedna migawka stanów na żądanie, nie na kartę. Liczona przed brakami: przy włączonych stanach ilość idzie
    // z magazynu, więc brak stałej liczby sztuk nie blokuje podglądu.
    const migawka = migawkaStanow(db);
    const vatKart = vatNaKazdejKarcie(ids);
    // Cennik dostaw nie blokuje podglądu ERLI: karta bez cennika (ani z konta, ani z wyjątku) dostaje własną
    // odmowę budowniczego, reszta kart idzie dalej.
    const braki = brakiUstawienOfert(ustawienia).filter(
      (b) =>
        b !== 'cennik dostaw' && !(b === 'stawka VAT' && vatKart) && !(b === 'stała liczba sztuk' && migawka.wlaczone),
    );
    const opcjeOms = opcjeCennikowOms(db);
    const wiersze = braki.length
      ? []
      : ids.map((id) => {
          const w = trescOferty(db, id, ustawienia, adresPublicznyZdjec, { migawka });
          if (w.karta?.wycofana) w.bledy.push('Karta jest wycofana.');
          if (ofertyKarty(db, id).some((o) => o.kanal === konto)) w.bledy.push('Karta ma już ofertę na tym koncie.');
          return {
            ...w,
            // Ten sam kształt odmowy co w Allegro — widok podglądu jest wspólny.
            bledy: w.bledy.map((tekst) => ({ tekst, odnosniki: [] })),
            id,
            nazwa: w.karta?.nazwa ?? `Karta ${id}`,
            iloscNapis: napisIlosci(w.ilosc, w.cialo?.stock),
            dostawa: opisDostawy(ustawienia, 'erli', w.dostawa, w.karta, nazwaCennikaKarty(db, id, konto)),
            liniaDanych: w.cialo
              ? liniaDanychKartyErli({
                  cena: w.cialo.price,
                  ilosc: napisIlosci(w.ilosc, w.cialo.stock),
                  czasWysylkiDni: w.cialo.dispatchTime?.period,
                  vat: w.cialo.taxRate,
                  zdjecia: w.cialo.images?.length,
                })
              : null,
            // Pole wyboru cennika OMS karty w wierszu: pierwsza opcja mówi, co da dobór po rozmiarze.
            cennikWiersza: w.karta
              ? {
                  wybor: String(cennikOmsKarty(db, id)?.cennikId ?? ''),
                  zKonta: dobierzCennik({ karta: w.karta, reguly }).cennik ?? 'brak',
                  opcje: opcjeOms,
                }
              : null,
          };
        });
    return { ustawienia, braki, wiersze, zrodloIlosci: zrodloIlosci(migawka, ustawienia) };
  }
  /** Konto „Wystaw na…” po kluczu: bieżące konto ERLI albo Allegro; inne → null. */
  const kontoOfert = (klucz) => {
    const erli = kontaErli().find((k) => k.klucz === klucz);
    if (erli) return { rodzaj: 'erli', konto: erli };
    const allegro = kontaAllegro().find((k) => k.klucz === klucz);
    return allegro ? { rodzaj: 'allegro', konto: allegro } : null;
  };
  // D43: odmowa = karta ma już ofertę na TYM koncie (rejestr OMS albo lustro sklepu); oferty na innych kontach
  // dają tylko ostrzeżenie domeny „dwie oferty”. Lustro czytamy raz na podgląd, nie raz na kartę.
  function zestawAllegro(konto, ids, admin) {
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    const { braki: brakiKonta, krok } = gotowoscOfertAllegro(db, konto.klucz);
    const braki = bezBrakuCennika(brakiKonta, konto.klucz, ids);
    const kontaSrodowiska = kontaAllegro()
      .filter((k) => k.srodowisko === konto.srodowisko)
      .map((k) => k.klucz);
    const migawka = migawkaStanow(db);
    const wLustrze = new Set(
      db
        .prepare(
          `SELECT DISTINCT karta_id FROM produkty_sklepowe
      WHERE kanal = ? AND zniknal_at IS NULL AND karta_id IS NOT NULL`,
        )
        .all(konto.klucz)
        .map((w) => Number(w.karta_id)),
    );
    const wiersze = braki.length
      ? []
      : ids.map((id) => {
          const w = ofertaAllegroKarty(
            db,
            id,
            // Nazwa konta trafia do treści odmów domeny — człowiek zna konto po nazwie, nie po kluczu.
            { klucz: konto.klucz, nazwa: konto.nazwa, srodowisko: konto.srodowisko },
            { kontaSrodowiska, migawka, tworzenie: true },
          );
          const bledy = w.bledy.map((b) => ({ tekst: b.tekst, odnosniki: odnosnikiBledu(b, id, konto, admin) }));
          const dostawa = opisDostawy(
            ustawienia,
            'allegro',
            w.dostawa,
            w.karta,
            nazwaCennikaKarty(db, id, konto.klucz),
          );
          if (w.karta?.wycofana) bledy.push({ tekst: 'Karta jest wycofana.', odnosniki: [] });
          const maOferte = ofertyKarty(db, id).some((o) => o.kanal === konto.klucz) || wLustrze.has(id);
          if (maOferte) bledy.push({ tekst: 'Karta ma już ofertę na tym koncie.', odnosniki: [] });
          const zadanie = bledy.length ? null : w.zadanie;
          return {
            id,
            nazwa: w.karta?.nazwa ?? `Karta ${id}`,
            bledy,
            ostrzezenia: w.ostrzezenia.map((o) => o.tekst),
            zadanie,
            dostawa,
            allegro: {
              droga: w.droga ? (DROGI[w.droga] ?? w.droga) : null,
              kategoria: w.zadanie?.category?.id ?? null,
              cena: w.zadanie?.sellingMode?.price?.amount ?? null,
              ilosc: napisIlosci(w.ilosc, w.zadanie?.stock?.available),
              prowizja: null,
            },
          };
        });
    return { ustawienia, braki, wiersze, konfigurator: krok, zrodloIlosci: zrodloIlosci(migawka, ustawienia) };
  }
  const zlotowki = (kwota) => `${String(kwota).replace('.', ',')} zł`;
  // Braki konta ERLI, które da się uzupełnić z podglądu; cennik dostaw zostaje w konfiguratorze.
  const POLA_BRAKOW = [
    { brak: 'stała liczba sztuk', pole: 'stalaIlosc', etykieta: 'Ilość w ofertach (szt.)' },
    { brak: 'czas wysyłki', pole: 'czasWysylkiDni', etykieta: 'Czas wysyłki (dni robocze)' },
    { brak: 'stawka VAT', pole: 'stawkaVat', etykieta: 'Stawka VAT' },
  ];
  const odciskKonta = (wybrane, konto) => (wybrane.rodzaj === 'erli' ? odciskUstawien(konto) : '');
  const tokenPodgladu = (req, wybrane, konto, ids) => {
    const czas = String(Date.now());
    return `${czas}.${podpis(req, konto, ids, czas, odciskKonta(wybrane, konto))}`;
  };
  const danePodgladu = (req, wybrane, konto, ids) =>
    wybrane.rodzaj === 'allegro'
      ? zestawAllegro(wybrane.konto, ids, uprawniony(req))
      : {
          ...zestaw(konto, ids),
          konfigurator: `/ustawienia/integracje/erli/${encodeURIComponent(konto)}?krok=oferty#erli-krok-oferty`,
        };
  // Cennik wybrany przy karcie w podglądzie ERLI to ten sam cennik OMS co w sekcji „Cennik dostaw” karty — działa na
  // wszystkich kontach, z którymi ma powiązanie. Wszystkie karty w jednej transakcji — błędne pole nie zapisuje
  // żadnego. Pole nieobecne w ciele (formularz bez pól cenników) zostawia wybór karty bez zmian.
  function zapiszCennikiZPodgladu(req, wybrane, konto, ids) {
    const wpisane = {};
    for (const id of ids) {
      const v = pomoc.pole(req.body, `cennik_${id}`);
      if (v !== null) wpisane[id] = v.trim();
    }
    const bledy = {};
    if (wybrane.rodzaj !== 'erli' || !Object.keys(wpisane).length) return { bledy, wpisane: {} };
    const znane = new Set(opcjeCennikowOms(db).map((o) => o.id));
    const opcje = { aktor: req.konto?.login ?? null };
    const karta = db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?');
    try {
      transakcjaOfert(db, () => {
        for (const [klucz, cennik] of Object.entries(wpisane)) {
          const kartaId = Number(klucz);
          if (cennik === String(cennikOmsKarty(db, kartaId)?.cennikId ?? '') || !karta.get(kartaId)) continue;
          if (cennik && !znane.has(cennik)) bledy[kartaId] = 'Wybierz cennik OMS z listy.';
          else ustawCennikKarty(db, { kartaId, cennikId: cennik ? Number(cennik) : null }, opcje);
        }
        if (Object.keys(bledy).length) throw new Error('odrzucone cenniki kart');
      });
    } catch (e) {
      if (!Object.keys(bledy).length) throw e;
    }
    return { bledy, wpisane };
  }
  function widokPodgladu(
    req,
    reply,
    { wybrane, konto, ids, dane, token, bledyPol = {}, wpisane = {}, bledyCennikow = {}, wpisaneCenniki = {} },
  ) {
    const allegro = wybrane.rodzaj === 'allegro';
    return reply.view('magazyn-oferty-podglad.ejs', {
      title: allegro ? 'Oferty Allegro — podgląd' : 'Oferty ERLI — podgląd',
      ...dane,
      rodzaj: wybrane.rodzaj,
      etykieta: `${allegro ? pomoc.adresKanalu(konto) : `ERLI · ${wybrane.konto.nazwa || konto}`}${allegro && wybrane.konto.srodowisko === 'sandbox' ? ' (sandbox)' : ''}`,
      zlotowki,
      konto,
      ids,
      token,
      bledyCennikow,
      // Po odrzuceniu formularz pokazuje wybory operatora, żeby poprawił tylko błędne pole.
      wpisaneCenniki: Object.keys(bledyCennikow).length ? wpisaneCenniki : {},
      aktywacja: null,
      uzupelnianie: allegro
        ? null
        : {
            mozeZapisac: uprawniony(req),
            stawki: STAWKI_Z_ZW,
            pola: POLA_BRAKOW.filter((p) => dane.braki.includes(p.brak)),
            bledyPol,
            wpisane,
          },
    });
  }
  for (const akcja of ['podglad', 'zatwierdz'])
    app.post(`/magazyn/oferty/${akcja}`, async (req, reply) => {
      if (!mozeWystawiacHurtem(req.konto)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const konto = pomoc.pole(req.body, 'konto');
      const wybrane = kontoOfert(konto);
      if (!wybrane) return odmowa(reply, 400, 'Wybierz bieżące konto ERLI albo Allegro.');
      // D21: konto Allegro bez zakresów ofert jest wyszarzone na liście; ręcznie wysłane → ten sam tekst.
      if (wybrane.rodzaj === 'allegro' && wybrane.konto.zgoda === false) return odmowa(reply, 400, BRAK_ZGODY_OFERT);
      const ids = [...new Set(idsZadania(req))].sort((a, b) => a - b);
      if (ids.length > LIMIT_KART_PODGLADU)
        return odmowa(reply, 400, `Za dużo kart naraz (${ids.length}) — zawęź filtr do 200`);
      if (!ids.length) return odmowa(reply, 400, 'Zaznacz co najmniej jedną kartę.');
      let token;
      if (akcja === 'zatwierdz') {
        token = pomoc.pole(req.body, 'podglad') ?? '';
        const [czas, mac] = token.split('.');
        const wzor = podpis(req, konto, ids, czas, odciskKonta(wybrane, konto));
        if (
          !/^\d+$/.test(czas ?? '') ||
          Date.now() - Number(czas) > 30 * 60_000 ||
          Number(czas) > Date.now() ||
          !/^[a-f0-9]{64}$/.test(mac ?? '') ||
          !timingSafeEqual(Buffer.from(mac), Buffer.from(wzor))
        ) {
          return odmowa(reply, 409, 'Otwórz podgląd ponownie przed zatwierdzeniem.');
        }
      } else {
        token = tokenPodgladu(req, wybrane, konto, ids);
      }
      // Cenniki z wierszy zapisujemy przed budową treści, żeby „Wystaw oferty” wstawił oferty już z nowym cennikiem.
      const cenniki = zapiszCennikiZPodgladu(req, wybrane, konto, ids);
      if (Object.keys(cenniki.bledy).length)
        return widokPodgladu(req, reply.code(400), {
          wybrane,
          konto,
          ids,
          dane: danePodgladu(req, wybrane, konto, ids),
          token: tokenPodgladu(req, wybrane, konto, ids),
          bledyCennikow: cenniki.bledy,
          wpisaneCenniki: cenniki.wpisane,
        });
      // E2.06: zawsze odczyt i walidacja na nowo, także przy zatwierdzeniu.
      const allegro = wybrane.rodzaj === 'allegro';
      const dane = danePodgladu(req, wybrane, konto, ids);
      if (akcja === 'zatwierdz' && !dane.braki.length) {
        transakcjaOfert(db, () => {
          for (const w of dane.wiersze) {
            if (w.bledy.length) continue;
            // Allegro: externalId nadaje OMS (`ext:<znak>-K<karta>`), numer oferty przychodzi dopiero z odpowiedzi.
            wstawOferte(db, {
              kartaId: w.id,
              kanal: konto,
              idZewnetrzne: allegro ? `ext:${znakInstalacji(db)}-K${w.id}` : idProduktuErli(db, w.id),
              stan: 'do_wyslania',
              pochodzenie: 'oms',
              tryb: 'zarzadzana',
            });
          }
        });
        // Wynik na osobnym adresie: F5 odświeża stan ofert zamiast ponownie wysyłać formularz.
        return reply
          .code(303)
          .redirect(`/magazyn/oferty/wynik?konto=${encodeURIComponent(konto)}&karty=${ids.join(',')}`);
      }
      // D40: prowizja tylko w podglądzie — informacja, nie bramka zatwierdzenia.
      if (allegro && akcja === 'podglad') await oplaty.prowizje(wybrane.konto, dane.wiersze);
      return widokPodgladu(req, reply, { wybrane, konto, ids, dane, token });
    });
  // Ekran po zatwierdzeniu: tylko odczyt kolejki ofert tego konta dla tych kart — nic nie zapisuje ani nie wysyła.
  app.get('/magazyn/oferty/wynik', async (req, reply) => {
    if (!mozeWystawiacHurtem(req.konto)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const konto = String(req.query?.konto ?? '');
    const wybrane = kontoOfert(konto);
    if (!wybrane) return odmowa(reply, 400, 'Wybierz bieżące konto ERLI albo Allegro.');
    const karty = String(req.query?.karty ?? '');
    if (!/^\d+(?:,\d+)*$/.test(karty)) return odmowa(reply, 400, 'Brak listy kart.');
    const ids = [...new Set(karty.split(',').map(Number))];
    if (ids.length > LIMIT_KART_PODGLADU)
      return odmowa(reply, 400, `Za dużo kart naraz (${ids.length}) — zawęź filtr do 200`);
    const allegro = wybrane.rodzaj === 'allegro';
    const nazwaKarty = db.prepare('SELECT nazwa FROM karty_produktow WHERE id = ?');
    const ustawieniaKonta = ustawieniaOfertKonta(db, konto);
    const wiersze = ids.map((id) => {
      const oferta = ofertyKarty(db, id).find((o) => o.kanal === konto) ?? null;
      const numer = String(oferta?.idZewnetrzne ?? '');
      // Allegro nadaje numer dopiero po wysłaniu (do tego czasu `ext:`); numer ERLI zna OMS, ale przed wysłaniem
      // oferty jeszcze nie ma w sklepie.
      const wyslana = allegro ? numer !== '' && !numer.startsWith('ext:') : oferta?.stan !== 'do_wyslania';
      return {
        id,
        nazwa: nazwaKarty.get(id)?.nazwa || `Karta ${id}`,
        stan: oferta ? STANY_PO_POLSKU[oferta.stan] : null,
        problem: oferta && ['problem', 'blad'].includes(oferta.stan) ? (oferta.problemy?.[0]?.tekst ?? null) : null,
        numer: oferta && wyslana ? numer : null,
        adres: allegro && oferta && wyslana && /^\d+$/.test(numer) ? `https://allegro.pl/oferta/${numer}` : null,
        doWyslania: oferta?.stan === 'do_wyslania',
        czeka: oferta
          ? zdanieCzekaniaOferty({
              rodzaj: wybrane.rodzaj,
              konto: wybrane.konto,
              ustawienia: ustawieniaKonta,
              oferta,
              teraz: Date.now(),
            })
          : null,
      };
    });
    const nazwa = wybrane.konto.nazwa || konto;
    return reply.view('magazyn-oferty-wynik.ejs', {
      title: `Oferty — ${nazwa}`,
      nazwa,
      allegro,
      aktywujPoSprawdzeniu: allegro ? ustawieniaOfertKonta(db, konto).aktywujPoSprawdzeniu === true : null,
      wiersze,
      wKolejce: wiersze.filter((w) => w.doWyslania).length,
      admin: req.konto?.admin === true,
      adres: `/magazyn/oferty/wynik?konto=${encodeURIComponent(konto)}&karty=${ids.join(',')}`,
    });
  });
  // Braki ustawień konta ERLI uzupełniane wprost z podglądu: te same walidatory co krok „Oferty” konfiguratora,
  // wszystkie pola w jednej transakcji — błąd jednego pola nie zapisuje żadnego.
  app.post('/magazyn/oferty/ustawienia-konta', async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const konto = pomoc.pole(req.body, 'konto');
    const wybrane = kontoOfert(konto);
    if (wybrane?.rodzaj !== 'erli') return odmowa(reply, 400, 'Wybierz bieżące konto ERLI.');
    const ids = [...new Set(idsZadania(req))].sort((a, b) => a - b);
    if (ids.length > LIMIT_KART_PODGLADU)
      return odmowa(reply, 400, `Za dużo kart naraz (${ids.length}) — zawęź filtr do 200`);
    if (!ids.length) return odmowa(reply, 400, 'Zaznacz co najmniej jedną kartę.');
    const wpisane = {};
    for (const { pole } of POLA_BRAKOW) {
      const v = String(pomoc.pole(req.body, pole) ?? '').trim();
      if (v !== '') wpisane[pole] = v;
    }
    const bledyPol = {};
    const aktor = { aktor: req.konto?.login ?? null };
    try {
      transakcjaOfert(db, () => {
        for (const [pole, v] of Object.entries(wpisane)) {
          const wartosc = pole === 'stawkaVat' || !/^\d+$/.test(v) ? v : Number(v);
          try {
            zapiszUstawieniaOfertKonta(db, konto, { [pole]: wartosc }, aktor);
          } catch (e) {
            bledyPol[pole] = e instanceof Error ? e.message : String(e);
          }
        }
        if (Object.keys(bledyPol).length) throw new Error('odrzucone pola ustawień');
      });
    } catch (e) {
      if (!Object.keys(bledyPol).length) throw e;
    }
    const zle = Object.keys(bledyPol).length > 0;
    const dane = danePodgladu(req, wybrane, konto, ids);
    return widokPodgladu(req, reply.code(zle ? 400 : 200), {
      wybrane,
      konto,
      ids,
      dane,
      token: tokenPodgladu(req, wybrane, konto, ids),
      bledyPol,
      wpisane: zle ? wpisane : {},
    });
  });
  // D30: „Aktywuj w Allegro” tylko zapisuje zamiar; wysyła pętla ofert (E3.08b).
  const aktywuj = (o) =>
    zmienOferte(db, o.id, {
      wyslanePola: { ...(o.wyslanePola ?? {}), aktywuj: true },
      liczbaProb: 0,
      nastepnaProbaAt: null,
    });
  app.post('/magazyn/oferty/aktywuj', async (req, reply) => {
    if (!mozeWystawiacHurtem(req.konto)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    let konto = pomoc.pole(req.body, 'konto');
    let wybrane = kontoOfert(konto);
    // Aktywacja przy wybranym koncie ERLI używa jedynego konta Allegro ze zgodą; nieznany klucz
    // (np. konto rozłączone po otwarciu strony) zostaje przy odmowie — inaczej szkice poszłyby na inne konto.
    if (wybrane?.rodzaj === 'erli') {
      const dostepne = kontaAllegro().filter((k) => k.zgoda !== false);
      if (dostepne.length > 1)
        return odmowa(reply, 400, 'Wybierz w polu Konto, na którym koncie Allegro aktywować szkice.');
      if (dostepne.length === 1) {
        konto = dostepne[0].klucz;
        wybrane = { rodzaj: 'allegro', konto: dostepne[0] };
      }
    }
    if (wybrane?.rodzaj !== 'allegro') return odmowa(reply, 400, 'Wybierz bieżące konto Allegro.');
    if (wybrane.konto.zgoda === false) return odmowa(reply, 400, BRAK_ZGODY_OFERT);
    const ids = [...new Set(idsZadania(req))].sort((a, b) => a - b);
    if (ids.length > LIMIT_KART_PODGLADU)
      return odmowa(reply, 400, `Za dużo kart naraz (${ids.length}) — zawęź filtr do 200`);
    if (!ids.length) return odmowa(reply, 400, 'Zaznacz co najmniej jedną kartę.');
    const aktywacja = transakcjaOfert(db, () => {
      let oznaczono = 0;
      for (const id of ids)
        for (const o of ofertyKarty(db, id)) {
          if (o.kanal !== konto || !mozeAktywowac(o)) continue;
          aktywuj(o);
          oznaczono++;
        }
      return { oznaczono, pominieto: ids.length - oznaczono };
    });
    return reply.view('magazyn-oferty-podglad.ejs', {
      title: 'Oferty Allegro — aktywacja',
      rodzaj: 'allegro',
      etykieta: `${pomoc.adresKanalu(konto)}${wybrane.konto.srodowisko === 'sandbox' ? ' (sandbox)' : ''}`,
      konto,
      aktywacja,
      wiersze: [],
      braki: [],
      ustawienia: ustawieniaOfertKonta(db, konto),
      ids,
      token: '',
      konfigurator: '',
      zlotowki,
    });
  });
  app.post('/magazyn/:id/oferty/:ofertaId/aktywuj', async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const o = ofertaPoId(db, Number(req.params.ofertaId));
    if (!o || o.kartaId !== Number(req.params.id)) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
    const konto = kontaAllegro().find((k) => k.klucz === o.kanal);
    if (!konto || !mozeAktywowac(o))
      return odmowa(reply, 409, 'Aktywować można tylko szkic oferty Allegro. Dla zakończonej oferty użyj Wznów.');
    if (konto.zgoda === false) return odmowa(reply, 400, BRAK_ZGODY_OFERT);
    aktywuj(o);
    return reply.code(303).redirect(`/magazyn/${o.kartaId}#produkty-karty`);
  });
  for (const akcja of ['zdejmij', 'ponow'])
    app.post(`/magazyn/:id/oferty/:ofertaId/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const o = ofertaPoId(db, Number(req.params.ofertaId));
      if (!o || o.kartaId !== Number(req.params.id)) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
      // E3.14: „Zdejmij” na Allegro zapisuje tylko zamiar (ENDED wysyła pętla), tak samo jak na ERLI.
      if (akcja === 'ponow' && brakWAllegro(o)) return odmowa(reply, 409, ODMOWA_BRAK_W_ALLEGRO);
      if (
        !kontoOfert(o.kanal) ||
        (akcja === 'ponow'
          ? !mozePonowic(o)
          : o.tryb !== 'zarzadzana' || !['aktywna', 'sprawdzana', 'problem'].includes(o.stan) || maKonflikt(o))
      )
        return odmowa(reply, 409, 'Ta oferta nie pozwala na tę akcję.');
      if (akcja === 'ponow')
        ponowOferte(
          db,
          o,
          kontaAllegro().some((k) => k.klucz === o.kanal),
        );
      else zmienOferte(db, o.id, zmianyZdjecia(o));
      return reply.code(303).redirect(`/magazyn/${o.kartaId}#produkty-karty`);
    });

  // Oferta usunięta w Allegro zostawia w OMS-ie martwy wiersz, który blokuje wystawienie karty od nowa na tym
  // koncie. Kasujemy tylko ten wiersz — Allegro niczego nie dostaje. Stan sprawdzamy jeszcze raz w transakcji,
  // bo między potwierdzeniem a kliknięciem pętla mogła znaleźć ofertę z powrotem.
  app.post('/magazyn/:id/oferty/:ofertaId/usun', async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const kartaId = Number(req.params.id);
    const ofertaId = Number(req.params.ofertaId);
    const wynik = transakcjaOfert(db, () => {
      const o = ofertaPoId(db, ofertaId);
      if (!o || o.kartaId !== kartaId) return { kod: 404 };
      if (!brakWAllegro(o)) return { kod: 409 };
      usunOferte(db, o.id);
      zapiszZmianeWKanale(db, {
        kanal: o.kanal,
        kartaId: o.kartaId,
        cel: `oferta:${o.idZewnetrzne}`,
        pole: 'status',
        stara: o.stan,
        nowa: STATUS_USUNIETEJ_Z_OMS,
        kto: String(req.konto?.login ?? 'panel'),
        at: new Date().toISOString(),
        wynik: 'ok',
      });
      return { kod: 303, numer: o.idZewnetrzne };
    });
    if (wynik.kod === 404) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
    if (wynik.kod === 409)
      return odmowa(reply, 409, 'Oferta jest w Allegro albo pętla jeszcze tego nie potwierdziła — nic nie usunięto.');
    return reply
      .code(303)
      .redirect(`/magazyn/${kartaId}?ok=oferta-usunieta&oferta=${encodeURIComponent(wynik.numer)}#produkty-karty`);
  });

  // Sterowanie ceną oferty Allegro, której OMS nie zarządza. Włączenie i oddanie zmieniają tylko rejestr i dziennik
  // zmian; cenę wysyła dopiero osobny przycisk, więc żadna z tych tras nie zapisuje niczego w Allegro.
  const NAPIS_STERUJ = 'Włączenie niczego nie wysyła. Ceny wyślesz przyciskiem Wyślij ceny do kanałów.';
  const POWODY_STERUJ = { 'oferty wstrzymane': 'oferty wstrzymane na koncie — włącz je w ustawieniach Allegro' };
  const SKAD_CENY = { reczna: 'ręczna cena kanału', narzut: 'cena karty z narzutem konta' };
  const zl = (gr) => zlotowki(kwotaDziesietna(gr));
  const kto = (req) => String(req.konto?.login ?? 'panel');
  /** Zaznaczone wiersze Powiązań → oferty do sterowania; wiersz zniknięty albo bez karty odpada. */
  const celeZLustra = (req) => {
    const surowe = req.body?.zaznaczone;
    const ids = [...new Set(pomoc.numeryZaznaczone(Array.isArray(surowe) ? surowe : [surowe]))].sort((a, b) => a - b);
    if (ids.length > LIMIT_KART_PODGLADU) return { ids, blad: `Za dużo ofert naraz (${ids.length}) — zaznacz do 200` };
    if (!ids.length) return { ids, blad: 'Zaznacz co najmniej jedną ofertę.' };
    const wiersz = db.prepare(
      `SELECT kanal, produkt_id, karta_id, status_publikacji FROM produkty_sklepowe
       WHERE id = ? AND zniknal_at IS NULL AND karta_id IS NOT NULL`,
    );
    const cele = ids
      .map((id) => wiersz.get(id))
      .filter(Boolean)
      .map((w) => ({
        kanal: w.kanal,
        idZewnetrzne: String(w.produkt_id),
        kartaId: Number(w.karta_id),
        stan: ['ENDED', 'INACTIVE'].includes(w.status_publikacji) ? 'nieaktywna' : 'aktywna',
      }));
    return { ids, cele };
  };
  // Liczone od nowa przy podglądzie i przy zatwierdzeniu: hamulec konta mógł się zmienić w międzyczasie.
  const ocenCel = (cel, konta) => {
    const konto = konta.find((k) => k.klucz === cel.kanal);
    const oferta = ofertaPoIdZewnetrznym(db, cel.kanal, cel.idZewnetrzne);
    const z = { ...cel, konto, oferta, powod: null };
    if (!konto) return { ...z, powod: 'konto spoza listy kont Allegro' };
    if (oferta && oferta.kartaId !== cel.kartaId) return { ...z, powod: 'oferta jest w rejestrze innej karty' };
    if (oferta?.tryb === 'zarzadzana') return { ...z, powod: 'ofertą zarządza OMS — cenę wysyła już teraz' };
    if (oferta?.cenaZOms) return { ...z, powod: 'cena już z OMS' };
    const bramka = bramkaZapisu({
      konto,
      ustawienia: ustawieniaOfertKonta(db, cel.kanal),
      oferta: { kanal: cel.kanal, tryb: 'obserwowana', cena_z_oms: 1 },
      klucze: konta.map((k) => k.klucz),
      kanal: 'Allegro',
      zakres: 'cena',
    });
    return bramka.wolno ? z : { ...z, powod: POWODY_STERUJ[bramka.powod] ?? bramka.powod };
  };
  const zakresSterowania = (oceny) =>
    oceny
      .filter((c) => !c.powod)
      .map((c) => `${c.kanal}:${c.idZewnetrzne}:${c.kartaId}`)
      .sort();
  const wierszPodgladu = async (c) => {
    const karta = db.prepare('SELECT nazwa, sku, cena_gr FROM karty_produktow WHERE id = ?').get(c.kartaId);
    const w = { ...c, nazwa: karta?.nazwa ?? `Karta ${c.kartaId}`, sku: karta?.sku ?? '', teraz: null, cel: null };
    if (c.powod) return w;
    try {
      const s = await c.konto.katalog.stanOferty(c.idZewnetrzne);
      const gr = s.ok ? groszeZKwoty(s.dane?.sellingMode?.price?.amount, 'cena oferty z odczytu Allegro') : null;
      w.teraz = gr === null ? 'nie udało się odczytać' : zl(gr);
    } catch {
      w.teraz = 'nie udało się odczytać';
    }
    const cena = cenaDlaKanalu({
      kartaGr: Number(karta?.cena_gr),
      narzutBp: ustawieniaOfertKonta(db, c.kanal).narzutBp,
      recznaGr: cenyReczneKarty(db, c.kartaId).get(c.kanal) ?? null,
    });
    w.cel = cena.bledy.length
      ? cena.zrodlo === 'reczna'
        ? 'błędna ręczna cena kanału'
        : 'brak ceny karty'
      : `${zl(cena.grosze)} (${SKAD_CENY[cena.zrodlo]})`;
    return w;
  };
  // Odczyt po kilka ofert naraz: 200 odczytów jeden po drugim trzymałoby podgląd zbyt długo.
  const podgladCen = async (oceny) => {
    const wiersze = [];
    for (let i = 0; i < oceny.length; i += 5)
      wiersze.push(...(await Promise.all(oceny.slice(i, i + 5).map(wierszPodgladu))));
    return wiersze;
  };
  const zapiszSterowanie = (req, oceny, wlacz) =>
    transakcjaOfert(db, () => {
      const at = new Date().toISOString();
      for (const c of oceny) {
        const o =
          c.oferta ??
          wstawOferte(db, {
            kartaId: c.kartaId,
            kanal: c.kanal,
            idZewnetrzne: c.idZewnetrzne,
            pochodzenie: 'przejeta',
            tryb: 'obserwowana',
            stan: c.stan,
          });
        zmienOferte(db, o.id, { cenaZOms: wlacz });
        zapiszZmianeWKanale(db, {
          kanal: c.kanal,
          kartaId: o.kartaId,
          cel: `oferta:${c.idZewnetrzne}`,
          pole: 'steruj_cena',
          stara: wlacz ? '0' : '1',
          nowa: wlacz ? '1' : '0',
          kto: kto(req),
          at,
          wynik: 'ok',
        });
      }
      return oceny.length;
    });
  const widokSterowania = (reply, dane) =>
    reply.view('magazyn-steruj-cena.ejs', {
      title: 'Sterowanie ceną Allegro',
      napis: NAPIS_STERUJ,
      wiersze: [],
      token: '',
      ids: [],
      wynik: null,
      ...dane,
    });
  /** Odmowa zatwierdzenia: hamulec albo stan rejestru zmienił się od podglądu — wtedy piszemy, dlaczego. */
  const odmowaZatwierdzenia = (reply, oceny) => {
    const powody = [...new Set(oceny.map((c) => c.powod).filter(Boolean))];
    return odmowa(
      reply,
      409,
      powody.length ? `Nie można włączyć sterowania ceną: ${powody.join('; ')}.` : 'Zaznacz co najmniej jedną ofertę.',
    );
  };

  for (const akcja of ['podglad', 'zatwierdz'])
    app.post(`/magazyn/oferty/steruj-cena/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const { ids, cele, blad } = celeZLustra(req);
      if (blad) return odmowa(reply, 400, blad);
      const konta = kontaAllegro();
      const oceny = cele.map((c) => ocenCel(c, konta));
      const zakres = zakresSterowania(oceny);
      if (akcja === 'zatwierdz') {
        if (!zakres.length) return odmowaZatwierdzenia(reply, oceny);
        if (!waznyPodpis(req, 'steruj-cena', zakres, pomoc.pole(req.body, 'podglad')))
          return odmowa(reply, 409, 'Podgląd jest nieaktualny — otwórz go ponownie przed włączeniem.');
        const wlaczono = zapiszSterowanie(
          req,
          oceny.filter((c) => !c.powod),
          true,
        );
        return widokSterowania(reply, {
          wroc: '/magazyn/powiazania',
          wynik: `Sterowanie ceną włączone: ${wlaczono}. Pominięto: ${ids.length - wlaczono}.`,
        });
      }
      const czas = String(Date.now());
      return widokSterowania(reply, {
        wroc: '/magazyn/powiazania',
        akcja: '/magazyn/oferty/steruj-cena/zatwierdz',
        ids,
        wiersze: await podgladCen(oceny),
        token: zakres.length ? `${czas}.${podpis(req, 'steruj-cena', zakres, czas)}` : '',
      });
    });
  app.post('/magazyn/oferty/oddaj-cene', async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const { ids, cele, blad } = celeZLustra(req);
    if (blad) return odmowa(reply, 400, blad);
    // Oddanie ceny tylko zwęża to, co OMS wysyła — nie potrzebuje podglądu ani czynnego konta.
    const doOddania = cele
      .map((c) => ({ ...c, oferta: ofertaPoIdZewnetrznym(db, c.kanal, c.idZewnetrzne) }))
      .filter((c) => c.oferta?.cenaZOms);
    const oddano = zapiszSterowanie(req, doOddania, false);
    return widokSterowania(reply, {
      wroc: '/magazyn/powiazania',
      wynik: `Cenę oddano Allegro: ${oddano}. Pominięto: ${ids.length - oddano}.`,
    });
  });
  /** Oferta z rejestru na karcie → cel sterowania; null, gdy nie należy do tej karty. */
  const celZKarty = (req) => {
    const o = ofertaPoId(db, Number(req.params.ofertaId));
    if (!o || o.kartaId !== Number(req.params.id)) return null;
    return { kanal: o.kanal, idZewnetrzne: o.idZewnetrzne, kartaId: o.kartaId, stan: o.stan, oferta: o };
  };
  for (const akcja of ['podglad', 'zatwierdz'])
    app.post(`/magazyn/:id/oferty/:ofertaId/steruj-cena/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
      const cel = celZKarty(req);
      if (!cel) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
      const ocena = ocenCel(cel, kontaAllegro());
      const zakres = zakresSterowania([ocena]);
      const wroc = `/magazyn/${cel.kartaId}#produkty-karty`;
      if (akcja === 'zatwierdz') {
        if (!zakres.length) return odmowaZatwierdzenia(reply, [ocena]);
        if (!waznyPodpis(req, 'steruj-cena', zakres, pomoc.pole(req.body, 'podglad')))
          return odmowa(reply, 409, 'Podgląd jest nieaktualny — otwórz go ponownie przed włączeniem.');
        zapiszSterowanie(req, [ocena], true);
        return reply.code(303).redirect(wroc);
      }
      const czas = String(Date.now());
      return widokSterowania(reply, {
        wroc,
        akcja: `/magazyn/${cel.kartaId}/oferty/${cel.oferta.id}/steruj-cena/zatwierdz`,
        wiersze: await podgladCen([ocena]),
        token: zakres.length ? `${czas}.${podpis(req, 'steruj-cena', zakres, czas)}` : '',
      });
    });
  app.post('/magazyn/:id/oferty/:ofertaId/oddaj-cene', async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const cel = celZKarty(req);
    if (!cel) return odmowa(reply, 404, 'Nie ma takiej oferty na karcie.');
    if (!cel.oferta.cenaZOms) return odmowa(reply, 409, 'Cena tej oferty nie jest prowadzona przez OMS.');
    zapiszSterowanie(req, [cel], false);
    return reply.code(303).redirect(`/magazyn/${cel.kartaId}#produkty-karty`);
  });
}
