// Magazyn → Producenci (/magazyn/producenci): jeden ekran producentów (GPSR) i marek kart. Producenci — nazwa,
// adres pocztowy, e-mail albo strona www; dodanie, edycja, usunięcie (odmowa, gdy producent ma marki albo jest
// domyślny), producent domyślny. Marki — słownik z liczbą kart, przypisanie producenta, mapowanie Allegro, dodanie,
// zmiana nazwy (przepisuje karty), usunięcie tylko bez kart. Marki nie mają własnej strony, bo producenta karty
// wskazuje jej marka — człowiek ustawia jedno i drugie w jednym miejscu. POST-y marek zostają pod /magazyn/marki/…,
// żeby nie zmieniać adresów akcji ani uprawnień; stary adres strony przekierowuje tutaj na stałe (zakładki).
// Reguły pól są w domenie (walidujProducenta), zapis w db/producenci.js — tu tylko formularze.
// Uprawnienie: ekran „magazyn” (prefiks /magazyn), jak Kategorie.
import { kolumnaAllegro } from './kategorie-allegro-trasy.js';
import { liczbaKart } from './slowniki.js';
import {
  listaSlownika,
  dodajDoSlownika,
  zmienNazwe,
  usunZeSlownika,
  czystaNazwa,
  wTransakcji,
} from './services/slowniki-kart.js';
import {
  listaProducentow,
  producentPoId,
  dodajProducenta,
  zmienProducenta,
  usunProducenta,
  ustawDomyslnego,
  przypiszMarki,
  przypisaniaMarek,
} from '../../oms/db/producenci.js';
import { LIMITY_PRODUCENTA, KRAJE_PRODUCENTA, opisProducenta } from '../../domena/producenci.js';

const ADRES = '/magazyn/producenci';

const KOMUNIKATY = Object.freeze({
  dodano: 'Dodano producenta.',
  zmieniono: 'Zapisano zmiany producenta.',
  usunieto: 'Usunięto producenta.',
  domyslny: 'Zapisano producenta domyślnego.',
  marki: 'Zapisano przypisania marek.',
});

// Komunikaty sekcji Marki — stoją przy tabeli marek, bo przekierowanie wraca do kotwicy #marki.
const KOMUNIKATY_MAREK = Object.freeze({
  'marka-dodana': 'Dodano markę.',
  'marka-zmieniona': 'Zmieniono nazwę marki.',
  'marka-usunieta': 'Usunięto markę.',
});
const ADRES_MAREK = '/magazyn/marki';
const PUSTA_MARKA = Object.freeze({ wartosci: { nazwa: '', producent: '' }, bledy: {} });

const PUSTY = Object.freeze({ nazwa: '', ulica: '', kod: '', miasto: '', kraj: 'PL', email: '', www: '' });

// Pole formularza jako tekst — pole podane dwa razy (tablica) traktujemy jak puste, walidacja je odrzuci.
const pole = (w) => (typeof w === 'string' ? w : '');
const id = (w) => (typeof w === 'string' && /^\d{1,9}$/.test(w) ? Number(w) : null);
// Jedno pole formularza przychodzi jako tekst, powtórzone — jako tablica.
const lista = (w) => (Array.isArray(w) ? w : w === undefined ? [] : [w]);
// Producent sprzed adresu w polach ma je puste (NULL) — formularz zmiany pokazuje wtedy dawny adres jednym tekstem,
// żeby człowiek mógł go przepisać; rozdzielać tekstu na pola za niego nie próbujemy.
const dotychczasowy = (p) => (p && p.ulica == null ? opisProducenta({ adres: p.adres }) : null);

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: any, kontaAllegro?: () => any[] }} opcje
 */
export function registerProducenciMagazynu(app, { db, kontaAllegro = () => [] }) {
  /**
   * `formularz` — producent do dodania albo edycji (pokazany, gdy podany albo gdy producentów nie ma);
   * `formularzMarki` — nowa marka (pokazana tylko, gdy podana); `bladMarek`/`komunikatMarek` — w sekcji Marki.
   */
  function ekran(
    reply,
    {
      kod = 200,
      blad = null,
      komunikat = null,
      formularz = null,
      formularzMarki = null,
      bladMarek = null,
      komunikatMarek = null,
    } = {},
  ) {
    const producenci = listaProducentow(db);
    const przypisania = przypisaniaMarek(db);
    const { pozycje, bez } = listaSlownika(db, 'marki');
    const marki = pozycje.map((p) => ({ ...p, producentId: przypisania.get(p.nazwa) ?? null }));
    return reply.code(kod).view('magazyn-producenci.ejs', {
      title: 'Magazyn — producenci',
      szerokosc: 'tabela',
      producenci,
      domyslny: producenci.find((p) => p.domyslny) ?? null,
      marki,
      bezMarki: bez,
      blad,
      komunikat,
      bladMarek,
      komunikatMarek,
      // Formularz: dodanie (bez id) albo edycja; `bledy` przy polach, `wartosci` — to, co wpisał człowiek.
      pokazFormularz: formularz !== null || !producenci.length,
      formularz: formularz ?? { id: null, wartosci: PUSTY, bledy: {} },
      formularzMarki,
      limity: LIMITY_PRODUCENTA,
      kraje: KRAJE_PRODUCENTA,
      adresJednaLinia: (p) => opisProducenta({ adres: p.adres }),
      adresFiltra: (nazwa) => `/magazyn?marka=${encodeURIComponent(nazwa)}`,
      // Kolumna „Allegro” (przypisanie na środowisko; null = brak konta i mapowań).
      allegro: kolumnaAllegro(db, 'marki', kontaAllegro),
    });
  }

  const wpisane = (body) => ({
    nazwa: pole(body?.nazwa),
    ulica: pole(body?.ulica),
    kod: pole(body?.kod),
    miasto: pole(body?.miasto),
    kraj: pole(body?.kraj).trim().toUpperCase() || 'PL',
    email: pole(body?.email),
    www: pole(body?.www),
  });

  app.get(ADRES, async (req, reply) => {
    const q = req.query ?? {};
    if (q.edytuj !== undefined) {
      const p = id(q.edytuj) === null ? null : producentPoId(db, id(q.edytuj));
      if (!p) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
      const wartosci = {
        nazwa: p.nazwa,
        ulica: p.ulica ?? '',
        kod: p.kod_pocztowy ?? '',
        miasto: p.miasto ?? '',
        kraj: p.kraj ?? 'PL',
        email: p.email ?? '',
        www: p.www ?? '',
      };
      return ekran(reply, { formularz: { id: p.id, wartosci, bledy: {}, dotychczasowy: dotychczasowy(p) } });
    }
    return ekran(reply, {
      komunikat: KOMUNIKATY[q.ok] ?? null,
      komunikatMarek: KOMUNIKATY_MAREK[q.ok] ?? null,
      formularz: q.dodaj === 'producent' ? { id: null, wartosci: PUSTY, bledy: {} } : null,
      formularzMarki: q.dodaj === 'marka' ? PUSTA_MARKA : null,
    });
  });

  app.post(`${ADRES}/dodaj`, async (req, reply) => {
    const wynik = dodajProducenta(db, req.body ?? {});
    if (!wynik.ok) {
      return ekran(reply, { kod: 400, formularz: { id: null, wartosci: wpisane(req.body), bledy: wynik.bledy } });
    }
    return reply.code(303).redirect(`${ADRES}?ok=dodano`);
  });

  app.post(`${ADRES}/:id/zmien`, async (req, reply) => {
    const nr = id(req.params.id);
    const p = nr === null ? null : producentPoId(db, nr);
    if (!p) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
    const wynik = zmienProducenta(db, nr, req.body ?? {});
    if (wynik.blad) return ekran(reply, { kod: 404, blad: wynik.blad });
    if (!wynik.ok) {
      const formularz = { id: nr, wartosci: wpisane(req.body), bledy: wynik.bledy, dotychczasowy: dotychczasowy(p) };
      return ekran(reply, { kod: 400, formularz });
    }
    return reply.code(303).redirect(`${ADRES}?ok=zmieniono`);
  });

  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const nr = id(req.params.id);
    if (nr === null || !producentPoId(db, nr)) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
    const wynik = usunProducenta(db, nr);
    if (wynik.blad) return ekran(reply, { kod: 409, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=usunieto`);
  });

  app.post(`${ADRES}/domyslny`, async (req, reply) => {
    const wybor = pole(req.body?.producent);
    const wynik = ustawDomyslnego(db, wybor === '' ? null : (id(wybor) ?? -1));
    if (wynik.blad) return ekran(reply, { kod: 400, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=domyslny`);
  });

  app.post(`${ADRES}/marki`, async (req, reply) => {
    const marki = lista(req.body?.marka);
    const wybory = lista(req.body?.producent);
    // Pary marka–producent idą w kolejności pól; różna liczba oznacza uszkodzony formularz — nic nie zapisujemy.
    if (marki.length !== wybory.length || [...marki, ...wybory].some((w) => typeof w !== 'string')) {
      return ekran(reply, { kod: 400, blad: 'Formularz przypisań jest niepełny. Odśwież stronę i zapisz ponownie.' });
    }
    const zmiany = marki.map((marka, i) => ({
      marka,
      producentId: wybory[i] === '' ? null : (id(wybory[i]) ?? -1),
    }));
    const wynik = przypiszMarki(db, zmiany);
    if (wynik.blad) return ekran(reply, { kod: 400, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=marki#marki`);
  });

  // Stara strona Marek — zakładki w przeglądarkach prowadzą teraz do sekcji Marki.
  app.get(ADRES_MAREK, async (req, reply) => reply.code(301).redirect(`${ADRES}#marki`));

  app.post(`${ADRES_MAREK}/dodaj`, async (req, reply) => {
    const wartosci = { nazwa: pole(req.body?.nazwa), producent: pole(req.body?.producent) };
    const nazwa = czystaNazwa(wartosci.nazwa);
    const producentId = wartosci.producent === '' ? null : id(wartosci.producent);
    const bledy = {};
    if (!nazwa) bledy.nazwa = 'Podaj nazwę marki.';
    if (wartosci.producent !== '' && (producentId === null || !producentPoId(db, producentId))) {
      bledy.producent = 'Nie ma takiego producenta. Wybierz producenta z listy.';
    }
    if (Object.keys(bledy).length) return ekran(reply, { kod: 400, formularzMarki: { wartosci, bledy } });
    // Słownik i przypisanie razem: marka nie zostaje bez producenta, którego człowiek wybrał.
    wTransakcji(db, () => {
      dodajDoSlownika(db, 'marki', nazwa);
      if (producentId === null) return;
      const wynik = przypiszMarki(db, [{ marka: nazwa, producentId }]);
      if (wynik.blad) throw new Error(wynik.blad);
    });
    return reply.code(303).redirect(`${ADRES}?ok=marka-dodana#marki`);
  });

  app.post(`${ADRES_MAREK}/zmien`, async (req, reply) => {
    const wynik = zmienNazwe(db, 'marki', req.body?.stara, req.body?.nowa);
    if (wynik.blad) return ekran(reply, { kod: 400, bladMarek: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=marka-zmieniona#marki`);
  });

  app.post(`${ADRES_MAREK}/usun`, async (req, reply) => {
    const wynik = usunZeSlownika(db, 'marki', req.body?.nazwa);
    if (wynik.blad) return ekran(reply, { kod: 400, bladMarek: wynik.blad });
    if (wynik.karty > 0) {
      const nazwa = czystaNazwa(req.body?.nazwa);
      return ekran(reply, {
        kod: 409,
        bladMarek: `Nie można usunąć „${nazwa}” — ma ${liczbaKart(wynik.karty)}. Najpierw zmień markę na tych kartach albo zmień nazwę (scali je z inną).`,
      });
    }
    return reply.code(303).redirect(`${ADRES}?ok=marka-usunieta#marki`);
  });
}
