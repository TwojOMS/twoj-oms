import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const dokument = readFileSync(new URL('../../docs/instalacja-docker.md', import.meta.url), 'utf8');

describe('PRZ-109.10: droga od instalacji Dockera do HTTPS', () => {
  it('prowadzi z logowania do sekcji HTTPS bez zmiany numerów dalszych kroków', () => {
    expect(dokument).toContain('[sekcji 7a](#7a-dostęp-spoza-biura-przez-https)');
    expect(dokument).toMatch(/## 7a\. Dostęp spoza biura przez HTTPS[\s\S]+## 8\. Przejście na pracę/);
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
