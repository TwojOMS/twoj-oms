// Ekran „Problemy ofert”: oferty ERLI i Allegro czekające na decyzję w jednej tabeli.
// Akcje zapisują tylko zamiar w rejestrze; do kanału nic nie idzie z trasy (wysyła pętla).
// Wznów: sam znacznik `wyslanePola.wznow` bez kwoty i bez osobnej zgody na opłatę.
import {
  ofertaPoId,
  zmienOferte,
  ofertyDoDecyzji,
  liczbaOfertDoDecyzji,
  ofertyKarty,
  ofertyZProblememIlosci,
  ustawieniaOfertKonta,
} from '../../oms/db/oferty-kanalow.ts';
import { przelacznikStanow, migawkaStanow, stanKarty, dodajRuch } from '../../oms/db/stany-magazynowe.js';
import { PROBLEMY_ILOSCI, iloscDlaKanalu } from '../../domena/ilosc-kanalu.js';
import { iloscOferty } from './services/tresc-oferty.js';
import { powodyProblemu, akcjeProblemu } from '../../domena/problemy-ofert.js';
import { kwotaDziesietna } from '../../domena/cena-kanalu.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { BRAK_ZGODY_OFERT } from '../kanaly/services/oferty-allegro-ustawienia.ts';
import {
  mozePonowic,
  duplikatDoWyboru,
  ponowOferte,
  mozeWznowic,
  zakonczonaDoWznowienia,
  brakWAllegro,
  ODMOWA_BRAK_W_ALLEGRO,
} from './oferty.js';

const LIMIT = 200;
const ADRES = '/magazyn/problemy-ofert';
const zl = (gr) => `${kwotaDziesietna(gr).replace('.', ',')} zł`;
// Przycisk alarmu ilości według kodu (trasa `/:ofertaId/ilosc/:akcja` sprawdza, że kod się zgadza).
const AKCJE_ILOSCI = Object.freeze({
  'potwierdz-skok': { kod: 'skok', napis: 'Potwierdź skok' },
  'wyslij-stan-oms': { kod: 'rozjazd-dol', napis: 'Wyślij stan OMS' },
  'przyjmij-stan-kanalu': { kod: 'rozjazd-dol', napis: 'Przyjmij stan kanału' },
  'przyjalem': { kod: 'rozjazd-gora', napis: 'Przyjąłem' },
});
const ODMOWA_ZMIANY = 'Dane się zmieniły — odśwież listę.';
// Odmowa według powodu z iloscDlaKanalu, gdy karta nie daje ilości.
const BEZ_STANU = Object.freeze({
  'stany-niezatwierdzone':
    'Stany magazynowe nie są jeszcze zatwierdzone — do zatwierdzenia podglądu OMS nie zmienia ilości ofert.',
  'brak-stanu': 'Stan karty nie jest znany — uzupełnij stan otwarcia.',
});
const ofert = (n) =>
  `${n} ${n === 1 ? 'oferta' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'oferty' : 'ofert'}`;
const szt = (n) => `${n} szt.`;
/** Alarm ilości widoczny na ekranie: wstrzymujący albo `brak-stanu` (jak w zapytaniu ofertyDoDecyzji). */
const problemIlosci = (o) =>
  o.iloscProblem && (o.iloscProblem.wstrzymuje === true || o.iloscProblem.kod === 'brak-stanu') ? o.iloscProblem : null;
/** Baza W/T po decyzji człowieka: najświeższy odczyt kanału i jego chwila — sprzedaż po alarmie wypada po T.
 * W z `odczytIlosc`, bo pętle zapisują go zawsze razem z `odczytanoAt` (`odczytIloscKanalu` bywa starszy).
 * Odczyt z alarmu tylko zapasowo, z T = chwila kliknięcia. */
const bazaOdczytu = (o, at) => {
  if (Number.isFinite(o.odczytIlosc)) {
    const t = Date.parse(o.odczytanoAt ?? '');
    return { ilosc: o.odczytIlosc, at: Number.isFinite(t) && t <= Date.parse(at) ? o.odczytanoAt : at };
  }
  return Number.isFinite(o.iloscProblem?.odczyt) ? { ilosc: o.iloscProblem.odczyt, at } : null;
};
const data = (iso) =>
  iso
    ? fmtDataCzas(iso)
        .replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1')
        .slice(0, 16)
    : '';

export function registerProblemyOfert(
  app,
  {
    db,
    pomoc,
    kontaErli,
    kontaAllegro = /** @returns {{ klucz: string, zgoda?: boolean }[]} */ () => [],
    sklepy = /** @type {Record<string, unknown>} */ ({}),
    kanalySklepow = /** @type {readonly string[]} */ ([]),
  },
) {
  const odmowa = (reply, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, { tytul: 'Problemy ofert', wroc: ADRES, napisWroc: 'Wróć do problemów ofert' });
  const uprawniony = (req) => req.konto?.admin === true;
  const kontaOfert = () => {
    const erli = kontaErli();
    const allegro = kontaAllegro();
    return (klucz) => kontoOfert(klucz, erli, allegro);
  };
  const kontoOfert = (klucz, kontaE = kontaErli(), kontaA = kontaAllegro()) => {
    const erli = kontaE.find((k) => k.klucz === klucz);
    if (erli) return { rodzaj: 'erli', konto: erli };
    const allegro = kontaA.find((k) => k.klucz === klucz);
    if (allegro) return { rodzaj: 'allegro', konto: allegro };
    // Sklep Woo z podłączonym klientem (ta sama mapa co pętla stanów Woo) — akcje ilości jak ERLI;
    // Ponów, Wznów i potwierdzenie ceny nie są dla Woo. Jak pętla — tylko sklepy z konfiguracji.
    return kanalySklepow.includes(klucz) && Object.hasOwn(sklepy, klucz) && sklepy[klucz]
      ? { rodzaj: 'woo', konto: { klucz } }
      : null;
  };
  const NAZWY_RODZAJOW = Object.freeze({ erli: 'ERLI', allegro: 'Allegro', woo: 'WooCommerce' });
  const wroc = (reply) => reply.code(303).redirect(ADRES);
  const wrocDoIlosci = (reply) => reply.code(303).redirect(`${ADRES}?filtr=ilosc`);
  const stanyWlaczone = () => przelacznikStanow(db).wlaczone;
  /** Ilość z karty dla konta oferty (stan − bufor); `ilosc: null` i `powod`, gdy stanu nie znamy. */
  const celOferty = (o, migawka = migawkaStanow(db)) => {
    const ustawienia = ustawieniaOfertKonta(db, o.kanal);
    const wynik = iloscOferty(migawka, o.kartaId, ustawienia);
    return { ilosc: wynik?.ilosc ?? null, powod: wynik?.powod ?? null };
  };
  /**
   * Wznów przy włączonych stanach bierze ilość z karty, nie ze stałej konta. Odmowa przy celu null/0 i przy
   * aktywnym problemie ilości (poza `czeste-wznawianie` — to właśnie ta decyzja człowieka). Stany wyłączone — ilość ze stałej konta, jak bez tej funkcji.
   */
  const wznowienieIlosci = (o, migawka) => {
    if (!stanyWlaczone()) return {};
    const p = problemIlosci(o);
    if (p?.wstrzymuje && p.kod !== 'czeste-wznawianie')
      return { odmowa: 'Najpierw rozwiąż problem ilości tej oferty.' };
    const { ilosc, powod } = celOferty(o, migawka);
    if (!ilosc)
      return { odmowa: BEZ_STANU[powod] ?? 'Karta nie ma sztuk do wystawienia — wznów ofertę, gdy przyjdzie towar.' };
    return { ilosc };
  };
  /** `wlaczone` = false: zalegający alarm po wyłączeniu stanów — sam opis, bez przycisków (trasy i tak odmówią). */
  const opisIlosci = (o, p, wlaczone) => {
    const szablon = Object.hasOwn(PROBLEMY_ILOSCI, p.kod) ? PROBLEMY_ILOSCI[p.kod].tekst : `Problem ilości: ${p.kod}`;
    const szczegoly = [
      Number.isFinite(p.odczyt) ? `odczyt ${szt(p.odczyt)}` : null,
      Number.isFinite(p.cel) ? `cel ${szt(p.cel)}` : null,
      Number.isFinite(p.zakres?.min) && Number.isFinite(p.zakres?.max)
        ? `zakres ${p.zakres.min}–${szt(p.zakres.max)}`
        : null,
      p.od ? `od ${data(p.od)}` : null,
    ].filter(Boolean);
    const akcje = wlaczone
      ? Object.entries(AKCJE_ILOSCI)
          .filter(([, a]) => a.kod === p.kod)
          .map(([akcja, a]) => ({ akcja, napis: a.napis }))
      : [];
    const tez =
      wlaczone && p.kod === 'rozjazd-dol'
        ? [
            ...new Set(
              ofertyKarty(db, o.kartaId)
                .filter((x) => x.id !== o.id)
                .map((x) => x.kanal),
            ),
          ]
        : [];
    return {
      tekst: typeof p.tekst === 'string' && p.tekst.trim() ? p.tekst : szablon,
      szczegoly,
      akcje,
      tez,
      otwarcie: wlaczone && p.kod === 'brak-stanu',
    };
  };

  app.get(ADRES, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const wszystkich = liczbaOfertDoDecyzji(db);
    const ilosci = liczbaOfertDoDecyzji(db, { ilosc: true });
    const przelacznik = przelacznikStanow(db);
    // Instalacja, która nigdy nie włączyła stanów, nie widzi filtra ilości.
    const etap4 = przelacznik.historia.length > 0 || ilosci > 0;
    const filtr = etap4 && req.query?.filtr === 'ilosc' ? 'ilosc' : null;
    const pokazanych = filtr ? ilosci : wszystkich;
    const znajdzKonto = kontaOfert();
    const wlaczone = przelacznik.wlaczone;
    const migawka = wlaczone ? migawkaStanow(db) : null;
    const zera = new Map();
    const wiersze = ofertyDoDecyzji(db, { limit: LIMIT, ilosc: filtr === 'ilosc' }).map((o) => {
      const k = znajdzKonto(o.kanal);
      const akcje = k ? akcjeProblemu(o, k.rodzaj) : { wznow: null, cena: null };
      const wznow =
        akcje.wznow && mozeWznowic(o) && k.konto.zgoda !== false && !wznowienieIlosci(o, migawka).odmowa
          ? akcje.wznow
          : null;
      const p = problemIlosci(o);
      // Formularz niesie listę pokazanych ofert — trasa potwierdza tylko ją.
      if (p?.kod === 'zero-masowe' && k && wlaczone && !zera.has(o.kanal)) zera.set(o.kanal, idyZer(o.kanal));
      return {
        id: o.id,
        kartaId: o.kartaId,
        nazwa: o.nazwa,
        konto: o.kanal,
        kanal: k ? NAZWY_RODZAJOW[k.rodzaj] : 'konto odłączone',
        powody: powodyProblemu(o),
        od: data(o.problemyOd ?? p?.od ?? o.zmienionoAt),
        ilosc: p ? opisIlosci(o, p, wlaczone) : null,
        ponow: Boolean(k) && k.rodzaj !== 'woo' && o.tryb === 'zarzadzana' && mozePonowic(o),
        duplikat: duplikatDoWyboru(o),
        brakWAllegro: k && k.rodzaj !== 'woo' && brakWAllegro(o) ? ODMOWA_BRAK_W_ALLEGRO : null,
        wznow,
        cena: akcje.cena && o.tryb === 'zarzadzana' ? { nowaGr: akcje.cena.nowaGr, nowa: zl(akcje.cena.nowaGr) } : null,
      };
    });
    return reply.view('magazyn-problemy-ofert.ejs', {
      szerokosc: 'tabela',
      title: 'Magazyn — problemy ofert',
      wiersze,
      wszystkich: pokazanych,
      liczby: { wszystkich, ilosci },
      filtr,
      etap4,
      adres: ADRES,
      zera: [...zera].map(([konto, ids]) => ({
        konto,
        n: ids.length,
        oferty: ids.join(','),
        napis: `Wyślij zera — ${konto} (${ofert(ids.length)})`,
      })),
    });
  });

  const oferta = (req, reply) => {
    const o = ofertaPoId(db, Number(req.params.ofertaId));
    if (!o) {
      odmowa(reply, 404, 'Nie ma takiej oferty.');
      return null;
    }
    return o;
  };

  app.post(`${ADRES}/:ofertaId/ponow`, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const o = oferta(req, reply);
    if (!o) return reply;
    if (!['blad', 'problem'].includes(o.stan)) return wroc(reply);
    const k = kontoOfert(o.kanal);
    if (brakWAllegro(o)) return odmowa(reply, 409, ODMOWA_BRAK_W_ALLEGRO);
    if (!k || k.rodzaj === 'woo' || !mozePonowic(o)) return odmowa(reply, 409, 'Tej oferty nie można ponowić.');
    ponowOferte(db, o, k.rodzaj === 'allegro');
    return wroc(reply);
  });

  app.post(`${ADRES}/:ofertaId/wznow`, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const o = oferta(req, reply);
    if (!o) return reply;
    const k = kontoOfert(o.kanal);
    if (!k || k.rodzaj !== 'allegro') return odmowa(reply, 409, 'Wznowić można tylko ofertę Allegro.');
    if (o.wyslanePola?.wznow || !zakonczonaDoWznowienia(o)) return wroc(reply);
    if (!mozeWznowic(o)) return odmowa(reply, 409, 'Tej oferty nie można teraz wznowić.');
    if (k.konto.zgoda === false) return odmowa(reply, 400, BRAK_ZGODY_OFERT);
    const { odmowa: bezIlosci, ilosc } = wznowienieIlosci(o);
    if (bezIlosci) return odmowa(reply, 409, bezIlosci);
    const czeste = o.iloscProblem?.kod === 'czeste-wznawianie' ? { iloscProblem: null } : {};
    zmienOferte(db, o.id, {
      wyslanePola: {
        ...o.wyslanePola,
        wznow: {
          login: req.konto?.login ?? null,
          at: new Date().toISOString(),
          ...(ilosc === undefined ? {} : { ilosc }),
        },
      },
      liczbaProb: 0,
      nastepnaProbaAt: null,
      ...czeste,
    });
    return wroc(reply);
  });

  // Decyzje przy alarmach ilości — tylko rejestr (i ruch `korekta`); wysyła pętla.
  app.post(`${ADRES}/:ofertaId/ilosc/:akcja`, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const akcja = Object.hasOwn(AKCJE_ILOSCI, req.params.akcja) ? req.params.akcja : null;
    if (!akcja) return odmowa(reply, 404, 'Nie ma takiej akcji.');
    const o = oferta(req, reply);
    if (!o) return reply;
    if (!o.iloscProblem) return wrocDoIlosci(reply);
    if (o.iloscProblem.kod !== AKCJE_ILOSCI[akcja].kod) return odmowa(reply, 409, ODMOWA_ZMIANY);
    if (!kontoOfert(o.kanal)) return odmowa(reply, 409, 'Konto tej oferty jest odłączone.');
    if (!stanyWlaczone()) return odmowa(reply, 409, 'Stany magazynowe są wyłączone.');
    const at = new Date().toISOString();
    const baza = bazaOdczytu(o, at);
    // Decyzja człowieka przesuwa T: inaczej następny przebieg liczy skok/rozjazd od starej wysyłki.
    // Bez odczytu nie ma pary W/T — także „Potwierdź skok” odmawia.
    if (!baza) return odmowa(reply, 409, 'Brak odczytu ilości z kanału — poczekaj na następny przebieg.');
    const nowaBaza = { wyslanaIlosc: baza.ilosc, iloscWyslanaAt: baza.at };
    if (akcja === 'potwierdz-skok') {
      const stan = stanKarty(db, o.kartaId)?.stan;
      if (!Number.isFinite(stan)) return odmowa(reply, 409, ODMOWA_ZMIANY);
      zmienOferte(db, o.id, { iloscProblem: null, stanKartyWyslany: stan, ...nowaBaza });
      return wrocDoIlosci(reply);
    }
    const zmiany = { iloscProblem: null, ...nowaBaza };
    if (akcja === 'wyslij-stan-oms') {
      const stan = stanKarty(db, o.kartaId)?.stan;
      zmienOferte(db, o.id, { ...zmiany, ...(Number.isFinite(stan) ? { stanKartyWyslany: stan } : {}) });
      return wrocDoIlosci(reply);
    }
    if (akcja !== 'przyjmij-stan-kanalu') {
      zmienOferte(db, o.id, zmiany);
      return wrocDoIlosci(reply);
    }
    // Ruch to różnica z chwili alarmu (odczyt − cel); cel liczony teraz tylko, gdy alarm go nie ma.
    const odczyt = Number.isFinite(o.iloscProblem.odczyt) ? o.iloscProblem.odczyt : baza.ilosc;
    const teraz = celOferty(o);
    if (teraz.ilosc == null) return odmowa(reply, 409, BEZ_STANU[teraz.powod] ?? 'Stan karty nie jest znany.');
    const cel = Number.isFinite(o.iloscProblem.cel) ? o.iloscProblem.cel : teraz.ilosc;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (odczyt !== cel) {
        dodajRuch(db, {
          kartaId: o.kartaId,
          rodzaj: 'korekta',
          ilosc: odczyt - cel,
          powod: `rozjazd: ${o.kanal}`,
          klucz: `rozjazd:${o.id}:${o.iloscProblem.od ?? at}`,
          konto: req.konto ?? null,
          at,
        });
      }
      // Korekta z chwilą kliknięcia — inne oferty karty widzą ją jako wyjaśnioną, a ta oferta
      // nie liczy jej dwa razy, bo wyjaśnienia pomijają jej własną korektę (klucz `rozjazd:<id>:…`), a S ją zawiera.
      // S = stan karty po korekcie (w tej samej transakcji), inaczej korekta wygląda na skok.
      const poKorekcie = stanKarty(db, o.kartaId)?.stan;
      zmienOferte(db, o.id, { ...zmiany, ...(Number.isFinite(poKorekcie) ? { stanKartyWyslany: poKorekcie } : {}) });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return wrocDoIlosci(reply);
  });

  /** Id ofert konta z `zero-masowe`, rosnąco — lista pokazana na ekranie i porównywana przy kliknięciu. */
  const idyZer = (konto) =>
    ofertyZProblememIlosci(db, konto, 'zero-masowe')
      .map((o) => o.id)
      .sort((a, b) => a - b);

  // „Wyślij zera” — jedno kliknięcie zdejmuje `zero-masowe` z ofert jednego konta.
  // Tylko z ofert z listy, którą pokazał formularz; nowe zera spoza niej → 409, nic nie zapisuje.
  app.post(`${ADRES}/konto/:konto/wyslij-zera`, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const konto = String(req.params.konto);
    if (!kontoOfert(konto)) return odmowa(reply, 404, 'Nie ma takiego konta.');
    if (!stanyWlaczone()) return odmowa(reply, 409, 'Stany magazynowe są wyłączone.');
    // Przed zatwierdzeniem bieżącego włączenia potwierdzenie ominęłoby zero masowe po zatwierdzeniu.
    if (iloscDlaKanalu({ migawka: migawkaStanow(db), tryb: 'zarzadzana' }).powod === 'stany-niezatwierdzone') {
      return odmowa(reply, 409, BEZ_STANU['stany-niezatwierdzone']);
    }
    const pokazane = new Set(
      String(pomoc.pole(req.body, 'oferty') ?? '')
        .split(',')
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    if (!pokazane.size) return odmowa(reply, 400, 'Brak listy ofert do potwierdzenia — odśwież listę.');
    // Potwierdzenie ważne tylko w bieżącym przełączeniu stanów (pętle porównują z migawką).
    const zaznaczenie = {
      login: req.konto?.login ?? null,
      at: new Date().toISOString(),
      przelaczenieId: przelacznikStanow(db).przelaczenieId,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const biezace = ofertyZProblememIlosci(db, konto, 'zero-masowe');
      if (biezace.some((o) => !pokazane.has(o.id))) {
        db.exec('ROLLBACK');
        return odmowa(reply, 409, 'Doszły nowe oferty do zera — odśwież');
      }
      for (const o of biezace) {
        zmienOferte(db, o.id, { iloscProblem: null, wyslanePola: { ...o.wyslanePola, zeraPotwierdzone: zaznaczenie } });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return wrocDoIlosci(reply);
  });

  app.post(`${ADRES}/:ofertaId/potwierdz-cene`, async (req, reply) => {
    if (!uprawniony(req)) return odmowa(reply, 403, 'Brak prawa edycji magazynu.');
    const o = oferta(req, reply);
    if (!o) return reply;
    const k = kontoOfert(o.kanal);
    if (!k || k.rodzaj === 'woo') return odmowa(reply, 409, 'Konto tej oferty jest odłączone.');
    if (o.cenaDoPotwierdzeniaGr == null || o.wyslanePola?.cenaPotwierdzonaGr === o.cenaDoPotwierdzeniaGr)
      return wroc(reply);
    if (o.tryb !== 'zarzadzana') return odmowa(reply, 409, 'Ta oferta nie pozwala na tę akcję.');
    const cenaGr = Number(pomoc.pole(req.body, 'cenaGr'));
    if (!Number.isInteger(cenaGr) || cenaGr !== o.cenaDoPotwierdzeniaGr)
      return odmowa(reply, 409, 'Dane się zmieniły — odśwież listę.');
    zmienOferte(db, o.id, { wyslanePola: { ...o.wyslanePola, cenaPotwierdzonaGr: cenaGr } });
    return wroc(reply);
  });
}
