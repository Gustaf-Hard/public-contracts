// tests/bounce.test.js — pure detector for delivery-failure notifications.
import { describe, it, expect } from 'vitest';
import { isBounce, failedRecipient } from '../src/bounce.js';

// The real Lund NDR (escalation #10) — from mailer-daemon, "Address not found".
const lundBounce = {
  from_email: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  subject: 'Delivery Status Notification (Failure)',
  body_text: "** Address not found **\n\nYour message wasn't delivered to lund.kommun@lund.se because the address couldn't be found, or is unable to receive mail.",
};

describe('isBounce', () => {
  it('detects the mailer-daemon NDR (Lund)', () => {
    expect(isBounce(lundBounce)).toBe(true);
  });

  it('detects by NDR subject even without the daemon sender', () => {
    expect(isBounce({ from_email: 'x@y.se', subject: 'Undeliverable: Begäran', body_text: '' })).toBe(true);
  });

  it('detects by strong body phrase alone', () => {
    expect(isBounce({ from_email: 'x@y.se', subject: 'Re: Begäran', body_text: 'The email account that you tried to reach does not exist.' })).toBe(true);
  });

  it('does NOT flag a genuine kommun reply', () => {
    expect(isBounce({
      from_email: '"Löf, Eleonor" <eleonor.lof@huddinge.se>',
      subject: 'VB: Begäran om allmänna handlingar',
      body_text: 'Hej, här kommer avtalet samt bilagor för leverantören IST.',
    })).toBe(false);
  });

  it('does NOT flag an out-of-office autosvar (deferred, must not be a bounce)', () => {
    expect(isBounce({
      from_email: 'Ingela Eklund <ingela.eklund@bjuv.se>',
      subject: 'Autosvar: Begäran om allmänna handlingar – Bjuvs kommun',
      body_text: 'Hej! Jag har semester och är åter på kontoret måndag 20 juli.',
    })).toBe(false);
  });

  it('is safe on empty / missing input', () => {
    expect(isBounce()).toBe(false);
    expect(isBounce({})).toBe(false);
  });
});

describe('failedRecipient', () => {
  it('extracts the bounced address from the NDR body', () => {
    expect(failedRecipient(lundBounce.body_text)).toBe('lund.kommun@lund.se');
  });

  it('returns null when no address is present', () => {
    expect(failedRecipient('delivery failed, no details')).toBeNull();
    expect(failedRecipient()).toBeNull();
  });
});
