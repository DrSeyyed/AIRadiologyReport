function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function favoriteId(value) {
	if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
		throw failure('Invalid favorite study or category ID.');
	return Number(value);
}

function categoryName(value) {
	if (typeof value !== 'string' || value.trim().length > 100)
		throw failure('Category names must be text up to 100 characters; a blank name is allowed.');
	return value.trim();
}

function requireCategory(db, userId, categoryId) {
	const category = db.prepare('SELECT id, name FROM study_favorite_categories WHERE user_id = ? AND id = ?').get(userId, categoryId);
	if (!category) throw failure('Favorite category not found.', 404);
	return category;
}

export function getFavoriteSummary(db, userId) {
	return {
		total: db.prepare('SELECT count(*) AS total FROM study_favorites WHERE user_id = ?').get(userId).total,
		categories: db.prepare(`SELECT c.id, c.name, count(m.study_id) AS total
			FROM study_favorite_categories c LEFT JOIN study_favorite_memberships m
			ON m.user_id = c.user_id AND m.category_id = c.id
			WHERE c.user_id = ? GROUP BY c.id ORDER BY c.id`).all(userId)
	};
}

export function createFavoriteCategory(db, userId, name = '') {
	name = categoryName(name);
	const result = db.prepare('INSERT INTO study_favorite_categories(user_id, name) VALUES (?, ?)').run(userId, name);
	return { id: Number(result.lastInsertRowid), name };
}

export function renameFavoriteCategory(db, userId, id, name) {
	id = favoriteId(id);
	name = categoryName(name);
	requireCategory(db, userId, id);
	db.prepare('UPDATE study_favorite_categories SET name = ? WHERE user_id = ? AND id = ?').run(name, userId, id);
	return { id, name };
}

export function deleteFavoriteCategory(db, userId, id) {
	id = favoriteId(id);
	requireCategory(db, userId, id);
	db.prepare('DELETE FROM study_favorite_categories WHERE user_id = ? AND id = ?').run(userId, id);
}

export function saveStudyFavorite(db, userId, studyId, categoryIds) {
	studyId = favoriteId(studyId);
	if (!Array.isArray(categoryIds) || categoryIds.some(id => !Number.isSafeInteger(id) || id <= 0))
		throw failure('Select valid favorite categories.');
	const ids = [...new Set(categoryIds)];
	return db.transaction(() => {
		if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId))
			throw failure('Study not found.', 404);
		for (const id of ids) requireCategory(db, userId, id);
		db.prepare('INSERT OR IGNORE INTO study_favorites(user_id, study_id) VALUES (?, ?)').run(userId, studyId);
		db.prepare('DELETE FROM study_favorite_memberships WHERE user_id = ? AND study_id = ?').run(userId, studyId);
		const insert = db.prepare('INSERT INTO study_favorite_memberships(user_id, study_id, category_id) VALUES (?, ?, ?)');
		for (const id of ids) insert.run(userId, studyId, id);
		return { is_favorite: true, favorite_category_ids: ids };
	})();
}

export function removeStudyFavorite(db, userId, studyId) {
	db.prepare('DELETE FROM study_favorites WHERE user_id = ? AND study_id = ?').run(userId, favoriteId(studyId));
}

export function favoriteStudyFilter(db, userId, value) {
	if (!value) return { sql: '', params: [] };
	if (value === 'all') return {
		sql: ' AND EXISTS (SELECT 1 FROM study_favorites f WHERE f.study_id = s.id AND f.user_id = ?)', params: [userId]
	};
	const id = favoriteId(value);
	requireCategory(db, userId, id);
	return {
		sql: ' AND EXISTS (SELECT 1 FROM study_favorite_memberships f WHERE f.study_id = s.id AND f.user_id = ? AND f.category_id = ?)',
		params: [userId, id]
	};
}

export function attachStudyFavorites(db, userId, rows) {
	const favorites = new Map();
	if (rows.length) {
		const items = db.prepare(`SELECT f.study_id, m.category_id FROM study_favorites f
			LEFT JOIN study_favorite_memberships m ON m.user_id = f.user_id AND m.study_id = f.study_id
			WHERE f.user_id = ? AND f.study_id IN (${rows.map(() => '?').join(',')}) ORDER BY m.category_id`)
			.all(userId, ...rows.map(row => row.id));
		for (const item of items) {
			if (!favorites.has(item.study_id)) favorites.set(item.study_id, []);
			if (item.category_id !== null) favorites.get(item.study_id).push(item.category_id);
		}
	}
	for (const row of rows) {
		row.is_favorite = favorites.has(row.id);
		row.favorite_category_ids = favorites.get(row.id) ?? [];
	}
}
