// Instrukcja instalacji w Dockerze prowadzi z kroku logowania do sekcji o dostępie przez HTTPS. Strażnik pilnuje,
// że odsyłacz działa (kotwica wskazuje istniejący nagłówek, liczona jak na GitHubie) i że wstawiona sekcja nie
// przesunęła numerów dalszych kroków — nie trzyma dosłownego tytułu sekcji, więc zmiana jej słów razem
// z odsyłaczem test zostawia zielonym. Pozostałe testy sprawdzają polecenia, które czytelnik przepisuje.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const dokument = readFileSync(new URL('../../docs/instalacja-docker.md', import.meta.url), 'utf8');

/** Kotwica nagłówka jak na GitHubie: małe litery, bez znaków innych niż litery, cyfry, spacja i kreska, spacja → kreska. */
export const kotwica = (tytul) =>
  tytul
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replaceAll(' ', '-');

/** Nagłówki poza blokami kodu: [{ poziom, tytul, kotwica, pozycja }]; powtórzona kotwica dostaje -1, -2… */
export function naglowki(md) {
  const wynik = [];
  const uzyte = new Map();
  let wKodzie = false;
  let pozycja = 0;
  for (const linia of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(linia)) wKodzie = !wKodzie;
    const m = !wKodzie && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(linia);
    if (m) {
      const baza = kotwica(m[2]);
      const n = uzyte.get(baza) ?? 0;
      uzyte.set(baza, n + 1);
      wynik.push({ poziom: m[1].length, tytul: m[2], kotwica: n ? `${baza}-${n}` : baza, pozycja });
    }
    pozycja += linia.length + 1;
  }
  return wynik;
}

/** Odsyłacze wewnątrz dokumentu: [{ cel, pozycja }]. */
export const odsylacze = (md) =>
  [...md.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => ({ cel: decodeURIComponent(m[1]), pozycja: m.index }));

describe('droga od instalacji Dockera do HTTPS', () => {
  it('prowadzi z wcześniejszego kroku do sekcji HTTPS bez zmiany numerów dalszych kroków', () => {
    const lista = naglowki(dokument);
    const kotwice = new Set(lista.map((n) => n.kotwica));
    const linki = odsylacze(dokument);
    expect(
      linki.filter((l) => !kotwice.has(l.cel)).map((l) => l.cel),
      'odsyłacz bez nagłówka',
    ).toEqual([]);
    const https = lista.find((n) => n.poziom === 2 && /HTTPS/.test(n.tytul));
    expect(https, 'sekcja o HTTPS').toBeDefined();
    expect(
      linki.some((l) => l.cel === https.kotwica && l.pozycja < https.pozycja),
      'odsyłacz z wcześniejszego kroku',
    ).toBe(true);
    // Kroki „## N.” idą 1, 2, 3… bez przeskoku; wstawiony krok ma literę („7a.”) i numer poprzedniego kroku.
    const kroki = lista
      .filter((n) => n.poziom === 2)
      .map((n) => /^(\d+)([a-z]?)\./.exec(n.tytul))
      .filter(Boolean);
    let numer = 0;
    for (const [, n, litera] of kroki) {
      expect(Number(n), `krok ${n}${litera}`).toBe(litera ? numer : numer + 1);
      numer = Number(n);
    }
    expect(https.tytul).toMatch(/^\d+[a-z]\./);
  });

  it('kotwice liczone jak na GitHubie, nagłówki w blokach kodu pominięte', () => {
    expect(kotwica('7a. Dostęp spoza biura przez HTTPS')).toBe('7a-dostęp-spoza-biura-przez-https');
    expect(kotwica('Polecenia `aktualizuj.sh sekrety`')).toBe('polecenia-aktualizujsh-sekrety');
    expect(kotwica('Kopia poza dyskiem (pendrive, dysk USB)')).toBe('kopia-poza-dyskiem-pendrive-dysk-usb');
    const md = '# A\n```bash\n# komentarz\n```\n## B b\n## B b\n';
    expect(naglowki(md).map((n) => n.kotwica)).toEqual(['a', 'b-b', 'b-b-1']);
    expect(odsylacze('zobacz [tu](#b-b) i [tam](https://x.pl/#c)').map((l) => l.cel)).toEqual(['b-b']);
  });

  it('podaje instalację Caddy, konfigurację i ponowne wczytanie oms.env', () => {
    expect(dokument).toContain('sudo apt-get install -y caddy');
    expect(dokument).toContain('reverse_proxy 127.0.0.1:3001');
    expect(dokument).toContain('OMS_TRUST_PROXY=127.0.0.1');
    expect(dokument).toContain('sudo sh /opt/oms/aktualizuj.sh compose up -d --force-recreate oms');
    expect(dokument).toContain('curl -I https://oms.przyklad.pl/login');
  });

  it('uwzględnia granicę zaufania Dockera i tunelu zamiast ufać wszystkim', () => {
    expect(dokument).toContain('0.0.0.0:${OMS_PORT_LAN:-3001}:3001');
    expect(dokument).toContain('docker inspect oms');
    expect(dokument).toContain('bez spacji');
    expect(dokument).toContain('nie zakresy adresów Cloudflare');
    expect(dokument).toContain('VPN');
  });

  it('sprawdza sesję i blokadę, nie traktuje samych nagłówków jako dowodu zaufania proxy', () => {
    expect(dokument).toContain('Strict-Transport-Security: max-age=15552000');
    expect(dokument).toContain('także bez `OMS_TRUST_PROXY`');
    expect(dokument).toContain('nie dubluj');
    expect(dokument).toContain('Secure');
    expect(dokument).toContain('szósta');
    expect(dokument).toContain('Adres panelu');
  });
});
