export const DEFAULT_DEV_WORKSPACE_SPECIFIERS = [
  "@aif/data",
  "@aif/shared",
  "@aif/runtime",
  "@aif/mcp",
];

const defaultResolveSpecifier = (specifier) => import.meta.resolve(specifier);

function normalizeResolvedPath(resolved) {
  return String(resolved).replace(/\\/g, "/").toLowerCase();
}

function isDistResolution(resolved) {
  return /(^|\/)dist(\/|$)/u.test(normalizeResolvedPath(resolved));
}

export function findDistWorkspaceResolutions(
  specifiers = DEFAULT_DEV_WORKSPACE_SPECIFIERS,
  resolveSpecifier = defaultResolveSpecifier,
) {
  const violations = [];

  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(specifier);
    if (isDistResolution(resolved)) {
      violations.push({ specifier, resolved: String(resolved) });
    }
  }

  return violations;
}

export function assertWorkspacePackagesResolveToSource(
  specifiers = DEFAULT_DEV_WORKSPACE_SPECIFIERS,
  resolveSpecifier = defaultResolveSpecifier,
) {
  const violations = findDistWorkspaceResolutions(specifiers, resolveSpecifier);
  if (violations.length === 0) {
    return;
  }

  const details = violations
    .map(({ specifier, resolved }) => `- ${specifier} -> ${resolved}`)
    .join("\n");

  throw new Error(
    [
      "Dev workspace resolution is using compiled dist output.",
      'Run "npm run build" or fix workspace package manifests so npm run dev resolves packages to src.',
      details,
    ].join("\n"),
  );
}
