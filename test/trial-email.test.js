import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trialEmailKey } from '../src/services/trial-email.js';

test('gmail aliases share one trial', () => {
  const key = 'johnsmith@gmail.com';
  assert.equal(trialEmailKey('johnsmith@gmail.com'), key);
  assert.equal(trialEmailKey('John.Smith@Gmail.com'), key);
  assert.equal(trialEmailKey('j.o.h.n.smith+trial2@gmail.com'), key);
  assert.equal(trialEmailKey('johnsmith@googlemail.com'), key);
  assert.equal(trialEmailKey('  johnsmith@gmail.com '), key);
});

test('other domains: +tags removed, dots kept', () => {
  assert.equal(trialEmailKey('a.b+x@outlook.com'), 'a.b@outlook.com');
  assert.notEqual(trialEmailKey('a.b@outlook.com'), trialEmailKey('ab@outlook.com'));
});

test('different people stay different', () => {
  assert.notEqual(trialEmailKey('anna@gmail.com'), trialEmailKey('anne@gmail.com'));
  assert.notEqual(trialEmailKey('anna@gmail.com'), trialEmailKey('anna@yahoo.com'));
});
