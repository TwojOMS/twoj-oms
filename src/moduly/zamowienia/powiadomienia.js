import { kluczDozwolony } from '../../domena/ostrzezenia.js';
import { maDostepDoEkranu } from '../../domena/ekrany.js';
import { RODZAJE_OSTRZEZEN, rodzajeDlaKonta } from '../../domena/powiadomienia.js';
import { odrzuc } from '../../oms/db/ostrzezenia.js';
import { powiadomieniaKonta, oznaczPrzeczytane, oznaczWszystkiePrzeczytane } from '../../oms/db/powiadomienia.js';
import { bezpiecznyPowrot } from '../../core/bezpieczenstwo/powrot.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { ktoKlikal } from './wspolne.js';
import { dzienWarszawa } from '../../domena/format-daty.js';

const STRONA = '/powiadomienia';
const NA_STRONE_ARCHIWUM = 50;
const NAZWY_RODZAJOW = new Map(RODZAJE_OSTRZEZEN.map((r) => [r.typ, r.nazwa]));

const adresStrony = (widok, rodzaj, strona) => {
  const q = new URLSearchParams();
  if (widok === 'archiwum') q.set('widok', 'archiwum');
  if (rodzaj) q.set('rodzaj', rodzaj);
  if (strona > 1) q.set('strona', String(strona));
  const s = q.toString();
  return s ? `${STRONA}?${s}` : STRONA;
};

const dzien = (iso) => (iso ? dzienWarszawa(iso) : '');

/**
 * Dokąd wrócić po akcji na powiadomieniu. Pole przychodzi z formularza, więc przepuszczamy wyłącznie ścieżkę
 * lokalną; wszystko inne (brak, `//obcy`, `/\obcy`, pełny adres) prowadzi na stronę powiadomień, a nie na
 * listę zamówień — tam człowiek klikał.
 */
export function powrotPowiadomien(surowa) {
  const t = String(surowa ?? '').trim();
  const bezpieczny = bezpiecznyPowrot(t);
  return bezpieczny === '/' && t !== '/' ? STRONA : bezpieczny;
}

// Martwego kanału nie da się zignorować — to brak nowych zamówień, nie sprawa do odłożenia.
const nieDoIgnorowania = (klucz) => klucz.startsWith('kanal:') && klucz.endsWith(':pilne');

/**
 * @param {any} app
 * @param {{ db: any, przelicz?: (() => Promise<unknown>) | null }} zaleznosci
 */
export function registerPowiadomieniaRoutes(app, { db, przelicz = null }) {
  app.get(STRONA, async (req, reply) => {
    const widok = req.query?.widok === 'archiwum' ? 'archiwum' : 'aktualne';
    // Ta sama reguła co odczyt: niski stan tylko z prawem do Magazynu, więc filtr nie oferuje rodzaju bez wierszy.
    const rodzaje = rodzajeDlaKonta(req.konto).filter(
      (r) => r.typ !== 'niski-stan' || !req.konto || maDostepDoEkranu(req.konto, 'magazyn'),
    );
    // Rodzaj spoza listy konta (też obcy ciąg z adresu) znaczy „wszystkie”, a nie pustą stronę.
    const rodzaj = rodzaje.some((r) => r.typ === req.query?.rodzaj) ? String(req.query.rodzaj) : '';
    const { aktualne, archiwum } = powiadomieniaKonta(db, req.konto);
    const filtruj = (w) => !rodzaj || w.typ === rodzaj;
    const nazwa = (w) => ({ ...w, nazwaRodzaju: NAZWY_RODZAJOW.get(w.typ) ?? w.typ });
    let wiersze;
    let stronicowanie = null;
    if (widok === 'archiwum') {
      const wszystkie = archiwum.filter(filtruj);
      const stron = Math.max(1, Math.ceil(wszystkie.length / NA_STRONE_ARCHIWUM));
      const strona = Math.min(Math.max(1, Number.parseInt(String(req.query?.strona), 10) || 1), stron);
      wiersze = wszystkie.slice((strona - 1) * NA_STRONE_ARCHIWUM, strona * NA_STRONE_ARCHIWUM).map((w) => ({
        ...nazwa(w),
        statusTekst:
          w.status === 'rozwiazane'
            ? `Rozwiązane ${dzien(w.statusAt)}`
            : w.status === 'wyciszone'
              ? `Wyciszone do ${dzien(w.statusAt)}`
              : `Zignorowane przez ${w.statusKto ?? 'nieznane konto'} ${dzien(w.statusAt)}`,
      }));
      if (stron > 1)
        stronicowanie = {
          strona,
          stron,
          lacznie: wszystkie.length,
          poprzednia: strona > 1 ? adresStrony(widok, rodzaj, strona - 1) : null,
          nastepna: strona < stron ? adresStrony(widok, rodzaj, strona + 1) : null,
        };
    } else {
      wiersze = aktualne.filter(filtruj).map(nazwa);
    }
    return reply.view('powiadomienia.ejs', {
      title: 'Powiadomienia',
      szerokosc: 'tabela',
      widok,
      rodzaj,
      rodzaje: rodzaje.map((r) => ({ typ: r.typ, nazwa: r.nazwa })),
      liczbaAktualnych: aktualne.length,
      wiersze,
      stronicowanie,
      adresAktualne: adresStrony('aktualne', rodzaj, 1),
      adresArchiwum: adresStrony('archiwum', rodzaj, 1),
      // Formularze wracają dokładnie tu, gdzie człowiek był (zakładka, filtr, strona).
      powrot: adresStrony(widok, rodzaj, stronicowanie?.strona ?? 1),
    });
  });

  app.post('/ostrzezenia/odrzuc', async (req, reply) => {
    const klucz = typeof req.body?.klucz === 'string' ? req.body.klucz : null;
    // „Ignoruj” jest wspólne dla firmy, więc przyjmujemy tylko sprawę, którą to konto widzi — inaczej sprzedawca
    // mógłby schować administratorowi cudzą awarię. Sprawę, której migawka jeszcze nie zna (zegar liczy co minutę,
    // a lista zamówień pokazuje ją od razu), najpierw przeliczamy; zgadywanie po prefiksie klucza pozwalałoby
    // z góry ukryć przewidywalny klucz cudzej sprawy.
    const widzi = () => {
      const { aktualne, archiwum } = powiadomieniaKonta(db, req.konto);
      return [...aktualne, ...archiwum].some((w) => w.klucz === klucz);
    };
    const odmowa = () =>
      stronaOdmowy(reply, 400, 'Nieznany klucz ostrzeżenia.', {
        tytul: 'Nie udało się ukryć ostrzeżenia',
        napisWroc: 'Wróć do listy zamówień',
      });
    if (!kluczDozwolony(klucz) || nieDoIgnorowania(klucz)) return odmowa();
    if (!widzi()) {
      try {
        await przelicz?.();
      } catch (e) {
        req.log?.error?.(e, 'przeliczenie powiadomień przed „Ignoruj” nie powiodło się');
      }
      if (!widzi()) return odmowa();
    }
    odrzuc(db, klucz, { kto: req.konto?.login ?? ktoKlikal(req) });
    // Migawka czyta „Ignoruj” przy następnym przebiegu; przeliczamy od razu, żeby dzwonek nie czekał na zegar.
    // Błąd przeliczenia nie cofa decyzji — zapis już jest, zegar policzy później.
    try {
      await przelicz?.();
    } catch (e) {
      req.log?.error?.(e, 'przeliczenie powiadomień po „Ignoruj” nie powiodło się');
    }
    return reply.redirect(powrotPowiadomien(req.body?.powrot), 303);
  });

  app.post('/powiadomienia/przeczytane', async (req, reply) => {
    const kontoId = req.konto?.id;
    if (req.body?.wszystkie === '1') oznaczWszystkiePrzeczytane(db, req.konto);
    else if (typeof req.body?.klucz === 'string') {
      // Tylko powiadomienie, które konto widzi — inaczej zapis śladu o sprawie spoza jego praw.
      const widoczne = powiadomieniaKonta(db, req.konto, { archiwum: false }).aktualne;
      if (widoczne.some((w) => w.klucz === req.body.klucz)) oznaczPrzeczytane(db, kontoId, req.body.klucz);
    }
    return reply.redirect(powrotPowiadomien(req.body?.powrot), 303);
  });

  app.post('/powiadomienia/:klucz/otworz', async (req, reply) => {
    const klucz = String(req.params?.klucz ?? '');
    const { aktualne, archiwum } = powiadomieniaKonta(db, req.konto);
    const wiersz = [...aktualne, ...archiwum].find((w) => w.klucz === klucz);
    if (!wiersz) return reply.redirect(STRONA, 303);
    oznaczPrzeczytane(db, req.konto?.id, klucz);
    const href = wiersz.przycisk?.href ?? null;
    // Adres z migawki pisze reguła, ale idzie do nagłówka `Location` — ta sama bramka co przy powrocie.
    const cel = href && bezpiecznyPowrot(href) === href ? href : STRONA;
    return reply.redirect(cel, 303);
  });
}
