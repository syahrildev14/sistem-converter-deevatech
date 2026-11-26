// Runs once when the Node.js server starts: prepares the storage dir, wipes leftovers from the
// previous run and starts the periodic cleanup sweeper.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { getJobManager } = await import('./lib/jobs');
  getJobManager();
}
