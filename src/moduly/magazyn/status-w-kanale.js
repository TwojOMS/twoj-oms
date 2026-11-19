// Status produktu w kanale (kolumna „Status” na karcie) i jego przełączanie. Ta ścieżka niesie wyłącznie status:
// Woo dostaje `{status}` na produkcie nadrzędnym, Allegro komendę publikacji. Status w lustrze pochodzi z odczytu
// po zapisie — kanał potrafi przyjąć zapis i zostawić stary status (np. Allegro bez sztuk nie wznowi oferty).
import { randomUUID } from 'node:crypto';
import { rodzajKanalu } from '../../domena/kanaly.js';
import { modulKanalu } from '../../domena/moduly-kanalow.ts';
import { kartaPoId } from '../../oms/db/magazyn.js';
import { ustawStatusPublikacji, zapiszZmianeWKanale } from '../../oms/db/ceny-kanalow.js';
import { ofertaPoIdZewnetrznym, ustawieniaOfertKonta, wstawOferte, zmienOferte } from '../../oms/db/oferty-kanalow.ts';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { bramkaZapisu, bramkaZapisuWoo } from './services/oferty-wspolne.js';
import { mozeWznowic } from './oferty.js';

const BRAK = Object.freeze({ plakietka: '—', ton: 'cichy' });

/** Plakietki i akcje statusu po `rodzaj.klucz`; akcja wolna tylko z jednego statusu wyjściowego. */
export const STATUSY_KANALOW = Object.freeze({
  woo: {
    plakietki: { publish: ['Opublikowany', 'ok'], draft: ['Szkic', 'cichy'] },
    akcje: {
      ukryj: {
        z: 'publish',
        cel: 'draft',
        napis: 'Ukryj (szkic)',
        potwierdz: 'Tak, ukryj',
        pytanie: 'Ukryć produkt w sklepie? Zmieni się tylko status — klienci przestaną go widzieć.',
      },
      opublikuj: {
        z: 'draft',
        cel: 'publish',
        napis: 'Opublikuj',
        potwierdz: 'Tak, opublikuj',
        pytanie: 'Opublikować produkt w sklepie? Zmieni się tylko status — klienci zobaczą go w sklepie.',
      },
    },
  },
  allegro: {
    plakietki: {
      ACTIVE: ['Aktywna', 'ok'],
      ENDED: ['Zakończona', 'cichy'],
      INACTIVE: ['Nieaktywna', 'uwaga'],
      ACTIVATING: ['Sprawdzana', 'uwaga'],
    },
    akcje: {
      zakoncz: {
        z: 'ACTIVE',
        cel: 'ENDED',
        komenda: 'END',
        napis: 'Zakończ ofertę',
        potwierdz: 'Tak, zakończ',
        pytanie: 'Zakończyć ofertę w Allegro? Zmieni się tylko status.',
      },
      wznow: {
        z: 'ENDED',
        cel: 'ACTIVE',
        komenda: 'ACTIVATE',
        napis: 'Wznów ofertę',
        potwierdz: 'Tak, wznów',
        pytanie: 'Wznowić ofertę? Allegro wystawi ją z ilością, jaką ma teraz w Allegro.',
      },
    },
  },
});

// Powody bramki na język ekranu; nieznany powód pokazujemy tak, jak go podała bramka.
const POWODY_WOO = {
  'konto w trybie tylko odczyt': 'klucz sklepu tylko do odczytu',
  'konto spoza listy kont Woo': 'sklep nie jest połączony',
};
const POWODY_ALLEGRO = {
  'oferty wstrzymane': 'oferty wstrzymane na koncie — włącz je w ustawieniach Allegro',
  'konto spoza listy kont Allegro': 'konto Allegro nie jest połączone',
};

const ODPYTANIE_MS = 15000;
const PRZERWA_MS = 500;
const czekaj = (ms) => new Promise((r) => setTimeout(r, ms));
const komunikatZadania = (t) =>
  t?.message || (t?.errors ?? []).map((e) => e?.userMessage || e?.message).find(Boolean) || 'Allegro odmówiło.';
const naWierszRejestru = (o) => ({
  ...o,
  status_z_oms: o.statusZOms ? 1 : 0,
  cena_z_oms: o.cenaZOms ? 1 : 0,
  ilosc_z_oms: o.iloscZOms ? 1 : 0,
});

/**
 * @param {object} opcje
 * @param {import('node:sqlite').DatabaseSync} opcje.db
 * @param {readonly {klucz:string;typ?:string}[]} opcje.definicje
 * @param {Record<string, any>} [opcje.sklepy] — klienci Woo po kluczu kanału
 * @param {() => readonly any[]} [opcje.kontaAllegro]
 */
export function createStatusWKanale({ db, definicje, sklepy = {}, kontaAllegro = () => [] }) {
  const rodzaj = (kanal) => {
    const klucz = rodzajKanalu(kanal, definicje)?.klucz;
    if (!klucz || !Object.hasOwn(STATUSY_KANALOW, klucz)) return null;
    return modulKanalu(klucz).umiejetnosci?.statusZOms ? klucz : null;
  };
  const kluczeRodzaju = (klucz) => Object.keys(sklepy).filter((k) => rodzajKanalu(k, definicje)?.klucz === klucz);
  const liczbaWariantow = (p) =>
    Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ? AND COALESCE(wariant_id, '') <> ''`,
        )
        .get(p.kanal, p.produkt_id).n,
    );

  const bramkaWoo = (p) => {
    const klient = sklepy[p.kanal];
    const konto = klient ? { klucz: p.kanal, tylkoOdczyt: () => klient.tylkoOdczyt === true } : null;
    const b = bramkaZapisuWoo({
      konto,
      klucze: kluczeRodzaju('woo'),
      produkt: p,
      kartaId: p.karta_id,
      zakres: 'status',
    });
    return b.wolno ? { wolno: true, klient } : { wolno: false, powod: POWODY_WOO[b.powod] ?? b.powod };
  };
  // Oferta obserwowana bez wiersza rejestru dostanie go dopiero po zatwierdzeniu, więc pytamy bramkę o wiersz,
  // jaki wtedy powstanie — hamulec konta (wstrzymane, tylko odczyt) działa, zanim cokolwiek zapiszemy.
  const bramkaAllegro = (p, oferta) => {
    const konto = kontaAllegro().find((k) => k.klucz === p.kanal) ?? null;
    const wiersz = oferta
      ? { ...naWierszRejestru(oferta), status_z_oms: 1 }
      : { kanal: p.kanal, tryb: 'obserwowana', status_z_oms: 1 };
    const b = bramkaZapisu({
      konto,
      ustawienia: ustawieniaOfertKonta(db, p.kanal),
      oferta: wiersz,
      klucze: kontaAllegro().map((k) => k.klucz),
      kanal: 'Allegro',
      zakres: 'status',
    });
    return b.wolno ? { wolno: true, konto } : { wolno: false, powod: POWODY_ALLEGRO[b.powod] ?? b.powod };
  };

  const akcjaZMapy = (klucz, status) =>
    Object.entries(STATUSY_KANALOW[klucz].akcje).find(([, a]) => a.z === status) ?? null;
  const pasek = (kartaId, p, [nazwa, a], dopisek = '') => ({
    klucz: nazwa,
    napis: a.napis,
    potwierdz: a.potwierdz,
    pytanie: dopisek ? `${a.pytanie} ${dopisek}` : a.pytanie,
    adres: `/magazyn/${kartaId}/status-kanalu`,
    pola: { produktId: String(p.id), akcja: nazwa },
  });

  // Akcja jednego wiersza po rodzaju kanału: { akcja, powodBlokady }.
  const AKCJE_WIERSZA = {
    woo(p, kartaId) {
      if (p.zniknal_at) return { akcja: null, powodBlokady: null };
      const wpis = akcjaZMapy('woo', p.status_publikacji);
      if (!wpis) return { akcja: null, powodBlokady: null };
      const n = p.wariant_id ? liczbaWariantow(p) : 0;
      const dopisek = n > 0 ? `Zmieni się cały produkt z ${n} ${n === 1 ? 'wariantem' : 'wariantami'}.` : '';
      const b = bramkaWoo(p);
      return { akcja: pasek(kartaId, p, wpis, dopisek), powodBlokady: b.wolno ? null : b.powod };
    },
    allegro(p, kartaId, oferty) {
      const o = oferty.find((x) => x.kanal === p.kanal && x.idZewnetrzne === p.produkt_id) ?? null;
      // Zarządzaną ofertą rządzą istniejące „Zdejmij” i „Wznów” — ta sama kolejka i te same warunki co w sekcji ofert.
      if (o?.tryb === 'zarzadzana') {
        const konto = kontaAllegro().find((k) => k.klucz === o.kanal);
        const [klucz, a] = o.zdejmij
          ? [
              'zakoncz',
              { ...STATUSY_KANALOW.allegro.akcje.zakoncz, adres: `/magazyn/${kartaId}/oferty/${o.id}/zdejmij` },
            ]
          : konto && konto.zgoda !== false && mozeWznowic(o)
            ? ['wznow', { ...STATUSY_KANALOW.allegro.akcje.wznow, adres: `/magazyn/problemy-ofert/${o.id}/wznow` }]
            : [null, null];
        if (!klucz) return { akcja: null, powodBlokady: null };
        return {
          akcja: { klucz, napis: a.napis, potwierdz: a.potwierdz, pytanie: a.pytanie, adres: a.adres, pola: {} },
          powodBlokady: null,
        };
      }
      const wpis = akcjaZMapy('allegro', p.status_publikacji);
      if (!wpis) return { akcja: null, powodBlokady: null };
      const b = bramkaAllegro(p, o);
      return { akcja: pasek(kartaId, p, wpis), powodBlokady: b.wolno ? null : b.powod };
    },
  };

  /** Model komórki Status: plakietka zawsze, akcja tylko dla admina. */
  function model(p, { admin = false, kartaId, oferty = [], komunikat = null } = {}) {
    const klucz = rodzaj(p.kanal);
    if (!klucz) return { ...BRAK, akcja: null, powodBlokady: null, komunikat };
    const [plakietka, ton] = STATUSY_KANALOW[klucz].plakietki[p.status_publikacji] ?? [BRAK.plakietka, BRAK.ton];
    const { akcja, powodBlokady } = admin
      ? AKCJE_WIERSZA[klucz](p, kartaId, oferty)
      : { akcja: null, powodBlokady: null };
    return { plakietka, ton, akcja, powodBlokady, komunikat };
  }

  // Wykonanie po rodzaju kanału: { kod, stara, nowa, cel, wynik, blad, odmowa? }.
  const WYKONAJ = {
    async woo(p, a) {
      const b = bramkaWoo(p);
      if (!b.wolno) return { odmowa: b.powod };
      const cel = `produkt:${p.produkt_id}`;
      try {
        await b.klient.ustawStatusProduktu(p.produkt_id, a.cel);
        const odczyt = await b.klient.pobierzProdukt(`products/${p.produkt_id}`);
        const jest = typeof odczyt?.status === 'string' ? odczyt.status : null;
        if (jest) ustawStatusPublikacji(db, p.kanal, p.produkt_id, jest);
        if (jest === a.cel) return { cel, wynik: 'ok' };
        return {
          cel,
          wynik: 'blad',
          blad: `Sklep nie zmienił statusu (w sklepie jest „${jest ?? 'nieznany'}”).`,
          kod: 409,
        };
      } catch (e) {
        return { cel, wynik: 'blad', blad: `Sklep odrzucił zmianę: ${e?.message ?? e}`, kod: 502 };
      }
    },
    async allegro(p, a, kartaId) {
      let o = ofertaPoIdZewnetrznym(db, p.kanal, p.produkt_id);
      if (o && (o.tryb === 'zarzadzana' || o.kartaId !== kartaId))
        return { odmowa: 'Tą ofertą zarządza OMS albo inna karta — użyj przycisków w sekcji ofert.' };
      const b = bramkaAllegro(p, o);
      if (!b.wolno) return { odmowa: b.powod };
      o ??= wstawOferte(db, {
        kartaId,
        kanal: p.kanal,
        idZewnetrzne: p.produkt_id,
        pochodzenie: 'przejeta',
        tryb: 'obserwowana',
        stan: p.status_publikacji === 'ACTIVE' ? 'aktywna' : 'nieaktywna',
      });
      if (!o.statusZOms) o = zmienOferte(db, o.id, { statusZOms: true }) ?? o;
      // Ten sam hamulec jeszcze raz na prawdziwym wierszu rejestru, tuż przed wysłaniem.
      const przed = bramkaZapisu({
        konto: b.konto,
        ustawienia: ustawieniaOfertKonta(db, p.kanal),
        oferta: naWierszRejestru(o),
        klucze: kontaAllegro().map((k) => k.klucz),
        kanal: 'Allegro',
        zakres: 'status',
      });
      if (!przed.wolno) return { odmowa: POWODY_ALLEGRO[przed.powod] ?? przed.powod };
      const cel = `oferta:${p.produkt_id}`;
      try {
        const klient = b.konto.klient;
        const komenda = randomUUID();
        await klient.komendaPublikacji(komenda, [p.produkt_id], a.komenda);
        let zadanie = null;
        for (const koniec = Date.now() + ODPYTANIE_MS; ;) {
          zadanie = (await klient.wynikKomendy('publikacja', komenda)).find(
            (t) => String(t?.offer?.id) === p.produkt_id && ['SUCCESS', 'FAIL'].includes(t?.status),
          );
          if (zadanie || Date.now() >= koniec) break;
          await czekaj(PRZERWA_MS);
        }
        const odczyt = await klient.pobierzOferte(p.produkt_id);
        const jest = typeof odczyt?.publication?.status === 'string' ? odczyt.publication.status : null;
        if (jest) ustawStatusPublikacji(db, p.kanal, p.produkt_id, jest);
        if (!zadanie)
          return {
            cel,
            wynik: 'w_toku',
            blad: 'Allegro jeszcze przetwarza zmianę — sprawdź status za chwilę.',
            kod: 202,
          };
        if (zadanie.status === 'FAIL') return { cel, wynik: 'blad', blad: komunikatZadania(zadanie), kod: 409 };
        if (jest === a.cel) return { cel, wynik: 'ok' };
        return { cel, wynik: 'blad', blad: `Allegro nie zmieniło statusu (jest „${jest ?? 'nieznany'}”).`, kod: 409 };
      } catch (e) {
        return { cel, wynik: 'blad', blad: `Allegro odrzuciło zmianę: ${e?.message ?? e}`, kod: 502 };
      }
    },
  };

  /** Zmiana statusu jednego wiersza lustra karty. */
  async function zmien({ karta, p, akcja, kto }) {
    const klucz = rodzaj(p.kanal);
    const a = klucz ? STATUSY_KANALOW[klucz].akcje[akcja] : null;
    if (!a || a.z !== p.status_publikacji) return { odmowa: 'Ten produkt nie pozwala teraz na tę zmianę statusu.' };
    // Produkt, którego ostatni odczyt już nie widział w kanale: zapis statusu mógłby go wskrzesić z kosza
    // albo opublikować coś, co sklep usunął. Ekran nie pokazuje przycisku, ale trasa musi odmówić sama.
    if (p.zniknal_at) return { odmowa: 'Tego produktu nie ma już w kanale — odśwież stany, zanim zmienisz status.' };
    const w = await WYKONAJ[klucz](p, a, karta.id);
    if (w.odmowa) return w;
    zapiszZmianeWKanale(db, {
      kanal: p.kanal,
      kartaId: karta.id,
      cel: w.cel,
      pole: 'status',
      stara: p.status_publikacji,
      nowa: a.cel,
      kto,
      at: new Date().toISOString(),
      wynik: w.wynik,
      blad: w.blad ?? null,
    });
    return w;
  }

  return { model, zmien, rodzaj };
}

/**
 * `POST /magazyn/:id/status-kanalu` — { produktId (wiersz lustra), akcja }. CSRF sprawdza wspólny hak panelu.
 * Odmowa przed zapisem to strona odmowy; wynik z kanału wraca na kartę z komunikatem w wierszu.
 */
export function registerStatusWKanale(app, { db, magazyn, statusy, ekranKarty, brakKarty, bezSklepow }) {
  app.post('/magazyn/:id/status-kanalu', async (req, reply) => {
    const odmowa = (kod, tekst) =>
      stronaOdmowy(reply, kod, tekst, {
        tytul: 'Nie zmieniono statusu w kanale',
        wroc: `/magazyn/${encodeURIComponent(req.params.id)}#produkty-karty`,
        napisWroc: 'Wróć do karty',
      });
    if (req.konto?.admin !== true) return odmowa(403, 'Tylko administrator może zmienić status produktu w kanale.');
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', bezSklepow);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    const akcja = typeof req.body?.akcja === 'string' ? req.body.akcja : '';
    const znane = Object.values(STATUSY_KANALOW).some((r) => Object.hasOwn(r.akcje, akcja));
    if (!znane) return odmowa(400, 'Nieznana zmiana statusu.');
    const id = Number(req.body?.produktId);
    const p = Number.isSafeInteger(id)
      ? db.prepare('SELECT * FROM produkty_sklepowe WHERE id = ? AND karta_id = ?').get(id, karta.id)
      : null;
    if (!p) return odmowa(404, 'Nie ma takiego produktu na tej karcie.');
    const w = await statusy.zmien({ karta, p, akcja, kto: String(req.konto?.login ?? 'panel') });
    if (w.odmowa) return odmowa(409, w.odmowa);
    if (w.wynik === 'ok') return reply.code(303).redirect(`/magazyn/${karta.id}#produkty-karty`);
    return ekranKarty(req, reply, {
      karta: kartaPoId(db, karta.id),
      kod: w.kod,
      bladStatusu: { produktId: p.id, tekst: w.blad },
    });
  });
}
