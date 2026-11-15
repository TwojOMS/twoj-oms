import { cenaZNarzutem } from './cena-kanalu.js';
import { poprawneSekcje, sekcjeDlaErli } from './opis-sekcje.js';
import { dobierzCennik, regulyKonta } from './cennik-dostaw.js';

// Stawka panelu (E2.01: STAWKI_Z_ZW) → wyliczenie ERLI; nieznana stawka nie może trafić do paczki (D9).
const STAWKI_ERLI = { '23': 'TAX_23', '8': 'TAX_8', '5': 'TAX_5', '0': 'TAX_0', zw: 'TAX_ZW' };
const ROZSZERZENIA = new Set(['jpg', 'png', 'webp']);
// D27: włączyć dopiero po potwierdzeniu w sandboxie ERLI.
export const WYSYLAJ_AI_ERLI = false;

/** E4.06: ilość czeka na stan magazynu (brak-stanu, niezatwierdzone) — nie blokuje treści; brak stałej nadal tak. */
export const bezIlosciKanalu = ilosc => ilosc != null && ilosc.ilosc == null && ilosc.powod !== 'brak-stalej';
export const OSTRZEZENIE_BRAK_STANU = 'Stan karty nie jest znany — ilość czeka na stan magazynu; oferta dostanie cenę i treść bez ilości.';

function napis(wartosc) {
  return typeof wartosc === 'string' ? wartosc.trim() : '';
}

// P2 nie rozstrzygnął mapowania kategorii. Kształt kategorii i atrybutu
// trzymamy razem, aby ewentualna korekta kontraktu dotyczyła jednego miejsca.
function klasyfikacja(karta, allegro) {
  const id = napis(allegro?.kategoria_id);
  const kategoria = napis(karta.kategoria_glowna);
  return {
    externalCategories: id
      ? [{ source: 'allegro', breadcrumb: [{ id }] }]
      : kategoria ? [{ source: 'shop', breadcrumb: [{ id: kategoria, name: kategoria }] }] : [],
    externalAttributes: [{ id: '11323', source: 'allegro', values: [{ id: '11323_1' }] }],
  };
}

/** Ciało POST produktu ERLI; dane i ustawienia dostarcza wywołujący. */
export function produktErliZKarty(wejscie) {
  const { karta = {}, ustawienia = {}, zdjecia = [], allegro, adresPublicznyZdjec, wysylajAi = WYSYLAJ_AI_ERLI, ilosc } = wejscie;
  const bledy = [];
  const ostrzezenia = [];
  const name = napis(karta.nazwa);
  if (name.length < 3 || name.length > 150) bledy.push('Ustaw nazwę produktu o długości od 3 do 150 znaków na karcie.');

  let description;
  if (karta.opis == null || (Array.isArray(karta.opis.sekcje) && karta.opis.sekcje.length === 0)) {
    ostrzezenia.push('Produkt nie ma opisu — uzupełnij opis na karcie.');
  } else {
    const walidacja = poprawneSekcje(karta.opis);
    if (!walidacja.ok) bledy.push(`Popraw opis na karcie: ${walidacja.bledy.join(' ')}`);
    else description = sekcjeDlaErli(karta.opis);
  }

  const images = [];
  const bazaZdjec = napis(adresPublicznyZdjec).replace(/\/+$/, '');
  if (!zdjecia.length) bledy.push('Dodaj co najmniej jedno zdjęcie na karcie produktu.');
  for (const [indeks, zdjecie] of zdjecia.entries()) {
    const znacznik = wysylajAi && zdjecie.ai === 1 ? { aiGenerated: true } : {};
    const zrodlo = napis(zdjecie.adres_zrodlowy);
    if (zrodlo) images.push({ url: zrodlo, ...znacznik });
    else if (!/^[0-9a-f]{64}$/.test(zdjecie.sha256 ?? '') || !ROZSZERZENIA.has(zdjecie.rozszerzenie)) {
      bledy.push(`Zdjęcie ${indeks + 1} ma niepoprawny skrót albo rozszerzenie — wgraj je ponownie na karcie.`);
    } else if (bazaZdjec && !/^https?:\/\//.test(bazaZdjec)) {
      bledy.push('Publiczny adres zdjęć (OMS_PUBLICZNY_ADRES_ZDJEC) musi zaczynać się od https:// lub http://.');
    } else if (bazaZdjec) images.push({ url: `${bazaZdjec}/z/${zdjecie.sha256}.${zdjecie.rozszerzenie}`, ...znacznik });
    else bledy.push(`Zdjęcie ${indeks + 1} jest tylko w OMS-ie. Ustaw publiczny adres zdjęć (OMS_PUBLICZNY_ADRES_ZDJEC) w konfiguracji instalacji.`);
  }

  const cena = cenaZNarzutem(karta.cena_gr, ustawienia.narzutBp);
  if (cena.bledy.includes('cena')) bledy.push('Ustaw cenę brutto większą od zera na karcie, w całkowitej liczbie groszy.');
  if (cena.bledy.includes('narzut')) bledy.push('Ustaw nieujemny, całkowity narzut w punktach bazowych w konfiguratorze konta ERLI.');
  if (cena.bledy.includes('zakres')) bledy.push('Cena z narzutem przekracza bezpieczny zakres — zmniejsz cenę lub narzut.');
  const price = cena.grosze ?? undefined;

  // E4.06 (D47): `ilosc` = wynik iloscDlaKanalu; null (poza „brak-stalej”) → treść i cena bez pola ilości.
  const bezIlosci = bezIlosciKanalu(ilosc);
  const stock = ilosc ? ilosc.ilosc : ustawienia.stalaIlosc;
  if (!bezIlosci && (!Number.isSafeInteger(stock) || stock < 0)) bledy.push('Ustaw stałą liczbę sztuk w konfiguratorze konta ERLI (całkowitą, nieujemną).');
  if (ilosc?.powod === 'brak-stanu') ostrzezenia.push(OSTRZEZENIE_BRAK_STANU);
  const period = ustawienia.czasWysylkiDni;
  if (!Number.isSafeInteger(period) || period < 0) bledy.push('Ustaw czas wysyłki w dniach w konfiguratorze konta ERLI.');
  // Cennik dobrany do rozmiaru (E3d.02, D5–D6): wyjątek na karcie, reguły konta albo jeden cennik.
  const dostawa = dobierzCennik({ karta, reguly: regulyKonta(ustawienia), wyjatek: wejscie.wyjatekCennika });
  const deliveryPriceList = dostawa.cennik ?? '';
  if (dostawa.odmowa?.kod === 'brak-wymiarow') bledy.push(dostawa.odmowa.tekst);
  else if (!deliveryPriceList) bledy.push('Ustaw cennik dostaw w konfiguratorze konta ERLI.');
  const vat = napis(karta.stawka_vat) || napis(ustawienia.stawkaVat);
  const taxRate = Object.hasOwn(STAWKI_ERLI, vat.toLowerCase()) ? STAWKI_ERLI[vat.toLowerCase()] : undefined;
  if (!vat) bledy.push('Ustaw stawkę VAT na karcie lub w konfiguratorze konta ERLI.');
  else if (!taxRate) bledy.push(`Stawka VAT „${vat}” nie jest obsługiwana w ERLI — ustaw 23, 8, 5, 0 albo zw.`);

  const klasy = klasyfikacja(karta, allegro);
  if (!klasy.externalCategories.length) ostrzezenia.push('ERLI nie przypisze kategorii — przypisz ją w panelu ERLI.');
  const grupa = napis(karta.grupa_wariantow);
  return {
    bledy, ostrzezenia, dostawa,
    zadanie: bledy.length ? null : {
      name, ...(description ? { description } : {}), images, price, ...(bezIlosci ? {} : { stock }),
      dispatchTime: { period, unit: 'day' }, deliveryPriceList, taxRate,
      status: 'inactive', ...klasy,
      ...(grupa ? { externalVariantGroup: grupa } : {}),
    },
  };
}
