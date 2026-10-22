import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
// PRZ-093.08: Ustawienia → Firma. Sprzedawca na proformie, specyfikacji i potwierdzeniu wywozu oraz nadawca
// paczek DPD z Ustawień. Dla instalacji bez DPD_NADAWCA_* w pliku konfiguracji (Twój OMS u obcej firmy).
//
// Zasady jak w PRZ-092 (kurier DPD): plik WYGRYWA — gdy adres stoi w pliku, ekran go tylko pokazuje, a zapis = 409
// (instalacje z plikiem, w tym produkcja właściciela, bez zmian). Zmiana działa od następnego dokumentu i następnej
// paczki, bez restartu (źródło czytane przy każdym użyciu: src/oms/db/adres-firmy.js).
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
//
// PRZ-102.20: na tym samym ekranie rachunek bankowy i bank (maile o płatności, proforma, IBAN pobrania WzA). Decyzja
// właściciela: zapisuje WYŁĄCZNIE administrator (403 dla reszty kont z dostępem do Ustawień), bez dodatkowych bezpieczników.
// Plik (OMS_RACHUNEK / OMS_BANK) wygrywa w całości: ekran pokazuje wartość z pliku, zapis = 409. Osobny wiersz
// w konfiguracja_integracji — formularz adresu i jego usunięcie rachunku nie ruszają.
import { sprawdzFormularzFirmy, EKRAN_ADRESU_FIRMY } from '../../../domena/adres-firmy.js';
import { wczytajZapisAdresuFirmy, zapiszAdresFirmy, usunAdresFirmy } from '../../../oms/db/adres-firmy.js';
import { sprawdzFormularzRachunku, ZAPIS_RACHUNKU_FIRMY, rachunekDoOdczytu } from '../../../domena/rachunek-firmy.js';
import { wczytajZapisRachunkuFirmy, zapiszRachunekFirmy, usunRachunekFirmy } from '../../../oms/db/rachunek-firmy.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
// PRZ-108.10: NIP i BDO sprzedawcy — zapisuje tylko administrator; plik wygrywa DLA SWOJEGO POLA (OMS_SPRZEDAWCA_NIP /
// OMS_SPRZEDAWCA_BDO): ekran pokazuje wartość z pliku, zapis tego pola = 409. Dwa wiersze w konfiguracja_integracji.
import { sprawdzFormularzNip, sprawdzFormularzBdo, ZAPIS_NIP_FIRMY, ZAPIS_BDO_FIRMY } from '../../../domena/nip-bdo-firmy.js';
import { wczytajZapisNipuFirmy, wczytajZapisBdoFirmy, zapiszNipFirmy, zapiszBdoFirmy, usunBdoFirmy } from '../../../oms/db/nip-bdo-firmy.js';
// PRZ-105: domyślna stawka VAT — zapisuje tylko administrator (ta sama zasada co rachunek), lista 23/8/5/0.
import { czytajStawkeDomyslna, zapiszStawkeDomyslna } from '../db/stawka-vat.js';
import { STAWKI_VAT, czyStawkaVat } from '../../../domena/vat.js';

const ZAPIS_STAWKI = '/ustawienia/firma/stawka-vat';

const KOMUNIKATY = {
  zapisano: 'Zapisano adres firmy. Następna proforma, specyfikacja i paczka DPD wyjdą z tym adresem.',
  usunieto: 'Usunięto adres zapisany na ekranie.',
  rachunek: 'Zapisano rachunek firmy. Następny mail o płatności, proforma i paczka za pobraniem Allegro wyjdą z tym rachunkiem.',
  'rachunek-usuniety': 'Usunięto rachunek zapisany na ekranie.',
  'stawka-vat': 'Zapisano domyślną stawkę VAT. Działa od następnej pozycji i następnej faktury.',
  nip: 'Zapisano NIP firmy. Następna proforma, specyfikacja, potwierdzenie wywozu i faktura WDT wyjdą z tym NIP-em. Wystawione faktury i proformy zostają z poprzednim NIP-em; specyfikacja i potwierdzenie wywozu pobrane ponownie pokażą nowy.',
  bdo: 'Zapisano numer BDO. Następna specyfikacja wyjdzie z tym numerem.',
  'bdo-usuniety': 'Usunięto numer BDO zapisany na ekranie — specyfikacje wyjdą bez BDO.',
};
const TYLKO_ADMIN_NIP = 'NIP i BDO firmy zmienia tylko administrator. Formularz niczego nie zapisał.';
const NIP_W_PLIKU = 'NIP firmy jest ustawiony w pliku konfiguracji (OMS_SPRZEDAWCA_NIP w oms.env) — tam go zmień. Formularz niczego nie zapisał.';
const BDO_W_PLIKU = 'Numer BDO jest ustawiony w pliku konfiguracji (OMS_SPRZEDAWCA_BDO w oms.env) — tam go zmień. Formularz niczego nie zapisał.';
const TYLKO_ADMIN_STAWKA = 'Domyślną stawkę VAT zmienia tylko administrator. Formularz niczego nie zapisał.';
const PUSTY = { nazwa: '', ulica: '', kod: '', miasto: '', kraj: 'PL', telefon: '', email: '' };
const TYLKO_ADMIN = 'Rachunek firmy zmienia tylko administrator. Formularz niczego nie zapisał.';
const W_PLIKU = 'Rachunek firmy jest ustawiony w pliku konfiguracji (OMS_RACHUNEK / OMS_BANK w oms.env) — tam go zmień. Formularz niczego nie zapisał.';
const tekst = (reply, kod, tresc) => reply.code(kod).type('text/plain; charset=utf-8').send(tresc);

export function registerUstawieniaFirmyRoutes(app, { db, adresFirmy, rachunekFirmy, nipBdoFirmy }) {
  function widok(req, reply, { wpisane = null, bledy = [], wpisanyRachunek = null, bledyRachunku = [], bledyStawki = [],
    wpisanyNip = null, bledyNipu = [], wpisanyBdo = null, bledyBdo = [] } = {}) {
    const zapis = wczytajZapisAdresuFirmy(db);
    const zapisRachunku = wczytajZapisRachunkuFirmy(db);
    const zapisNipu = wczytajZapisNipuFirmy(db);
    const zapisBdo = wczytajZapisBdoFirmy(db);
    const biezace = nipBdoFirmy.biezacy();
    return reply.view('ustawienia-firma.ejs', {
      nipBdo: {
        nipWPliku: nipBdoFirmy.nipWPliku, bdoWPliku: nipBdoFirmy.bdoWPliku, zPliku: nipBdoFirmy.zPliku, biezace,
        zapisNipu, zapisBdo, mozeZmieniac: req.konto?.admin === true,
        pola: { nip: wpisanyNip ?? zapisNipu?.ustawienia?.nip ?? '', bdo: wpisanyBdo ?? zapisBdo?.ustawienia?.bdo ?? '' },
        bledyNipu, bledyBdo,
      },
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(req.url),
      wPliku: adresFirmy.wPliku, zPliku: adresFirmy.zPliku, zapis,
      pola: { ...PUSTY, ...(zapis?.ustawienia ?? {}), ...(wpisane ?? {}) },
      bledy, zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      rachunek: {
        wPliku: rachunekFirmy.wPliku, zPliku: rachunekFirmy.zPliku, zapis: zapisRachunku, biezacy: rachunekFirmy.biezacy(),
        mozeZmieniac: req.konto?.admin === true, odczyt: rachunekDoOdczytu,
        pola: { rachunek: '', bank: '', ...(zapisRachunku?.ustawienia ?? {}), ...(wpisanyRachunek ?? {}) },
        bledy: bledyRachunku,
      },
      stawkaVat: {
        biezaca: czytajStawkeDomyslna(db), stawki: STAWKI_VAT, mozeZmieniac: req.konto?.admin === true,
        zapis: ZAPIS_STAWKI, bledy: bledyStawki,
      },
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

  // PRZ-102.20: rachunek. Kolejność odmów: konto (403) → plik (409) → walidacja NRB (400, zdanie jak przy starcie).
  app.post(ZAPIS_RACHUNKU_FIRMY, async (req, reply) => {
    if (req.konto?.admin !== true) return tekst(reply, 403, TYLKO_ADMIN);
    if (rachunekFirmy.wPliku) return tekst(reply, 409, W_PLIKU);
    const { ustawienia, bledy } = sprawdzFormularzRachunku(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisanyRachunek: ustawienia, bledyRachunku: bledy });
    }
    const konto = { id: req.konto.id ?? null, login: req.konto.login ?? null };
    zapiszRachunekFirmy(db, ustawienia, { konto });
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=rachunek`);
  });

  // PRZ-105: kolejność odmów jak przy rachunku — konto (403) → wartość spoza listy (400, ekran z komunikatem).
  app.post(ZAPIS_STAWKI, async (req, reply) => {
    if (req.konto?.admin !== true) return tekst(reply, 403, TYLKO_ADMIN_STAWKA);
    const stawka = String(req.body?.stawka ?? '').trim();
    if (!czyStawkaVat(stawka)) {
      reply.code(400);
      return widok(req, reply, { bledyStawki: [`Wybierz jedną ze stawek: ${STAWKI_VAT.join(', ')}%.`] });
    }
    zapiszStawkeDomyslna(db, stawka);
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=stawka-vat`);
  });

  // PRZ-108.10: NIP. Kolejność odmów jak przy rachunku: konto (403) → pole w pliku (409) → walidacja (400, zdanie jak
  // przy starcie). Starych dokumentów nie ruszamy — nowy NIP działa od następnego dokumentu.
  app.post(ZAPIS_NIP_FIRMY, async (req, reply) => {
    if (req.konto?.admin !== true) return tekst(reply, 403, TYLKO_ADMIN_NIP);
    if (nipBdoFirmy.nipWPliku) return tekst(reply, 409, NIP_W_PLIKU);
    const { ustawienia, bledy } = sprawdzFormularzNip(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisanyNip: ustawienia.nip, bledyNipu: bledy });
    }
    zapiszNipFirmy(db, ustawienia.nip, { konto: { id: req.konto.id ?? null, login: req.konto.login ?? null } });
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=nip`);
  });

  // PRZ-108.10: BDO — pusty wpis znaczy „firma nie ma BDO” (wiersz z ekranu znika).
  app.post(ZAPIS_BDO_FIRMY, async (req, reply) => {
    if (req.konto?.admin !== true) return tekst(reply, 403, TYLKO_ADMIN_NIP);
    if (nipBdoFirmy.bdoWPliku) return tekst(reply, 409, BDO_W_PLIKU);
    const { ustawienia, bledy, wpisane } = sprawdzFormularzBdo(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisanyBdo: wpisane, bledyBdo: bledy });
    }
    if (!ustawienia.bdo) {
      usunBdoFirmy(db);
      return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=bdo-usuniety`);
    }
    zapiszBdoFirmy(db, ustawienia.bdo, { konto: { id: req.konto.id ?? null, login: req.konto.login ?? null } });
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=bdo`);
  });

  // Jak przy adresie: działa także przy rachunku w pliku (zapis sprzed dopisania do pliku musi dać się usunąć).
  app.post(`${ZAPIS_RACHUNKU_FIRMY}/usun`, async (req, reply) => {
    if (req.konto?.admin !== true) return tekst(reply, 403, TYLKO_ADMIN);
    usunRachunekFirmy(db);
    return reply.code(303).redirect(`${EKRAN_ADRESU_FIRMY}?zapisano=rachunek-usuniety`);
  });
}
