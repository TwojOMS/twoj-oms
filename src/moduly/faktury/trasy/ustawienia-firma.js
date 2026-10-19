import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
// PRZ-093.08: Ustawienia → Firma. Sprzedawca na proformie, specyfikacji i potwierdzeniu wywozu oraz nadawca
// paczek DPD z Ustawień. Dla instalacji bez DPD_NADAWCA_* w pliku konfiguracji (Twój OMS u obcej firmy).
//
// Zasady jak w PRZ-092 (kurier DPD): plik WYGRYWA — gdy adres stoi w pliku, ekran go tylko pokazuje, a zapis = 409
// (instalacje z plikiem, w tym produkcja właściciela, bez zmian). Zmiana działa od następnego dokumentu i następnej
// paczki, bez restartu (źródło czytane przy każdym użyciu: src/oms/db/adres-firmy.js).
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
import { sprawdzFormularzFirmy, EKRAN_ADRESU_FIRMY } from '../../../domena/adres-firmy.js';
import { wczytajZapisAdresuFirmy, zapiszAdresFirmy, usunAdresFirmy } from '../../../oms/db/adres-firmy.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

const KOMUNIKATY = {
  zapisano: 'Zapisano adres firmy. Następna proforma, specyfikacja i paczka DPD wyjdą z tym adresem.',
  usunieto: 'Usunięto adres zapisany na ekranie.',
};
const PUSTY = { nazwa: '', ulica: '', kod: '', miasto: '', kraj: 'PL', telefon: '', email: '' };

export function registerUstawieniaFirmyRoutes(app, { db, adresFirmy }) {
  function widok(req, reply, { wpisane = null, bledy = [] } = {}) {
    const zapis = wczytajZapisAdresuFirmy(db);
    return reply.view('ustawienia-firma.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(req.url),
      wPliku: adresFirmy.wPliku, zPliku: adresFirmy.zPliku, zapis,
      pola: { ...PUSTY, ...(zapis?.ustawienia ?? {}), ...(wpisane ?? {}) },
      bledy, zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  }

  app.get(EKRAN_ADRESU_FIRMY, async (req, reply) => widok(req, reply));

  app.post(EKRAN_ADRESU_FIRMY, async (req, reply) => {
    if (adresFirmy.wPliku) {
      return reply.code(409).type('text/plain; charset=utf-8')
        .send('Adres firmy jest ustawiony w pliku konfiguracji (DPD_NADAWCA_… w oms.env) — tam go zmień. Formularz niczego nie zapisał.');
    }
    const { ustawienia, bledy } = sprawdzFormularzFirmy(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisane: ustawienia, bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszAdresFirmy(db, ustawienia, { konto });
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=zapisano`);
  });

  // Działa także przy adresie w pliku: zapis z ekranu sprzed dopisania adresu do pliku musi dać się usunąć.
  app.post(`${EKRAN_ADRESU_FIRMY}/usun`, async (_req, reply) => {
    usunAdresFirmy(db);
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=usunieto`);
  });
}
