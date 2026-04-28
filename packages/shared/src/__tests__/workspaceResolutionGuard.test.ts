import { describe, expect, it } from "vitest";

type ResolutionViolation = {
  specifier: string;
  resolved: string;
};

type WorkspaceResolutionGuard = {
  DEFAULT_DEV_WORKSPACE_SPECIFIERS: string[];
  findDistWorkspaceResolutions: (
    specifiers?: string[],
    resolveSpecifier?: (specifier: string) => string,
  ) => ResolutionViolation[];
  assertWorkspacePackagesResolveToSource: (
    specifiers?: string[],
    resolveSpecifier?: (specifier: string) => string,
  ) => void;
};

const guardModulePath = new URL(
  "../../../../scripts/lib/workspace-resolution-guard.mjs",
  import.meta.url,
).href;
const {
  DEFAULT_DEV_WORKSPACE_SPECIFIERS,
  assertWorkspacePackagesResolveToSource,
  findDistWorkspaceResolutions,
} = (await import(guardModulePath)) as WorkspaceResolutionGuard;
const nodeImportMeta = import.meta as ImportMeta & { resolve: (specifier: string) => string };

describe("workspace resolution guard", () => {
  it("keeps dev workspace package resolution on source files", () => {
    expect(findDistWorkspaceResolutions()).toEqual([]);

    const resolved = DEFAULT_DEV_WORKSPACE_SPECIFIERS.map((specifier) =>
      nodeImportMeta.resolve(specifier),
    );
    for (const resolvedSpecifier of resolved) {
      expect(resolvedSpecifier.replace(/\\/g, "/")).toContain("/src/");
    }
  });

  it("reports compiled dist workspace resolutions with a clear startup error", () => {
    const resolveToDist = (specifier: string) =>
      `file:///repo/packages/${specifier.replace("@aif/", "")}/dist/index.js`;

    expect(findDistWorkspaceResolutions(["@aif/data"], resolveToDist)).toEqual([
      {
        specifier: "@aif/data",
        resolved: "file:///repo/packages/data/dist/index.js",
      },
    ]);
    expect(() => assertWorkspacePackagesResolveToSource(["@aif/data"], resolveToDist)).toThrow(
      /Dev workspace resolution is using compiled dist output/u,
    );
  });
});
