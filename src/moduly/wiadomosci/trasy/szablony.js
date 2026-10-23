// PRZ-101.03: Ustawienia → Szablony wiadomości — edycja czterech maili wbudowanych i szablony własne.
//
// Kto może: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia"; gościa demo
// w podglądzie zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js). CSRF sprawdza wspólny hak
// (core/bezpieczenstwo/csrf.js). Tu nie powtarzamy żadnej z tych blokad.
//
// PRG: zapis → 303 na ekran edycji; odmowa → 400 z wpisaną treścią i powodem (nic nie ginie).
// „Podgląd" to GET z treścią w adresie — niczego nie zapisuje, działa też u gościa demo.
import {
  WBUDOWANE, KONTA, MAKS, NOWY_WLASNY, polaSzablonu, rodzajSzablonu, sprawdzSzablon, szablonDoEdycji, zapiszSzablon, usunSzablon,
} from '../../../domena/szablony-wiadomosci.js';
import { wczytajSzablonyWiadomosci, zmienSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { podgladSzablonu } from '../szablony.js';
import {
  wczytajZapisaneZdania, zdaniaPlatnosciTeraz, zapiszZdaniaPlatnosci, przywrocZdanie, zdaniaDoEkranu,
} from '../zdania-platnosci.js';
import { MAKS_ZDAN } from '../../../domena/zdania-platnosci.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { regulyUzywajaceSzablonu } from '../../automatyzacje/db/reguly.js';
import { maDostepDoAdresu } from '../../../domena/ekrany.js';

const ADRES = '/ustawienia/szablony-wiadomosci';
// PRZ-102.17: sekcja „Zdania o płatności" na liście szablonów. Trasy statyczne — find-my-way stawia je przed `/:id`,
// a żaden szablon nie ma id „zdania-platnosci" (wbudowane mają stałe nazwy, własne `wlasny-N`).
const ZDANIA_ADRES = `${ADRES}/zdania-platnosci`;

const KOMUNIKATY = {
  przywrocono: 'Przywrócono treść domyślną.',
  usunieto: 'Szablon usunięty. Wysłane nim wiadomości zostają w historii zamówień.',
  zdania: 'Zapisano zdania i etykiety. Następny mail pójdzie z tą treścią.',
  'zdanie-przywrocone': 'Przywrócono zdanie domyślne.',
};

export function registerSzablonyWiadomosciRoutes(app, { db, oprawa, config = {}, teraz = () => new Date() }) {
  // Podstrony edycji świecą w menu tą samą pozycją, co lista (podmenu zna wyłącznie adres listy).
  const nawigacja = (req, reply) => nawigacjaUstawien({ url: ADRES, konto: req.konto }, reply);
  // Wąski skład bez modułu automatyzacji może mieć bazę zachowaną z wcześniejszego uruchomienia.
  const regulySzablonu = id => app.hasRoute({ method: 'GET', url: '/ustawienia/automatyzacje/:id' })
    ? regulyUzywajaceSzablonu(db, id) : [];

  /** Szablon pod adresem albo `null` (nieznany id, usunięty szablon własny). */
  function szablonPod(id) {
    if (id === 'nowy') return { ...NOWY_WLASNY, id: 'nowy', rodzaj: 'wlasny', wbudowany: false, nowy: true };
    return szablonDoEdycji(wczytajSzablonyWiadomosci(db), id);
  }

  function ekranEdycji(req, reply, s, { formularz = null, blad = null, podglad = null } = {}) {
    return reply.view('ustawienia-szablon.ejs', {
      nawigacja: nawigacja(req, reply),
      title: s.nowy ? 'Nowy szablon wiadomości' : `Szablon: ${s.nazwa}`,
      s, f: formularz ?? { nazwa: s.nazwa ?? '', temat: s.temat, tresc: s.tresc },
      pola: polaSzablonu(s.rodzaj), maks: MAKS, blad, podglad,
      reguly: !s.wbudowany && !s.nowy ? regulySzablonu(s.id).map(r => ({ ...r,
        // Dziennik reguły ma dodatkową ochronę admina; gość demo może go tylko oglądać.
        adres: (req.konto?.admin || req.konto?.podgladDemo)
          && maDostepDoAdresu(req.konto, `/ustawienia/automatyzacje/${r.id}`) ? `/ustawienia/automatyzacje/${r.id}` : null,
      })) : [],
      zapisano: req.query?.zapisano === '1' ? 'Zapisano. Następny mail pójdzie z tą treścią.' : null,
    });
  }

  function ekranListy(req, reply, { wpisane = null, bledy = {} } = {}) {
    const stan = wczytajSzablonyWiadomosci(db);
    const reguly = req.query?.zapisano === 'usunieto' && rodzajSzablonu(req.query?.usunietySzablon) === 'wlasny'
      ? regulySzablonu(req.query.usunietySzablon) : [];
    const ostrzezenie = reguly.length ? ` Reguły ${reguly.map(r => r.nazwa).join(', ')} mają teraz usunięty szablon.` : '';
    return reply.view('ustawienia-szablony.ejs', {
      nawigacja: nawigacja(req, reply),
      title: 'Szablony wiadomości',
      wbudowane: WBUDOWANE.map((id) => szablonDoEdycji(stan, id)),
      // PRZ-101.06: maile do pracowników — osobna sekcja, żeby nikt nie pomylił ich z mailami do klientów.
      zespol: KONTA.map((id) => szablonDoEdycji(stan, id)),
      wlasne: stan.wlasne, maks: MAKS,
      komunikat: wpisane ? null : ((KOMUNIKATY[req.query?.zapisano] ?? '') + ostrzezenie || null),
      zdania: zdaniaDoEkranu(wczytajZapisaneZdania(db), { wpisane, bledy }),
      maksZdan: MAKS_ZDAN,
      bladZdan: Object.keys(bledy).length ? (bledy._ ?? 'Popraw zaznaczone zdania — nic nie zostało zapisane.') : null,
    });
  }

  app.get(ADRES, async (req, reply) => ekranListy(req, reply));

  // PRZ-102.17: zapis wszystkich zdań naraz (wszystkie albo żadne). Odmowa → 400 z wpisanymi tekstami i powodem przy
  // polu. Prawo „ustawienia" sprawdza strażnik po prefiksie `/ustawienia`, CSRF — wspólny hak.
  app.post(ZDANIA_ADRES, async (req, reply) => {
    const pola = req.body ?? {};
    const wynik = zapiszZdaniaPlatnosci(db, pola, teraz().toISOString());
    if (wynik.kod !== 303) {
      reply.code(400);
      return ekranListy(req, reply, { wpisane: pola, bledy: wynik.bledy });
    }
    return reply.code(303).redirect(`${ADRES}?zapisano=zdania#zdania-platnosci`);
  });

  app.post(`${ZDANIA_ADRES}/:klucz/przywroc`, async (req, reply) => {
    if (!przywrocZdanie(db, String(req.params.klucz), teraz().toISOString())) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Nie ma takiego zdania.');
    }
    return reply.code(303).redirect(`${ADRES}?zapisano=zdanie-przywrocone#zdania-platnosci`);
  });

  app.get(`${ADRES}/:id`, async (req, reply) => {
    const s = szablonPod(String(req.params.id));
    if (!s) return reply.code(404).type('text/plain; charset=utf-8').send('Nie ma takiego szablonu — mógł zostać usunięty.');
    if (req.query?.podglad === undefined) return ekranEdycji(req, reply, s);

    const formularz = {
      nazwa: String(req.query.nazwa ?? s.nazwa ?? ''), temat: String(req.query.temat ?? ''), tresc: String(req.query.tresc ?? ''),
    };
    const sprawdzony = sprawdzSzablon(s.rodzaj, formularz);
    if (!sprawdzony.ok) return ekranEdycji(req, reply, s, { formularz, blad: sprawdzony.blad });
    return ekranEdycji(req, reply, s, { formularz, podglad: podgladSzablonu(s.id, sprawdzony.szablon, {
      oprawa: typeof oprawa === 'function' ? oprawa() : oprawa, config, teraz: teraz(), zdania: zdaniaPlatnosciTeraz(db),
    }) });
  });

  app.post(`${ADRES}/:id`, async (req, reply) => {
    const id = String(req.params.id);
    const s = szablonPod(id);
    if (!s) return reply.code(404).type('text/plain; charset=utf-8').send('Nie ma takiego szablonu — mógł zostać usunięty.');
    const pola = req.body ?? {};
    const formularz = { nazwa: String(pola.nazwa ?? ''), temat: String(pola.temat ?? ''), tresc: String(pola.tresc ?? '') };
    const wynik = zmienSzablonyWiadomosci(db, (stan) => zapiszSzablon(stan, id, formularz, teraz().toISOString()));
    if (!wynik.ok) {
      reply.code(400);
      return ekranEdycji(req, reply, s, { formularz, blad: wynik.blad });
    }
    return reply.code(303).redirect(`${ADRES}/${encodeURIComponent(wynik.id)}?zapisano=1`);
  });

  // Wbudowany: „Przywróć domyślny" (kasuje zapis — mail wraca do treści dostarczonej z panelem).
  // Własny: „Usuń". Jedna trasa, bo w obu wypadkach znika wpis z zapisu.
  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const id = String(req.params.id);
    const s = szablonPod(id);
    const reguly = s && !s.wbudowany && !s.nowy ? regulySzablonu(id) : [];
    if (reguly.length && req.body?.potwierdzUsuniecie !== '1') {
      reply.code(400);
      return ekranEdycji(req, reply, s, { blad: 'Potwierdź, że reguły przestaną wysyłać ten mail.' });
    }
    const wynik = zmienSzablonyWiadomosci(db, (stan) => usunSzablon(stan, id));
    if (!wynik.ok) return reply.code(404).type('text/plain; charset=utf-8').send(wynik.blad);
    const zaleznosci = reguly.length ? `&usunietySzablon=${encodeURIComponent(id)}` : '';
    return reply.code(303).redirect(`${ADRES}?zapisano=${rodzajSzablonu(id) === 'wlasny' ? 'usunieto' : 'przywrocono'}${zaleznosci}`);
  });
}
