// PRZ-102.09: Finanse → Kompletność danych — daty, od których raporty mają pełne dane, ustawiane w panelu.
//
// Dostęp: strażnik po prefiksie `/finanse` wpuszcza tylko konto z uprawnieniem „finanse”, gościa demo zatrzymuje
// na każdym POST-cie. Zapis tylko administrator — reszta widzi wartości i prośbę do administratora.
// Plik konfiguracji wygrywa (jak kurier DPD w PRZ-092): ekran pokazuje wartość i skąd pochodzi, zapis daje 409.
import { POLA_POKRYCIA, konfiguracjaZPokryciem, zapiszPokrycie } from '../pokrycie.js';

const ADRES = '/finanse/pokrycie';
// Formularz z ekranu odmowy Finansów wraca tam, skąd przyszedł — tylko na /finanse, nigdy pod obcy adres.
const powrotFinansow = (p) => (typeof p === 'string' && /^\/finanse(\?[^\s\\]*)?$/.test(p) ? p : null);

export function zarejestrujTrasyPokrycia(app, { db, config }) {
  const biezaca = konfiguracjaZPokryciem(db, config);
  const widok = (req, reply, blad = null) => reply.view('finanse-pokrycie.ejs', {
    title: 'Kompletność danych', admin: req.konto?.admin === true, blad,
    zapisano: req.query?.zapisano === '1',
    pola: POLA_POKRYCIA.map(p => ({ ...p, zPliku: config[p.klucz] != null, wartosc: biezaca[p.klucz] ?? '' })),
  });
  app.get(ADRES, async (req, reply) => widok(req, reply));
  app.post(ADRES, async (req, reply) => {
    if (req.konto?.admin !== true) return reply.code(403).type('text/plain; charset=utf-8')
      .send('Daty kompletności danych zapisuje administrator. Poproś go o ustawienie.');
    const wynik = zapiszPokrycie(db, config, req.body?.klucz, req.body?.wartosc);
    if (wynik.blad) return widok(req, reply.code(wynik.kod), wynik.blad);
    return reply.code(303).redirect(powrotFinansow(req.body?.powrot) ?? `${ADRES}?zapisano=1`);
  });
}
