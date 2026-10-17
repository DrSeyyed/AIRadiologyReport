// +page.server.ts
import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPacsViewerUrl } from '$lib/server/pacs-settings.js';
import { getFavoriteSummary } from '$lib/server/study-favorites.js';

export async function load({ locals, fetch, url }) {
  if (!locals.user) throw redirect(302, '/login');

  // Filters from URL
  const patient_code      = url.searchParams.get('patient_code')?.trim() ?? '';
  const patient_firstname = url.searchParams.get('patient_firstname')?.trim() ?? '';
  const patient_lastname  = url.searchParams.get('patient_lastname')?.trim() ?? '';
  const patient_fullname = url.searchParams.get('patient_fullname')?.trim()
    || [patient_firstname, patient_lastname].filter(Boolean).join(' ');
  const modality_id       = url.searchParams.get('modality_id')?.trim() ?? '';
  const exam_type_id      = url.searchParams.get('exam_type_id')?.trim() ?? '';
  const corresponding_resident_id = url.searchParams.get('corresponding_resident_id')?.trim() ?? '';
  const corresponding_attending_id = url.searchParams.get('corresponding_attending_id')?.trim() ?? '';
  const date_from         = url.searchParams.get('date_from')?.trim() ?? '';
  const date_to           = url.searchParams.get('date_to')?.trim() ?? '';
  const favorites         = url.searchParams.get('favorites')?.trim() ?? '';

  const signatureFilters = Object.fromEntries(['resident', 'attending', 'typist'].map((role) => [
    `${role}_checked`, url.searchParams.get(`${role}_checked`)?.trim() ?? ''
  ]));

  // Pagination + sorting from URL
  const page       = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rowcount   = Math.min(100, Math.max(1, Number(url.searchParams.get('rowcount') ?? '20') || 20));
  const orderedby  = url.searchParams.get('orderedby')?.trim() ?? '';
  const orderdir   = (url.searchParams.get('orderdir')?.trim()?.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  // Build querystring for /api/studies
  const qs = new URLSearchParams();
  if (patient_code)      qs.set('patient_code', patient_code);
  if (patient_fullname)  qs.set('patient_fullname', patient_fullname);
  if (modality_id)       qs.set('modality_id', modality_id);
  if (exam_type_id)      qs.set('exam_type_id', exam_type_id);
  if (corresponding_resident_id) qs.set('corresponding_resident_id', corresponding_resident_id);
  if (corresponding_attending_id) qs.set('corresponding_attending_id', corresponding_attending_id);
  if (date_from)         qs.set('date_from', date_from);
  if (date_to)           qs.set('date_to', date_to);
  if (favorites)         qs.set('favorites', favorites);
  for (const [key, value] of Object.entries(signatureFilters)) {
    if (value) qs.set(key, value);
  }

  // Always include pagination + sorting so backend can paginate deterministically
  qs.set('page', String(page));
  qs.set('rowcount', String(rowcount));
  if (orderedby) qs.set('orderedby', orderedby);
  qs.set('orderdir', orderdir);

  // Fetch reference data & studies in parallel
  const responses = await Promise.all([
    fetch('/api/modalities'),
    fetch('/api/exam-types'),
    fetch('/api/users?role=resident'),
    fetch('/api/users?role=attending'),
    fetch(`/api/studies?${qs.toString()}`)
  ]);
  for (const response of responses) {
    if (!response.ok) throw error(response.status, 'Unable to load studies or reference data');
  }
  const [modalities, exam_types, residents, attendings, studiesPayload] = await Promise.all(
    responses.map((response) => response.json())
  );
  const users = [...residents, ...attendings];

  // studiesPayload shape: { total, page, rowcount, rows }
  const { total, rows: studies } = studiesPayload;
  const totalPages = Math.max(1, Math.ceil(total / rowcount));

  return {
    user: locals.user,
    pacsViewerUrl: getPacsViewerUrl(getDb()),
    favorites: getFavoriteSummary(getDb(), locals.user.id),
    filters: {
      patient_code,
      patient_fullname,
      modality_id,
      exam_type_id,
      corresponding_resident_id,
      corresponding_attending_id,
      date_from,
      date_to,
      favorites,
      ...signatureFilters
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
    residents,
    attendings,
    studies // <- array of rows
  };
}
