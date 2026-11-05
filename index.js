/**
 * Host half of the job-monitor bundle.
 *
 * The bundle exists for its Client module: `client.js` registers a dedicated page
 * in the `main` slot plus its sidebar entry, and reads the shipped job
 * controller's client service (`ctx.jobs`), which already owns the roster and
 * observation streams over `remote.job`. Nothing is registered on the Host.
 */
export function apply() {}
