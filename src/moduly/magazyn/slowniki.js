// Strony słowników Magazynu: Kategorie (/magazyn/kategorie) i Marki (/magazyn/marki).
// Lista płaska z liczbą kart (odnośnik do filtra listy Magazynu), dodanie, zmiana nazwy (przepisuje karty
// w jednej transakcji), usunięcie tylko bez kart. Kategorie można też pobrać z połączenia WooCommerce
// (tylko odczyt sklepu). Uprawnienie: ekran „magazyn” — to samo, co edycja karty (prefiks /magazyn).
import { kolumnaAllegro } from './kategorie-allegro-trasy.js';
import {
  listaSlownika, dodajDoSlownika, zmienNazwe, usunZeSlownika, scalKategorieWoo, czystaNazwa,
} from './services/slowniki-kart.js';

const STRONY = Object.freeze({
  kategorie: Object.freeze({
    typ: 'kategorie', tytul: 'Kategorie', adres: '/magazyn/kategorie', filtr: 'kategoria', bez: 'Bez kategorii',
    podtytul: 'Kategorie główne kart produktów — do wyboru na karcie i do filtra listy Magazynu',
    pusto: 'Nie ma jeszcze żadnej kategorii.', jedna: 'kategorię',
  }),
  marki: Object.freeze({
    typ: 'marki', tytul: 'Marki', adres: '/magazyn/marki', filtr: 'marka', bez: 'Bez marki',
    podtytul: 'Marki kart produktów — do wyboru na karcie i do filtra listy Magazynu',
    pusto: 'Nie ma jeszcze żadnej marki.', jedna: 'markę',
  }),
});

const KOMUNIKATY = Object.freeze({ dodano: 'Dodano.', zmieniono: 'Zmieniono nazwę.', usunieto: 'Usunięto.' });

/** „1 kartę”, „2 karty”, „5 kart” — po polsku. */
function karty(n) {
  const d = n % 10;
  const s = n % 100;
  if (n === 1) return '1 kartę';
  if (d >= 2 && d <= 4 && (s < 12 || s > 14)) return `${n} karty`;
  return `${n} kart`;
}

const liczba = wartosc => (typeof wartosc === 'string' && /^\d{1,6}$/.test(wartosc) ? Number(wartosc) : null);

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: any, sklepy?: Record<string, any>, definicje?: () => readonly { klucz: string, typ?: string, etykieta?: string }[], kontaAllegro?: () => any[] }} opcje
 */
export function registerSlownikiMagazynu(app, { db, sklepy = {}, definicje = () => [], kontaAllegro = () => [] }) {
  // Połączenia, których klient umie czytać kategorie produktów (dziś WooCommerce); etykieta z konfiguracji.
  const polaczeniaWoo = () => (definicje() ?? [])
    .filter(d => typeof sklepy?.[d.klucz]?.pobierzKategorieProduktow === 'function')
    .map(d => ({ klucz: d.klucz, etykieta: d.etykieta ?? d.klucz }));

  function ekran(req, reply, strona, { kod = 200, blad = null, komunikat = null } = {}) {
    const { pozycje, bez } = listaSlownika(db, strona.typ);
    return reply.code(kod).view('magazyn-slownik.ejs', {
      title: `Magazyn — ${strona.tytul.toLowerCase()}`, szerokosc: 'tabela', strona, pozycje, bez, blad, komunikat,
      woo: strona.typ === 'kategorie' ? polaczeniaWoo() : [],
      adresFiltra: nazwa => `/magazyn?${strona.filtr}=${encodeURIComponent(nazwa)}`,
      adresBez: `/magazyn?brak=${strona.filtr}`,
      // Kolumna „Allegro” (przypisanie na środowisko; null = brak konta i mapowań).
      allegro: kolumnaAllegro(db, strona.typ, kontaAllegro),
    });
  }

  for (const strona of Object.values(STRONY)) {
    app.get(strona.adres, async (req, reply) => {
      const q = req.query ?? {};
      const dodano = liczba(q.dodano);
      const bylo = liczba(q.bylo);
      const woo = polaczeniaWoo().find(p => p.klucz === q.kanal);
      let komunikat = KOMUNIKATY[q.ok] ?? null;
      if (strona.typ === 'kategorie' && dodano !== null && bylo !== null) {
        komunikat = `Pobrano kategorie${woo ? ` z „${woo.etykieta}”` : ''}: dodano ${dodano}, było już ${bylo}.`;
      }
      return ekran(req, reply, strona, { komunikat });
    });

    app.post(`${strona.adres}/dodaj`, async (req, reply) => {
      const nazwa = czystaNazwa(req.body?.nazwa);
      if (!nazwa) return ekran(req, reply, strona, { kod: 400, blad: 'Podaj nazwę.' });
      dodajDoSlownika(db, strona.typ, nazwa);
      return reply.code(303).redirect(`${strona.adres}?ok=dodano`);
    });

    app.post(`${strona.adres}/zmien`, async (req, reply) => {
      const wynik = zmienNazwe(db, strona.typ, req.body?.stara, req.body?.nowa);
      if (wynik.blad) return ekran(req, reply, strona, { kod: 400, blad: wynik.blad });
      return reply.code(303).redirect(`${strona.adres}?ok=zmieniono`);
    });

    app.post(`${strona.adres}/usun`, async (req, reply) => {
      const wynik = usunZeSlownika(db, strona.typ, req.body?.nazwa);
      if (wynik.blad) return ekran(req, reply, strona, { kod: 400, blad: wynik.blad });
      if (wynik.karty > 0) {
        const nazwa = czystaNazwa(req.body?.nazwa);
        return ekran(req, reply, strona, { kod: 409,
          blad: `Nie można usunąć „${nazwa}” — ma ${karty(wynik.karty)}. Najpierw zmień ${strona.jedna} na tych kartach albo zmień nazwę (scali je z inną).` });
      }
      return reply.code(303).redirect(`${strona.adres}?ok=usunieto`);
    });
  }

  app.post('/magazyn/kategorie/pobierz-woo', async (req, reply) => {
    const strona = STRONY.kategorie;
    const kanal = typeof req.body?.kanal === 'string' ? req.body.kanal : '';
    const polaczenie = polaczeniaWoo().find(p => p.klucz === kanal);
    if (!polaczenie) return ekran(req, reply, strona, { kod: 400, blad: 'To połączenie nie jest sklepem WooCommerce z dostępem do kategorii.' });
    let lista;
    try {
      lista = await sklepy[kanal].pobierzKategorieProduktow();
    } catch {
      // Treść błędu klienta może nieść adres z kluczami — nie pokazujemy jej na ekranie.
      return ekran(req, reply, strona, { kod: 502,
        blad: `Nie udało się pobrać kategorii z „${polaczenie.etykieta}”. Sprawdź połączenie w Ustawieniach i spróbuj ponownie.` });
    }
    const { dodano, bylo } = scalKategorieWoo(db, kanal, lista);
    return reply.code(303).redirect(`${strona.adres}?kanal=${encodeURIComponent(kanal)}&dodano=${dodano}&bylo=${bylo}`);
  });
}
