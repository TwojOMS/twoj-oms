import { describe, it, expect, vi } from 'vitest';
import { createGusClient } from '../../src/oms/gus/client.js';

// Klient GUS BIR1.1: logowanie, sesja `sid`, ponowienie po jej wygaśnięciu. Bez sieci —
// `fetchImpl` jest atrapą, tak samo jak przy testach DPD.

const odp = (tresc, ok = true, status = 200) => ({ ok, status, text: async () => tresc });
const wynikLogowania = (sid) => `<s:Envelope><s:Body><ZalogujResponse><ZalogujResult>${sid}</ZalogujResult></ZalogujResponse></s:Body></s:Envelope>`;
const wynikSzukania = (srodek) => '<s:Envelope><s:Body><DaneSzukajPodmiotyResponse><DaneSzukajPodmiotyResult>'
  + `&lt;root&gt;${srodek}&lt;/root&gt;`
  + '</DaneSzukajPodmiotyResult></DaneSzukajPodmiotyResponse></s:Body></s:Envelope>';
// Wygasla sesja: GUS oddaje 200 z PUSTYM elementem wyniku — nie z bledem, nie z pustym
// dokumentem w srodku. To wlasnie ta postac odpowiedzi jest nie do odroznienia od
// „nie znaleziono", jesli sie jej nie obsluzy osobno.
const wynikPusty = () => '<s:Envelope><s:Body><DaneSzukajPodmiotyResponse><DaneSzukajPodmiotyResult></DaneSzukajPodmiotyResult></DaneSzukajPodmiotyResponse></s:Body></s:Envelope>';
const firmaXml = '&lt;dane&gt;&lt;Nazwa&gt;ACME SP. Z O.O.&lt;/Nazwa&gt;&lt;Nip&gt;5252248481&lt;/Nip&gt;'
  + '&lt;Ulica&gt;ul. Prosta&lt;/Ulica&gt;&lt;NrNieruchomosci&gt;51&lt;/NrNieruchomosci&gt;'
  + '&lt;KodPocztowy&gt;00838&lt;/KodPocztowy&gt;&lt;Miejscowosc&gt;WARSZAWA&lt;/Miejscowosc&gt;&lt;/dane&gt;';

const klient = (kolejka, opcje = {}) => {
  const wywolania = [];
  const fetchImpl = vi.fn(async (url, init) => {
    wywolania.push({ url, sid: init.headers.sid, body: init.body });
    const nast = kolejka.shift();
    if (typeof nast === 'function') return nast();
    return nast;
  });
  return {
    gus: createGusClient({ klucz: 'K1', url: 'https://gus/uslugi.svc' }, { fetchImpl, ...opcje }),
    wywolania,
    fetchImpl,
  };
};

describe('logowanie i sesja', () => {
  it('loguje się kluczem, potem niesie sid w nagłówku KAŻDEGO żądania', async () => {
    const { gus, wywolania } = klient([odp(wynikLogowania('SID-1')), odp(wynikSzukania(firmaXml))]);
    const f = await gus.firmaPoNip('5252248481');

    expect(f.firma).toBe('ACME SP. Z O.O.');
    expect(wywolania).toHaveLength(2);
    expect(wywolania[0].sid).toBeUndefined();
    expect(wywolania[0].body).toContain('<ns:pKluczUzytkownika>K1</ns:pKluczUzytkownika>');
    // ⚠️ `sid` jedzie w nagłówku HTTP, nie w kopercie — pomyłka w tym miejscu daje pustą
    // odpowiedź, czyli komunikat „nie znaleziono firmy" przy każdym NIP-ie.
    expect(wywolania[1].sid).toBe('SID-1');
    expect(wywolania[1].body).toContain('<dat:Nip>5252248481</dat:Nip>');
  });

  it('drugie zapytanie w tej samej sesji NIE loguje się ponownie', async () => {
    const { gus, wywolania } = klient([
      odp(wynikLogowania('SID-1')), odp(wynikSzukania(firmaXml)), odp(wynikSzukania(firmaXml)),
    ]);
    await gus.firmaPoNip('5252248481');
    await gus.firmaPoNip('5252248481');
    expect(wywolania).toHaveLength(3);
    expect(wywolania.filter((w) => w.body.includes('pKluczUzytkownika'))).toHaveLength(1);
  });

  // ⚠️ Sesja GUS-u wygasa po ok. 60 min. Trzymamy 45, żeby nie trafiać w moment wygaśnięcia.
  it('po upływie żywotności loguje się od nowa', async () => {
    let czas = 1_000_000;
    const { gus, wywolania } = klient(
      [odp(wynikLogowania('SID-1')), odp(wynikSzukania(firmaXml)), odp(wynikLogowania('SID-2')), odp(wynikSzukania(firmaXml))],
      { teraz: () => czas },
    );
    await gus.firmaPoNip('5252248481');
    czas += 46 * 60 * 1000;
    await gus.firmaPoNip('5252248481');

    expect(wywolania.filter((w) => w.body.includes('pKluczUzytkownika'))).toHaveLength(2);
    expect(wywolania.at(-1).sid).toBe('SID-2');
  });

  // Zły klucz NIE daje błędu HTTP — usługa oddaje 200 z pustym wynikiem logowania.
  it('pusty wynik logowania → czytelna odmowa, nie ciche „nie znaleziono”', async () => {
    const { gus } = klient([odp(wynikLogowania(''))]);
    await expect(gus.firmaPoNip('5252248481')).rejects.toThrow(/klucz użytkownika/i);
  });
});

describe('wygaśnięcie sesji w trakcie', () => {
  // ⚠️ TO JEST TEN PRZYPADEK Z BRIEFU: wygaśnięcie nie wygląda jak błąd — GUS oddaje 200
  // z pustą treścią. Bez ponowienia pierwsze kliknięcie po dłuższej przerwie kończyłoby się
  // komunikatem „GUS nie zna takiej firmy", czyli KŁAMSTWEM o danych klienta.
  it('pusta odpowiedź → przelogowanie i JEDNO ponowienie, dane wracają', async () => {
    const { gus, wywolania } = klient([
      odp(wynikLogowania('SID-1')),
      odp(wynikPusty()), // sesja wygasła: 200, ale bez wyniku
      odp(wynikLogowania('SID-2')),
      odp(wynikSzukania(firmaXml)),
    ]);
    const f = await gus.firmaPoNip('5252248481');
    expect(f.firma).toBe('ACME SP. Z O.O.');
    expect(wywolania).toHaveLength(4);
    expect(wywolania.at(-1).sid).toBe('SID-2');
  });

  // Pętla ponowień dobijałaby GUS przy złym kluczu — jedno i koniec.
  it('gdy po ponowieniu dalej pusto, oddaje null i NIE próbuje w kółko', async () => {
    const { gus, wywolania } = klient([
      odp(wynikLogowania('SID-1')), odp(wynikPusty()),
      odp(wynikLogowania('SID-2')), odp(wynikPusty()),
    ]);
    expect(await gus.firmaPoNip('5252248481')).toBeNull();
    expect(wywolania).toHaveLength(4);
  });
});

describe('odpowiedzi i awarie', () => {
  it('firma nieznaleziona → null (to odpowiedź, nie awaria)', async () => {
    const brak = '&lt;dane&gt;&lt;ErrorCode&gt;4&lt;/ErrorCode&gt;&lt;/dane&gt;';
    const { gus } = klient([odp(wynikLogowania('SID-1')), odp(wynikSzukania(brak))]);
    expect(await gus.firmaPoNip('5252248481')).toBeNull();
  });

  it('błąd HTTP niesie status w komunikacie', async () => {
    const { gus } = klient([odp('coś padło', false, 503)]);
    await expect(gus.firmaPoNip('5252248481')).rejects.toThrow(/503/);
  });

  it('timeout → komunikat dla operatora, nie surowy AbortError', async () => {
    const { gus } = klient([() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }]);
    await expect(gus.firmaPoNip('5252248481')).rejects.toThrow(/nie odpowiedział w 10 sekund/);
  });

  // PRZ-102.11: „Sprawdź połączenie” z Ustawień — zawsze świeże logowanie (nie stara sesja), bez pytania o firmę.
  it('sprawdzPolaczenie loguje się od nowa i o nic nie pyta; zły klucz = odmowa dla operatora', async () => {
    const { gus, wywolania } = klient([odp(wynikLogowania('SID-1')), odp(wynikLogowania('SID-2')), odp(wynikLogowania(''))]);
    await expect(gus.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    await expect(gus.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    expect(gus._sesja().sid).toBe('SID-2');
    expect(wywolania.every((w) => w.body.includes('pKluczUzytkownika'))).toBe(true);
    const e = await gus.sprawdzPolaczenie().catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('GUS odrzucił logowanie');
    expect(e.message).not.toContain('K1');
  });

  it('bez klucza albo bez adresu klient w ogóle nie powstaje', () => {
    expect(() => createGusClient({ klucz: '', url: 'https://x' })).toThrow(/GUS/);
    expect(() => createGusClient({ klucz: 'K', url: '' })).toThrow(/GUS/);
  });
});
