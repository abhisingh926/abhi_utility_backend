import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageType } from '../src/services/image-type.js';

const bytes = (...b) => Buffer.from(b);

test('recognises JPEG, PNG and WebP by their first bytes', () => {
  assert.equal(imageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'image/jpeg');
  assert.equal(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(imageType(Buffer.concat([Buffer.from('RIFF'), bytes(1, 2, 3, 4), Buffer.from('WEBPVP8 ')])), 'image/webp');
});

test('rejects anything else, whatever it claims to be', () => {
  assert.equal(imageType(Buffer.alloc(0)), null);
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null); // SVG can carry scripts
  assert.equal(imageType(Buffer.from('GIF89a')), null);
  assert.equal(imageType(Buffer.concat([Buffer.from('RIFF'), bytes(1, 2, 3, 4), Buffer.from('AVI ')])), null);
  assert.equal(imageType(bytes(0xff, 0xd8)), null); // too short
});
