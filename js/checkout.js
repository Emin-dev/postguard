// checkout.js — SANDBOX-ONLY fake payment processor. No real payment
// provider is ever contacted. This validates card-shaped input client-side
// (real Luhn check, real expiry-not-in-the-past check using the actual
// runtime clock, real CVC format check) and simulates network latency to
// demo the unlock flow. The designated "always declines" test card lets the
// failure path be demoed too, the same way real sandbox modes (e.g. Stripe
// test cards) work.
//
// What this unlocks: a client-side flag (see markUnlocked/isUnlocked) that
// lifts the free-tier limit in this same browser — batch/multi-file
// processing (several images/PDFs in one flow without re-uploading one at a
// time). Monetization model is BUY: one-time purchase, not a subscription.
// Free tier keeps single-file scrub/redact forever.

const DECLINE_TEST_CARD = '4000000000000002';
const ONE_TIME_PRICE_USD = 3.99;
const STORAGE_KEY = 'postguard_unlocked_v1';

export function getOneTimePriceUSD() {
  return ONE_TIME_PRICE_USD;
}

function luhnCheck(numStr) {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Validate sandbox card fields. Returns { valid: boolean, errors: {field: msg} }.
 */
export function validateCard({ number, expiry, cvc }) {
  const errors = {};
  const digits = (number || '').replace(/\D/g, '');

  if (!digits) {
    errors.number = 'Enter a card number.';
  } else if (!luhnCheck(digits) && digits !== DECLINE_TEST_CARD.replace(/\D/g, '')) {
    errors.number = "That card number doesn't look valid (sandbox check).";
  }

  if (!expiry || !/^\d{2}\s*\/\s*\d{2}$/.test(expiry.trim())) {
    errors.expiry = 'Use MM/YY format.';
  } else {
    const [mm, yy] = expiry.split('/').map((s) => parseInt(s.trim(), 10));
    if (mm < 1 || mm > 12) {
      errors.expiry = 'Month must be between 01-12.';
    } else {
      const expiryEnd = new Date(2000 + yy, mm, 0); // last day of the expiry month
      if (expiryEnd < new Date()) errors.expiry = 'This card has expired.';
    }
  }

  if (!cvc || !/^\d{3,4}$/.test(cvc.trim())) {
    errors.cvc = '3-4 digit security code.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Simulate submitting a sandbox one-time purchase. Always resolves (never
 * throws) after a short artificial delay, with either a success or a
 * decline result.
 * @returns {Promise<{ok: boolean, message: string, reference?: string}>}
 */
export function submitSandboxPayment({ number }) {
  const digits = (number || '').replace(/\D/g, '');
  const isDeclineCard = digits === DECLINE_TEST_CARD.replace(/\D/g, '');

  return new Promise((resolve) => {
    setTimeout(() => {
      if (isDeclineCard) {
        resolve({ ok: false, message: 'Card declined (sandbox test card). Try a different number.' });
      } else {
        const reference = 'SANDBOX-' + Math.random().toString(36).slice(2, 10).toUpperCase();
        resolve({ ok: true, message: 'Batch mode unlocked (sandbox).', reference });
      }
    }, 700);
  });
}

/** Persist the unlock flag in this browser only (no server, no account system). */
export function markUnlocked() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* localStorage unavailable (e.g. private mode) — unlock just won't persist across reloads */
  }
}

export function isUnlocked() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export { DECLINE_TEST_CARD };
