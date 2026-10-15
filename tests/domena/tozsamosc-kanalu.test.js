import { describe, it, expect } from 'vitest';
import { kontoZTokenu, kolizjeKont } from '../../src/domena/tozsamosc-kanalu.js';

// ⚠️⚠️ TEN MODUL POWSTAL PO POMYLCE Z 28.08.2026. Wlasciciel kliknal „Polacz z Allegro"
// przy kanale `allegro_amarka`, bedac zalogowanym w przegladarce na konto `szkicownia`.
// Device flow zrobil DOKLADNIE to, o co go poproszono: zwiazal kanal amarka z kontem
// szkicownia. Panel nie mial jak tego zauwazyc — kanal byl polaczony, bez bledu, z kompletem
// osmiu zakresow i 89 dniami waznosci, czyli ZDROWY wedle kazdego sita, jakie mial.
//
// Przez ~40 minut poller ciagnal cudze zamowienia pod nazwa amarka: 6 zdublowanych
// zamowien, 5 zdublowanych platnosci (czyli przychod policzony dwa razy), 18 watkow i 59
// wiadomosci w lustrze oraz PRZESTAWIONY KURSOR POLLERA — a ten ostatni po cichu pomijalby
// prawdziwe zamowienia amarka z calego okna.
//
// Ekran nie pokazywal ani slowa o tym, z jakim kontem kanal jest zwiazany.

// Token Allegro jest JWT: naglowek.payload.podpis. Liczy sie wylacznie srodek.
const token = (payload) => `naglowek.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.podpis`;

describe('konto Allegro odczytane z tokenu', () => {
  it('oddaje identyfikator konta z pola user_name', () => {
    expect(kontoZTokenu(token({ user_name: '36457435', scope: ['allegro:api:orders:read'] }))).toBe('36457435');
  });

  it('oddaje identyfikator jako napis, nawet gdy Allegro poda liczbe', () => {
    // ⚠️ Porownanie miedzy kanalami musi byc miedzy tymi samymi typami, inaczej
    // 75246625 !== '75246625' i kolizja przechodzi niezauwazona.
    expect(kontoZTokenu(token({ user_name: 75246625 }))).toBe('75246625');
  });

  it('NIE RZUCA i oddaje null, gdy tokenu nie da sie odczytac', () => {
    // Ten odczyt wola ekran stanu kanalu. Wyjatek tutaj wywalilby cala strone
    // z powodu tokenu o nieznanym ksztalcie.
    for (const zly of [null, undefined, '', 'bezkropek', 'a.niebase64!!.c', 'a.eyJ4Ijox.c']) {
      expect(kontoZTokenu(zly)).toBeNull();
    }
  });
});

describe('kolizja kont miedzy kanalami', () => {
  it('wskazuje OBA kanaly wiszace na tym samym koncie', () => {
    const wynik = kolizjeKont([
      { kanal: 'allegro_szkicownia', kontoAllegro: '36457435' },
      { kanal: 'allegro_amarka', kontoAllegro: '36457435' },
    ]);
    // Oba, bo panel nie wie KTORY jest zly — wie tylko, ze dwa kanaly to dwa konta.
    expect(wynik).toEqual(['allegro_amarka', 'allegro_szkicownia']);
  });

  it('milczy, gdy kazdy kanal ma swoje konto', () => {
    expect(kolizjeKont([
      { kanal: 'allegro_szkicownia', kontoAllegro: '36457435' },
      { kanal: 'allegro_amarka', kontoAllegro: '75246625' },
    ])).toEqual([]);
  });

  it('⚠️ NIEZNANE KONTO TO NIE JEST TO SAMO KONTO', () => {
    // Dwa nieczytelne tokeny nie sa dowodem kolizji, a kolizja OTWIERA bariere wiazania —
    // czyli zaprasza do nadpisania dzialajacej pary tokenow. „Nie wiem" nie moze
    // uruchamiac nieodwracalnego kroku (ta sama regula co w brakujaceUprawnienia).
    expect(kolizjeKont([
      { kanal: 'allegro_szkicownia', kontoAllegro: null },
      { kanal: 'allegro_amarka', kontoAllegro: null },
    ])).toEqual([]);
  });

  it('nie wywraca sie na pustce ani na braku pol', () => {
    expect(kolizjeKont([])).toEqual([]);
    expect(kolizjeKont(null)).toEqual([]);
    expect(kolizjeKont([{ kanal: 'a' }, {}])).toEqual([]);
  });

  it('znajduje kolizje takze przy trzech kanalach, wskazujac tylko te sklejone', () => {
    expect(kolizjeKont([
      { kanal: 'a', kontoAllegro: '111' },
      { kanal: 'b', kontoAllegro: '222' },
      { kanal: 'c', kontoAllegro: '111' },
    ])).toEqual(['a', 'c']);
  });
});
