import { describe, it, expect, vi } from 'vitest';
import { createMailer } from '../../../src/core/poczta/smtp.js';

function mailerWithSpy() {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
  const mailer = createMailer({ smtp: { host: 'h', port: 465, user: 'u', pass: 'p' }, mailFrom: 'indywidualne@szkicownia.pl', transportFactory: () => ({ sendMail }) });
  return { mailer, sendMail };
}

describe('sendMail threading', () => {
  it('przekazuje inReplyTo i references', async () => {
    const { mailer, sendMail } = mailerWithSpy();
    await mailer.sendMail({ to: 'k@x.pl', subject: 'Re: X', text: 'hej', inReplyTo: '<abc@x>', references: '<abc@x>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: '<abc@x>', references: '<abc@x>', from: 'indywidualne@szkicownia.pl' }));
  });
  it('odrzuca obcy from', async () => {
    const { mailer } = mailerWithSpy();
    await expect(mailer.sendMail({ to: 'k@x.pl', subject: 's', text: 't', from: 'zly@x.pl' })).rejects.toThrow(/Illegal from/);
  });
});
