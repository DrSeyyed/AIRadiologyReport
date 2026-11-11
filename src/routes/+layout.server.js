export async function load({ locals }) {
  return {
    user: locals.user || null,
    maintenance: locals.user?.role === 'admin' ? locals.maintenance || null : null
  };
}