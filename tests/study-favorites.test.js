import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import {
	getFavoriteSummary, createFavoriteCategory, renameFavoriteCategory, deleteFavoriteCategory,
	saveStudyFavorite, removeStudyFavorite, attachStudyFavorites
} from '../src/lib/server/study-favorites.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
async function loadModule(relativePath, dbKey) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		let resolved;
		if (specifier === '$lib/server/db') resolved = `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(dbKey)}]}`)}`;
		else if (specifier.startsWith('$lib/')) resolved = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
		else resolved = import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
async function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec("INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Admin','admin'),(2,'Synthetic Resident','resident'),(3,'Synthetic Attending','attending'),(4,'Synthetic Typist','typist')");
	const study = code => insertStudy(db, { patient_code: code, patient_fullname: 'Synthetic Patient', exam_date_jalali: '1405-07-25', exam_time: '10:00', corresponding_attending_id: 3 });
	const studies = [study('FIRST'), study('SECOND'), study('THIRD')];
	const key = `studyFavorites_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	const routes = {
		categories: await loadModule('../src/routes/api/favorite-categories/+server.js', key),
		category: await loadModule('../src/routes/api/favorite-categories/[id]/+server.js', key),
		favorite: await loadModule('../src/routes/api/study-favorites/[id]/+server.js', key),
		studies: await loadModule('../src/routes/api/studies/+server.js', key)
	};
	const users = [null, { id: 1, role: 'admin' }, { id: 2, role: 'resident' }, { id: 3, role: 'attending' }, { id: 4, role: 'typist' }];
	async function request(route, method, userId = 2, body, id = studies[0], filters = {}) {
		const url = new URL(`http://localhost/api/test?${new URLSearchParams(filters)}`);
		const response = await routes[route][method]({
			locals: { user: users[userId] }, params: { id: String(id) }, url,
			request: new Request(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
		});
		return { status: response.status, data: await response.json() };
	}
	return { db, studies, key, routes, users, request };
}

test('favorites default list and optional-name categories persist through idempotent schema upgrades', async (t) => {
	const { db, studies } = await fixture(t);
	db.exec('DROP TABLE study_favorite_memberships; DROP TABLE study_favorite_categories; DROP TABLE study_favorites');
	initializeSchema(db, schema);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 3);
	const a = createFavoriteCategory(db, 2, '  Teaching  '), b = createFavoriteCategory(db, 2);
	assert.equal(a.name, 'Teaching'); assert.equal(b.name, '');
	saveStudyFavorite(db, 2, studies[0], []);
	saveStudyFavorite(db, 2, studies[1], [a.id, b.id, a.id]);
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(getFavoriteSummary(db, 2), { total: 2, categories: [{ ...a, total: 1 }, { ...b, total: 1 }] });
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	const rows = studies.map(id => ({ id }));
	attachStudyFavorites(db, 2, rows);
	assert.deepEqual(rows.map(row => [row.is_favorite, row.favorite_category_ids]), [[true, []], [true, [a.id, b.id]], [false, []]]);
});

test('category rename/delete keeps favorites and other memberships; removing a favorite removes every membership', async (t) => {
	const { db, studies } = await fixture(t);
	const a = createFavoriteCategory(db, 2, 'First'), b = createFavoriteCategory(db, 2, 'Second');
	saveStudyFavorite(db, 2, studies[0], [a.id, b.id]);
	renameFavoriteCategory(db, 2, a.id, '  آموزش  ');
	assert.equal(getFavoriteSummary(db, 2).categories[0].name, 'آموزش');
	renameFavoriteCategory(db, 2, a.id, '');
	deleteFavoriteCategory(db, 2, a.id);
	assert.deepEqual(getFavoriteSummary(db, 2), { total: 1, categories: [{ ...b, total: 1 }] });
	saveStudyFavorite(db, 2, studies[0], []);
	assert.equal(getFavoriteSummary(db, 2).total, 1);
	assert.equal(getFavoriteSummary(db, 2).categories[0].total, 0);
	saveStudyFavorite(db, 2, studies[0], [b.id]);
	removeStudyFavorite(db, 2, studies[0]);
	removeStudyFavorite(db, 2, studies[0]);
	assert.equal(getFavoriteSummary(db, 2).total, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_favorite_memberships').get().n, 0);
});

test('all user roles can maintain independent private favorites without study-edit permissions', async (t) => {
	const { request, studies, db } = await fixture(t);
	db.prepare('UPDATE studies SET disabled=1 WHERE id=?').run(studies[0]);
	for (const id of [1, 2, 3, 4]) {
		const category = await request('categories', 'POST', id, { name: 'My cases', user_id: 999 });
		assert.equal(category.status, 201);
		assert.equal((await request('favorite', 'PUT', id, { category_ids: [category.data.id], user_id: 999 })).status, 200);
		const summary = await request('categories', 'GET', id);
		assert.equal(summary.data.total, 1);
		assert.deepEqual(summary.data.categories, [{ ...category.data, total: 1 }]);
	}
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_favorites').get().n, 4);
	assert.equal(db.prepare('SELECT disabled FROM studies WHERE id=?').get(studies[0]).disabled, 1);
});

test('every favorites API rejects signed-out requests before accessing body or database', async (t) => {
	const { routes, key } = await fixture(t);
	const db = globalThis[key];
	delete globalThis[key];
	try {
		for (const [route, methods] of [['categories', ['GET', 'POST']], ['category', ['PATCH', 'DELETE']], ['favorite', ['PUT', 'DELETE']]]) {
			for (const method of methods) {
				const response = await routes[route][method]({ locals: {}, params: { id: '1' }, request: { json: () => assert.fail('Must authenticate first') } });
				assert.equal(response.status, 401, `${route} ${method}`);
			}
		}
	} finally { globalThis[key] = db; }
});

test('foreign categories cannot be read, renamed, deleted, assigned or used to filter even by admins', async (t) => {
	const { db, studies, request } = await fixture(t);
	const category = createFavoriteCategory(db, 2, 'Private resident list');
	saveStudyFavorite(db, 2, studies[0], [category.id]);
	for (const id of [1, 3, 4]) {
		assert.equal((await request('category', 'PATCH', id, { name: 'Spoofed', user_id: 2 }, category.id)).status, 404);
		assert.equal((await request('category', 'DELETE', id, undefined, category.id)).status, 404);
		assert.equal((await request('favorite', 'PUT', id, { category_ids: [category.id], user_id: 2 })).status, 404);
		assert.equal((await request('studies', 'GET', id, undefined, undefined, { favorites: category.id })).status, 404);
		assert.deepEqual((await request('categories', 'GET', id)).data, { total: 0, categories: [] });
		assert.equal((await request('studies', 'GET', id)).data.rows.find(row => row.id === studies[0]).is_favorite, false);
		assert.equal((await request('favorite', 'DELETE', id)).status, 200);
	}
	assert.equal(getFavoriteSummary(db, 2).total, 1);
	assert.equal(getFavoriteSummary(db, 2).categories[0].name, 'Private resident list');
	assert.throws(() => db.prepare('INSERT INTO study_favorite_memberships VALUES(?,?,?)').run(1, studies[0], category.id), /FOREIGN KEY/);
});

test('invalid IDs, names, study IDs and category lists fail without altering an existing favorite', async (t) => {
	const { db, studies, request } = await fixture(t);
	const category = createFavoriteCategory(db, 2, 'Valid');
	saveStudyFavorite(db, 2, studies[0], [category.id]);
	for (const category_ids of [null, '1', {}, [0], [-1], [1.5], ['1'], [9007199254740992]])
		assert.equal((await request('favorite', 'PUT', 2, { category_ids })).status, 400);
	for (const name of [42, {}, 'x'.repeat(101)]) {
		assert.equal((await request('categories', 'POST', 2, { name })).status, 400);
		assert.equal((await request('category', 'PATCH', 2, { name }, category.id)).status, 400);
	}
	for (const id of ['0', '-1', '1.5', 'NaN', '1 OR 1=1', '9007199254740992']) {
		assert.equal((await request('favorite', 'PUT', 2, { category_ids: [] }, id)).status, 400);
		assert.equal((await request('favorite', 'DELETE', 2, undefined, id)).status, 400);
		assert.equal((await request('category', 'DELETE', 2, undefined, id)).status, 400);
		assert.equal((await request('studies', 'GET', 2, undefined, undefined, { favorites: id })).status, 400);
	}
	assert.equal((await request('favorite', 'PUT', 2, { category_ids: [category.id] }, 999)).status, 404);
	assert.equal((await request('favorite', 'PUT', 2, { category_ids: [category.id, 999] })).status, 404);
	assert.deepEqual(getFavoriteSummary(db, 2), { total: 1, categories: [{ ...category, total: 1 }] });
});

test('favorites filters use the current user with deterministic counts, pagination and existing patient filters', async (t) => {
	const { db, studies, request } = await fixture(t);
	const a = createFavoriteCategory(db, 2, 'First'), b = createFavoriteCategory(db, 2, 'Second');
	saveStudyFavorite(db, 2, studies[0], [a.id, b.id]);
	saveStudyFavorite(db, 2, studies[1], [a.id]);
	saveStudyFavorite(db, 1, studies[2], []);
	const all = await request('studies', 'GET', 2, undefined, undefined, { favorites: 'all', rowcount: '1', page: '1' });
	assert.equal(all.data.total, 2); assert.equal(all.data.rows.length, 1); assert.equal(all.data.rows[0].id, studies[1]);
	assert.equal(all.data.rows[0].is_favorite, true);
	const second = await request('studies', 'GET', 2, undefined, undefined, { favorites: 'all', rowcount: '1', page: '2' });
	assert.deepEqual(second.data.rows[0].favorite_category_ids, [a.id, b.id]);
	const filtered = await request('studies', 'GET', 2, undefined, undefined, { favorites: a.id, patient_code: 'FIRST', corresponding_attending_id: '3', date_from: '1405-07-25' });
	assert.equal(filtered.data.total, 1); assert.equal(filtered.data.rows[0].id, studies[0]);
	assert.equal((await request('studies', 'GET', 2, undefined, undefined, { favorites: b.id })).data.total, 1);
	assert.equal((await request('studies', 'GET', 1, undefined, undefined, { favorites: 'all' })).data.total, 1);
	assert.equal((await request('studies', 'GET', 4, undefined, undefined, { favorites: 'all' })).data.total, 0);
});

test('removing studies and users cascades only their favorites; categories stay when a study is removed', async (t) => {
	const { db, studies } = await fixture(t);
	const category = createFavoriteCategory(db, 2, 'Cases');
	saveStudyFavorite(db, 2, studies[0], [category.id]);
	saveStudyFavorite(db, 4, studies[0], []);
	db.prepare('DELETE FROM studies WHERE id=?').run(studies[0]);
	assert.deepEqual(getFavoriteSummary(db, 2), { total: 0, categories: [{ ...category, total: 0 }] });
	assert.equal(getFavoriteSummary(db, 4).total, 0);
	saveStudyFavorite(db, 2, studies[1], [category.id]);
	saveStudyFavorite(db, 4, studies[1], []);
	db.prepare('DELETE FROM users WHERE id=2').run();
	assert.deepEqual(getFavoriteSummary(db, 2), { total: 0, categories: [] });
	assert.equal(getFavoriteSummary(db, 4).total, 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('page load forwards the favorites filter and returns only the current user category summary', async (t) => {
	const { db, key, routes, users, studies } = await fixture(t);
	const category = createFavoriteCategory(db, 2, 'Teaching');
	saveStudyFavorite(db, 2, studies[0], [category.id]);
	createFavoriteCategory(db, 1, 'Admin private');
	const { load } = await loadModule('../src/routes/studies/+page.server.js', key);
	const locals = { user: users[2] }, url = new URL(`http://localhost/studies?favorites=${category.id}&rowcount=10`);
	const data = await load({ locals, url, fetch: async path => {
		if (path.startsWith('/api/studies?')) {
			const query = new URL(path, url);
			assert.equal(query.searchParams.get('favorites'), String(category.id));
			return routes.studies.GET({ locals, url: query });
		}
		return Response.json([]);
	} });
	assert.equal(data.filters.favorites, String(category.id));
	assert.equal(data.paging.total, 1);
	assert.deepEqual(data.favorites, { total: 1, categories: [{ ...category, total: 1 }] });
	assert.equal(data.studies[0].is_favorite, true);
});
