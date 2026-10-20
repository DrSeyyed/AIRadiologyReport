function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

function requireAttending(db, actor) {
	const user = actor && db.prepare('SELECT id, role FROM users WHERE id=?').get(actor.id);
	if (!user) throw failure('Unauthorized', 401);
	if (user.role !== 'attending') throw failure('Only attendings can manage their own signing delegates', 403);
	return user;
}

export function getAttendingDelegateIds(db, residentId) {
	return db.prepare(`SELECT d.attending_id FROM attending_signing_delegates d
		JOIN users a ON a.id=d.attending_id AND a.role='attending'
		JOIN users r ON r.id=d.resident_id AND r.role='resident'
		WHERE d.resident_id=? ORDER BY d.attending_id`).all(residentId).map(row => row.attending_id);
}

export function getSigningDelegates(db, actor) {
	const user = requireAttending(db, actor);
	const residents = db.prepare("SELECT id, full_name FROM users WHERE role='resident' ORDER BY full_name COLLATE NOCASE, id").all();
	const resident_ids = db.prepare('SELECT resident_id FROM attending_signing_delegates WHERE attending_id=? ORDER BY resident_id').all(user.id).map(row => row.resident_id);
	return { residents, resident_ids };
}

export function updateSigningDelegates(db, actor, input) {
	return db.transaction(() => {
		const user = requireAttending(db, actor);
		if (!input || typeof input !== 'object' || Array.isArray(input) ||
			Object.keys(input).some(key => key !== 'resident_ids') || !Array.isArray(input.resident_ids) ||
			input.resident_ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
			new Set(input.resident_ids).size !== input.resident_ids.length)
			throw failure('Provide a list of distinct resident IDs');
		const resident = db.prepare("SELECT id FROM users WHERE id=? AND role='resident'");
		for (const id of input.resident_ids) {
			if (!resident.get(id)) throw failure('Every selected user must be a current resident');
		}
		db.prepare('DELETE FROM attending_signing_delegates WHERE attending_id=?').run(user.id);
		const insert = db.prepare('INSERT INTO attending_signing_delegates(attending_id,resident_id) VALUES(?,?)');
		for (const id of input.resident_ids) insert.run(user.id, id);
		return getSigningDelegates(db, user);
	})();
}
