import { describe, it, expect } from 'vitest';
import { statusDlaAllegro, stanAllegroPotwierdzaZgodnosc, STATUS_ALLEGRO_DLA } from '../../src/domena/allegro-status.js';

// ⚠️ Minimalne zamówienie: `wyliczStatus` liczy status z FAKTÓW (przewodnik 4.1), a fakty
// dla „w realizacji" i „wysłane" ZAPISUJE CZŁOWIEK (`domain/status-reczny.js`): `w_realizacji_at`
// i `wyslane_at`. Zamówienie świeżo pobrane z Allegro nie ma ANI JEDNEGO z nich, więc jest
// „nowe" — i właśnie dlatego panel nie wysyła niczego, dopóki właściciel nie kliknie.
// ⚠️ Stan realizacji w Allegro NIE JEST polem zamówienia — idzie DRUGIM ARGUMENTEM, świeżo
// odczytany z Allegro (patrz ostrzeżenie na początku zadania). Kolumna `status_realizacji`
// celowo nie występuje w tej fikstrurze: gdyby reguła po nią sięgnęła, testy by tego nie
// zauważyły, a produkcja cofnęłaby status kupującemu.
const z = (nadpisania) => ({
  sklep: 'allegro_szkicownia', zrodlo_id: 'abc', kwota_brutto: '100.00',
  platnosci: [{ kwota: '100.00', zrodlo: 'sklep' }], przesylki: [], anulowane: 0,
  w_realizacji_at: '2026-08-05T09:00:00Z', ...nadpisania,
});

describe('statusDlaAllegro', () => {
  // ⚠️ TO JEST PIERWSZY KROK PRZEPŁYWU WŁAŚCICIELA. Zamówienie wpada z Allegro do OMS-u jako
  // „nowe" i panel ma wtedy NIE ODZYWAĆ SIĘ do Allegro w ogóle — `PROCESSING` jest zdaniem
  // „wziąłem się za to", a tego nikt jeszcze nie powiedział. Dopiero ręczna zmiana statusu
  // zapisuje `w_realizacji_at` i dopiero ona wyzwala wysyłkę.
  it('zamówienie w realizacji dostaje PROCESSING', () => {
    expect(statusDlaAllegro(z({}), 'NEW')).toBe('PROCESSING');
  });

  it('zamówienie wysłane dostaje SENT', () => {
    expect(statusDlaAllegro(z({ wyslane_at: '2026-08-05T12:00:00Z' }), 'PROCESSING')).toBe('SENT');
  });

  // ⚠️⚠️ SEDNO DECYZJI WŁAŚCICIELA: ODBICIE DZIAŁA W OBIE STRONY. „Wracam w OMS na NOWE →
  // w Allegro zmienia się na NOWE". Reguła „nigdy wstecz" (usunięta 05.08) blokowałaby
  // dokładnie te dwa przypadki — dlatego mają własny test, żeby nikt jej nie przywrócił
  // „dla bezpieczeństwa".
  it('COFNIĘCIE statusu w OMS cofa go TAKŻE w Allegro', () => {
    // OMS wrócił na „nowe", a Allegro stoi na PROCESSING → ma zejść na NEW.
    expect(statusDlaAllegro(z({ w_realizacji_at: null }), 'PROCESSING')).toBe('NEW');
    // OMS wrócił z „wysłane" na „w realizacji" (`status-reczny.js` kasuje wtedy `wyslane_at`).
    expect(statusDlaAllegro(z({}), 'SENT')).toBe('PROCESSING');
  });

  it('NIE wysyła stanu, który Allegro już ma', () => {
    expect(statusDlaAllegro(z({ w_realizacji_at: null }), 'NEW')).toBeNull();
    expect(statusDlaAllegro(z({}), 'PROCESSING')).toBeNull();
    expect(statusDlaAllegro(z({ wyslane_at: '2026-08-05T12:00:00Z' }), 'SENT')).toBeNull();
  });

  // Anulowanie i zwrot świadomie NIE JADĄ (`CANCELLED` nie jest u Allegro statusem realizacji).
  // ⚠️ Skutek: w Allegro zostaje ostatni wysłany status — jedyne miejsce, gdzie odbicie nie
  // jest wierne, i dlatego ma jawny test, a nie milczące przeoczenie.
  it('anulowane i zwrot nie wysyłają niczego', () => {
    expect(statusDlaAllegro(z({ anulowane: 1 }), 'PROCESSING')).toBeNull();
    expect(statusDlaAllegro(z({ zwrot_at: '2026-08-05T12:00:00Z' }), 'SENT')).toBeNull();
  });

  // Wartość, której nie znamy (`CANCELLED` z Allegro, cokolwiek dojdzie jutro), nie jest równa
  // temu, co chcemy wysłać — więc wysyłamy. To jest właściwe zachowanie przy odbiciu: panel ma
  // doprowadzić Allegro do stanu OMS-u, a nie zatrzymywać się przed nieznanym.
  it('nieznany stan w Allegro NIE blokuje odbicia', () => {
    expect(statusDlaAllegro(z({}), 'COS_NOWEGO')).toBe('PROCESSING');
  });

  // ⚠️⚠️ TEST, KTÓREGO BRAK KOSZTOWAŁBY COFNIĘTY STATUS U KUPUJĄCEGO. `null` znaczy „Allegro
  // nie ma statusu realizacji" i wolno wysyłać; `undefined` znaczy „NIE UDAŁO SIĘ ODCZYTAĆ"
  // i wysyłać NIE WOLNO. Jedna z tych wartości powstaje przy awarii odczytu — i gdyby obie
  // znaczyły to samo, awaria sieci wyglądałaby jak czyste zamówienie.
  it('BRAK ODCZYTU (undefined) blokuje, ale brak statusu (null) przepuszcza', () => {
    expect(statusDlaAllegro(z({}), undefined)).toBeNull();
    expect(statusDlaAllegro(z({}))).toBeNull();
    expect(statusDlaAllegro(z({}), null)).toBe('PROCESSING');
  });

  // ⚠️ Mapa musi mieć wpis na „nowe" — bez niego powrót na „Nowe" byłby CICHYM brakiem akcji,
  // nieodróżnialnym od poprawnego pominięcia. Test na samą mapę, żeby usunięcie wpisu bolało
  // od razu, a nie dopiero na produkcji.
  it('mapa niesie WSZYSTKIE trzy statusy odbijane', () => {
    expect(STATUS_ALLEGRO_DLA).toEqual({ nowe: 'NEW', w_realizacji: 'PROCESSING', wyslane: 'SENT' });
  });

  it('sklep NIE jest kanałem — ta reguła go nie dotyczy', () => {
    expect(statusDlaAllegro(z({ sklep: 'szkicownia' }), 'NEW')).toBeNull();
    expect(statusDlaAllegro(z({ sklep: 'reczne' }), 'NEW')).toBeNull();
  });

  // ⚠️ TEST DOPISANY PO WŁASNEJ MUTACJI (Zadanie 2, trzecia mutacja): usunięcie warunku
  // `!z.zrodlo_id` PRZEŻYŁO całą suitę z planu. `zrodlo_id` to identyfikator zamówienia
  // w Allegro i jedyne, z czego wołający buduje ścieżkę `PUT /order/checkout-forms/{id}/
  // fulfillment`. Bez tego warunku reguła oddaje „wyślij PROCESSING" dla zamówienia, którego
  // w Allegro nie umiemy wskazać — a zapis leci pod adres z `undefined` w miejscu id.
  // Kanał bez identyfikatora to nie jest hipoteza: `sklep` bywa ustawiony wcześniej niż
  // odpowiedź z Allegro, a kolumna jest zwyczajnie NULLowalna.
  it('kanał BEZ zrodlo_id nie wysyła niczego — nie ma czego zaadresować', () => {
    expect(statusDlaAllegro(z({ zrodlo_id: null }), 'NEW')).toBeNull();
    expect(statusDlaAllegro(z({ zrodlo_id: '' }), 'NEW')).toBeNull();
    const bez = z({}); delete bez.zrodlo_id;
    expect(statusDlaAllegro(bez, 'NEW')).toBeNull();
  });

  it('nie rzuca na pustce', () => {
    expect(statusDlaAllegro(null, 'NEW')).toBeNull();
    expect(statusDlaAllegro({}, 'NEW')).toBeNull();
  });
});

// ⚠️ K2 (recenzja Partii 1). `statusDlaAllegro` oddaje `null` z sześciu różnych powodów
// i tylko JEDEN z nich cokolwiek dowodzi. Ta funkcja odpowiada wyłącznie na pytanie
// „czy świeży odczyt DOWODZI, że rozjazdu nie ma" — bo tylko wtedy wolno zdjąć z karty
// ślad po nieudanej synchronizacji (usługa: services/sync-sklep.js).
describe('stanAllegroPotwierdzaZgodnosc', () => {
  it('stan docelowy już osiągnięty → TAK', () => {
    expect(stanAllegroPotwierdzaZgodnosc(z(), 'PROCESSING')).toBe(true);
    expect(stanAllegroPotwierdzaZgodnosc(z({ w_realizacji_at: null }), 'NEW')).toBe(true);
  });

  it('stan inny niż docelowy → NIE (jest rozjazd, ślad ma zostać)', () => {
    expect(stanAllegroPotwierdzaZgodnosc(z(), 'NEW')).toBe(false);
  });

  // ⚠️ NAJWAŻNIEJSZY WIERSZ: „nie pytaliśmy" to nie to samo, co „sprawdziliśmy i jest
  // dobrze". Gdyby `undefined` przechodziło, awaria odczytu KASOWAŁABY ślad po awarii.
  it('brak odczytu (undefined) → NIE', () => {
    expect(stanAllegroPotwierdzaZgodnosc(z(), undefined)).toBe(false);
  });

  it('anulowane, zwrot i zamówienie ze sklepu → NIE (o Allegro nie wiemy nic)', () => {
    expect(stanAllegroPotwierdzaZgodnosc(z({ anulowane: 1 }), 'PROCESSING')).toBe(false);
    expect(stanAllegroPotwierdzaZgodnosc(z({ zwrot_at: '2026-08-06' }), 'PROCESSING')).toBe(false);
    expect(stanAllegroPotwierdzaZgodnosc(z({ sklep: 'szkicownia' }), 'PROCESSING')).toBe(false);
  });

  it('nie rzuca na pustce', () => {
    expect(stanAllegroPotwierdzaZgodnosc(null, 'NEW')).toBe(false);
    expect(stanAllegroPotwierdzaZgodnosc({}, 'NEW')).toBe(false);
  });
});
