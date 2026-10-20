import assert from 'node:assert/strict';
import test from 'node:test';
import { isRedirect } from '@sveltejs/kit';
import { load } from '../src/routes/+page.server.js';

for (const role of ['admin', 'resident', 'attending', 'typist']) {
	test(`the root route sends signed-in ${role} users to studies`, () => {
		assert.throws(() => load({ locals: { user: { role } } }), (error) =>
			isRedirect(error) && error.status === 302 && error.location === '/studies'
		);
	});
}

test('the root route sends visitors to login', () => {
	for (const user of [null, undefined]) {
		assert.throws(() => load({ locals: { user } }), (error) =>
			isRedirect(error) && error.status === 302 && error.location === '/login'
		);
	}
});
