import { describe, it, expect, vi } from 'vitest';
import { createMailer } from '../../../src/core/poczta/smtp.js';

const smtp = { host: 'h', port: 465, user: 'u', pass: 'secret' };

describe('mailer', () => {
  it('sends from the configured address', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id>' });
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    await mailer.sendMail({ to: 'k@x.pl', subject: 'Wycena', text: 'treść' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'indywidualne@szkicownia.pl', to: 'k@x.pl' }));
  });
  it('przekazuje html do transportu (multipart: text zostaje fallbackiem)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id>' });
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    await mailer.sendMail({ to: 'k@x.pl', subject: 'Wycena', text: 'treść', html: '<p>treść</p>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: 'treść', html: '<p>treść</p>' }));
  });
  // DW („do wiadomości"). Testy trasy sprawdzają, że panel podaje `cc` swojemu mailerowi —
  // to jest ostatni odcinek: czy mailer dokłada je do koperty nodemailera.
  it('przekazuje `cc` do transportu — adres w kopii dojeżdża do koperty', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id>' });
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    await mailer.sendMail({ to: 'k@x.pl', cc: ['d@x.pl', 'e@x.pl'], subject: 's', text: 't' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'k@x.pl', cc: ['d@x.pl', 'e@x.pl'] }));
  });
  it('przyjmuje `cc` także tekstem', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id>' });
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    await mailer.sendMail({ to: 'k@x.pl', cc: 'd@x.pl', subject: 's', text: 't' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ cc: 'd@x.pl' }));
  });
  // ⚠️ Pusty nagłówek `Cc:` to nagłówek USZKODZONY — klienty poczty potrafią się o niego
  // wyłożyć. Ta sama zasada, co przy pustym In-Reply-To (patrz services/wysylka.js).
  it('PUSTE `cc` w ogóle nie wchodzi do koperty', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id>' });
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    for (const cc of [undefined, null, '', '   ', []]) {
      await mailer.sendMail({ to: 'k@x.pl', cc, subject: 's', text: 't' });
      expect(sendMail.mock.calls.at(-1)[0]).not.toHaveProperty('cc');
    }
  });
  it('refuses a from that is not mailFrom', async () => {
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail: vi.fn() }) });
    await expect(mailer.sendMail({ to: 'k@x.pl', subject: 's', text: 't', from: 'wlasciciel@example.com' }))
      .rejects.toThrow(/from address/i);
  });
  it('wraps transport errors without leaking the password', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('auth failed for u:secret'));
    const mailer = createMailer({ smtp, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
    await expect(mailer.sendMail({ to: 'k@x.pl', subject: 's', text: 't' })).rejects.toThrow('SMTP error');
  });
});
