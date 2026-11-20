import { stronaOdmowy } from '../../core/web/odmowa.js';
import { rodzajKanalu } from '../../domena/kanaly.js';
import { MODUL_ERLI } from '../../domena/modul-erli.ts';
import { modulKanalu } from '../../domena/moduly-kanalow.ts';
import { cenyReczneKarty, ustawCeneReczna, usunCeneReczna, zapiszZmianeWKanale } from '../../oms/db/ceny-kanalow.js';
import { produktyKarty } from '../../oms/db/magazyn.js';
import { ofertyKarty } from '../../oms/db/oferty-kanalow.ts';
import { LIMIT_KART } from './services/ceny-kanalow-podglad.js';
import { createZapisCenKanalow, OdmowaZapisuCen } from './services/ceny-kanalow-zapis.js';

export const czyKanalObslugujeCeny = (rodzaj, oferty) =>
  rodzaj &&
  modulKanalu(rodzaj.klucz).umiejetnosci.cenyZOms === true &&
  (rodzaj.klucz !== MODUL_ERLI.typ || oferty.some((o) => o.tryb === 'zarzadzana'));

const klientCenKonta = ({ klucz, klient, zgoda, tylkoOdczyt }) => [
  klucz,
  { ...klient, tylkoOdczyt: () => zgoda === false || tylkoOdczyt() },
];

const waluta = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
const procent = new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 2 });
const zmianaProc = new Intl.NumberFormat('pl-PL', {
  style: 'percent',
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const cena = (gr) => (gr == null ? '—' : waluta.format(gr / 100));
const powrot = (kartaId) => (kartaId ? `/magazyn/${kartaId}#sprzedaz-kanalow` : '/magazyn');

function zapiszCeneIDziennik(db, { kartaId, kanal, cenaGr, kto, at }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stara = cenyReczneKarty(db, kartaId).get(kanal) ?? null;
    if (stara !== cenaGr) {
      if (cenaGr === null) usunCeneReczna(db, { kartaId, kanal });
      else ustawCeneReczna(db, { kartaId, kanal, cenaGr, kto, at });
      // Cel odróżnia zmianę ustawienia karty od ceny zapisanej później na ofercie lub produkcie.
      zapiszZmianeWKanale(db, {
        kartaId,
        kanal,
        cel: 'karta',
        pole: 'cena',
        stara,
        nowa: cenaGr,
        kto,
        at,
        wynik: 'ok',
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export function registerCenyKanalow(app, { db, definicje, pomoc, sklepy, kontaAllegro, kontaErli }) {
  const { kartaPoId, pole, zmianyZFormularza, numeryZaznaczone } = pomoc;
  const zapis = createZapisCenKanalow({
    db,
    definicje,
    klienci: () => ({
      ...sklepy,
      ...Object.fromEntries([...kontaAllegro(), ...kontaErli()].map(klientCenKonta)),
    }),
    blokujPromocjeWoo: true,
  });

  // Jak pozostałe formularze magazynu, trasa korzysta ze wspólnego haka CSRF.
  const odmowaZapisu = (reply) =>
    stronaOdmowy(reply, 403, 'Tylko administrator może zmieniać ceny kanałów.', { wroc: '/magazyn' });

  app.post('/magazyn/ceny-kanalow/podglad', async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaZapisu(reply);
    const ids = [...new Set(numeryZaznaczone(req.body?.karty ?? req.body?.zaznaczone))];
    const odmowa = (tekst) => stronaOdmowy(reply, 400, tekst, { wroc: '/magazyn' });
    if (ids.length === 0) return odmowa('Zaznacz co najmniej jedną kartę.');
    if (ids.length > LIMIT_KART) return odmowa(`Zaznacz najwyżej ${LIMIT_KART} kart.`);

    const kartaId = ids.length === 1 ? ids[0] : null;
    const podglad = await zapis.podglad(req.konto.login, ids);
    const doEkranu = (w) => ({
      ...w,
      cenaObecna: cena(w.staraGr),
      cenaDocelowa: cena(w.nowaGr),
      opisZrodla:
        w.nowaGr == null ? '—' : w.zrodlo === 'reczna' ? 'ręczna' : `z karty + ${procent.format(w.narzutBp / 10000)}`,
      roznica: w.roznicaBp == null ? '—' : zmianaProc.format(w.roznicaBp / 10000),
    });
    const wiersze = podglad.wiersze.map(doEkranu);
    return reply.view('magazyn-ceny-kanalow.ejs', {
      title: 'Podgląd wysyłki cen',
      wroc: powrot(kartaId),
      kartaId,
      podglad: {
        ...podglad,
        wiersze,
        pominieteWiersze: podglad.pominieteWiersze.map(doEkranu),
        bezZmianWiersze: podglad.bezZmianWiersze.map((w) => ({ ...w, cenaObecna: cena(w.staraGr) })),
        moznaZatwierdzic: wiersze.some((w) => w.doWyboru),
      },
      grupy: null,
    });
  });

  app.post('/magazyn/ceny-kanalow/zatwierdz', async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaZapisu(reply);
    const [kartaId] = numeryZaznaczone(pole(req.body, 'karty'));
    const wroc = powrot(kartaId);
    const klucze = Object.entries(req.body ?? {})
      .filter(([klucz, wartosc]) => klucz.includes('|') && wartosc === '1')
      .map(([klucz]) => klucz);

    let wynik;
    try {
      wynik = await zapis.zatwierdz(req.konto.login, pole(req.body, 'podpis'), klucze);
    } catch (e) {
      if (!(e instanceof OdmowaZapisuCen)) throw e;
      return stronaOdmowy(reply, ['podpis', 'wybor'].includes(e.kod) ? 400 : 409, e.message, {
        wroc,
        napisWroc: 'otwórz podgląd ponownie',
      });
    }

    const zapisane = Map.groupBy(wynik.zapisane, (w) => w.wynik === 'w_toku');
    const etykiety = new Map(definicje.map((d) => [d.klucz, d.etykieta]));
    const grupy = [
      ['Zapisane', zapisane.get(false) ?? []],
      ['Błędy', wynik.bledy],
      ['Pominięte', wynik.pominiete],
      ['W toku', zapisane.get(true) ?? []],
    ];
    if (!grupy.at(-1)[1].length) grupy.pop();

    return reply.view('magazyn-ceny-kanalow.ejs', {
      title: 'Wynik wysyłki cen',
      wroc,
      kartaId,
      podglad: null,
      grupy: grupy.map(([tytul, lista]) => ({
        tytul,
        pozycje: lista.map((w) => ({
          ...w,
          etykietaKanalu: etykiety.get(w.kanal) ?? w.kanal,
          cenaDocelowa: cena(w.nowaGr),
          opis: w.blad ?? w.powod ?? w.uwaga,
        })),
      })),
    });
  });

  app.post('/magazyn/:id/cena-kanalu', async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaZapisu(reply);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return stronaOdmowy(reply, 404, 'Nie ma takiej karty produktu.', { wroc: '/magazyn' });

    const wroc = `/magazyn/${karta.id}#sprzedaz-kanalow`;
    const odmowa = (kod, tekst) => stronaOdmowy(reply, kod, tekst, { wroc });
    const kanal = pole(req.body, 'kanal');
    const oferty = ofertyKarty(db, karta.id).filter((o) => o.kanal === kanal);
    if (
      !czyKanalObslugujeCeny(rodzajKanalu(kanal, definicje), oferty) ||
      (oferty.length === 0 && !produktyKarty(db, karta.id).some((p) => p.kanal === kanal))
    ) {
      return odmowa(404, 'Ta karta nie ma powiązania z kontem kanału obsługującym ceny z OMS.');
    }

    let cenaGr = null;
    if (pole(req.body, 'wyczysc') === null) {
      const { zmiany } = zmianyZFormularza(db, karta, { cena_zl: pole(req.body, 'cena_zl') });
      cenaGr = zmiany?.cena_gr;
      if (!Number.isSafeInteger(cenaGr) || cenaGr <= 0)
        return odmowa(400, 'Wpisz cenę większą od zera w złotych, np. 49,90.');
    }

    zapiszCeneIDziennik(db, { kartaId: karta.id, kanal, cenaGr, kto: req.konto.login, at: new Date().toISOString() });
    return reply.code(303).redirect(wroc);
  });
}
