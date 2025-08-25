// +page.server.ts
import { redirect } from '@sveltejs/kit';

export async function load({ locals, fetch, url }) {
  if (!locals.user) throw redirect(302, '/login');

  // Filters from URL
  const patient_code      = url.searchParams.get('patient_code')?.trim() ?? '';
  const patient_firstname = url.searchParams.get('patient_firstname')?.trim() ?? '';
  const patient_lastname  = url.searchParams.get('patient_lastname')?.trim() ?? '';
  const modality_id       = url.searchParams.get('modality_id')?.trim() ?? '';
  const exam_type_id      = url.searchParams.get('exam_type_id')?.trim() ?? '';
  const date_from         = url.searchParams.get('date_from')?.trim() ?? '';
  const date_to           = url.searchParams.get('date_to')?.trim() ?? '';

  // Pagination + sorting from URL
  const page       = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rowcount   = Math.min(100, Math.max(1, Number(url.searchParams.get('rowcount') ?? '20') || 20));
  const orderedby  = url.searchParams.get('orderedby')?.trim() ?? '';
  const orderdir   = (url.searchParams.get('orderdir')?.trim()?.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  // Build querystring for /api/studies
  const qs = new URLSearchParams();
  if (patient_code)      qs.set('patient_code', patient_code);
  if (patient_firstname) qs.set('patient_firstname', patient_firstname);
  if (patient_lastname)  qs.set('patient_lastname', patient_lastname);
  if (modality_id)       qs.set('modality_id', modality_id);
  if (exam_type_id)      qs.set('exam_type_id', exam_type_id);
  if (date_from)         qs.set('date_from', date_from);
  if (date_to)           qs.set('date_to', date_to);

  // Always include pagination + sorting so backend can paginate deterministically
  qs.set('page', String(page));
  qs.set('rowcount', String(rowcount));
  if (orderedby) qs.set('orderedby', orderedby);
  qs.set('orderdir', orderdir);

  // Fetch reference data & studies in parallel
  const [modsRes, typesRes, usersRes, studiesRes] = await Promise.all([
    fetch('/api/modalities'),
    fetch('/api/exam-types'),
    fetch('/api/users'),
    fetch(`/api/studies?${qs.toString()}`)
  ]);

  // NOTE: only 4 fetches → only 4 destructured values
  const [modalities, exam_types, users, studiesPayload] = await Promise.all([
    modsRes.json(),
    typesRes.json(),
    usersRes.json(),
    studiesRes.json()
  ]);

  // studiesPayload shape: { total, page, rowcount, rows }
  const { total, rows: studies } = studiesPayload;
  const totalPages = Math.max(1, Math.ceil(total / rowcount));

  return {
    user: locals.user,
    filters: {
      patient_code,
      patient_firstname,
      patient_lastname,
      modality_id,
      exam_type_id,
      date_from,
      date_to
    },
    // expose paging/sort so the UI can render controls
    paging: {
      page,
      rowcount,
      total,
      totalPages,
      orderedby,
      orderdir
    },
    modalities,
    exam_types,
    users,
    studies // <- array of rows
  };
}
