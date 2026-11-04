import { chceFakture, daneFaktury } from './dane-faktury.js';
import { brakiAdresuNabywcy, zdanieBrakuAdresu } from './adres-nabywcy-faktury.js';
import { odmianaNazwyProgramu, ekranProgramu } from './nazwa-programu.js';

// Dostępność na karcie BEZ faktury. POST zachowuje własne zabezpieczenia i rezerwację.
export function wystawienieFaktury(z, { mozliwaFaktura, mozeAdres, dlaKazdego, program, zdanieBraku, zrodloProgramu,
  okresyWlaczone, fakturaOkresuIstnieje, mozeFaktury, nazwaOkresu }) {
  const nie = (powod, odnosnik = null, poOdnosniku = '') => ({ mozna: false, powod, odnosnik, poOdnosniku });
  if (z.anulowane) return nie('Zamówienie jest anulowane — aby wystawić fakturę, najpierw wyjaśnij anulowanie zamówienia.');
  if (z.okres_rozliczeniowy_id) {
    if (fakturaOkresuIstnieje) return mozeFaktury
      ? nie('Faktura za okres jest już wystawiona — do KSeF wysyłasz ją z zakładki ', { href: '/faktury', tekst: 'Faktury' }, '.')
      : nie('Faktura za okres jest już wystawiona — do KSeF wysyłasz ją z zakładki Faktury.');
    return okresyWlaczone
      ? nie('Zamówienie rozlicza się fakturą zbiorczą — otwórz ',
        { href: `/okresy/${z.okres_rozliczeniowy_id}`, tekst: `okres ${nazwaOkresu}` }, ', aby wystawić fakturę za cały okres.')
      : nie('Zamówienie rozlicza się fakturą zbiorczą — administrator może włączyć Rozliczenia w Ustawienia → Moduły, aby wystawić fakturę za okres.');
  }
  const nazwa = odmianaNazwyProgramu(program);
  if (!mozliwaFaktura) {
    if (zdanieBraku) return nie(zrodloProgramu === 'plik' ? zdanieBraku
      : `${zdanieBraku} Administrator może włączyć program w Ustawienia → Integracje → Moduł faktur.`);
    return nie(`${nazwa.mianownik} nie jest skonfigurowany — administrator może skonfigurować program w `,
      { href: ekranProgramu(program), tekst: `Ustawienia → Integracje → ${nazwa.mianownik}` }, '.');
  }
  if (!mozeAdres) return nie('Twoje konto nie ma prawa wystawiać faktur — poproś administratora o dostęp do wystawiania faktur.');
  if (!chceFakture(z) && !dlaKazdego) return nie('Klient nie prosił o fakturę. Administrator może to włączyć w Ustawienia → Faktury („faktura także bez prośby klienta”)'
    + (program?.opis?.wbudowany === true ? `; przy ${nazwa.miejscownik} najpierw „Faktury konsumenckie w KSeF”.` : '.'));
  // PRZ-126.PT5: ta sama reguła co odmowa serwera (faktura-odmowa.js), sprawdzana ostatnia.
  const braki = brakiAdresuNabywcy(daneFaktury(z));
  if (braki.length) return nie(`Brak adresu nabywcy (${zdanieBrakuAdresu(braki)}) — `,
    { href: '#dane-faktury', tekst: 'uzupełnij dane do faktury' }, '.');
  return { mozna: true, powod: null };
}
