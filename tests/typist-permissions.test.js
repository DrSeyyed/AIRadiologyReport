import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function loadEndpoint(relativePath) {
	const url = new URL(relativePath, import.meta.url);
	const source = readFileSync(url, 'utf8').replace(
		/from (['"])([^'"]+)\1/g,
		(statement, quote, specifier) => {
			let resolved;
			if (specifier === '$lib/server/db') {
				resolved =
					'data:text/javascript,export function getDb(){throw new Error("Database accessed before permission check")}';
			} else if (specifier.startsWith('$lib/')) {
				resolved = new URL(
					`../src/lib/${specifier.slice(5)}${specifier.endsWith('.js') ? '' : '.js'}`,
					import.meta.url
				).href;
			} else if (specifier.startsWith('.')) {
				resolved = new URL(specifier, url).href;
			} else {
				resolved = import.meta.resolve(specifier);
			}
			return `from ${JSON.stringify(resolved)}`;
		}
	);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('typists cannot reach study or recording mutation bodies, database or external APIs', async () => {
	const [studies, study, importer, recordings] = await Promise.all([
		loadEndpoint('../src/routes/api/studies/+server.js'),
		loadEndpoint('../src/routes/api/studies/[id]/+server.js'),
		loadEndpoint('../src/routes/api/studies/import/+server.js'),
		loadEndpoint('../src/lib/server/recording-http.js')
	]);
	const mutations = {
		createStudy: studies.POST,
		editStudy: study.PATCH,
		deleteStudy: study.DELETE,
		importStudies: importer.POST,
		uploadRecording: recordings.upload,
		configureRecording: recordings.configure,
		deleteRecording: recordings.remove,
		generateReport: recordings.generate,
		editReport: recordings.writeReport
	};
	const event = {
		params: { id: '1', recordingId: '1' },
		locals: { user: { id: 4, role: 'typist' } },
		request: {
			json() {
				throw new Error('Request body consumed before permission check');
			},
			formData() {
				throw new Error('Upload consumed before permission check');
			}
		}
	};
	for (const [name, handler] of Object.entries(mutations)) {
		const response = await handler(event);
		assert.equal(response.status, 403, name);
		assert.ok((await response.json()).error, name);
		const anonymous = await handler({ ...event, locals: {} });
		assert.equal(anonymous.status, 401, `${name} anonymous`);
	}
});
