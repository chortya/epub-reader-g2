import test from 'node:test';
import assert from 'node:assert/strict';

import { sentenceStartBefore, nextSentenceStart } from '../src/sentences.ts';

const TEXT = 'One fine morning. Mr. Jones left early! Was it raining? Yes… heavily.';

test('sentenceStartBefore: offsets inside a sentence map to its start', () => {
  // "One fine morning." = 0..16; "Mr. Jones left early!" starts at 18
  assert.equal(sentenceStartBefore(TEXT, 0), 0);
  assert.equal(sentenceStartBefore(TEXT, 5), 0);
  assert.equal(sentenceStartBefore(TEXT, 20), 18);
  assert.equal(sentenceStartBefore(TEXT, 40), 40, 'offset at a sentence start maps to itself');
  assert.equal(sentenceStartBefore(TEXT, 39), 18);
});

test('sentenceStartBefore: abbreviations do not split', () => {
  // "Mr." must not end a sentence — offset inside "Jones" stays in sentence 2.
  assert.equal(sentenceStartBefore(TEXT, 24), 18, 'Mr. Jones is one sentence');
});

test('nextSentenceStart: returns the start of the following sentence', () => {
  assert.equal(nextSentenceStart(TEXT, 0), 18);
  assert.equal(nextSentenceStart(TEXT, 18), 40);
  assert.equal(nextSentenceStart(TEXT, 61), TEXT.length, 'no further sentence');
});

test('helpers clamp out-of-range offsets', () => {
  assert.equal(sentenceStartBefore(TEXT, -5), 0);
  assert.equal(sentenceStartBefore(TEXT, 9999), 61);
  assert.equal(nextSentenceStart('', 0), 0);
});
