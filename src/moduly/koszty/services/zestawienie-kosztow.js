import { PDFDocument } from 'pdf-lib';
import { bladOperatora } from '../../../domena/bledy.js';
import { zakresMiesiaca } from '../../../domena/lista-faktur.js';
import { zlozZestawienieKosztow } from '../../../domena/paczka-dla-biura.js';
import { kosztyOtrzymaneWMiesiacu, odrzuconeWMiesiacu } from '../../../oms/db/koszty.js';
import { zbudujZestawieniePdf } from '../pdf/zestawienie-dla-biura-pdf.js';

// Zestawienie KOSZTÓW miesiąca jako PDF (PRZ-086) — przycisk na zakładce KOSZTY. Dwie osobne
// części na jednym wydruku: faktury kosztowe z KSeF i faktury dopisane ręcznie.
//
// ⚠️ WYŁĄCZNIE LISTA, BEZ DOŁĄCZONYCH DOKUMENTÓW — tak samo jak zestawienie przychodów na FAKTURACH
// (decyzja z 14.09.2026: „jedno wejście do PDF”, bez paczki z fakturami). Dzięki temu usługa
// czyta TYLKO BAZĘ: nie woła KSeF (limity 16/min i 64/h), nie woła inFaktu i działa także
// w panelu bez sekcji KSEF_*. Pełna paczka z dokumentami zostaje pod `GET /faktury/paczka?czesc=koszty`.
//
// ⚠️ KRYTERIUM MIESIĄCA JEST TO Z PACZKI, nie z ekranu: `kosztyOtrzymaneWMiesiacu` (KSeF — dzień
// otrzymania, ręczne — data wystawienia), bo to zestawienie idzie do biura. Ekran KOSZTY liczy po
// dacie wystawienia, więc na granicy miesiąca (faktura wystawiona 31.07, odebrana 02.08) obie
// liczby mogą się różnić — wydruk mówi o tym w metryczce i w Uwagach przy wierszu.

const TYTUL = 'Zestawienie kosztów';

export function createZestawienieKosztow({
  db, teraz = () => new Date(), zbudujPdf = zbudujZestawieniePdf,
}) {
  async function zbuduj(miesiac) {
    if (!zakresMiesiaca(miesiac)) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
    const z = zlozZestawienieKosztow({
      miesiac,
      koszty: kosztyOtrzymaneWMiesiacu(db, miesiac),
      kwarantanna: odrzuconeWMiesiacu(db, miesiac),
    });
    const wygenerowano = teraz().toISOString();
    const liczbaDokumentow = z.ksef.length + z.reczne.length;
    const zestaw = (liczbaStron) => zbudujPdf({
      // `paczka` niesie to, co zestawienie czyta niezależnie od podziału na części:
      // miesiąc i ostrzeżenia; wiersze i sumy idą przez `sekcje`.
      paczka: { miesiac, ostrzezenia: z.ostrzezenia, sumy: {} },
      czesc: 'koszty',
      wygenerowano,
      liczbaStron,
      liczbaDokumentow,
      tytul: TYTUL,
      zrodlo: 'KSeF i faktury dopisane ręcznie',
      sekcje: [
        {
          naglowek: `Faktury kosztowe z KSeF (${z.ksef.length})`,
          wiersze: z.ksef,
          sumy: z.sumy.ksef,
          pusto: 'Brak faktur kosztowych z KSeF w tym miesiącu.',
          etykietaSum: 'KSeF',
        },
        {
          naglowek: `Faktury dopisane ręcznie (${z.reczne.length})`,
          // Zdanie o oryginałach tylko wtedy, gdy jest czego dołączać.
          opis: z.reczne.length > 0 ? z.opisRecznych : null,
          wiersze: z.reczne,
          sumy: z.sumy.reczne,
          pusto: 'Brak faktur dopisanych ręcznie w tym miesiącu.',
          etykietaSum: 'ręczne',
        },
      ],
      sumyRazem: z.sumy.razem,
    });
    // ⚠️ DWA PRZEBIEGI jak w paczce: stopka niesie liczbę stron całego pliku, której nie da się
    // znać przed złożeniem. Pierwszy przebieg jest pomiarem, drugi rysuje z prawdziwą liczbą.
    const proba = await PDFDocument.load(await zestaw(0));
    const stron = proba.getPageCount();
    const wynik = await PDFDocument.load(await zestaw(stron));
    if (stron !== wynik.getPageCount()) {
      throw bladOperatora(`Nie udało się przygotować zestawienia: liczba stron w stopce (${stron}) nie zgadza się z plikiem (${wynik.getPageCount()}).`);
    }
    // Tytuł dokumentu („Zestawienie kosztów — sierpień 2026”) ustawia sam rysunek PDF-a —
    // nie dotykamy go tutaj (zestawienie przychodów miało takiego buga: `setTitle` zjadał miesiąc).
    return {
      bajty: Buffer.from(await wynik.save()),
      nazwa: `zestawienie-kosztow-${miesiac}.pdf`,
      ksef: z.ksef.length,
      reczne: z.reczne.length,
      stron,
    };
  }
  return { zbuduj };
}
