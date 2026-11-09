export default async function beforeBuild() {
  // The staged desktop runtime intentionally has no third-party production
  // dependencies. Returning false tells electron-builder that dependency
  // handling is complete, so it must not inspect the outer pnpm workspace.
  return false;
}
