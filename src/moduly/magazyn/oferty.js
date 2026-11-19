import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ofertyKarty,
  ofertaPoId,
  ofertaPoIdZewnetrznym,
  wstawOferte,
  zmienOferte,
  ustawieniaOfertKonta,
} from '../../oms/db/oferty-kanalow.ts';
import { wyjatekCennika } from '../../oms/db/cenniki-kart.ts';
import { brakiUstawienOfert } from '../../domena/erli-oferty-ustawienia.js';
import { dobierzCennik, regulyKonta } from '../../domena/cennik-dostaw.js';
import { trescOferty } from './services/tresc-oferty.js';
import { idProduktuErli } from './services/petla-ofert.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
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
  'duplikatu). Sprawdź ją w panelu Allegro albo wycofaj kartę ze sprzedaży („Wycofaj ze sprzedaży” na karcie).';
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

/** E3d.02: lista cenników konta Allegro z „Pobierz z Allegro” (krok 6) — `[{ id, nazwa }]`, bez listy pusta. */
export function cennikiAllegro(ustawienia) {
  const lista = ustawienia?.slowniki?.cenniki;
  return Array.isArray(lista) ? lista.filter((p) => p && typeof p.id === 'string' && p.id.trim()) : [];
}
/**
 * E3d.02-03: wybrany cennik do podglądu i karty — nazwa ze słownika konta Allegro albo identyfikator (ERLI: nazwa
 * z panelu ERLI) i powód doboru. Odmowa doboru → null (odmowę pokazują błędy karty).
 */
export function opisDostawy(ustawienia, rodzaj, dostawa, karta = null) {
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
  return {
    cennik: dostawa.cennik,
    nazwa: typeof nazwa === 'string' && nazwa.trim() ? nazwa : dostawa.cennik,
    rodzaj: dostawa.powod?.rodzaj ?? null,
    powod: (dostawa.powod?.tekst ?? '') + dopisek,
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
  const podpis = (req, konto, ids, czas) =>
    createHmac('sha256', sekret)
      .update(JSON.stringify([req.konto?.login, konto, ids, czas]))
      .digest('hex');
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
  // E3d.02-03 (decyzja kierownika): wyjątek cennika z karty wystarcza — konto bez reguł nie blokuje podglądu, gdy choć
  // jedna wybrana karta ma wyjątek na tym koncie; karty bez wyjątku dostają wtedy odmowę osobno (błąd budowniczego).
  const bezBrakuCennika = (braki, konto, ids) =>
    braki.includes('cennik dostaw') && ids.some((id) => wyjatekCennika(db, { kartaId: id, konto }))
      ? braki.filter((b) => b !== 'cennik dostaw')
      : braki;
  function zestaw(konto, ids) {
    const ustawienia = ustawieniaOfertKonta(db, konto);
    const braki = bezBrakuCennika(brakiUstawienOfert(ustawienia), konto, ids);
    // E4.06: jedna migawka stanów na żądanie, nie na kartę.
    const migawka = migawkaStanow(db);
    const wiersze = braki.length
      ? []
      : ids.map((id) => {
          const w = trescOferty(db, id, ustawienia, adresPublicznyZdjec, { migawka });
          if (w.karta?.wycofana) w.bledy.push('Karta jest wycofana.');
          if (ofertyKarty(db, id).some((o) => o.kanal === konto)) w.bledy.push('Karta ma już ofertę na tym koncie.');
          return {
            ...w,
            id,
            nazwa: w.karta?.nazwa ?? `Karta ${id}`,
            iloscNapis: napisIlosci(w.ilosc, w.cialo?.stock),
            dostawa: opisDostawy(ustawienia, 'erli', w.dostawa, w.karta),
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
  function zestawAllegro(konto, ids) {
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
            { klucz: konto.klucz, srodowisko: konto.srodowisko },
            { kontaSrodowiska, migawka, tworzenie: true },
          );
          const bledy = w.bledy.map((b) => b.tekst);
          const dostawa = opisDostawy(ustawienia, 'allegro', w.dostawa, w.karta);
          if (w.karta?.wycofana) bledy.push('Karta jest wycofana.');
          const maOferte = ofertyKarty(db, id).some((o) => o.kanal === konto.klucz) || wLustrze.has(id);
          if (maOferte) bledy.push('Karta ma już ofertę na tym koncie.');
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
  for (const akcja of ['podglad', 'zatwierdz'])
    app.post(`/magazyn/oferty/${akcja}`, async (req, reply) => {
      if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
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
        const wzor = podpis(req, konto, ids, czas);
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
        const czas = String(Date.now());
        token = `${czas}.${podpis(req, konto, ids, czas)}`;
      }
      // E2.06: zawsze odczyt i walidacja na nowo, także przy zatwierdzeniu.
      const allegro = wybrane.rodzaj === 'allegro';
      const dane = allegro
        ? zestawAllegro(wybrane.konto, ids)
        : {
            ...zestaw(konto, ids),
            konfigurator: `/ustawienia/integracje/erli/${encodeURIComponent(konto)}?krok=oferty#erli-krok-oferty`,
          };
      let wynik = null;
      if (akcja === 'zatwierdz' && !dane.braki.length) {
        let poszlo = 0;
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
            poszlo++;
          }
        });
        wynik = { poszlo, odmowiono: dane.wiersze.length - poszlo };
      }
      // D40: prowizja tylko w podglądzie — informacja, nie bramka zatwierdzenia.
      if (allegro && akcja === 'podglad') await oplaty.prowizje(wybrane.konto, dane.wiersze);
      return reply.view('magazyn-oferty-podglad.ejs', {
        title: allegro ? 'Oferty Allegro — podgląd' : 'Oferty ERLI — podgląd',
        ...dane,
        rodzaj: wybrane.rodzaj,
        etykieta: `${allegro ? pomoc.adresKanalu(konto) : `ERLI · ${konto}`}${allegro && wybrane.konto.srodowisko === 'sandbox' ? ' (sandbox)' : ''}`,
        zlotowki,
        konto,
        ids,
        token,
        wynik,
        aktywacja: null,
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
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
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
      wynik: null,
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
