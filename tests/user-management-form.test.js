import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'svelte/compiler';

function patternAttributes(node, found = []) {
	if (!node || typeof node !== 'object') return found;
	if (node.type === 'Attribute' && node.name === 'pattern') found.push(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) value.forEach((child) => patternAttributes(child, found));
		else if (value && typeof value === 'object') patternAttributes(value, found);
	}
	return found;
}

test('create and edit username patterns preserve regex quantifiers through Svelte parsing', () => {
	const source = readFileSync(
		new URL('../src/routes/admin/users/+page.svelte', import.meta.url),
		'utf8'
	);
	const attributes = patternAttributes(parse(source, { modern: true }));
	assert.equal(attributes.length, 2);
	for (const attribute of attributes) {
		assert.equal(attribute.value.type, 'ExpressionTag');
		assert.equal(attribute.value.expression.type, 'Literal');
		const pattern = attribute.value.expression.value;
		assert.equal(pattern, String.raw`[a-z][a-z0-9._\-]{2,31}`);
		const regex = new RegExp(`^(?:${pattern})$`, 'v');
		for (const username of [
			'admin',
			'resident',
			'user.name',
			'user_name',
			'user-name',
			'a'.repeat(32)
		]) {
			assert.ok(regex.test(username), `Valid username rejected: ${username}`);
		}
		for (const username of ['ab', '1user', 'Admin', 'user name', 'a'.repeat(33)]) {
			assert.ok(!regex.test(username), `Invalid username accepted: ${username}`);
		}
	}
});
