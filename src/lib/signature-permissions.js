export function isResidentAttendingDelegate(user, recording, study) {
	return user?.role === 'resident' &&
		study?.corresponding_attending_id != null &&
		Array.isArray(user.attending_delegate_ids) &&
		user.attending_delegate_ids.some(id => Number(id) === Number(study.corresponding_attending_id)) &&
		recording?.corresponding_resident_id != null &&
		Number(user.id) === Number(recording.corresponding_resident_id);
}
