// Real verification for js/checkout.js (sandbox payment simulation only — no real network calls)
import assert from 'node:assert/strict';
import { validateCard, submitSandboxPayment, getOneTimePriceUSD, DECLINE_TEST_CARD } from '../js/checkout.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

check('validateCard rejects a well-formed but already-expired card', () => {
  const { valid, errors } = validateCard({ number: '4242424242424242', expiry: '01/20', cvc: '123' });
  assert.equal(valid, false);
  assert.ok(errors.expiry);
});

check('getOneTimePriceUSD returns the documented $3.99 one-time price', () => {
  const price = getOneTimePriceUSD();
  assert.equal(typeof price, 'number');
  assert.equal(price, 3.99);
});

check('validateCard rejects empty fields', () => {
  const { valid, errors } = validateCard({ number: '', expiry: '', cvc: '' });
  assert.equal(valid, false);
  assert.ok(errors.number);
  assert.ok(errors.expiry);
  assert.ok(errors.cvc);
});

check('validateCard accepts a well-formed Luhn-valid test number', () => {
  const { valid, errors } = validateCard({ number: '4242 4242 4242 4242', expiry: '12/29', cvc: '123' });
  assert.equal(valid, true);
  assert.deepEqual(errors, {});
});

check('validateCard rejects a Luhn-invalid number', () => {
  const { valid, errors } = validateCard({ number: '1234 5678 9012 3456', expiry: '12/29', cvc: '123' });
  assert.equal(valid, false);
  assert.ok(errors.number);
});

check('validateCard accepts the designated decline test card as well-formed (fails only at submit time)', () => {
  const { valid, errors } = validateCard({ number: DECLINE_TEST_CARD, expiry: '12/29', cvc: '123' });
  assert.equal(valid, true);
  assert.deepEqual(errors, {});
});

check('validateCard rejects malformed expiry and cvc', () => {
  const r1 = validateCard({ number: '4242424242424242', expiry: '13/29', cvc: '123' });
  assert.ok(r1.errors.expiry);
  const r2 = validateCard({ number: '4242424242424242', expiry: '12/29', cvc: '12' });
  assert.ok(r2.errors.cvc);
});

check('validateCard rejects a card number that is too short even if numeric', () => {
  const { valid, errors } = validateCard({ number: '4242', expiry: '12/29', cvc: '123' });
  assert.equal(valid, false);
  assert.ok(errors.number);
});

await checkAsync('submitSandboxPayment resolves ok:true with a SANDBOX- reference for a normal valid card', async () => {
  const result = await submitSandboxPayment({ number: '4242424242424242' });
  assert.equal(result.ok, true);
  assert.match(result.reference, /^SANDBOX-/);
});

await checkAsync('submitSandboxPayment resolves ok:false for the designated decline test card', async () => {
  const result = await submitSandboxPayment({ number: DECLINE_TEST_CARD });
  assert.equal(result.ok, false);
  assert.match(result.message, /declined/i);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED');
}
