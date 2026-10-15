export function isResidentAttendingDelegate(user, recording) {
	return user?.role === 'resident' &&
		(user.can_sign_as_attending === 1 || user.can_sign_as_attending === true) &&
		recording?.corresponding_resident_id != null &&
		Number(user.id) === Number(recording.corresponding_resident_id);
}
